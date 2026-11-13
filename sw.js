/* خدمة العمل لتشغيل موجز أحوال دون اتصال (هيكل التطبيق + اللقطة) */
const CACHE = 'ahwal-swipe-v4';
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

  // واجهة ووردبريس والموجز: شبكة فقط، بلا تخزين، حتى تظهر الحذف والتعديل فوراً
  if (url.hostname === 'ahwal.sa' && (url.pathname.startsWith('/wp-json/') || url.pathname === '/feed' || url.pathname.startsWith('/feed'))) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // ملفات التطبيق: شبكة أولاً عند الاتصال، واللقطة المخزّنة احتياط دون اتصال فقط
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || Promise.reject(new Error('offline'))))
  );
});
