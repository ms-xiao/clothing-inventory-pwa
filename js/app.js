import {
  openDB,
  listProducts,
  listMovements,
  saveProduct,
  receiveStock,
  sellStock,
  exportBackup,
  validateBackup,
  restoreBackup,
  moneyToCents,
  formatMoney,
} from "./db.js";

const $ = (selector, node = document) => node.querySelector(selector);
const main = $("#main");
const sheet = $("#sheet");
const state = {
  view: "inventory",
  products: [],
  movements: [],
  query: "",
  stockFilter: "all",
  historyFilter: "all",
  historyQuery: "",
  historyLimit: 100,
  detailId: null,
  entryPreset: null,
  drafts: {},
  scroll: {},
};
let busy = false;
let toastTimer;
let restoreCandidate;
let waitingWorker;
let updating = false;
let sheetOpener;
const channel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("yiji-data")
    : null;
const paths = {
  hanger:
    "M10 7a2 2 0 1 1 3 1.7L12 10v2L3 17a1.5 1.5 0 0 0 .7 2.8h16.6A1.5 1.5 0 0 0 21 17l-9-5",
  inventory: "m12 3 9 5v9l-9 5-9-5V8l9-5zm0 10 9-5M3 8l9 5v9M7.5 5.5l9 5v5",
  receive: "M12 3v18m-7-7 7 7 7-7",
  sell: "M12 21V3m-7 7 7-7 7 7",
  history: "M6 3h12v18H6V3zm3 4h6m-6 5h6m-6 5h4",
  settings:
    "m10 2 4 0 1 3 3 1 3 0 1 4-2 2v3l1 3-3 3-3-1h-3l-2 2-4-1 0-3-1-3-3-1V10l3-1 1-3 0-3 4-1zm2 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  close: "M6 6l12 12M6 18 18 6",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6z",
  shirt: "m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0",
  layers: "m12 3 10 5-10 5L2 8l10-5zm-10 9 10 5 10-5M2 17l10 5 10-5",
  check: "m5 12 4 4L19 6",
  shield: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4zm-4 10 3 3 5-6",
  backup: "M12 21V3m-6 6 6-6 6 6",
  device: "M5 4h14l3 13v3H2v-3L5 4zM2 16h20M6 18h2",
  more: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M7 12h.01M12 12h.01M17 12h.01",
  back: "m15 4-8 8 8 8",
  chevron: "m9 5 7 7-7 7",
  sidebar: "M3 4h18v16H3V4zm6 0v16M5 8h2m-2 4h2",
  warning: "M12 7v6m0 4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  bag: "M5 7h14l2 14H3L5 7zm3 0V5a4 4 0 0 1 8 0v2",
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.inventory}"/></svg>`;
}
function hydrateIcons(node = document) {
  node.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}
function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}
function number(value) {
  return value.toLocaleString("zh-CN");
}
function fullDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
function localDay(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function toast(text, error = false) {
  const node = $("#toast");
  clearTimeout(toastTimer);
  node.textContent = text;
  node.classList.toggle("error", error);
  node.hidden = false;
  toastTimer = setTimeout(
    () => {
      node.hidden = true;
    },
    error ? 6500 : 3500,
  );
}
function errorIn(form, error) {
  const node = $(".form-error", form);
  node.textContent = error.message || "操作失败，请重试。";
  node.hidden = false;
  node.focus();
}
function pageTop(title, description = "", extra = "") {
  return `<div class="page-top"><div><h1>${escape(title)}</h1>${description ? `<p class="page-description">${escape(description)}</p>` : ""}</div>${extra}</div>`;
}
function empty(title, description, action = "", glyph = "hanger") {
  return `<div class="empty"><span class="empty-icon">${icon(glyph)}</span><h2>${title}</h2><p>${description}</p>${action}</div>`;
}
function addButton() {
  return `<button class="button" data-action="add">${icon("plus")}添加商品</button>`;
}
function groupKey(p) {
  return JSON.stringify([p.sku, p.name]);
}
function groups() {
  const result = new Map();
  for (const p of state.products) {
    const key = groupKey(p);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(p);
  }
  return [...result.values()];
}
function sum(products) {
  return products.reduce((n, p) => n + p.stock, 0);
}
function tint(sku) {
  let hash = 0;
  for (const ch of sku) hash = (Math.imul(hash, 17) ^ ch.codePointAt(0)) >>> 0;
  return ["blue", "purple", "green", "orange", "pink"][hash % 5];
}
function swatch(color) {
  const match = [
    ["黑", "#242426"],
    ["白", "#fafafa"],
    ["灰", "#a7a7ad"],
    ["蓝", "#6b8cac"],
    ["燕麦", "#d6cbb6"],
    ["卡其", "#b8a17b"],
    ["红", "#c86b6b"],
    ["绿", "#719777"],
    ["粉", "#e3b0c2"],
  ].find(([name]) => color.includes(name));
  return match?.[1] || "#b9b9c2";
}
function badge(name, color = "blue") {
  return `<span class="glyph ${color}">${icon(name)}</span>`;
}
function searchBox(id, label, placeholder, value) {
  return `<label class="search">${icon("search")}<input type="search" id="${id}" aria-label="${label}" placeholder="${placeholder}" value="${escape(value)}"></label>`;
}
function renderInventory() {
  const today = state.movements.filter(
    (m) => localDay(m.createdAt) === localDay(Date.now()),
  );
  const summaries = [
    ["库存总数", sum(state.products), "inventory", "blue"],
    [
      "暂无库存规格",
      state.products.filter((p) => p.stock === 0).length,
      "warning",
      "red",
    ],
    [
      "今日进货件数",
      today.filter((m) => m.type === "in").reduce((n, m) => n + m.quantity, 0),
      "receive",
      "green",
    ],
    [
      "今日销售件数",
      today.filter((m) => m.type === "out").reduce((n, m) => n + m.quantity, 0),
      "sell",
      "orange",
    ],
  ];
  main.innerHTML =
    pageTop("库存") +
    searchBox(
      "inventory-search",
      "搜索商品",
      "搜索商品、货号、颜色或尺码",
      state.query,
    ) +
    `<div class="stats" aria-label="库存概览">${summaries.map(([label, value, glyph, color]) => `<div class="stat" data-metric="${label}">${badge(glyph, color)}<strong>${number(value)}</strong><span>${label}</span></div>`).join("")}</div><div class="section-heading"><h2>我的商品</h2><button class="text-button" id="stock-filter-toggle" aria-expanded="${state.stockFilter !== "all"}" aria-controls="stock-filters">${state.stockFilter === "all" ? "全部规格" : state.stockFilter === "available" ? "有库存规格" : "暂无库存规格"}${icon("chevron")}</button></div><div class="segmented" id="stock-filters" aria-label="库存筛选" ${state.stockFilter === "all" ? "hidden" : ""}>${[
      ["all", "全部"],
      ["available", "有库存"],
      ["zero", "暂无库存"],
    ]
      .map(
        ([v, l]) =>
          `<button data-stock="${v}" class="${state.stockFilter === v ? "active" : ""}" aria-pressed="${state.stockFilter === v}">${l}</button>`,
      )
      .join("")}</div><div id="inventory-results"></div>`;
  renderProductList();
  $("#inventory-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderProductList();
  });
  $("#stock-filter-toggle").addEventListener("click", () => {
    const target = $("#stock-filters");
    target.hidden = !target.hidden;
    $("#stock-filter-toggle").setAttribute(
      "aria-expanded",
      String(!target.hidden),
    );
  });
}
function renderProductList() {
  const query = state.query.trim().toLocaleLowerCase();
  // Match a specification, then display its entire style and its full stock total.
  const filtered = groups().filter((products) =>
    products.some(
      (p) =>
        `${p.name} ${p.sku} ${p.color} ${p.size}`
          .toLocaleLowerCase()
          .includes(query) &&
        (state.stockFilter === "all" ||
          (state.stockFilter === "available" ? p.stock > 0 : p.stock === 0)),
    ),
  );
  const target = $("#inventory-results");
  if (!state.products.length) {
    target.innerHTML = empty(
      "添加第一件商品",
      "每个颜色、尺码单独录入，再登记进货。",
      addButton(),
    );
    return;
  }
  if (!filtered.length) {
    target.innerHTML = empty(
      "没有找到商品",
      "试试其他关键词，或切换库存筛选。",
      "",
      "search",
    );
    return;
  }
  target.innerHTML = `<div class="grouped product-list">${filtered.map((products) => `<article class="product-card"><button class="product-row" data-style="${products[0].id}">${badge("shirt", tint(products[0].sku))}<span class="product-heading"><h3>${escape(products[0].name)}</h3><span class="sku">货号 ${escape(products[0].sku)}</span><span class="variant-overview">${escape([...new Set(products.map((p) => p.color))].join(" / "))} · ${escape([...new Set(products.map((p) => p.size))].join(" / "))}</span></span><span class="stock-badge">${number(sum(products))}<small>件</small></span><span class="chevron">${icon("chevron")}</span></button></article>`).join("")}</div><p class="section-foot">${number(filtered.length)} 款 · 显示整款库存${state.stockFilter !== "all" ? "；筛选匹配其中任一规格" : ""}</p>`;
}
function detailProducts() {
  const product = state.products.find((p) => p.id === state.detailId);
  return product
    ? state.products.filter((p) => groupKey(p) === groupKey(product))
    : [];
}
function renderDetail() {
  const products = detailProducts();
  if (!products.length) {
    main.innerHTML =
      pageTop("款式详情") +
      empty("找不到此款式", "商品可能已被备份恢复替换，请返回库存。");
    return;
  }
  const first = products[0];
  const colors = new Map();
  for (const p of products) {
    if (!colors.has(p.color)) colors.set(p.color, []);
    colors.get(p.color).push(p);
  }
  main.innerHTML = `<div class="detail-heading">${badge("shirt", tint(first.sku))}<div><h1>${escape(first.name)}</h1><p class="sku">货号 ${escape(first.sku)}</p></div><span class="detail-total">${number(sum(products))}<small> 件</small></span></div><div class="section-heading"><h2>颜色与尺码</h2><button class="text-button" data-action="add-variant">添加规格</button></div><div class="colors">${[...colors].map(([color, items]) => `<details class="color-group grouped" open><summary><span class="color-swatch" style="background:${swatch(color)}"></span><strong>${escape(color)}</strong><span>${number(sum(items))} 件</span>${icon("chevron")}</summary><div class="specifications">${items.map((p) => `<div class="spec-row"><span class="spec-size">${escape(p.size)}</span><span>${number(p.stock)} 件</span><button class="icon-button" data-edit="${p.id}" aria-label="编辑 ${escape(p.name)} ${escape(p.color)} ${escape(p.size)}">${icon("edit")}</button></div>`).join("")}</div></details>`).join("")}</div><div class="grouped action-list"><button data-entry="receive" data-product="${first.id}">${badge("inventory", "blue")}<span>登记进货</span>${icon("chevron")}</button><button data-entry="sell" data-product="${first.id}">${badge("bag", "purple")}<span>登记销售</span>${icon("chevron")}</button><button data-action="add-variant">${badge("plus", "blue")}<span>继续添加此款其他规格</span>${icon("chevron")}</button></div><div class="section-heading"><h2>最近记录</h2><button class="text-button" data-action="style-history">全部记录${icon("chevron")}</button></div><div id="detail-history"></div>`;
  const ids = new Set(products.map((p) => p.id));
  $("#detail-history").innerHTML =
    movementGroups(
      state.movements.filter((m) => ids.has(m.productId)).slice(0, 5),
      false,
    ) || '<p class="section-foot">此款式还没有进销记录。</p>';
}
function entrySelection(form, level = "style", selectedId = "") {
  const styles = groups();
  const chosen = state.products.find((p) => p.id === selectedId);
  if (level === "style") {
    form.elements.style.innerHTML =
      '<option value="">请选择款式</option>' +
      styles
        .map(
          (items) =>
            `<option value="${items[0].id}">${escape(items[0].name)} · ${escape(items[0].sku)}</option>`,
        )
        .join("");
    form.elements.style.value = chosen
      ? styles.find((items) => items.some((p) => p.id === chosen.id))[0].id
      : "";
  }
  const base = state.products.find((p) => p.id === form.elements.style.value);
  const items = base
    ? state.products.filter((p) => groupKey(p) === groupKey(base))
    : [];
  const colors = [...new Set(items.map((p) => p.color))];
  if (level !== "size") {
    form.elements.color.innerHTML =
      '<option value="">请选择颜色</option>' +
      colors
        .map((c) => `<option value="${escape(c)}">${escape(c)}</option>`)
        .join("");
    form.elements.color.value =
      chosen?.color ?? (colors.length === 1 ? colors[0] : "");
  }
  form.elements.color.disabled = !items.length;
  const specs = items.filter((p) => p.color === form.elements.color.value);
  form.elements.productId.innerHTML =
    '<option value="">请选择尺码</option>' +
    specs
      .map(
        (p) =>
          `<option value="${p.id}">${escape(p.size)} · ${number(p.stock)} 件</option>`,
      )
      .join("");
  form.elements.productId.disabled = !specs.length;
  form.elements.productId.value =
    chosen?.id ?? (specs.length === 1 ? specs[0].id : "");
}
function renderEntry(type) {
  const incoming = type === "in";
  main.innerHTML = pageTop(incoming ? "登记进货" : "登记销售");
  if (!state.products.length) {
    main.innerHTML += empty(
      "先添加一件商品",
      "录入商品规格后，即可登记进货与销售。",
      addButton(),
    );
    return;
  }
  main.innerHTML += `<form id="entry-form" class="entry-layout"><div class="entry-fields"><div class="grouped form-group"><label class="field">商品款式<select name="style" required aria-label="商品款式"></select></label><label class="field">颜色<select name="color" required aria-label="颜色"></select></label><label class="field">尺码<select name="productId" required aria-label="尺码"></select></label></div><div class="grouped form-group"><label class="field">${incoming ? "进货数量" : "销售数量"}<input name="quantity" type="number" inputmode="numeric" min="1" max="999999" step="1" placeholder="填写件数" required></label>${incoming ? '<div class="field readonly"><span>当前进价</span><output id="entry-cost">—</output></div>' : '<label class="field">实售单价<input name="price" type="text" inputmode="decimal" maxlength="12" placeholder="元 / 件" required></label>'}</div><p class="help-note">${incoming ? "进货按当前商品进价登记。进价有变化时，请先编辑该规格。" : "单价可按本次成交修改。确认时会再次核对可售库存。"}</p></div><aside class="entry-aside"><div class="entry-summary ${incoming ? "incoming" : "outgoing"}" id="entry-summary" aria-live="polite"></div></aside><div class="entry-footer"><p class="form-error" role="alert" tabindex="-1" hidden></p><button class="button full" type="submit">${icon(incoming ? "receive" : "sell")}${incoming ? "确认进货" : "确认销售"}</button></div></form>`;
  const form = $("#entry-form");
  const draft = state.drafts[state.view];
  entrySelection(form, "style", state.entryPreset || draft?.productId);
  if (draft && !state.entryPreset) {
    if (!draft.productId) {
      form.elements.style.value = draft.style;
      entrySelection(form, "color");
      form.elements.color.value = draft.color;
      entrySelection(form, "size");
    }
    form.elements.quantity.value = draft.quantity;
    if (!incoming) form.elements.price.value = draft.price;
  } else if (!incoming) {
    const p = state.products.find(
      (p) => p.id === form.elements.productId.value,
    );
    form.elements.price.value = p ? (p.priceCents / 100).toFixed(2) : "";
  }
  state.entryPreset = null;
  const selectChanged = () => {
    const product = state.products.find(
      (p) => p.id === form.elements.productId.value,
    );
    if (!incoming)
      form.elements.price.value = product
        ? (product.priceCents / 100).toFixed(2)
        : "";
    $(".form-error", form).hidden = true;
    updateEntrySummary(type);
  };
  form.elements.style.addEventListener("change", () => {
    entrySelection(form, "color");
    selectChanged();
  });
  form.elements.color.addEventListener("change", () => {
    entrySelection(form, "size");
    selectChanged();
  });
  form.elements.productId.addEventListener("change", selectChanged);
  form.addEventListener("input", () => updateEntrySummary(type));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = $('[type="submit"]', form);
    button.disabled = true;
    try {
      const payload = {
        productId: form.elements.productId.value,
        quantity: Number(form.elements.quantity.value),
      };
      if (!incoming)
        payload.priceCents = moneyToCents(form.elements.price.value);
      const result = await (incoming
        ? receiveStock(payload)
        : sellStock(payload));
      state.products = state.products.map((p) =>
        p.id === result.product.id ? result.product : p,
      );
      state.movements.unshift(result.movement);
      form.reset();
      delete state.drafts[state.view];
      $(".form-error", form).hidden = true;
      channel?.postMessage("changed");
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }
      updateOptions(form);
      updateEntrySummary(type);
      toast(
        `${incoming ? "进货" : "销售"}已登记，当前库存 ${result.product.stock} 件${refreshed ? "" : "。列表刷新失败，请重新打开应用"}`,
      );
    } catch (error) {
      errorIn(form, error);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
  updateEntrySummary(type);
}
function updateOptions(form) {
  if (!form) return;
  const id = form.elements.productId.value;
  const styleId = form.elements.style.value;
  const color = form.elements.color.value;
  entrySelection(form, "style", id);
  if (!id) {
    form.elements.style.value = styleId;
    entrySelection(form, "color");
    form.elements.color.value = color;
    entrySelection(form, "size");
  }
}
function updateEntrySummary(type) {
  const form = $("#entry-form");
  if (!form) return;
  const product = state.products.find(
    (p) => p.id === form.elements.productId.value,
  );
  const quantity = Number(form.elements.quantity.value);
  let cents = product?.costCents ?? 0;
  let validPrice = true;
  if (type === "out") {
    try {
      cents = moneyToCents(form.elements.price.value);
    } catch {
      validPrice = false;
    }
  }
  const validQuantity =
    Number.isInteger(quantity) && quantity > 0 && quantity <= 999999;
  if ($("#entry-cost"))
    $("#entry-cost").textContent = product
      ? formatMoney(product.costCents)
      : "—";
  const enough = product && (type === "in" || quantity <= product.stock);
  $("#entry-summary").innerHTML =
    `<h2>${badge(type === "in" ? "inventory" : "bag", type === "in" ? "green" : "orange")}${type === "in" ? "进货汇总" : "销售摘要"}</h2><div class="summary-row"><span>商品</span><strong>${product ? escape(product.name) : "待选规格"}</strong></div><div class="summary-row"><span>颜色 · 尺码</span><strong>${product ? `${escape(product.color)} · ${escape(product.size)}` : "—"}</strong></div><div class="summary-row"><span>当前库存</span><strong>${product ? `${number(product.stock)} 件` : "—"}</strong></div><div class="summary-row"><span>数量 · 单价</span><strong>${validQuantity ? number(quantity) : "—"} × ${product && validPrice ? formatMoney(cents) : "—"}</strong></div><div class="summary-row"><span>登记后库存</span><strong class="${enough ? "" : "text-red"}">${product && validQuantity ? (enough ? `${number(product.stock + (type === "in" ? quantity : -quantity))} 件` : "库存不足，无法销售") : "—"}</strong></div><div class="summary-row summary-total"><span>合计金额</span><strong>${product && validQuantity && validPrice ? formatMoney(cents * quantity) : "—"}</strong></div>`;
}
function movementGroups(records, dated = true) {
  const days = new Map();
  for (const m of records) {
    const key = dated ? localDay(m.createdAt) : "";
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(m);
  }
  return [...days.values()]
    .map(
      (items) =>
        `${dated ? `<h2 class="date-heading">${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(items[0].createdAt))}</h2>` : ""}<div class="history-list grouped">${items.map((m) => `<article class="history-row">${badge(m.type === "in" ? "inventory" : "bag", m.type === "in" ? "green" : "red")}<div class="history-description"><h3>${m.type === "in" ? "登记进货" : "登记销售"} · ${escape(m.snapshot.name)}</h3><p>${escape(m.snapshot.color)} · ${escape(m.snapshot.size)} · ${number(m.quantity)} 件</p><p>${escape(m.snapshot.sku)} · 单价 ${formatMoney(m.priceCents)}</p></div><div class="history-amount ${m.type === "in" ? "text-green" : "text-red"}">${m.type === "in" ? "+" : "−"}${number(m.quantity)}<small>${formatMoney(m.totalCents)}</small><time datetime="${m.createdAt}" title="${fullDate(m.createdAt)}">${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(m.createdAt))}</time></div></article>`).join("")}</div>`,
    )
    .join("");
}
function renderHistory() {
  main.innerHTML =
    pageTop("进销记录") +
    searchBox(
      "history-search",
      "搜索进销记录",
      "搜索商品、货号、颜色或尺码",
      state.historyQuery,
    ) +
    `<div class="toolbar"><div class="segmented" aria-label="记录筛选">${[
      ["all", "全部"],
      ["in", "进货"],
      ["out", "销售"],
    ]
      .map(
        ([value, label]) =>
          `<button data-history="${value}" class="${state.historyFilter === value ? "active" : ""}" aria-pressed="${state.historyFilter === value}">${label}</button>`,
      )
      .join(
        "",
      )}</div><span id="history-count" class="section-foot"></span></div><div id="history-results"></div>`;
  $("#history-search").addEventListener("input", (event) => {
    state.historyQuery = event.target.value;
    state.historyLimit = 100;
    renderHistoryResults();
  });
  renderHistoryResults();
}
function renderHistoryResults() {
  const query = state.historyQuery.trim().toLocaleLowerCase();
  const records = state.movements.filter(
    (m) =>
      (state.historyFilter === "all" || m.type === state.historyFilter) &&
      Object.values(m.snapshot).join(" ").toLocaleLowerCase().includes(query),
  );
  $("#history-count").textContent = `共 ${number(records.length)} 笔`;
  $("#history-results").innerHTML = records.length
    ? movementGroups(records.slice(0, state.historyLimit)) +
      (records.length > state.historyLimit
        ? '<button class="button secondary full" data-action="more-history">显示更多记录</button>'
        : "") +
      '<p class="section-foot">记录保留登记时的商品信息与价格。</p>'
    : empty("还没有这类记录", "进销登记后，记录会出现在这里。", "", "history");
}
function renderSettings() {
  main.innerHTML =
    pageTop("设置") +
    `<section class="storage-note">${badge("device", "blue")}<div><h2>数据仅保存在这台设备</h2><p>商品、库存与记录保存在本机。请定期导出 JSON 备份，保存到安全位置。</p></div></section><h2 class="date-heading">数据与备份</h2><div class="grouped action-list"><button data-action="export" aria-label="导出 JSON 备份">${badge("backup", "blue")}<span>导出 JSON 备份<small>${number(state.products.length)} 个规格 · ${number(state.movements.length)} 笔记录</small></span>${icon("chevron")}</button><button data-action="import" aria-label="从 JSON 备份恢复">${badge("receive", "green")}<span>从 JSON 备份恢复<small>确认后覆盖本机商品、库存与记录</small></span>${icon("chevron")}</button></div><input type="file" id="backup-file" accept=".json,application/json" hidden><h2 class="date-heading">存储与离线</h2><div class="grouped info-list"><details><summary>${badge("device", "blue")}<span>本机存储说明</span>${icon("chevron")}</summary><div class="info-body"><p>数据仅属于当前设备、浏览器和来源地址，不同设备不会自动同步。清理网站数据、删除 PWA、无痕模式结束、改变来源 URL 或系统清理存储可能造成数据丢失。</p><p>请定期把 JSON 备份保存到「文件」等安全位置。备份包含进价，请妥善保管；更换设备前先备份，再在新设备恢复。</p></div></details><details><summary>${badge("plus", "purple")}<span>添加到主屏幕与离线</span>${icon("chevron")}</summary><div class="info-body"><p>使用 iPhone 或 iPad 的 Safari 打开本应用，轻点「分享」→「添加到主屏幕」。首次联网打开，等待显示「离线可用」，即可离线打开和登记。</p><p id="settings-offline"></p></div></details><div class="info-row">${badge("shirt", "purple")}<span>衣记<small>V1.1 · 本机服装进销存</small></span></div></div><p class="section-foot">无需账号，数据不会上传到云端。</p>`;
  $("#backup-file").addEventListener("change", previewRestore);
  $("#settings-offline").textContent = $("#offline-status").textContent;
}
function currentRoute() {
  return state.view === "detail" ? `style/${state.detailId}` : state.view;
}
function render() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active =
      button.dataset.view ===
      (state.view === "detail" ? "inventory" : state.view);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#sidebar-stock").textContent = number(sum(state.products));
  $("#back-button").hidden = state.view !== "detail";
  if (state.view === "inventory") renderInventory();
  else if (state.view === "detail") renderDetail();
  else if (state.view === "receive") renderEntry("in");
  else if (state.view === "sell") renderEntry("out");
  else if (state.view === "history") renderHistory();
  else renderSettings();
  document.title = `${{ inventory: "库存", detail: "款式详情", receive: "进货", sell: "销售", history: "记录", settings: "设置" }[state.view]} · 衣记`;
}
async function refresh() {
  [state.products, state.movements] = await Promise.all([
    listProducts(),
    listMovements(),
  ]);
}
function rememberView() {
  state.scroll[currentRoute()] = window.scrollY;
  const form = $("#entry-form");
  if (form) state.drafts[state.view] = Object.fromEntries(new FormData(form));
}
function closeMenu() {
  document.body.classList.remove("menu-open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}
async function navigate(view, focus = true, fromHash = false) {
  if (busy) return;
  rememberView();
  main.setAttribute("aria-busy", "true");
  try {
    await refresh();
    state.view = view.startsWith("style/") ? "detail" : view;
    if (state.view === "detail") state.detailId = view.slice(6);
    const hash = `#${currentRoute()}`;
    if (!fromHash && location.hash !== hash) history.pushState(null, "", hash);
    closeMenu();
    render();
    window.scrollTo(0, state.scroll[currentRoute()] || 0);
    if (focus) main.focus({ preventScroll: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    main.setAttribute("aria-busy", "false");
  }
}
function openSheet(content) {
  sheetOpener = document.activeElement;
  sheet.innerHTML = content;
  sheet.showModal();
}
function closeSheet() {
  if (busy) return;
  sheet.close();
  sheet.innerHTML = "";
  restoreCandidate = undefined;
  if (sheetOpener?.isConnected) sheetOpener.focus();
}
function sheetHeader(title) {
  return `<div class="sheet-header"><h2 id="sheet-title">${title}</h2><button type="button" class="icon-button" data-action="close" aria-label="关闭">${icon("close")}</button></div>`;
}
function productEditor(product, template) {
  const fields = product || {
    name: template?.name || "",
    sku: template?.sku || "",
    color: "",
    size: "",
    costCents: template?.costCents || 0,
    priceCents: template?.priceCents || 0,
  };
  openSheet(
    sheetHeader(product ? "编辑商品" : "添加商品") +
      `<form id="product-form" class="sheet-body"><div class="grouped form-group"><label class="field">商品名称<input name="name" value="${escape(fields.name)}" maxlength="100" placeholder="请输入商品名称" required autocomplete="off"></label><label class="field">货号<input name="sku" value="${escape(fields.sku)}" maxlength="60" placeholder="请输入货号" required autocapitalize="off" autocomplete="off"></label><label class="field">颜色<input name="color" value="${escape(fields.color)}" maxlength="40" placeholder="例如：燕麦色" required></label><label class="field">尺码<input name="size" value="${escape(fields.size)}" maxlength="40" placeholder="例如：M / 2XL / 均码" required></label></div><div class="grouped form-group"><label class="field">进价<input name="cost" type="text" inputmode="decimal" maxlength="12" value="${product || template ? (fields.costCents / 100).toFixed(2) : ""}" placeholder="¥ 元 / 件" required></label><label class="field">售价<input name="price" type="text" inputmode="decimal" maxlength="12" value="${product || template ? (fields.priceCents / 100).toFixed(2) : ""}" placeholder="¥ 元 / 件" required></label></div><p class="help-note">每次保存一个颜色、尺码规格。${product ? "编辑保留原库存和历史记录。" : "新增库存为 0，保存后可登记进货。"}</p><p class="form-error" role="alert" tabindex="-1" hidden></p><div class="sheet-actions"><button class="button quiet" type="button" data-action="close">取消</button><button class="button" type="submit">保存商品</button></div></form>`,
  );
  $("#product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    busy = true;
    form.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      const data = new FormData(form);
      const saved = await saveProduct({
        ...(product ? { id: product.id } : {}),
        name: data.get("name"),
        sku: data.get("sku"),
        color: data.get("color"),
        size: data.get("size"),
        costCents: moneyToCents(data.get("cost")),
        priceCents: moneyToCents(data.get("price")),
      });
      state.products = [
        saved,
        ...state.products.filter((p) => p.id !== saved.id),
      ];
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }
      channel?.postMessage("changed");
      busy = false;
      closeSheet();
      if (state.view === "detail") state.detailId = saved.id;
      rememberView();
      render();
      toast(
        (product ? "商品已更新" : "商品已添加，可以登记进货了") +
          (refreshed ? "" : "。列表刷新失败，请重新打开应用"),
      );
    } catch (error) {
      errorIn(form, error);
    } finally {
      busy = false;
      form.querySelectorAll("button").forEach((button) => {
        button.disabled = false;
      });
    }
  });
}
async function downloadBackup() {
  if (busy) return;
  busy = true;
  try {
    const backup = await exportBackup();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `衣记备份-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("备份文件已生成，请在「文件」中确认保存");
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
  }
}
async function previewRestore(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || busy) return;
  try {
    restoreCandidate = validateBackup(await file.text());
    const backup = restoreCandidate;
    openSheet(
      sheetHeader("确认恢复备份") +
        `<div class="sheet-body"><p>备份时间：${fullDate(backup.exportedAt)}<br>包含 ${number(backup.products.length)} 个商品规格、${number(backup.movements.length)} 笔进销记录。</p><p class="restore-warning">恢复将覆盖本机现有的 ${number(state.products.length)} 个商品规格和 ${number(state.movements.length)} 笔记录。此操作不能撤销，请先导出当前数据备份。</p><p class="form-error" role="alert" tabindex="-1" hidden></p><div class="sheet-actions"><button class="button quiet" data-action="close">取消</button><button class="button danger" data-action="restore">确认覆盖并恢复</button></div></div>`,
    );
  } catch (error) {
    restoreCandidate = undefined;
    toast(error.message, true);
  }
}
async function confirmRestore() {
  if (busy || !restoreCandidate) return;
  busy = true;
  sheet.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  try {
    await restoreBackup(restoreCandidate);
    state.products = restoreCandidate.products;
    state.movements = [...restoreCandidate.movements].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    let refreshed = true;
    try {
      await refresh();
    } catch {
      refreshed = false;
    }
    channel?.postMessage("changed");
    busy = false;
    closeSheet();
    render();
    toast(
      "备份已恢复，库存与记录已更新" +
        (refreshed ? "" : "。列表刷新失败，请重新打开应用"),
    );
  } catch (error) {
    errorIn(sheet, error);
  } finally {
    busy = false;
    sheet.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
  }
}
document.addEventListener("click", (event) => {
  const style = event.target.closest("[data-style]");
  if (style) {
    navigate(`style/${style.dataset.style}`);
    return;
  }
  const entry = event.target.closest("[data-entry]");
  if (entry) {
    state.entryPreset = entry.dataset.product;
    delete state.drafts[entry.dataset.entry];
    navigate(entry.dataset.entry);
    return;
  }
  const nav = event.target.closest("[data-view]");
  if (nav) {
    navigate(nav.dataset.view);
    return;
  }
  const edit = event.target.closest("[data-edit]");
  if (edit && !busy) {
    const product = state.products.find((p) => p.id === edit.dataset.edit);
    if (product) productEditor(product);
    return;
  }
  const stock = event.target.closest("[data-stock]");
  if (stock) {
    state.stockFilter = stock.dataset.stock;
    $("#stock-filter-toggle").innerHTML =
      `${state.stockFilter === "all" ? "全部规格" : state.stockFilter === "available" ? "有库存规格" : "暂无库存规格"}${icon("chevron")}`;
    document.querySelectorAll("[data-stock]").forEach((button) => {
      const active = button === stock;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderProductList();
    return;
  }
  const historyButton = event.target.closest("[data-history]");
  if (historyButton) {
    state.historyFilter = historyButton.dataset.history;
    state.historyLimit = 100;
    renderHistory();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "add-variant") {
    productEditor(null, detailProducts()[0]);
    return;
  }
  if (action === "more-history") {
    state.historyLimit += 100;
    renderHistoryResults();
    return;
  }
  if (action === "style-history") {
    state.historyQuery = detailProducts()[0]?.sku || "";
    state.historyFilter = "all";
    navigate("history");
    return;
  }
  if (action === "close") closeSheet();
  else if (action === "add" && !busy) productEditor();
  else if (action === "export") downloadBackup();
  else if (action === "import" && !busy) $("#backup-file").click();
  else if (action === "restore") confirmRestore();
});
sheet.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSheet();
});
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1) || "inventory";
  if (validRoute(view)) navigate(view, true, true);
});
function validRoute(view) {
  return (
    ["inventory", "receive", "sell", "history", "settings"].includes(view) ||
    /^style\/[a-zA-Z0-9_-]{1,128}$/.test(view)
  );
}
$("#back-button").addEventListener("click", () => navigate("inventory"));
$("#menu-toggle").addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});
$("#sidebar-toggle").addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebar-toggle").setAttribute(
    "aria-label",
    collapsed ? "展开侧边栏" : "收起侧边栏",
  );
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("menu-open")) {
    closeMenu();
    $("#menu-toggle").focus();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#sidebar,#menu-toggle")) closeMenu();
});
// Refresh lists across tabs without discarding an entry form or an open sheet.
async function externalRefresh() {
  if (busy || sheet.open) return;
  try {
    await refresh();
    if (
      ["inventory", "detail", "history", "settings"].includes(state.view) ||
      !$("#entry-form") ||
      !state.products.length
    )
      render();
    else {
      updateOptions($("#entry-form"));
      updateEntrySummary(state.view === "receive" ? "in" : "out");
    }
  } catch {
    /* Existing form remains usable; writes report database errors. */
  }
}
channel?.addEventListener("message", externalRefresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) externalRefresh();
});
async function setupOffline() {
  const node = $("#offline-status");
  const setStatus = (ready, text) => {
    node.classList.toggle("ready", ready);
    node.lastElementChild.textContent = text;
    if ($("#settings-offline")) $("#settings-offline").textContent = text;
  };
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    setStatus(false, "离线缓存不可用");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register(
      new URL("../sw.js", import.meta.url),
      { scope: new URL("../", import.meta.url).pathname },
    );
    const update = () => {
      if (registration.waiting && registration.active) {
        waitingWorker = registration.waiting;
        $("#update-banner").hidden = false;
      }
    };
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        update();
        if (worker.state === "redundant" && !registration.active)
          setStatus(false, "离线缓存失败，请联网重开");
      });
    });
    update();
    await navigator.serviceWorker.ready;
    setStatus(true, navigator.onLine ? "离线可用" : "离线使用中");
    window.addEventListener("online", () => setStatus(true, "离线可用"));
    window.addEventListener("offline", () => setStatus(true, "离线使用中"));
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updating) location.reload();
    });
  } catch {
    setStatus(false, "离线缓存失败，请联网重开");
  }
}
$("#update-app").addEventListener("click", () => {
  if (busy) return;
  if (
    (sheet.open || $("#entry-form")) &&
    !confirm("更新将重新打开应用，未提交的内容会丢失。确认更新？")
  )
    return;
  updating = true;
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
});
hydrateIcons();
try {
  await openDB();
  const view = location.hash.slice(1);
  if (validRoute(view)) {
    state.view = view.startsWith("style/") ? "detail" : view;
    if (state.view === "detail") state.detailId = view.slice(6);
  }
  await refresh();
  render();
} catch (error) {
  main.innerHTML =
    pageTop("账本暂时无法打开", escape(error.message)) +
    empty(
      "请检查浏览器存储",
      "请使用正常浏览模式，并确认设备有可用存储空间，然后刷新重试。",
    );
}
setupOffline();
