import { openDB, listProducts, listMovements, saveProduct, receiveStock, sellStock, exportBackup, validateBackup, restoreBackup, moneyToCents, formatMoney } from './db.js';

const $ = (selector, node = document) => node.querySelector(selector);
const main = $('#main');
const sheet = $('#sheet');
const state = { view: 'inventory', products: [], movements: [], query: '', stockFilter: 'all', historyFilter: 'all' };
let busy = false;
let toastTimer;
let restoreCandidate;
let waitingWorker;
let updating = false;
let sheetOpener;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('yiji-data') : null;
const paths = {
  hanger: 'M10 7a2 2 0 1 1 3 1.7L12 10v2L3 17a1.5 1.5 0 0 0 .7 2.8h16.6A1.5 1.5 0 0 0 21 17l-9-5',
  inventory: 'M3 7l9-4 9 4v13H3V7zm0 0h18M8 11h8v5H8z',
  receive: 'M4 10v10h16V10M3 10h18M12 3v11m-4-4 4 4 4-4',
  sell: 'M4 10v10h16V10M3 10h18M12 14V3m-4 4 4-4 4 4',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 3v5h5m4-1v6l4 2',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6',
  plus: 'M12 5v14M5 12h14', search: 'M21 21l-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  close: 'M6 6l12 12M6 18 18 6', edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6z',
  shirt: 'm8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0',
  layers: 'm12 3 10 5-10 5L2 8l10-5zm-10 9 10 5 10-5M2 17l10 5 10-5',
  check: 'm5 12 4 4L19 6', shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4zm-4 10 3 3 5-6',
  backup: 'M12 16V3m-4 4 4-4 4 4M4 15v6h16v-6', device: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm3 17h2',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.inventory}"/></svg>`; }
function hydrateIcons(node = document) { node.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function escape(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function number(value) { return value.toLocaleString('zh-CN'); }
function date(value) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
function fullDate(value) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
function toast(text, error = false) {
  const node = $('#toast'); clearTimeout(toastTimer); node.textContent = text; node.classList.toggle('error', error); node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6500 : 3500);
}
function errorIn(form, error) { const node = $('.form-error', form); node.textContent = error.message || '操作失败，请重试。'; node.hidden = false; node.focus(); }
function pageTop(title, description, extra = '', eyebrow = '小店的每一件，都有记录') {
  return `<div class="page-top"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-description">${description}</p></div>${extra}</div>`;
}
function empty(title, description, action = '', glyph = 'hanger') {
  return `<div class="empty"><span class="empty-icon">${icon(glyph)}</span><h2>${title}</h2><p>${description}</p>${action}</div>`;
}
function addButton() { return `<button class="button" data-action="add">${icon('plus')}添加商品</button>`; }
function renderInventory() {
  const total = state.products.reduce((sum, p) => sum + p.stock, 0);
  const zero = state.products.filter(p => p.stock === 0).length;
  main.innerHTML = pageTop('我的库存', '从一件衣服开始，把小店打理得井井有条。', addButton()) +
    `<div class="stats"><div class="stat"><div><p class="stat-label">在库总数</p><p class="stat-value">${number(total)}<span>件</span></p></div><span class="stat-icon">${icon('inventory')}</span></div><div class="stat"><div><p class="stat-label">商品规格</p><p class="stat-value">${number(state.products.length)}<span>种</span></p></div><span class="stat-icon">${icon('layers')}</span></div><div class="stat"><div><p class="stat-label">暂无库存</p><p class="stat-value">${number(zero)}<span>种</span></p></div><span class="stat-icon">${icon('hanger')}</span></div></div>
    <div class="toolbar"><label class="search">${icon('search')}<input type="search" id="inventory-search" aria-label="搜索商品" placeholder="搜索名称、货号、颜色或尺码" value="${escape(state.query)}"></label><div class="segmented" aria-label="库存筛选"><button data-stock="all" class="${state.stockFilter === 'all' ? 'active' : ''}" aria-pressed="${state.stockFilter === 'all'}">全部</button><button data-stock="available" class="${state.stockFilter === 'available' ? 'active' : ''}" aria-pressed="${state.stockFilter === 'available'}">有库存</button><button data-stock="zero" class="${state.stockFilter === 'zero' ? 'active' : ''}" aria-pressed="${state.stockFilter === 'zero'}">暂无库存</button></div></div><div id="inventory-results"></div><p class="local-note">${icon('shield')}数据保存在这台设备，记得定期导出备份</p>`;
  renderProductList();
  $('#inventory-search').addEventListener('input', event => { state.query = event.target.value; renderProductList(); });
}
function renderProductList() {
  const query = state.query.trim().toLocaleLowerCase();
  const filtered = state.products.filter(p => `${p.name} ${p.sku} ${p.color} ${p.size}`.toLocaleLowerCase().includes(query) &&
    (state.stockFilter === 'all' || (state.stockFilter === 'available' ? p.stock > 0 : p.stock === 0)));
  const groups = new Map();
  for (const product of filtered) { const key = JSON.stringify([product.sku, product.name]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(product); }
  const target = $('#inventory-results');
  if (!state.products.length) { target.innerHTML = empty('小店的第一件商品', '先添加商品和规格，再登记进货。库存会随着每一笔进货、销售自动更新。', addButton()); return; }
  if (!filtered.length) { target.innerHTML = empty('没有找到商品', '试试其他关键词，或切换库存筛选。', '', 'search'); return; }
  target.innerHTML = `<div class="list-caption"><span>商品清单</span><span>${number(filtered.length)} 个规格 · ${number(groups.size)} 款</span></div><div class="product-grid">${[...groups.values()].map(products => `<article class="product-card"><div class="product-head"><span class="product-avatar">${icon('shirt')}</span><div class="product-heading"><h3>${escape(products[0].name)}</h3><p class="sku">货号 ${escape(products[0].sku)}</p></div><div class="group-stock">${number(products.reduce((sum, p) => sum + p.stock, 0))}<small>在库 / 件</small></div></div>${products.map(p => `<div class="variant-row"><div class="variant-main"><p class="variant-name">${escape(p.color)}<span class="size-tag">${escape(p.size)}</span></p><p class="variant-price">进价 ${formatMoney(p.costCents)} · 售价 ${formatMoney(p.priceCents)}</p></div><span class="stock-badge ${p.stock === 0 ? 'zero' : ''}">${p.stock === 0 ? '暂无库存' : `${number(p.stock)} 件`}</span><button class="icon-button" data-edit="${p.id}" aria-label="编辑 ${escape(p.name)} ${escape(p.color)} ${escape(p.size)}">${icon('edit')}</button></div>`).join('')}</article>`).join('')}</div>`;
}
function renderEntry(type) {
  const incoming = type === 'in';
  main.innerHTML = pageTop(incoming ? '进货登记' : '销售登记', incoming ? '新货入店，记录每一件的到来。' : '记录每一笔成交，库存自动扣减。', '', incoming ? '让库存清清楚楚' : '让每一笔都有迹可循');
  if (!state.products.length) { main.innerHTML += empty('先添加一件商品吧', '有了商品和规格，就可以开始登记进货与销售。', addButton()); return; }
  main.innerHTML += `<div class="entry-layout"><form id="entry-form" class="panel"><h2>${incoming ? '本次进货' : '本次销售'}</h2><label class="field">商品规格<select name="productId" required><option value="">请选择商品及颜色、尺码</option>${state.products.map(p => `<option value="${p.id}">${escape(p.name)} · ${escape(p.sku)} · ${escape(p.color)} / ${escape(p.size)}（${p.stock} 件）</option>`).join('')}</select></label><label class="field">数量<input name="quantity" type="number" inputmode="numeric" min="1" max="999999" step="1" placeholder="填写${incoming ? '进货' : '销售'}件数" required><small>请填写大于 0 的整数</small></label>${incoming ? '' : `<label class="field">实际售价<span><input name="price" type="text" inputmode="decimal" maxlength="12" placeholder="每件售价，单位：元" required></span><small>自动带入商品售价，可按本次成交价修改</small></label>`}<p class="form-error" role="alert" tabindex="-1" hidden></p><button class="button full" type="submit">${icon(incoming ? 'receive' : 'sell')}${incoming ? '确认进货' : '确认销售'}</button></form><aside><div class="entry-summary" id="entry-summary"></div><p class="help-note">${incoming ? '进货金额按商品当前进价记录。如进价有变化，请先在库存页编辑商品。' : '提交时会再次核对可售库存。库存不足的销售不会保存，也不会扣减库存。'}</p></aside></div>`;
  const form = $('#entry-form');
  $('[name="productId"]', form).addEventListener('change', () => {
    const product = state.products.find(p => p.id === form.elements.productId.value);
    if (!incoming) form.elements.price.value = product ? (product.priceCents / 100).toFixed(2) : '';
    $('.form-error', form).hidden = true; updateEntrySummary(type);
  });
  form.addEventListener('input', () => updateEntrySummary(type));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; const button = $('[type="submit"]', form); button.disabled = true;
    try {
      const payload = { productId: form.elements.productId.value, quantity: Number(form.elements.quantity.value) };
      if (!incoming) payload.priceCents = moneyToCents(form.elements.price.value);
      const result = await (incoming ? receiveStock(payload) : sellStock(payload));
      state.products = state.products.map(p => p.id === result.product.id ? result.product : p);
      state.movements.unshift(result.movement);
      form.reset(); $('.form-error', form).hidden = true;
      channel?.postMessage('changed');
      // A committed entry must never look like a failed write or invite a retry.
      let refreshed = true; try { await refresh(); } catch { refreshed = false; }
      updateOptions(form); updateEntrySummary(type);
      toast(`${incoming ? '进货' : '销售'}已登记，当前库存 ${result.product.stock} 件${refreshed ? '' : '。列表刷新失败，请重新打开应用'}`);
    } catch (error) { errorIn(form, error); }
    finally { busy = false; button.disabled = false; }
  });
  updateEntrySummary(type);
}
function updateOptions(form) {
  if (!form) return;
  const selected = form.elements.productId.value;
  form.elements.productId.innerHTML = '<option value="">请选择商品及颜色、尺码</option>' + state.products.map(p => `<option value="${p.id}">${escape(p.name)} · ${escape(p.sku)} · ${escape(p.color)} / ${escape(p.size)}（${p.stock} 件）</option>`).join('');
  if (state.products.some(p => p.id === selected)) form.elements.productId.value = selected;
  else if (form.elements.price) form.elements.price.value = '';
}
function updateEntrySummary(type) {
  const form = $('#entry-form'); if (!form) return;
  const product = state.products.find(p => p.id === form.elements.productId.value);
  const quantity = Number(form.elements.quantity.value);
  let cents = product?.costCents ?? 0;
  let validPrice = true;
  if (type === 'out') { try { cents = moneyToCents(form.elements.price.value); } catch { validPrice = false; } }
  const validQuantity = Number.isInteger(quantity) && quantity > 0 && quantity <= 999999;
  $('#entry-summary').innerHTML = `${icon(type === 'in' ? 'receive' : 'sell')}<h3>登记预览</h3><div class="summary-row"><span>当前库存</span><strong>${product ? `${number(product.stock)} 件` : '待选商品'}</strong></div><div class="summary-row"><span>${type === 'in' ? '商品进价' : '实际单价'}</span><strong>${product && validPrice ? formatMoney(cents) : '—'}</strong></div><div class="summary-row"><span>登记后库存</span><strong>${product && validQuantity ? `${number(product.stock + (type === 'in' ? quantity : -quantity))} 件${type === 'out' && quantity > product.stock ? ' · 库存不足' : ''}` : '—'}</strong></div><div class="summary-row summary-total"><span>本次${type === 'in' ? '进货' : '销售'}金额</span><strong>${product && validQuantity && validPrice ? formatMoney(cents * quantity) : '—'}</strong></div>`;
}
function renderHistory() {
  const records = state.movements.filter(m => state.historyFilter === 'all' || m.type === state.historyFilter);
  main.innerHTML = pageTop('进销记录', '每一笔进出，都留一份清楚的记录。') + `<div class="toolbar"><div class="segmented" aria-label="记录筛选">${[['all','全部记录'],['in','进货'],['out','销售']].map(([value,label]) => `<button data-history="${value}" class="${state.historyFilter === value ? 'active' : ''}" aria-pressed="${state.historyFilter === value}">${label}</button>`).join('')}</div><span class="section-foot">共 ${number(records.length)} 笔</span></div>`;
  if (!records.length) { main.innerHTML += empty('还没有这类记录', '完成进货或销售登记后，记录就会出现在这里。', '', 'history'); return; }
  main.innerHTML += `<div class="history-list">${records.map(m => `<article class="history-row"><span class="movement-icon ${m.type}">${icon(m.type === 'in' ? 'receive' : 'sell')}</span><div class="history-description"><h3>${escape(m.snapshot.name)} · ${m.type === 'in' ? '进货' : '销售'}</h3><p>${escape(m.snapshot.sku)} · ${escape(m.snapshot.color)} / ${escape(m.snapshot.size)}<br>${fullDate(m.createdAt)} · 单价 ${formatMoney(m.priceCents)}</p></div><div class="history-amount">${m.type === 'in' ? '+' : '−'}${number(m.quantity)} 件<small>${formatMoney(m.totalCents)}</small></div></article>`).join('')}</div><p class="section-foot">记录保留登记时的商品信息与价格，编辑商品不会改写历史。</p>`;
}
function renderSettings() {
  main.innerHTML = pageTop('小店设置', '数据在手边，安心经营每一天。') + `<div class="settings-grid"><section class="settings-card"><span class="settings-icon">${icon('backup')}</span><h2>数据备份</h2><p>导出完整 JSON 备份，保存到「文件」或其他安全位置。恢复会覆盖本机现有商品、库存和全部进销记录。</p><div class="settings-actions"><button class="button" data-action="export">${icon('backup')}导出备份</button><button class="button secondary" data-action="import">从备份恢复</button><input type="file" id="backup-file" accept=".json,application/json" hidden></div><p class="settings-meta">本机已有 ${number(state.products.length)} 个商品规格、${number(state.movements.length)} 笔记录。<br>备份文件包含商品进价，请自行妥善保管。</p></section><section class="settings-card"><span class="settings-icon">${icon('device')}</span><h2>把衣记放到主屏幕</h2><p>在 iPhone 或 iPad 的 Safari 中打开本应用：</p><ol><li>轻点 Safari 的「分享」按钮。</li><li>选择「添加到主屏幕」。</li><li>首次联网打开，等待顶部显示「离线可用」。</li></ol><p class="settings-meta">缓存完成后，即使没有网络，也能打开和登记。</p></section><section class="settings-card wide"><span class="settings-icon">${icon('shield')}</span><h2>只属于这台设备的账本</h2><p>衣记第一版 · 商品、进货、销售、库存与记录均保存在本机浏览器中，无需账号。不同设备、浏览器或访问地址的数据不会自动同步。清理网站数据、无痕模式结束或系统回收存储可能丢失数据，请定期导出备份；更换设备前先导出，再在新设备恢复。</p></section></div>`;
  $('#backup-file').addEventListener('change', previewRestore);
}
function render() {
  document.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === state.view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  if (state.view === 'inventory') renderInventory(); else if (state.view === 'receive') renderEntry('in'); else if (state.view === 'sell') renderEntry('out'); else if (state.view === 'history') renderHistory(); else renderSettings();
  document.title = `${({ inventory: '库存', receive: '进货', sell: '销售', history: '记录', settings: '设置' })[state.view]} · 衣记`;
}
async function refresh() { [state.products, state.movements] = await Promise.all([listProducts(), listMovements()]); }
async function navigate(view, focus = true) {
  if (busy) return;
  try { await refresh(); state.view = view; history.replaceState(null, '', `#${view}`); render(); window.scrollTo(0,0); if (focus) main.focus({ preventScroll: true }); }
  catch (error) { toast(error.message, true); }
}
function openSheet(content) { sheetOpener = document.activeElement; sheet.innerHTML = content; sheet.showModal(); }
function closeSheet() { if (busy) return; sheet.close(); restoreCandidate = undefined; sheetOpener?.focus(); }
function sheetHeader(title) { return `<div class="sheet-header"><h2 id="sheet-title">${title}</h2><button type="button" class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div>`; }
function productEditor(product) {
  const fields = product || { name:'', sku:'', color:'', size:'', costCents:0, priceCents:0 };
  openSheet(sheetHeader(product ? '编辑商品' : '添加商品') + `<form id="product-form" class="sheet-body"><p>每个颜色、尺码单独添加。${product ? '修改后保留当前库存，历史记录保持原样。' : '新商品库存为 0，添加后请登记进货。'}</p><label class="field">商品名称<input name="name" value="${escape(fields.name)}" maxlength="100" placeholder="例如：圆领针织衫" required autocomplete="off"></label><label class="field">货号<input name="sku" value="${escape(fields.sku)}" maxlength="60" placeholder="例如：KN-001" required autocapitalize="off" autocomplete="off"></label><div class="field-row"><label class="field">颜色<input name="color" value="${escape(fields.color)}" maxlength="40" placeholder="例如：燕麦色" required></label><label class="field">尺码<input name="size" value="${escape(fields.size)}" maxlength="40" placeholder="例如：M / 均码" required></label></div><div class="field-row"><label class="field">进价<input name="cost" type="text" inputmode="decimal" maxlength="12" value="${product ? (fields.costCents/100).toFixed(2) : ''}" placeholder="元 / 件" required></label><label class="field">售价<input name="price" type="text" inputmode="decimal" maxlength="12" value="${product ? (fields.priceCents/100).toFixed(2) : ''}" placeholder="元 / 件" required></label></div><p class="form-error" role="alert" tabindex="-1" hidden></p><div class="sheet-actions"><button class="button quiet" type="button" data-action="close">取消</button><button class="button" type="submit">保存商品</button></div></form>`);
  $('#product-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget; busy = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const data = new FormData(form);
      const saved = await saveProduct({ ...(product ? { id:product.id } : {}), name:data.get('name'), sku:data.get('sku'), color:data.get('color'), size:data.get('size'), costCents:moneyToCents(data.get('cost')), priceCents:moneyToCents(data.get('price')) });
      state.products = [saved, ...state.products.filter(p => p.id !== saved.id)];
      let refreshed = true; try { await refresh(); } catch { refreshed = false; }
      channel?.postMessage('changed'); busy = false; closeSheet(); render(); toast((product ? '商品已更新' : '商品已添加，可以登记进货了') + (refreshed ? '' : '。列表刷新失败，请重新打开应用'));
    } catch (error) { errorIn(form, error); }
    finally { busy = false; form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  });
}
async function downloadBackup() {
  if (busy) return; busy = true;
  try {
    const backup = await exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)], { type:'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `衣记备份-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); toast('备份文件已生成，请在「文件」中确认保存');
  } catch (error) { toast(error.message, true); } finally { busy = false; }
}
async function previewRestore(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || busy) return;
  try {
    restoreCandidate = validateBackup(await file.text());
    const backup = restoreCandidate;
    openSheet(sheetHeader('确认恢复备份') + `<div class="sheet-body"><p>备份时间：${fullDate(backup.exportedAt)}<br>包含 ${number(backup.products.length)} 个商品规格、${number(backup.movements.length)} 笔进销记录。</p><p class="restore-warning">恢复将覆盖本机现有的 ${number(state.products.length)} 个商品规格和 ${number(state.movements.length)} 笔记录。此操作不能撤销，请先导出当前数据备份。</p><p class="form-error" role="alert" tabindex="-1" hidden></p><div class="sheet-actions"><button class="button quiet" data-action="close">取消</button><button class="button danger" data-action="restore">确认覆盖并恢复</button></div></div>`);
  } catch (error) { restoreCandidate = undefined; toast(error.message, true); }
}
async function confirmRestore() {
  if (busy || !restoreCandidate) return; busy = true; sheet.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    await restoreBackup(restoreCandidate);
    state.products = restoreCandidate.products; state.movements = [...restoreCandidate.movements].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    let refreshed = true; try { await refresh(); } catch { refreshed = false; }
    channel?.postMessage('changed'); busy = false; closeSheet(); render(); toast('备份已恢复，库存与记录已更新' + (refreshed ? '' : '。列表刷新失败，请重新打开应用'));
  } catch (error) { errorIn(sheet,error); } finally { busy = false; sheet.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
document.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]'); if (nav) { navigate(nav.dataset.view); return; }
  const edit = event.target.closest('[data-edit]'); if (edit && !busy) { const product = state.products.find(p => p.id === edit.dataset.edit); if (product) productEditor(product); return; }
  const stock = event.target.closest('[data-stock]'); if (stock) { state.stockFilter = stock.dataset.stock; document.querySelectorAll('[data-stock]').forEach(button => { const active = button === stock; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); renderProductList(); return; }
  const historyButton = event.target.closest('[data-history]'); if (historyButton) { state.historyFilter = historyButton.dataset.history; renderHistory(); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') closeSheet(); else if (action === 'add' && !busy) productEditor(); else if (action === 'export') downloadBackup(); else if (action === 'import' && !busy) $('#backup-file').click(); else if (action === 'restore') confirmRestore();
});
sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (['inventory','receive','sell','history','settings'].includes(view)) navigate(view); });
// Refresh lists across tabs without discarding an entry form or an open sheet.
async function externalRefresh() {
  if (busy || sheet.open) return;
  try { await refresh(); if (['inventory','history','settings'].includes(state.view) || !$('#entry-form') || !state.products.length) render(); else { updateOptions($('#entry-form')); updateEntrySummary(state.view === 'receive' ? 'in' : 'out'); } } catch { /* Existing form remains usable; writes report database errors. */ }
}
channel?.addEventListener('message', externalRefresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) externalRefresh(); });
async function setupOffline() {
  const node = $('#offline-status');
  const setStatus = (ready, text) => { node.classList.toggle('ready', ready); node.lastElementChild.textContent = text; };
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { setStatus(false,'离线缓存不可用'); return; }
  try {
    const registration = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
    const update = () => { if (registration.waiting && registration.active) { waitingWorker = registration.waiting; $('#update-banner').hidden = false; } };
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        update();
        if (worker.state === 'redundant' && !registration.active) setStatus(false,'离线缓存失败，请联网重开');
      });
    }); update();
    await navigator.serviceWorker.ready; setStatus(true,navigator.onLine ? '离线可用' : '离线使用中');
    window.addEventListener('online', () => setStatus(true,'离线可用')); window.addEventListener('offline', () => setStatus(true,'离线使用中'));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
  } catch { setStatus(false,'离线缓存失败，请联网重开'); }
}
$('#update-app').addEventListener('click', () => {
  if (busy) return;
  if ((sheet.open || $('#entry-form')) && !confirm('更新将重新打开应用，未提交的内容会丢失。确认更新？')) return;
  updating = true; waitingWorker?.postMessage({ type:'SKIP_WAITING' });
});
hydrateIcons();
try { await openDB(); const view = location.hash.slice(1); if (['inventory','receive','sell','history','settings'].includes(view)) state.view = view; await refresh(); render(); }
catch (error) { main.innerHTML = pageTop('账本暂时无法打开', escape(error.message)) + empty('请检查浏览器存储', '请使用正常浏览模式，并确认设备有可用存储空间，然后刷新重试。'); }
setupOffline();
