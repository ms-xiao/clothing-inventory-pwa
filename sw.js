/* Bump VERSION when any application asset changes. Caches are isolated by scope. */
const VERSION = 'v1.1.0';
const BASE = self.registration.scope;
const PREFIX = `yiji-${encodeURIComponent(BASE)}-`;
const CACHE = `${PREFIX}${VERSION}`;
const ASSETS = [
  './', './index.html', './styles.css', './js/app.js', './js/db.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png',
  './icons/icon-192.png', './icons/icon-512.png',
].map(path => new URL(path, BASE).href);

self.addEventListener('install', event => {
  // addAll is atomic: an incomplete download never becomes the next app shell.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    ASSETS.map(url => new Request(url, { cache: 'reload' })),
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// A waiting update is activated only after the user accepts it in the app.
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
      || !url.href.startsWith(BASE)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Keep HTML and JavaScript on the same fully downloaded version, online or off.
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch {
      if (request.mode === 'navigate') return cache.match(new URL('./index.html', BASE).href);
      return new Response('当前离线，资源尚未缓存。', { status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
