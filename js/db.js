// Every stock change and its journal entry commit together. Nothing is seeded.
const DB_NAME = 'clothing-inventory-pwa';
const DB_VERSION = 1;
const APP_ID = 'clothing-inventory-pwa';
const MAX_QUANTITY = 999999;
const MAX_STOCK = 999999999;
const MAX_PRICE = 99999999;
let database = null;
let opening = null;

function message(error) {
  if (error?.name === 'ConstraintError') return new Error('这个货号、颜色、尺码的商品已存在，请编辑原商品。');
  if (error?.name === 'QuotaExceededError') return new Error('设备存储空间不足，请先导出备份并释放空间后重试。');
  return error instanceof Error ? error : new Error('本地数据操作失败，请重试。');
}

export async function openDB() {
  if (database) return database;
  if (opening) return opening;
  if (!globalThis.indexedDB) throw new Error('当前浏览器无法使用本地数据库，请使用正常浏览模式的 Safari。');
  opening = new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const products = db.createObjectStore('products', { keyPath: 'id' });
      products.createIndex('specification', ['sku', 'color', 'size'], { unique: true });
      const movements = db.createObjectStore('movements', { keyPath: 'id' });
      movements.createIndex('productId', 'productId');
    };
    request.onerror = () => reject(message(request.error));
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('本地数据库正在升级，请关闭其他本应用窗口后重试。'));
    };
    request.onsuccess = () => {
      const connected = request.result;
      if (abandoned) { connected.close(); return; }
      database = connected;
      connected.onversionchange = () => {
        connected.close();
        if (database === connected) database = null;
      };
      connected.onclose = () => { if (database === connected) database = null; };
      resolve(connected);
    };
  });
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

export async function closeDB() {
  if (opening) await opening;
  database?.close();
  database = null;
}

// The worker only schedules IndexedDB requests; no timers, fetches or unrelated
// promises can let Safari auto-close a transaction between dependent requests.
async function transaction(stores, mode, worker) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    let tx;
    try { tx = db.transaction(stores, mode); } catch (error) { reject(message(error)); return; }
    const fail = (error) => {
      failure = error;
      try { tx.abort(); } catch { reject(message(failure)); }
    };
    const guard = (callback) => (...args) => {
      try { callback(...args); } catch (error) { fail(error); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(message(failure || tx.error));
    // Request errors bubble and abort the entire transaction by default.
    tx.onerror = () => {};
    guard(worker)(tx, (value) => { result = value; }, guard);
  });
}

function text(value, label, max = 100) {
  if (typeof value !== 'string') throw new Error(`${label}格式不正确。`);
  const normalized = value.trim().normalize('NFC');
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label}请填写 1 至 ${max} 个有效字符。`);
  }
  return normalized;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须为 ${min} 至 ${max} 之间的整数。`);
  }
  return value;
}

function identifier(value, label = '编号') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}格式不正确。`);
  return value;
}

function date(value, label) {
  if (typeof value !== 'string' || value.length !== 24 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label}格式不正确。`);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式不正确。`);
  return value;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function productFields(raw) {
  object(raw, '商品');
  return {
    name: text(raw.name, '商品名称'),
    sku: text(raw.sku, '货号', 60),
    color: text(raw.color, '颜色', 40),
    size: text(raw.size, '尺码', 40),
    costCents: integer(raw.costCents, '进价（分）', 0, MAX_PRICE),
    priceCents: integer(raw.priceCents, '售价（分）', 0, MAX_PRICE),
  };
}

export function moneyToCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error('金额请填写非负数字，最多保留两位小数。');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), '金额（分）', 0, MAX_PRICE);
}

export function formatMoney(cents) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100);
}

export async function listProducts() {
  return transaction(['products'], 'readonly', (tx, done, guard) => {
    const request = tx.objectStore('products').getAll();
    request.onsuccess = guard(() => done(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))));
  });
}

export async function listMovements() {
  return transaction(['movements'], 'readonly', (tx, done, guard) => {
    const request = tx.objectStore('movements').getAll();
    request.onsuccess = guard(() => done(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))));
  });
}

export async function saveProduct(raw) {
  const fields = productFields(raw);
  const id = raw.id === undefined ? uuid() : identifier(raw.id, '商品编号');
  return transaction(['products'], 'readwrite', (tx, done, guard) => {
    const store = tx.objectStore('products');
    const write = (existing) => {
      const now = new Date().toISOString();
      const product = {
        id, ...fields,
        stock: existing?.stock ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const request = existing ? store.put(product) : store.add(product);
      request.onsuccess = guard(() => done(product));
    };
    if (raw.id === undefined) write(null);
    else {
      const request = store.get(id);
      request.onsuccess = guard(() => {
        if (!request.result) throw new Error('商品不存在，请刷新后重试。');
        write(request.result);
      });
    }
  });
}

async function changeStock(raw, type) {
  object(raw, '登记内容');
  const productId = identifier(raw.productId, '商品编号');
  const quantity = integer(raw.quantity, '数量', 1, MAX_QUANTITY);
  if (type === 'out') integer(raw.priceCents, '实际售价（分）', 0, MAX_PRICE);
  return transaction(['products', 'movements'], 'readwrite', (tx, done, guard) => {
    const products = tx.objectStore('products');
    const request = products.get(productId);
    request.onsuccess = guard(() => {
      const product = request.result;
      if (!product) throw new Error('商品不存在，请重新选择商品。');
      if (type === 'out' && product.stock < quantity) throw new Error(`库存不足，当前可售 ${product.stock} 件。`);
      const stock = product.stock + (type === 'in' ? quantity : -quantity);
      if (stock > MAX_STOCK) throw new Error(`库存最多为 ${MAX_STOCK} 件，请检查进货数量。`);
      const now = new Date().toISOString();
      const priceCents = type === 'in' ? product.costCents : raw.priceCents;
      const movement = {
        id: uuid(), type, productId, quantity, priceCents,
        totalCents: priceCents * quantity,
        createdAt: now,
        snapshot: { name: product.name, sku: product.sku, color: product.color, size: product.size },
      };
      const updated = { ...product, stock, updatedAt: now };
      products.put(updated);
      tx.objectStore('movements').add(movement);
      done({ product: updated, movement });
    });
  });
}

export async function receiveStock(raw) { return changeStock(raw, 'in'); }
export async function sellStock(raw) { return changeStock(raw, 'out'); }

export async function exportBackup() {
  return transaction(['products', 'movements'], 'readonly', (tx, done, guard) => {
    const backup = { app: APP_ID, version: 1, exportedAt: new Date().toISOString(), products: [], movements: [] };
    const products = tx.objectStore('products').getAll();
    const movements = tx.objectStore('movements').getAll();
    products.onsuccess = guard(() => { backup.products = products.result; });
    movements.onsuccess = guard(() => { backup.movements = movements.result; });
    done(backup);
  });
}

export function validateBackup(raw) {
  let backup = raw;
  if (typeof raw === 'string') {
    try { backup = JSON.parse(raw); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
  }
  object(backup, '备份');
  if (backup.app !== APP_ID || backup.version !== 1) throw new Error('这不是本应用支持的第 1 版备份文件。');
  date(backup.exportedAt, '备份时间');
  if (!Array.isArray(backup.products) || !Array.isArray(backup.movements)) throw new Error('备份缺少商品或进销记录。');
  const ids = new Set();
  const specifications = new Set();
  const stocks = new Map();
  const products = backup.products.map((rawProduct) => {
    object(rawProduct, '备份商品');
    const product = {
      id: identifier(rawProduct.id, '商品编号'),
      ...productFields(rawProduct),
      stock: integer(rawProduct.stock, '库存', 0, MAX_STOCK),
      createdAt: date(rawProduct.createdAt, '商品创建时间'),
      updatedAt: date(rawProduct.updatedAt, '商品更新时间'),
    };
    if (ids.has(product.id)) throw new Error('备份包含重复的商品编号。');
    const specification = JSON.stringify([product.sku, product.color, product.size]);
    if (specifications.has(specification)) throw new Error('备份包含重复的货号、颜色、尺码。');
    ids.add(product.id);
    specifications.add(specification);
    stocks.set(product.id, 0);
    return product;
  });
  const movementIds = new Set();
  const movements = backup.movements.map((rawMovement) => {
    object(rawMovement, '进销记录');
    object(rawMovement.snapshot, '记录商品信息');
    const movement = {
      id: identifier(rawMovement.id, '记录编号'),
      type: rawMovement.type,
      productId: identifier(rawMovement.productId, '记录商品编号'),
      quantity: integer(rawMovement.quantity, '记录数量', 1, MAX_QUANTITY),
      priceCents: integer(rawMovement.priceCents, '记录单价（分）', 0, MAX_PRICE),
      totalCents: integer(rawMovement.totalCents, '记录金额（分）', 0, MAX_QUANTITY * MAX_PRICE),
      createdAt: date(rawMovement.createdAt, '记录时间'),
      snapshot: {
        name: text(rawMovement.snapshot.name, '记录商品名称'),
        sku: text(rawMovement.snapshot.sku, '记录货号', 60),
        color: text(rawMovement.snapshot.color, '记录颜色', 40),
        size: text(rawMovement.snapshot.size, '记录尺码', 40),
      },
    };
    if (!['in', 'out'].includes(movement.type)) throw new Error('备份包含不支持的记录类型。');
    if (movementIds.has(movement.id)) throw new Error('备份包含重复的记录编号。');
    if (!ids.has(movement.productId)) throw new Error('备份记录引用了不存在的商品。');
    if (movement.totalCents !== movement.quantity * movement.priceCents) throw new Error('备份中的记录金额与数量、单价不一致。');
    movementIds.add(movement.id);
    const stock = stocks.get(movement.productId) + (movement.type === 'in' ? movement.quantity : -movement.quantity);
    if (!Number.isSafeInteger(stock)) throw new Error('备份中的进销数量超出安全范围。');
    stocks.set(movement.productId, stock);
    return movement;
  });
  for (const product of products) {
    if (stocks.get(product.id) !== product.stock) throw new Error(`“${product.name}”的库存与进销记录不一致，无法恢复。`);
  }
  // Rebuild plain, known fields only. Import never retains arbitrary properties.
  return { app: APP_ID, version: 1, exportedAt: backup.exportedAt, products, movements };
}

export async function restoreBackup(raw) {
  const backup = validateBackup(raw);
  return transaction(['products', 'movements'], 'readwrite', (tx, done) => {
    const products = tx.objectStore('products');
    const movements = tx.objectStore('movements');
    products.clear();
    movements.clear();
    for (const product of backup.products) products.add(product);
    for (const movement of backup.movements) movements.add(movement);
    done({ productCount: backup.products.length, movementCount: backup.movements.length });
  });
}
