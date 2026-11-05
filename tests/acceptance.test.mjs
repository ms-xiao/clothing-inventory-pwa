import assert from 'node:assert/strict';
import { after, before, test as nodeTest } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Use the declared dev dependency in CI; the managed workspace also provides it.
let playwright;
try {
  playwright = await import('playwright');
} catch (error) {
  const provided = '/opt/codex/cua_node/lib/node_modules/playwright/index.mjs';
  if (!existsSync(provided)) throw error;
  playwright = await import(provided);
}

let browser;
let server;
let baseURL;
let serverOutput = '';
const test = (name, run) => nodeTest(name, { timeout: 45000 }, run);

before(async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  baseURL = `http://127.0.0.1:${port}/clothing-inventory-pwa/`;
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) { ready = true; break; }
    } catch { /* Server has not bound its port yet. */ }
    if (server.exitCode !== null) break;
    await delay(50);
  }
  assert.ok(ready, `Static server did not start: ${serverOutput}`);
  browser = await playwright.chromium.launch({
    ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
    headless: true, args: ['--no-sandbox'],
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function withStore(run, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await page.evaluate(async () => { await (await import('./js/db.js')).openDB(); });
    await run(page, context);
  } finally {
    await context.close();
  }
}

async function seed(page, overrides = {}) {
  return page.evaluate(async (extra) => {
    const db = await import('./js/db.js');
    await db.saveProduct({
      name: '验收棉质衬衫', sku: 'TEST-001', color: '米白', size: 'M',
      costCents: 5500, priceCents: 12900, ...extra,
    });
    return (await db.listProducts()).find(product => product.sku === (extra.sku || 'TEST-001'));
  }, overrides);
}

test('new products start empty; receiving and selling atomically maintain stock and history', async () => {
  await withStore(async page => {
    const initial = await seed(page);
    assert.equal(initial.stock, 0);
    const result = await page.evaluate(async id => {
      const db = await import('./js/db.js');
      await db.receiveStock({ productId: id, quantity: 10 });
      await db.sellStock({ productId: id, quantity: 3, priceCents: 11900 });
      return { products: await db.listProducts(), movements: await db.listMovements() };
    }, initial.id);
    assert.equal(result.products[0].stock, 7);
    assert.equal(result.movements.length, 2);
    const incoming = result.movements.find(item => item.type === 'in');
    const outgoing = result.movements.find(item => item.type === 'out');
    assert.equal(incoming.quantity, 10);
    assert.equal(incoming.priceCents, 5500);
    assert.equal(incoming.totalCents, 55000);
    assert.equal(outgoing.quantity, 3);
    assert.equal(outgoing.priceCents, 11900);
    assert.equal(outgoing.totalCents, 35700);
    assert.equal(outgoing.snapshot.name, '验收棉质衬衫');
    const before = JSON.stringify(result);
    const rejected = await page.evaluate(async id => {
      const db = await import('./js/db.js');
      try { await db.sellStock({ productId: id, quantity: 8, priceCents: 11900 }); }
      catch { return true; }
      return false;
    }, initial.id);
    assert.equal(rejected, true, 'An oversale must reject');
    assert.equal(await page.evaluate(async () => {
      const db = await import('./js/db.js');
      return JSON.stringify({ products: await db.listProducts(), movements: await db.listMovements() });
    }), before, 'Rejected transactions must change neither stock nor history');
    await page.evaluate(async id => {
      await (await import('./js/db.js')).sellStock({ productId: id, quantity: 7, priceCents: 0 });
    }, initial.id);
    assert.equal(await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 0);
  });
});

test('invalid quantities, money and duplicate specifications cannot alter data', async () => {
  await withStore(async page => {
    const product = await seed(page);
    const result = await page.evaluate(async item => {
      const db = await import('./js/db.js');
      const attempts = [
        () => db.receiveStock({ productId: item.id, quantity: 0 }),
        () => db.receiveStock({ productId: item.id, quantity: -1 }),
        () => db.receiveStock({ productId: item.id, quantity: 1.5 }),
        () => db.receiveStock({ productId: item.id, quantity: Number.NaN }),
        () => db.receiveStock({ productId: item.id, quantity: 1000000 }),
        () => db.receiveStock({ productId: 'missing', quantity: 1 }),
        () => db.saveProduct({ ...item, id: undefined }),
        () => db.saveProduct({ ...item, priceCents: 1.5 }),
        () => db.saveProduct({ ...item, costCents: -1 }),
        () => db.saveProduct({ ...item, priceCents: Number.POSITIVE_INFINITY }),
        () => db.saveProduct({ ...item, name: '   ' }),
      ];
      const rejected = [];
      for (const attempt of attempts) {
        try { await attempt(); rejected.push(false); } catch { rejected.push(true); }
      }
      await db.receiveStock({ productId: item.id, quantity: 2 });
      for (const quantity of [0, -1, 0.5, Number.NaN, 1000000]) {
        try {
          await db.sellStock({ productId: item.id, quantity, priceCents: 12900 });
          rejected.push(false);
        } catch { rejected.push(true); }
      }
      for (const priceCents of [-1, 1.5, Number.NaN, 100000000]) {
        try {
          await db.sellStock({ productId: item.id, quantity: 1, priceCents });
          rejected.push(false);
        } catch { rejected.push(true); }
      }
      return { rejected, products: await db.listProducts(), movements: await db.listMovements() };
    }, product);
    assert.ok(result.rejected.every(Boolean), `Invalid input accepted: ${JSON.stringify(result.rejected)}`);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].stock, 2);
    assert.equal(result.movements.length, 1);
  });
});

test('different colors and sizes keep separate inventory, with duplicate edits rejected', async () => {
  await withStore(async page => {
    const product = await seed(page);
    const result = await page.evaluate(async first => {
      const db = await import('./js/db.js');
      await db.saveProduct({ ...first, id: undefined, color: '黑色', size: 'L' });
      const second = (await db.listProducts()).find(item => item.id !== first.id);
      await db.receiveStock({ productId: first.id, quantity: 5 });
      await db.receiveStock({ productId: second.id, quantity: 2 });
      await db.sellStock({ productId: first.id, quantity: 3, priceCents: 12900 });
      let duplicateRejected = false;
      try { await db.saveProduct({ ...second, color: first.color, size: first.size }); }
      catch { duplicateRejected = true; }
      return { products: await db.listProducts(), duplicateRejected, firstId: first.id, secondId: second.id };
    }, product);
    assert.equal(result.duplicateRejected, true);
    assert.equal(result.products.find(item => item.id === result.firstId).stock, 2);
    assert.equal(result.products.find(item => item.id === result.secondId).stock, 2);
    assert.equal(result.products.find(item => item.id === result.secondId).color, '黑色');
  });
});

test('editing a specification preserves stock and immutable historical details', async () => {
  await withStore(async page => {
    const product = await seed(page);
    const result = await page.evaluate(async item => {
      const db = await import('./js/db.js');
      await db.receiveStock({ productId: item.id, quantity: 4 });
      await db.sellStock({ productId: item.id, quantity: 1, priceCents: 10000 });
      const before = await db.listMovements();
      await db.saveProduct({ ...item, name: '修改后的商品', color: '奶白', costCents: 6000, priceCents: 13900, stock: 999 });
      return { before, after: await db.listMovements(), product: (await db.listProducts())[0] };
    }, product);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.product.name, '修改后的商品');
    assert.equal(result.product.stock, 3, 'Product editing must not overwrite stock');
  });
});

test('two tabs cannot oversell the same inventory', async () => {
  await withStore(async (page, context) => {
    const product = await seed(page);
    await page.evaluate(async id => (await import('./js/db.js')).receiveStock({ productId: id, quantity: 5 }), product.id);
    const other = await context.newPage();
    await other.goto(baseURL);
    const attempt = id => page.evaluate(async productId => {
      try {
        await (await import('./js/db.js')).sellStock({ productId, quantity: 4, priceCents: 12900 });
        return 'fulfilled';
      } catch { return 'rejected'; }
    }, id);
    const outcomes = await Promise.all([
      attempt(product.id),
      other.evaluate(async productId => {
        try {
          await (await import('./js/db.js')).sellStock({ productId, quantity: 4, priceCents: 12900 });
          return 'fulfilled';
        } catch { return 'rejected'; }
      }, product.id),
    ]);
    assert.deepEqual(outcomes.sort(), ['fulfilled', 'rejected']);
    const snapshot = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      return { products: await db.listProducts(), movements: await db.listMovements() };
    });
    assert.equal(snapshot.products[0].stock, 1);
    assert.equal(snapshot.movements.length, 2);
  });
});

test('IndexedDB survives refresh and closing/reopening the page', async () => {
  await withStore(async (page, context) => {
    const product = await seed(page);
    await page.evaluate(async id => (await import('./js/db.js')).receiveStock({ productId: id, quantity: 6 }), product.id);
    await page.reload();
    assert.equal(await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 6);
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(baseURL);
    assert.equal(await reopened.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 6);
    assert.equal(await reopened.evaluate(async () => (await (await import('./js/db.js')).listMovements()).length), 1);
  });
});

test('backup round-trip restores exactly; invalid backups never replace current data', async () => {
  await withStore(async page => {
    const product = await seed(page);
    const result = await page.evaluate(async id => {
      const db = await import('./js/db.js');
      await db.receiveStock({ productId: id, quantity: 8 });
      await db.sellStock({ productId: id, quantity: 2, priceCents: 12888 });
      const backup = await db.exportBackup();
      await db.receiveStock({ productId: id, quantity: 3 });
      await db.saveProduct({ name: '恢复时应移除的商品', sku: 'TEST-EXTRA', color: '蓝色', size: 'S', costCents: 1000, priceCents: 2000 });
      await db.restoreBackup(JSON.stringify(backup));
      const restored = await db.exportBackup();
      const stable = value => JSON.stringify({ products: value.products, movements: value.movements });
      const malformed = [];
      const modify = edit => { const copy = structuredClone(backup); edit(copy); malformed.push(copy); };
      modify(copy => { copy.app = 'another-app'; });
      modify(copy => { copy.version = 999; });
      modify(copy => { copy.products.push(structuredClone(copy.products[0])); });
      modify(copy => { copy.products.push({ ...copy.products[0], id: `${copy.products[0].id}-extra` }); });
      modify(copy => { copy.products[0].stock += 1; });
      modify(copy => { copy.products[0].stock = -1; });
      modify(copy => { copy.movements[0].productId = 'missing'; });
      modify(copy => { copy.movements[0].quantity = 1.5; });
      modify(copy => { copy.movements[0].totalCents += 1; });
      modify(copy => { copy.movements[0].type = 'adjustment'; });
      modify(copy => { copy.movements.push(structuredClone(copy.movements[0])); });
      malformed.push('{invalid JSON', null, []);
      const rejected = [];
      const unchanged = [];
      for (const input of malformed) {
        try { await db.restoreBackup(input); rejected.push(false); }
        catch { rejected.push(true); }
        unchanged.push(stable(await db.exportBackup()) === stable(restored));
      }
      return { backup, restored, rejected, unchanged };
    }, product.id);
    assert.deepEqual(result.restored.products, result.backup.products);
    assert.deepEqual(result.restored.movements, result.backup.movements);
    assert.ok(result.rejected.every(Boolean), 'All malformed backups must reject');
    assert.ok(result.unchanged.every(Boolean), 'Rejecting a backup must preserve the entire existing database');
  });
});

test('manifest and fully cached app work offline under the GitHub Pages subpath', async () => {
  await withStore(async (page, context) => {
    const response = await page.request.get(new URL('manifest.webmanifest', baseURL).href);
    assert.equal(response.status(), 200);
    const manifest = await response.json();
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    assert.equal(await page.locator('#update-banner').isVisible(), false, 'A first installation must not be presented as an app update');
    const product = await seed(page);
    await page.evaluate(async id => (await import('./js/db.js')).receiveStock({ productId: id, quantity: 3 }), product.id);
    await context.setOffline(true);
    await page.close();
    const offline = await context.newPage();
    await offline.goto(baseURL);
    await offline.waitForSelector('nav');
    const offlineResult = await offline.evaluate(async id => {
      const db = await import('./js/db.js');
      await db.sellStock({ productId: id, quantity: 1, priceCents: 12900 });
      return { products: await db.listProducts(), movements: await db.listMovements() };
    }, product.id);
    assert.equal(offlineResult.products[0].stock, 2);
    assert.equal(offlineResult.movements.length, 2);
    await offline.reload();
    assert.equal(await offline.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 2);
    await context.setOffline(false);
  });
});

test('mobile UI completes product, purchase, sale, search, history and confirmed backup restore', async () => {
  await withStore(async page => {
    await page.getByRole('heading', { name: '我的库存', exact: true }).waitFor();
    await page.getByRole('button', { name: '添加商品', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('商品名称', { exact: true }).fill('手机验收衬衫 <&>');
    await dialog.getByLabel('货号', { exact: true }).fill('UI-001');
    await dialog.getByLabel('颜色', { exact: true }).fill('米白');
    await dialog.getByLabel('尺码', { exact: true }).fill('M');
    await dialog.getByLabel('进价', { exact: true }).fill('55.29');
    await dialog.getByLabel('售价', { exact: true }).fill('129.00');
    await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const product = await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0]);
    assert.equal(product.costCents, 5529, 'Decimal input should be preserved as integer cents');
    assert.equal(await page.locator('.product-card h3').textContent(), '手机验收衬衫 <&>', 'Names must render literally');
    const nav = page.locator('nav');
    await nav.getByRole('button', { name: '进货', exact: true }).click();
    await page.getByLabel(/^商品规格/).selectOption(product.id);
    await page.getByLabel(/^数量/).fill('10');
    await page.getByRole('button', { name: '确认进货', exact: true }).click();
    await page.waitForFunction(async () => (await (await import('./js/db.js')).listProducts())[0].stock === 10);
    await nav.getByRole('button', { name: '销售', exact: true }).click();
    await page.getByLabel(/^商品规格/).selectOption(product.id);
    await page.getByLabel(/^数量/).fill('11');
    await page.getByLabel(/^实际售价/).fill('119.01');
    await page.getByRole('button', { name: '确认销售', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '库存不足' }).waitFor();
    assert.equal(await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 10);
    await page.getByLabel(/^数量/).fill('3');
    await page.getByRole('button', { name: '确认销售', exact: true }).click();
    await page.waitForFunction(async () => (await (await import('./js/db.js')).listProducts())[0].stock === 7);
    await nav.getByRole('button', { name: '库存', exact: true }).click();
    const search = page.getByRole('searchbox', { name: '搜索商品', exact: true });
    await search.fill('不存在的商品');
    await page.getByRole('heading', { name: '没有找到商品', exact: true }).waitFor();
    await search.fill('UI-001');
    assert.equal(await page.locator('.stock-badge').textContent(), '7 件');
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: '/tmp/yiji-iphone.png', fullPage: true });
    await nav.getByRole('button', { name: '记录', exact: true }).click();
    await page.locator('.history-row').nth(1).waitFor();
    assert.equal(await page.locator('.history-row').count(), 2);
    assert.ok((await page.locator('.history-list').textContent()).includes('119.01'));
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出备份', exact: true }).click();
    const download = await downloadReady;
    assert.ok(download.suggestedFilename().endsWith('.json'));
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(backup.products[0].stock, 7);
    assert.equal(backup.movements.length, 2);
    // Change current state so cancellation and replacement have observable effects.
    await page.evaluate(async id => (await import('./js/db.js')).receiveStock({ productId: id, quantity: 2 }), product.id);
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    const file = { name: '衣记测试备份.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
    await page.locator('#backup-file').setInputFiles(file);
    await dialog.getByRole('heading', { name: '确认恢复备份', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 9);
    await page.locator('#backup-file').setInputFiles(file);
    await dialog.getByRole('button', { name: '确认覆盖并恢复', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const restored = await page.evaluate(async () => (await import('./js/db.js')).exportBackup());
    assert.deepEqual(restored.products, backup.products);
    assert.deepEqual(restored.movements, backup.movements);
    await page.locator('#backup-file').setInputFiles({ name: '损坏.json', mimeType: 'application/json', buffer: Buffer.from('{bad JSON') });
    await page.locator('#toast').filter({ hasText: 'JSON' }).waitFor();
    assert.equal(await page.evaluate(async () => (await (await import('./js/db.js')).listProducts())[0].stock), 7);
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
});

test('a committed sale is reported as saved and cleared even when its following refresh fails', async () => {
  await withStore(async page => {
    const product = await seed(page);
    await page.evaluate(async id => (await import('./js/db.js')).receiveStock({ productId: id, quantity: 10 }), product.id);
    await page.locator('nav').getByRole('button', { name: '销售', exact: true }).click();
    await page.getByLabel(/^商品规格/).selectOption(product.id);
    await page.getByLabel(/^数量/).fill('3');
    await page.getByLabel(/^实际售价/).fill('119.00');
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      let committed = false;
      let remainingReadFailures = 2;
      IDBDatabase.prototype.transaction = function (...args) {
        if (committed && args[1] === 'readonly' && remainingReadFailures > 0) {
          remainingReadFailures -= 1;
          throw new DOMException('Simulated read failure after a successful commit', 'InvalidStateError');
        }
        const transaction = original.apply(this, args);
        if (args[1] === 'readwrite') transaction.addEventListener('complete', () => { committed = true; }, { once: true });
        return transaction;
      };
      window.restoreTestTransaction = () => { IDBDatabase.prototype.transaction = original; };
    });
    await page.getByRole('button', { name: '确认销售', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name="quantity"]').value === '', null, { timeout: 10000 });
    assert.match(await page.locator('#toast').textContent(), /已登记|已保存/);
    await page.evaluate(() => window.restoreTestTransaction());
    const result = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      return { products: await db.listProducts(), movements: await db.listMovements() };
    });
    assert.equal(result.products[0].stock, 7);
    assert.equal(result.movements.length, 2, 'A refresh failure must not create another sale');
  });
});

test('iPhone and iPad portrait/landscape layouts fit without horizontal overflow', async () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await page.goto(baseURL);
      await page.getByRole('heading', { name: '我的库存', exact: true }).waitFor();
      const product = await seed(page);
      const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(width.document <= width.viewport + 1, `${JSON.stringify(viewport)}: horizontal overflow ${JSON.stringify(width)}`);
      const nav = page.locator('nav');
      await nav.getByRole('button', { name: '进货', exact: true }).click();
      await page.getByRole('heading', { name: '进货登记', exact: true }).waitFor();
      await page.getByLabel(/^商品规格/).selectOption(product.id);
      await page.getByLabel(/^数量/).fill('6');
      const entryWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(entryWidth.document <= entryWidth.viewport + 1);
      if (viewport.width === 820) await page.screenshot({ path: '/tmp/yiji-ipad.png', fullPage: true });
    } finally { await context.close(); }
  }
});
