/* خدمة العمل لتشغيل موجز أحوال دون اتصال (هيكل التطبيق + اللقطة) */
const CACHE = 'ahwal-swipe-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './data/feed-snapshot.json',
  './data/snapshot.js',
  './assets/logo-on-dark.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // واجهة ووردبريس: شبكة أولاً ثم تجاهل الفشل (اللقطة في الصفحة)
  if (url.hostname === 'ahwal.sa' && url.pathname.startsWith('/wp-json/')) {
    event.respondWith(fetch(req).catch(() => new Response('[]', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const networked = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networked;
    })
  );
});
