import assert from "node:assert/strict";
import { after, before, test as nodeTest } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHTTPServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Use the declared dev dependency in CI; the managed workspace also provides it.
let playwright;
try {
  playwright = await import("playwright");
} catch (error) {
  const provided = "/opt/codex/cua_node/lib/node_modules/playwright/index.mjs";
  if (!existsSync(provided)) throw error;
  playwright = await import(provided);
}

const engine = process.env.TEST_BROWSER || "chromium";
if (!["chromium", "webkit"].includes(engine))
  throw new Error("Unsupported TEST_BROWSER");
let browser;
let server;
let baseURL;
let serverOutput = "";
const test = (name, run) => nodeTest(name, { timeout: 45000 }, run);

before(async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  baseURL = `http://127.0.0.1:${port}/clothing-inventory-pwa/`;
  server = spawn(
    process.execPath,
    ["scripts/serve.mjs", "--port", String(port)],
    {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server has not bound its port yet. */
    }
    if (server.exitCode !== null) break;
    await delay(50);
  }
  assert.ok(ready, `Static server did not start: ${serverOutput}`);
  browser = await playwright[engine].launch({
    ...(engine === "chromium" && existsSync("/usr/bin/chromium")
      ? { executablePath: "/usr/bin/chromium" }
      : {}),
    headless: true,
    args: engine === "chromium" ? ["--no-sandbox"] : [],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function withStore(run, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const messages = [];
  page.on("console", (entry) =>
    messages.push({ type: entry.type(), text: entry.text() }),
  );
  page.on("pageerror", (error) =>
    messages.push({ type: "pageerror", text: error.stack || error.message }),
  );
  await page.addInitScript(() => {
    window.testFormEvents = [];
    for (const type of ["submit", "invalid"])
      document.addEventListener(
        type,
        (event) => {
          const form = event.target.form || event.target;
          window.testFormEvents.push({
            type,
            target: event.target.name || event.target.id,
            values:
              form instanceof HTMLFormElement
                ? Object.fromEntries(new FormData(form))
                : null,
          });
        },
        true,
      );
  });
  try {
    await page.goto(baseURL);
    await page.evaluate(async () => {
      await (await import("./js/db.js")).openDB();
    });
    await run(page, context);
    assert.deepEqual(
      messages.filter((entry) => entry.type === "pageerror"),
      [],
      "No uncaught browser errors",
    );
  } catch (error) {
    // Keep browser state from CI failures without hiding the original assertion.
    try {
      await mkdir("test-results", { recursive: true });
      const stem = `test-results/failure-${Date.now()}`;
      const state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        events: window.testFormEvents,
        fields: [...document.querySelectorAll("input,select")].map((input) => ({
          name: input.name,
          value: input.value,
          valid: input.validity.valid,
          validationMessage: input.validationMessage,
          disabled: input.disabled,
        })),
        buttons: [...document.querySelectorAll("button")].map((button) => ({
          text: button.textContent.trim(),
          disabled: button.disabled,
        })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(
          (alert) => ({ text: alert.textContent, hidden: alert.hidden }),
        ),
        toast: document.querySelector("#toast")?.textContent,
      }));
      await writeFile(
        `${stem}.json`,
        JSON.stringify(
          { error: error.stack || String(error), messages, state },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: `${stem}.png`,
        fullPage: true,
        timeout: 5000,
      });
      console.error(`Browser failure details: ${stem}.json and ${stem}.png`);
    } catch (diagnosticError) {
      console.error(
        "Could not capture browser failure:",
        diagnosticError.message,
      );
    }
    throw error;
  } finally {
    await context.close();
  }
}

// Fail real HTTP transport instead of using the browser inspector's offline flag.
// Both engines must reopen from their existing Service Worker with no server data.
async function withOfflineStore(run) {
  let disconnected = false;
  const root = new URL("../", import.meta.url);
  const allowed = new Set([
    "index.html",
    "styles.css",
    "sw.js",
    "manifest.webmanifest",
    "js/app.js",
    "js/db.js",
    "icons/icon.svg",
    "icons/icon-180.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
  ]);
  const host = createHTTPServer(async (req, res) => {
    if (disconnected) {
      req.socket.destroy();
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path.startsWith("/clothing-inventory-pwa/")
      ? path.slice("/clothing-inventory-pwa/".length) || "index.html"
      : "";
    if (!allowed.has(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".png")
          ? "image/png"
          : file.endsWith(".webmanifest")
            ? "application/manifest+json"
            : "text/html";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(await readFile(new URL(file, root)));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const previousURL = baseURL;
  baseURL = `http://127.0.0.1:${host.address().port}/clothing-inventory-pwa/`;
  try {
    await withStore((page, context) =>
      run(page, context, () => {
        disconnected = true;
      }),
    );
  } finally {
    baseURL = previousURL;
    host.closeAllConnections();
    await new Promise((resolve) => host.close(resolve));
  }
}

async function navigateUI(page, view) {
  const button = page.locator(`nav [data-view="${view}"]`);
  if (!(await button.isVisible()))
    await page
      .getByRole("button", { name: "打开导航菜单", exact: true })
      .click();
  await button.click();
  await page.waitForFunction(
    (v) =>
      document.querySelector('nav [aria-current="page"]')?.dataset.view === v &&
      document.querySelector("main").getAttribute("aria-busy") !== "true" &&
      !document.body.classList.contains("menu-open"),
    view,
  );
}
async function selectSpec(page, id) {
  const p = await page.evaluate(
    async (id) =>
      (await (await import("./js/db.js")).listProducts()).find(
        (p) => p.id === id,
      ),
    id,
  );
  await page
    .locator("#entry-form")
    .getByLabel("商品款式", { exact: true })
    .selectOption({ label: `${p.name} · ${p.sku}` });
  await page
    .locator("#entry-form")
    .getByLabel("颜色", { exact: true })
    .selectOption(p.color);
  await page
    .locator("#entry-form")
    .getByLabel("尺码", { exact: true })
    .selectOption(id);
}

async function seed(page, overrides = {}) {
  return page.evaluate(async (extra) => {
    const db = await import("./js/db.js");
    await db.saveProduct({
      name: "验收棉质衬衫",
      sku: "TEST-001",
      color: "米白",
      size: "M",
      costCents: 5500,
      priceCents: 12900,
      ...extra,
    });
    return (await db.listProducts()).find(
      (product) => product.sku === (extra.sku || "TEST-001"),
    );
  }, overrides);
}

test("new products start empty; receiving and selling atomically maintain stock and history", async () => {
  await withStore(async (page) => {
    const initial = await seed(page);
    assert.equal(initial.stock, 0);
    const result = await page.evaluate(async (id) => {
      const db = await import("./js/db.js");
      await db.receiveStock({ productId: id, quantity: 10 });
      await db.sellStock({ productId: id, quantity: 3, priceCents: 11900 });
      return {
        products: await db.listProducts(),
        movements: await db.listMovements(),
      };
    }, initial.id);
    assert.equal(result.products[0].stock, 7);
    assert.equal(result.movements.length, 2);
    const incoming = result.movements.find((item) => item.type === "in");
    const outgoing = result.movements.find((item) => item.type === "out");
    assert.equal(incoming.quantity, 10);
    assert.equal(incoming.priceCents, 5500);
    assert.equal(incoming.totalCents, 55000);
    assert.equal(outgoing.quantity, 3);
    assert.equal(outgoing.priceCents, 11900);
    assert.equal(outgoing.totalCents, 35700);
    assert.equal(outgoing.snapshot.name, "验收棉质衬衫");
    const before = JSON.stringify(result);
    const rejected = await page.evaluate(async (id) => {
      const db = await import("./js/db.js");
      try {
        await db.sellStock({ productId: id, quantity: 8, priceCents: 11900 });
      } catch {
        return true;
      }
      return false;
    }, initial.id);
    assert.equal(rejected, true, "An oversale must reject");
    assert.equal(
      await page.evaluate(async () => {
        const db = await import("./js/db.js");
        return JSON.stringify({
          products: await db.listProducts(),
          movements: await db.listMovements(),
        });
      }),
      before,
      "Rejected transactions must change neither stock nor history",
    );
    await page.evaluate(async (id) => {
      await (
        await import("./js/db.js")
      ).sellStock({ productId: id, quantity: 7, priceCents: 0 });
    }, initial.id);
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock,
      ),
      0,
    );
  });
});

async function waitForEntrySaved(page) {
  await page.waitForFunction(
    () => {
      const form = document.querySelector("#entry-form");
      return (
        form &&
        !form.querySelector('[type="submit"]').disabled &&
        form.elements.quantity.value === "" &&
        form.elements.productId.value === ""
      );
    },
    null,
    { timeout: 10000 },
  );
}

test("invalid quantities, money and duplicate specifications cannot alter data", async () => {
  await withStore(async (page) => {
    const product = await seed(page);
    const result = await page.evaluate(async (item) => {
      const db = await import("./js/db.js");
      const attempts = [
        () => db.receiveStock({ productId: item.id, quantity: 0 }),
        () => db.receiveStock({ productId: item.id, quantity: -1 }),
        () => db.receiveStock({ productId: item.id, quantity: 1.5 }),
        () => db.receiveStock({ productId: item.id, quantity: Number.NaN }),
        () => db.receiveStock({ productId: item.id, quantity: 1000000 }),
        () => db.receiveStock({ productId: "missing", quantity: 1 }),
        () => db.saveProduct({ ...item, id: undefined }),
        () => db.saveProduct({ ...item, priceCents: 1.5 }),
        () => db.saveProduct({ ...item, costCents: -1 }),
        () => db.saveProduct({ ...item, priceCents: Number.POSITIVE_INFINITY }),
        () => db.saveProduct({ ...item, name: "   " }),
      ];
      const rejected = [];
      for (const attempt of attempts) {
        try {
          await attempt();
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      await db.receiveStock({ productId: item.id, quantity: 2 });
      for (const quantity of [0, -1, 0.5, Number.NaN, 1000000]) {
        try {
          await db.sellStock({
            productId: item.id,
            quantity,
            priceCents: 12900,
          });
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      for (const priceCents of [-1, 1.5, Number.NaN, 100000000]) {
        try {
          await db.sellStock({ productId: item.id, quantity: 1, priceCents });
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      return {
        rejected,
        products: await db.listProducts(),
        movements: await db.listMovements(),
      };
    }, product);
    assert.ok(
      result.rejected.every(Boolean),
      `Invalid input accepted: ${JSON.stringify(result.rejected)}`,
    );
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].stock, 2);
    assert.equal(result.movements.length, 1);
  });
});

test("different colors and sizes keep separate inventory, with duplicate edits rejected", async () => {
  await withStore(async (page) => {
    const product = await seed(page);
    const result = await page.evaluate(async (first) => {
      const db = await import("./js/db.js");
      await db.saveProduct({
        ...first,
        id: undefined,
        color: "黑色",
        size: "L",
      });
      const second = (await db.listProducts()).find(
        (item) => item.id !== first.id,
      );
      await db.receiveStock({ productId: first.id, quantity: 5 });
      await db.receiveStock({ productId: second.id, quantity: 2 });
      await db.sellStock({
        productId: first.id,
        quantity: 3,
        priceCents: 12900,
      });
      let duplicateRejected = false;
      try {
        await db.saveProduct({
          ...second,
          color: first.color,
          size: first.size,
        });
      } catch {
        duplicateRejected = true;
      }
      return {
        products: await db.listProducts(),
        duplicateRejected,
        firstId: first.id,
        secondId: second.id,
      };
    }, product);
    assert.equal(result.duplicateRejected, true);
    assert.equal(
      result.products.find((item) => item.id === result.firstId).stock,
      2,
    );
    assert.equal(
      result.products.find((item) => item.id === result.secondId).stock,
      2,
    );
    assert.equal(
      result.products.find((item) => item.id === result.secondId).color,
      "黑色",
    );
  });
});

test("editing a specification preserves stock and immutable historical details", async () => {
  await withStore(async (page) => {
    const product = await seed(page);
    const result = await page.evaluate(async (item) => {
      const db = await import("./js/db.js");
      await db.receiveStock({ productId: item.id, quantity: 4 });
      await db.sellStock({
        productId: item.id,
        quantity: 1,
        priceCents: 10000,
      });
      const before = await db.listMovements();
      await db.saveProduct({
        ...item,
        name: "修改后的商品",
        color: "奶白",
        costCents: 6000,
        priceCents: 13900,
        stock: 999,
      });
      return {
        before,
        after: await db.listMovements(),
        product: (await db.listProducts())[0],
      };
    }, product);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.product.name, "修改后的商品");
    assert.equal(
      result.product.stock,
      3,
      "Product editing must not overwrite stock",
    );
  });
});

test("two tabs cannot oversell the same inventory", async () => {
  await withStore(async (page, context) => {
    const product = await seed(page);
    await page.evaluate(
      async (id) =>
        (await import("./js/db.js")).receiveStock({
          productId: id,
          quantity: 5,
        }),
      product.id,
    );
    const other = await context.newPage();
    await other.goto(baseURL);
    const attempt = (id) =>
      page.evaluate(async (productId) => {
        try {
          await (
            await import("./js/db.js")
          ).sellStock({ productId, quantity: 4, priceCents: 12900 });
          return "fulfilled";
        } catch {
          return "rejected";
        }
      }, id);
    const outcomes = await Promise.all([
      attempt(product.id),
      other.evaluate(async (productId) => {
        try {
          await (
            await import("./js/db.js")
          ).sellStock({ productId, quantity: 4, priceCents: 12900 });
          return "fulfilled";
        } catch {
          return "rejected";
        }
      }, product.id),
    ]);
    assert.deepEqual(outcomes.sort(), ["fulfilled", "rejected"]);
    const snapshot = await page.evaluate(async () => {
      const db = await import("./js/db.js");
      return {
        products: await db.listProducts(),
        movements: await db.listMovements(),
      };
    });
    assert.equal(snapshot.products[0].stock, 1);
    assert.equal(snapshot.movements.length, 2);
  });
});

test("IndexedDB survives refresh and closing/reopening the page", async () => {
  await withStore(async (page, context) => {
    const product = await seed(page);
    await page.evaluate(
      async (id) =>
        (await import("./js/db.js")).receiveStock({
          productId: id,
          quantity: 6,
        }),
      product.id,
    );
    await page.reload();
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock,
      ),
      6,
    );
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(baseURL);
    assert.equal(
      await reopened.evaluate(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock,
      ),
      6,
    );
    assert.equal(
      await reopened.evaluate(
        async () => (await (await import("./js/db.js")).listMovements()).length,
      ),
      1,
    );
  });
});

test("backup round-trip restores exactly; invalid backups never replace current data", async () => {
  await withStore(async (page) => {
    const product = await seed(page);
    const result = await page.evaluate(async (id) => {
      const db = await import("./js/db.js");
      await db.receiveStock({ productId: id, quantity: 8 });
      await db.sellStock({ productId: id, quantity: 2, priceCents: 12888 });
      const backup = await db.exportBackup();
      await db.receiveStock({ productId: id, quantity: 3 });
      await db.saveProduct({
        name: "恢复时应移除的商品",
        sku: "TEST-EXTRA",
        color: "蓝色",
        size: "S",
        costCents: 1000,
        priceCents: 2000,
      });
      await db.restoreBackup(JSON.stringify(backup));
      const restored = await db.exportBackup();
      const stable = (value) =>
        JSON.stringify({
          products: value.products,
          movements: value.movements,
        });
      const malformed = [];
      const modify = (edit) => {
        const copy = structuredClone(backup);
        edit(copy);
        malformed.push(copy);
      };
      modify((copy) => {
        copy.app = "another-app";
      });
      modify((copy) => {
        copy.version = 999;
      });
      modify((copy) => {
        copy.products.push(structuredClone(copy.products[0]));
      });
      modify((copy) => {
        copy.products.push({
          ...copy.products[0],
          id: `${copy.products[0].id}-extra`,
        });
      });
      modify((copy) => {
        copy.products[0].stock += 1;
      });
      modify((copy) => {
        copy.products[0].stock = -1;
      });
      modify((copy) => {
        copy.movements[0].productId = "missing";
      });
      modify((copy) => {
        copy.movements[0].quantity = 1.5;
      });
      modify((copy) => {
        copy.movements[0].totalCents += 1;
      });
      modify((copy) => {
        copy.movements[0].type = "adjustment";
      });
      modify((copy) => {
        copy.movements.push(structuredClone(copy.movements[0]));
      });
      malformed.push("{invalid JSON", null, []);
      const rejected = [];
      const unchanged = [];
      for (const input of malformed) {
        try {
          await db.restoreBackup(input);
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
        unchanged.push(stable(await db.exportBackup()) === stable(restored));
      }
      return { backup, restored, rejected, unchanged };
    }, product.id);
    assert.deepEqual(result.restored.products, result.backup.products);
    assert.deepEqual(result.restored.movements, result.backup.movements);
    assert.ok(
      result.rejected.every(Boolean),
      "All malformed backups must reject",
    );
    assert.ok(
      result.unchanged.every(Boolean),
      "Rejecting a backup must preserve the entire existing database",
    );
  });
});

test("manifest and fully cached app work offline under the GitHub Pages subpath", async () => {
  await withOfflineStore(async (page, context, disconnect) => {
    const response = await page.request.get(
      new URL("manifest.webmanifest", baseURL).href,
    );
    assert.equal(response.status(), 200);
    const manifest = await response.json();
    assert.equal(manifest.start_url, "./");
    assert.equal(manifest.scope, "./");
    assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
    assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      null,
      { timeout: 15000 },
    );
    assert.equal(
      await page.locator("#update-banner").isVisible(),
      false,
      "A first installation must not be presented as an app update",
    );
    const product = await seed(page);
    await page.evaluate(
      async (id) =>
        (await import("./js/db.js")).receiveStock({
          productId: id,
          quantity: 3,
        }),
      product.id,
    );
    disconnect();
    await assert.rejects(fetch(baseURL, { signal: AbortSignal.timeout(2000) }));
    await page.close();
    const offline = await context.newPage();
    await offline.goto(baseURL);
    await offline.waitForSelector("nav");
    const offlineResult = await offline.evaluate(async (id) => {
      const db = await import("./js/db.js");
      await db.sellStock({ productId: id, quantity: 1, priceCents: 12900 });
      return {
        products: await db.listProducts(),
        movements: await db.listMovements(),
      };
    }, product.id);
    assert.equal(offlineResult.products[0].stock, 2);
    assert.equal(offlineResult.movements.length, 2);
    await offline.reload();
    assert.equal(
      await offline.evaluate(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock,
      ),
      2,
    );
  });
});

test("mobile UI completes product, purchase, sale, search, history and confirmed backup restore", async () => {
  await withStore(
    async (page) => {
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "添加商品", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("商品名称", { exact: true })
        .fill("手机验收衬衫 <&>");
      await dialog.getByLabel("货号", { exact: true }).fill("UI-001");
      await dialog.getByLabel("颜色", { exact: true }).fill("米白");
      await dialog.getByLabel("尺码", { exact: true }).fill("M");
      await dialog.getByLabel("进价", { exact: true }).fill("55.29");
      await dialog.getByLabel("售价", { exact: true }).fill("129.00");
      await dialog
        .getByRole("button", { name: "保存商品", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const product = await page.evaluate(
        async () => (await (await import("./js/db.js")).listProducts())[0],
      );
      assert.equal(
        product.costCents,
        5529,
        "Decimal input should be preserved as integer cents",
      );
      assert.equal(
        await page.locator(".product-card h3").textContent(),
        "手机验收衬衫 <&>",
        "Names must render literally",
      );
      const nav = page.locator("nav");
      await navigateUI(page, "receive");
      await selectSpec(page, product.id);
      await page.getByLabel(/^(进货|销售)数量/).fill("10");
      await page.getByRole("button", { name: "确认进货", exact: true }).click();
      await waitForEntrySaved(page);
      await page.waitForFunction(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock === 10,
      );
      await navigateUI(page, "sell");
      await page
        .getByRole("heading", { name: "登记销售", exact: true })
        .waitFor();
      await selectSpec(page, product.id);
      await page.getByLabel(/^(进货|销售)数量/).fill("11");
      await page.getByLabel("实售单价", { exact: true }).fill("119.01");
      await page.getByRole("button", { name: "确认销售", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "库存不足" }).waitFor();
      assert.equal(
        await page.evaluate(
          async () =>
            (await (await import("./js/db.js")).listProducts())[0].stock,
        ),
        10,
      );
      await page.getByLabel(/^(进货|销售)数量/).fill("3");
      await page.getByRole("button", { name: "确认销售", exact: true }).click();
      await waitForEntrySaved(page);
      await page.waitForFunction(
        async () =>
          (await (await import("./js/db.js")).listProducts())[0].stock === 7,
      );
      await navigateUI(page, "inventory");
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      const search = page.getByRole("searchbox", {
        name: "搜索商品",
        exact: true,
      });
      await search.fill("不存在的商品");
      await page
        .getByRole("heading", { name: "没有找到商品", exact: true })
        .waitFor();
      await search.fill("UI-001");
      assert.match(await page.locator(".stock-badge").textContent(), /7\s*件/);
      await page.locator("#toast").waitFor({ state: "hidden" });
      await page.screenshot({ path: "/tmp/yiji-iphone.png", fullPage: true });
      await navigateUI(page, "history");
      await page.locator(".history-row").nth(1).waitFor();
      assert.equal(await page.locator(".history-row").count(), 2);
      assert.ok(
        (await page.locator(".history-list").textContent()).includes("119.01"),
      );
      await navigateUI(page, "settings");
      const downloadReady = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出 JSON 备份", exact: true })
        .click();
      const download = await downloadReady;
      assert.ok(download.suggestedFilename().endsWith(".json"));
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const backup = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(backup.products[0].stock, 7);
      assert.equal(backup.movements.length, 2);
      // Change current state so cancellation and replacement have observable effects.
      await page.evaluate(
        async (id) =>
          (await import("./js/db.js")).receiveStock({
            productId: id,
            quantity: 2,
          }),
        product.id,
      );
      await navigateUI(page, "settings");
      const file = {
        name: "衣记测试备份.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(backup)),
      };
      await page.locator("#backup-file").setInputFiles(file);
      await dialog
        .getByRole("heading", { name: "确认恢复备份", exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(
          async () =>
            (await (await import("./js/db.js")).listProducts())[0].stock,
        ),
        9,
      );
      await page.locator("#backup-file").setInputFiles(file);
      await dialog
        .getByRole("button", { name: "确认覆盖并恢复", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const restored = await page.evaluate(async () =>
        (await import("./js/db.js")).exportBackup(),
      );
      assert.deepEqual(restored.products, backup.products);
      assert.deepEqual(restored.movements, backup.movements);
      await page.locator("#backup-file").setInputFiles({
        name: "损坏.json",
        mimeType: "application/json",
        buffer: Buffer.from("{bad JSON"),
      });
      await page.locator("#toast").filter({ hasText: "JSON" }).waitFor();
      assert.equal(
        await page.evaluate(
          async () =>
            (await (await import("./js/db.js")).listProducts())[0].stock,
        ),
        7,
      );
    },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  );
});

test("a committed sale is reported as saved and cleared even when its following refresh fails", async () => {
  await withStore(async (page) => {
    const product = await seed(page);
    await page.evaluate(
      async (id) =>
        (await import("./js/db.js")).receiveStock({
          productId: id,
          quantity: 10,
        }),
      product.id,
    );
    await navigateUI(page, "sell");
    await selectSpec(page, product.id);
    await page.getByLabel(/^(进货|销售)数量/).fill("3");
    await page.getByLabel("实售单价", { exact: true }).fill("119.00");
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      let committed = false;
      let remainingReadFailures = 2;
      IDBDatabase.prototype.transaction = function (...args) {
        if (committed && args[1] === "readonly" && remainingReadFailures > 0) {
          remainingReadFailures -= 1;
          throw new DOMException(
            "Simulated read failure after a successful commit",
            "InvalidStateError",
          );
        }
        const transaction = original.apply(this, args);
        if (args[1] === "readwrite")
          transaction.addEventListener(
            "complete",
            () => {
              committed = true;
            },
            { once: true },
          );
        return transaction;
      };
      window.restoreTestTransaction = () => {
        IDBDatabase.prototype.transaction = original;
      };
    });
    await page.getByRole("button", { name: "确认销售", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[name="quantity"]').value === "",
      null,
      { timeout: 10000 },
    );
    assert.match(await page.locator("#toast").textContent(), /已登记|已保存/);
    await page.evaluate(() => window.restoreTestTransaction());
    const result = await page.evaluate(async () => {
      const db = await import("./js/db.js");
      return {
        products: await db.listProducts(),
        movements: await db.listMovements(),
      };
    });
    assert.equal(result.products[0].stock, 7);
    assert.equal(
      result.movements.length,
      2,
      "A refresh failure must not create another sale",
    );
  });
});

test("iPhone and iPad portrait/landscape layouts fit without horizontal overflow", async () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
  ]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await page.goto(baseURL);
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      const product = await seed(page);
      const width = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert.ok(
        width.document <= width.viewport + 1,
        `${JSON.stringify(viewport)}: horizontal overflow ${JSON.stringify(width)}`,
      );
      const nav = page.locator("nav");
      await navigateUI(page, "receive");
      await page
        .getByRole("heading", { name: "登记进货", exact: true })
        .waitFor();
      await selectSpec(page, product.id);
      await page.getByLabel(/^(进货|销售)数量/).fill("6");
      const entryWidth = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert.ok(entryWidth.document <= entryWidth.viewport + 1);
      if (viewport.width === 820)
        await page.screenshot({ path: "/tmp/yiji-ipad.png", fullPage: true });
    } finally {
      await context.close();
    }
  }
});

async function visualSeed(page) {
  return page.evaluate(async () => {
    const db = await import("./js/db.js");
    const items = [];
    for (const [name, sku, color, size, quantity] of [
      ["基础短袖 T 恤", "TS001", "黑色", "M", 18],
      ["基础短袖 T 恤", "TS001", "黑色", "L", 8],
      ["基础短袖 T 恤", "TS001", "米白", "均码", 0],
      ["高腰牛仔裤", "JN002", "深蓝", "S", 12],
      ["纯色卫衣", "SW003", "燕麦色", "2XL", 6],
      ["轻薄防晒衫", "JK004", "浅蓝", "L", 10],
    ]) {
      const p = await db.saveProduct({
        name,
        sku,
        color,
        size,
        costCents: 3500,
        priceCents: 6900,
      });
      if (quantity) await db.receiveStock({ productId: p.id, quantity });
      items.push(p);
    }
    await db.sellStock({
      productId: items[0].id,
      quantity: 2,
      priceCents: 6900,
    });
    return items;
  });
}

test("empty ledger has four real zero summaries and all phone menu routes work", async () => {
  await withStore(
    async (page) => {
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      assert.equal(await page.locator(".stat").count(), 4);
      assert.deepEqual(await page.locator(".stat strong").allTextContents(), [
        "0",
        "0",
        "0",
        "0",
      ]);
      assert.equal(await page.locator(".product-card").count(), 0);
      assert.equal(await page.locator("nav").isVisible(), false);
      for (const view of [
        "receive",
        "sell",
        "history",
        "settings",
        "inventory",
      ])
        await navigateUI(page, view);
      const backup = await page.evaluate(async () =>
        (await import("./js/db.js")).exportBackup(),
      );
      assert.equal(backup.products.length, 0);
      assert.equal(backup.movements.length, 0);
      await page
        .getByRole("button", { name: "打开导航菜单", exact: true })
        .click();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("nav").isVisible(), false);
      assert.equal(
        await page
          .getByRole("button", { name: "打开导航菜单", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
    },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  );
});

test("style search and specification filters retain full totals; detail editing keeps IDs and history", async () => {
  await withStore(
    async (page) => {
      const items = await visualSeed(page);
      await page.reload();
      const search = page.getByRole("searchbox", {
        name: "搜索商品",
        exact: true,
      });
      await search.fill("米白");
      assert.equal(await page.locator(".product-card").count(), 1);
      assert.match(await page.locator(".stock-badge").textContent(), /24\s*件/);
      await page.locator("#stock-filter-toggle").click();
      await page.locator('[data-stock="zero"]').click();
      assert.match(await page.locator(".stock-badge").textContent(), /24\s*件/);
      await page.locator('[data-stock="available"]').click();
      await page
        .getByRole("heading", { name: "没有找到商品", exact: true })
        .waitFor();
      await page.locator('[data-stock="all"]').click();
      await page.locator("[data-style]").click();
      await page.locator(".detail-heading").waitFor();
      assert.match(
        await page.locator(".detail-total").textContent(),
        /24\s*件/,
      );
      assert.equal(await page.locator(".spec-row").count(), 3);
      assert.ok(
        (await page.locator(".specifications").allTextContents())
          .join(" ")
          .includes("0 件"),
      );
      const historyBefore = await page.evaluate(async () =>
        (await import("./js/db.js")).listMovements(),
      );
      await page.locator(`[data-edit="${items[0].id}"]`).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("进价", { exact: true }).fill("36.29");
      await dialog.getByLabel("售价", { exact: true }).fill("79");
      await dialog
        .getByRole("button", { name: "保存商品", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const edited = await page.evaluate(
        async (id) =>
          (await (await import("./js/db.js")).listProducts()).find(
            (p) => p.id === id,
          ),
        items[0].id,
      );
      assert.equal(edited.stock, 16);
      assert.equal(edited.costCents, 3629);
      assert.equal(edited.priceCents, 7900);
      assert.deepEqual(
        await page.evaluate(async () =>
          (await import("./js/db.js")).listMovements(),
        ),
        historyBefore,
      );
      await page
        .getByRole("button", { name: "继续添加此款其他规格", exact: true })
        .click();
      assert.equal(
        await dialog.getByLabel("商品名称", { exact: true }).inputValue(),
        "基础短袖 T 恤",
      );
      await dialog.getByLabel("颜色", { exact: true }).fill("燕麦色");
      await dialog.getByLabel("尺码", { exact: true }).fill("3XL");
      await dialog
        .getByRole("button", { name: "保存商品", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.locator(".spec-row").count(), 4);
      assert.match(
        await page.locator(".detail-total").textContent(),
        /24\s*件/,
      );
      await page.locator("#back-button").click();
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      assert.equal(await search.inputValue(), "米白");
    },
    { viewport: { width: 390, height: 844 } },
  );
});

test("cascading selectors use exact specifications and retain unsaved entry across navigation", async () => {
  await withStore(
    async (page) => {
      const items = await visualSeed(page);
      await page.reload();
      await page
        .locator("[data-style]")
        .filter({ hasText: "基础短袖" })
        .click();
      await page.locator(".detail-heading").waitFor();
      await page.locator('[data-entry="sell"]').click();
      await page
        .getByRole("heading", { name: "登记销售", exact: true })
        .waitFor();
      const form = page.locator("#entry-form");
      assert.ok(await form.locator('[name="style"]').inputValue());
      await selectSpec(page, items[0].id);
      await page.getByLabel("销售数量", { exact: true }).fill("2");
      await page.getByLabel("实售单价", { exact: true }).fill("68.29");
      assert.match(await page.locator("#entry-summary").textContent(), /14 件/);
      assert.match(
        await page.locator(".summary-total").textContent(),
        /136.58/,
      );
      await navigateUI(page, "inventory");
      await navigateUI(page, "sell");
      assert.equal(
        await form.locator('[name="productId"]').inputValue(),
        items[0].id,
      );
      assert.equal(
        await page.getByLabel("销售数量", { exact: true }).inputValue(),
        "2",
      );
      assert.equal(
        await page.getByLabel("实售单价", { exact: true }).inputValue(),
        "68.29",
      );
      await form.getByLabel("颜色", { exact: true }).selectOption("米白");
      assert.equal(
        await form.locator('[name="productId"]').inputValue(),
        items[2].id,
      );
      assert.equal(
        await page.getByLabel("实售单价", { exact: true }).inputValue(),
        "69.00",
      );
      await page.getByRole("button", { name: "确认销售", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "库存不足" }).waitFor();
      await selectSpec(page, items[0].id);
      await page.getByLabel("实售单价", { exact: true }).fill("68.29");
      await page
        .getByRole("button", { name: "确认销售", exact: true })
        .dblclick();
      await waitForEntrySaved(page);
      const result = await page.evaluate(async () => {
        const db = await import("./js/db.js");
        return {
          products: await db.listProducts(),
          movements: await db.listMovements(),
        };
      });
      assert.equal(result.products.find((p) => p.id === items[0].id).stock, 14);
      assert.equal(result.products.find((p) => p.id === items[1].id).stock, 8);
      assert.equal(
        result.movements.filter((m) => m.type === "out").length,
        2,
        "Rapid double click saves one additional sale",
      );
      assert.equal(result.movements[0].totalCents, 13658);
    },
    { viewport: { width: 390, height: 844 } },
  );
});

test("today summaries use the device local calendar day, across UTC midnight boundaries", async () => {
  await withStore(
    async (page) => {
      await page.clock.install({ time: new Date("2026-11-08T16:30:00Z") });
      const p = await seed(page);
      await page.evaluate(async (id) => {
        const db = await import("./js/db.js");
        await db.receiveStock({ productId: id, quantity: 10 });
        await db.receiveStock({ productId: id, quantity: 5 });
        await db.sellStock({ productId: id, quantity: 2, priceCents: 100 });
        const backup = await db.exportBackup();
        backup.movements.find((m) => m.quantity === 10).createdAt =
          "2026-11-08T15:59:59.000Z";
        backup.movements.find((m) => m.quantity === 5).createdAt =
          "2026-11-08T16:00:00.000Z";
        await db.restoreBackup(backup);
      }, p.id);
      await page.reload();
      await page.locator(".stat").first().waitFor();
      assert.deepEqual(await page.locator(".stat strong").allTextContents(), [
        "13",
        "0",
        "5",
        "2",
      ]);
    },
    { timezoneId: "Asia/Shanghai" },
  );
});

test("history searches immutable snapshots, filters types and renders records in bounded batches", async () => {
  await withStore(async (page) => {
    const p = await seed(page);
    await page.evaluate(async (id) => {
      const db = await import("./js/db.js");
      for (let i = 0; i < 106; i++)
        await db.receiveStock({ productId: id, quantity: 1 });
      await db.sellStock({ productId: id, quantity: 1, priceCents: 100 });
      const p = (await db.listProducts())[0];
      await db.saveProduct({ ...p, name: "新名字" });
    }, p.id);
    await navigateUI(page, "history");
    assert.equal(await page.locator(".history-row").count(), 100);
    await page
      .getByRole("button", { name: "显示更多记录", exact: true })
      .click();
    assert.equal(await page.locator(".history-row").count(), 107);
    await page.locator('[data-history="out"]').click();
    assert.equal(await page.locator(".history-row").count(), 1);
    await page
      .getByRole("searchbox", { name: "搜索进销记录", exact: true })
      .fill("验收棉质");
    assert.equal(await page.locator(".history-row").count(), 1);
    await page
      .getByRole("searchbox", { name: "搜索进销记录", exact: true })
      .fill("新名字");
    assert.equal(await page.locator(".history-row").count(), 0);
    await page
      .getByRole("searchbox", { name: "搜索进销记录", exact: true })
      .fill("");
    await page.locator('[data-history="all"]').click();
    assert.ok((await page.locator(".date-heading").count()) > 0);
  });
});

test("v1 cached application upgrades only after consent and retains original database and JSON backups", async () => {
  const root = new URL("../", import.meta.url);
  const baseline = "50c9b46dec5b22561c04963aa052c2b50e625830";
  const files = new Set([
    "index.html",
    "styles.css",
    "sw.js",
    "manifest.webmanifest",
    "js/app.js",
    "js/db.js",
    "icons/icon.svg",
    "icons/icon-180.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
  ]);
  const legacyFiles = new Map(
    [...files].map((file) => [
      file,
      execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root }),
    ]),
  );
  let legacy = true;
  let disconnected = false;
  const host = createHTTPServer(async (req, res) => {
    if (disconnected) {
      req.socket.destroy();
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path.startsWith("/clothing-inventory-pwa/")
      ? path.slice("/clothing-inventory-pwa/".length) || "index.html"
      : "";
    if (!files.has(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = legacy
      ? legacyFiles.get(file)
      : await readFile(new URL(file, root));
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".png")
          ? "image/png"
          : file.endsWith(".webmanifest")
            ? "application/manifest+json"
            : "text/html";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${host.address().port}/clothing-inventory-pwa/`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    const product = await seed(page);
    await page.evaluate(async (id) => {
      const db = await import("./js/db.js");
      await db.receiveStock({ productId: id, quantity: 18 });
      await db.sellStock({ productId: id, quantity: 2, priceCents: 11900 });
    }, product.id);
    const before = await page.evaluate(async () =>
      (await import("./js/db.js")).exportBackup(),
    );
    assert.equal(
      await page
        .getByRole("heading", { name: "我的库存", exact: true })
        .count(),
      1,
      "Actual v1 UI must be loaded before upgrade",
    );
    // An old dirty form must survive rejecting the update prompt.
    await page.locator('nav [data-view="sell"]').click();
    await page.locator("#entry-form").waitFor();
    await page.locator('[name="productId"]').selectOption(product.id);
    await page.locator('[name="quantity"]').fill("3");
    legacy = false;
    await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r.update();
    });
    await page.locator("#update-app").waitFor({ state: "visible" });
    page.once("dialog", (d) => d.dismiss());
    await page.locator("#update-app").click();
    assert.equal(await page.locator('[name="quantity"]').inputValue(), "3");
    assert.equal(
      await page
        .getByRole("heading", { name: "销售登记", exact: true })
        .count(),
      1,
    );
    page.once("dialog", (d) => d.accept());
    await page.locator("#update-app").click();
    await page
      .getByRole("heading", { name: "登记销售", exact: true })
      .waitFor();
    const after = await page.evaluate(async () =>
      (await import("./js/db.js")).exportBackup(),
    );
    assert.deepEqual(after.products, before.products);
    assert.deepEqual(after.movements, before.movements);
    assert.equal(
      await page.evaluate(async () => {
        const db = await (await import("./js/db.js")).openDB();
        return db.version;
      }),
      1,
    );
    assert.equal(await page.locator("#update-banner").isVisible(), false);
    const caches = await page.evaluate(() => window.caches.keys());
    assert.ok(caches.some((k) => k.endsWith("-v1.1.1")));
    assert.ok(!caches.some((k) => k.endsWith("-v1")));
    await page.evaluate(async (backup) => {
      const db = await import("./js/db.js");
      db.validateBackup(backup);
      await db.restoreBackup(backup);
    }, before);
    disconnected = true;
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
    await page.close();
    const offline = await context.newPage();
    await offline.goto(url);
    await navigateUI(offline, "receive");
    await selectSpec(offline, product.id);
    await offline.getByLabel("进货数量", { exact: true }).fill("2");
    await offline
      .getByRole("button", { name: "确认进货", exact: true })
      .click();
    await waitForEntrySaved(offline);
    await navigateUI(offline, "sell");
    await selectSpec(offline, product.id);
    await offline.getByLabel("销售数量", { exact: true }).fill("2");
    await offline
      .getByRole("button", { name: "确认销售", exact: true })
      .click();
    await waitForEntrySaved(offline);
    await offline.reload();
    const final = await offline.evaluate(async () =>
      (await import("./js/db.js")).exportBackup(),
    );
    assert.equal(final.products[0].stock, 16);
    assert.equal(final.movements.length, 4);
  } finally {
    await context.close();
    await new Promise((resolve) => host.close(resolve));
  }
});

test("actual phone and iPad page galleries include working forms, history and backup UI", async () => {
  await mkdir("test-results/screenshots", { recursive: true });
  for (const [device, viewport] of [
    ["iphone", { width: 390, height: 844 }],
    ["ipad", { width: 1180, height: 820 }],
  ]) {
    await withStore(
      async (page) => {
        await page
          .getByRole("heading", { name: "库存", exact: true })
          .waitFor();
        const capture = async (name) => {
          await page
            .locator("input:focus,select:focus,button:focus")
            .evaluateAll((nodes) => nodes.forEach((n) => n.blur()));
          await page.screenshot({
            path: `test-results/screenshots/${device}-${name}.png`,
            fullPage: !(await page.getByRole("dialog").isVisible()),
            animations: "disabled",
          });
        };
        await capture("empty");
        const items = await visualSeed(page);
        await page.reload();
        await page.locator(".product-card").first().waitFor();
        await capture("inventory");
        await page
          .locator("[data-style]")
          .filter({ hasText: "基础短袖" })
          .click();
        await page.locator(".detail-heading").waitFor();
        await capture("detail");
        await page
          .getByRole("button", { name: "继续添加此款其他规格", exact: true })
          .click();
        await capture("add");
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "取消", exact: true })
          .click();
        await navigateUI(page, "receive");
        await selectSpec(page, items[0].id);
        await page.getByLabel("进货数量", { exact: true }).fill("20");
        await capture("receive");
        await navigateUI(page, "sell");
        await selectSpec(page, items[0].id);
        await page.getByLabel("销售数量", { exact: true }).fill("2");
        await capture("sell");
        await navigateUI(page, "history");
        await page.locator(".history-row").first().waitFor();
        await capture("history");
        await navigateUI(page, "settings");
        await capture("settings");
        await page.emulateMedia({
          colorScheme: "dark",
          reducedMotion: "reduce",
        });
        await navigateUI(page, "inventory");
        await capture("dark");
      },
      { viewport, hasTouch: true },
    );
  }
});

test("all required viewports, long values and 200% text stay usable without page overflow", async () => {
  const sizes = [
    [320, 812],
    [375, 812],
    [390, 844],
    [430, 932],
    [820, 1180],
    [1180, 820],
    [1024, 768],
  ];
  await withStore(
    async (page) => {
      const items = await visualSeed(page);
      await page.evaluate(async (id) => {
        const db = await import("./js/db.js");
        const p = (await db.listProducts()).find((p) => p.id === id);
        await db.saveProduct({
          ...p,
          name: "长名称服装商品".repeat(12),
          sku: "LONG-".repeat(12),
          color: "燕麦奶白色".repeat(6),
          size: "非标准特别宽松均码".repeat(4),
        });
      }, items[0].id);
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await navigateUI(page, "inventory");
        assert.equal(await page.locator(".stat").count(), 4);
        if (width >= 760)
          assert.equal(await page.locator(".sidebar").isVisible(), true);
        else assert.equal(await page.locator("nav").isVisible(), false);
        await page
          .getByRole("button", { name: "添加商品", exact: true })
          .click();
        await page
          .getByRole("dialog")
          .getByLabel("尺码", { exact: true })
          .fill("均码");
        const save = page
          .getByRole("dialog")
          .getByRole("button", { name: "保存商品", exact: true });
        await save.scrollIntoViewIfNeeded();
        const box = await save.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= height + 1);
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "取消", exact: true })
          .click();
        for (const view of [
          "inventory",
          `style/${items[0].id}`,
          "receive",
          "sell",
          "history",
          "settings",
        ]) {
          if (view.startsWith("style")) {
            await page.locator(`[data-style="${items[0].id}"]`).click();
            await page.locator(".detail-heading").waitFor();
          } else await navigateUI(page, view);
          if (view === "receive" || view === "sell")
            await selectSpec(page, items[0].id);
          const result = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert.ok(
            result.scroll <= result.width + 1,
            `${width}x${height} ${view}: ${JSON.stringify(result)}`,
          );
          const buttons = await page
            .locator("main button:visible")
            .evaluateAll((nodes) =>
              nodes.map((n) => ({
                text: n.textContent.trim(),
                w: n.getBoundingClientRect().width,
                h: n.getBoundingClientRect().height,
              })),
            );
          assert.ok(
            buttons.every((b) => b.w >= 43 && b.h >= 43),
            JSON.stringify(buttons),
          );
        }
      }
      await page.setViewportSize({ width: 320, height: 812 });
      await navigateUI(page, "sell");
      await page.addStyleTag({
        content:
          "html{font-size:200%} main{font-size:200%} main input,main select,main button,main p,main label,main strong,main output{font-size:1em!important}",
      });
      await selectSpec(page, items[0].id);
      await page.getByLabel("销售数量", { exact: true }).fill("2");
      const submit = page.getByRole("button", {
        name: "确认销售",
        exact: true,
      });
      await submit.scrollIntoViewIfNeeded();
      assert.equal(await submit.isVisible(), true);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: "test-results/screenshots/320-large-text.png",
        fullPage: true,
      });
    },
    { viewport: { width: 390, height: 844 } },
  );
});

test("sidebar collapse, browser back and a reduced keyboard viewport preserve reachable controls", async () => {
  await withStore(
    async (page) => {
      const items = await visualSeed(page);
      await page.reload();
      await page.locator(".product-card").first().waitFor();
      await page
        .getByRole("button", { name: "收起侧边栏", exact: true })
        .click();
      assert.equal(await page.locator("nav").isVisible(), false);
      await page
        .getByRole("button", { name: "展开侧边栏", exact: true })
        .click();
      assert.equal(await page.locator("nav").isVisible(), true);
      await page
        .locator("[data-style]")
        .filter({ hasText: "基础短袖" })
        .click();
      await page.locator(".detail-heading").waitFor();
      await page.goBack();
      await page.getByRole("heading", { name: "库存", exact: true }).waitFor();
      await page.setViewportSize({ width: 375, height: 450 });
      await page.getByRole("button", { name: "添加商品", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const bounds = await dialog.boundingBox();
      assert.ok(
        Math.abs(bounds.width - 375) <= 1,
        "Phone sheet spans full width",
      );
      await dialog.getByLabel("售价", { exact: true }).fill("99.01");
      const submit = dialog.getByRole("button", {
        name: "保存商品",
        exact: true,
      });
      await submit.scrollIntoViewIfNeeded();
      const box = await submit.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 450);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(
          async () =>
            (await (await import("./js/db.js")).listProducts()).length,
        ),
        items.length,
        "Cancelled form does not write",
      );
    },
    { viewport: { width: 1180, height: 820 } },
  );
});
