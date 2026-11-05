import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(option('--port', process.env.PORT || '4173'));
const base = `/${option('--base', 'clothing-inventory-pwa').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const root = fileURLToPath(new URL('../', import.meta.url));
const knownFiles = new Set(['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'icons/icon.svg', 'icons/icon-180.png',
  'icons/icon-192.png', 'icons/icon-512.png']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); return response.end('Bad request'); }
  if (pathname === '/' && base !== '/' || pathname === base.slice(0, -1)) {
    response.writeHead(302, { Location: base });
    return response.end();
  }
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) || 'index.html' : '';
  if (!knownFiles.has(relative)) {
    response.writeHead(404); return response.end('Not found');
  }
  try {
    const bytes = await readFile(path.join(root, relative));
    response.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(404); response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`衣记: http://127.0.0.1:${server.address().port}${base}`);
});
