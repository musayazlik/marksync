// The viewer's service worker: keeps the app itself available offline and
// makes it installable. Bookmarks are never cached: they always come from
// Google Drive (and may be encrypted), only the page, scripts and styles are.
const CACHE = 'marksync-viewer-v2';
const PAGES = ['./', './index.html', './join.html', './manifest.webmanifest', './logo.svg', './icon-128.png'];

/** The pages, and the hashed scripts and styles they load (found in the HTML). */
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(PAGES);
  for (const page of ['./index.html', './join.html']) {
    const html = await (await cache.match(page))?.text();
    const assets = [...(html ?? '').matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]);
    if (assets.length) await cache.addAll(assets);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only this site's own files; Google's APIs and sign-in go straight to the network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        // Offline: pages fall back to the viewer; anything else is simply missing.
        if (event.request.mode === 'navigate') return (await caches.match('./index.html')) ?? Response.error();
        return Response.error();
      }),
  );
});
