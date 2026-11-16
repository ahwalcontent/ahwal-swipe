/*!
 * جميع الحقوق محفوظة © 2026 صحيفة أحوال الإلكترونية — عبدالله بن صالح بن خميس الكناني
 * يُمنع نسخ هذا البرنامج أو إعادة استخدامه أو توزيعه دون إذن كتابي من المالك.
 */
/* خدمة العمل لتشغيل موجز أحوال دون اتصال (هيكل التطبيق + اللقطة) */
const CACHE = 'ahwal-swipe-v11';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './editor.html',
  './editor.css',
  './editor.js',
  './manifest.webmanifest',
  './data/feed-snapshot.json',
  './data/snapshot.js',
  './assets/logo-on-dark.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/maskable-512.png'
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

  // لوحة المحررين: أي طلب يحمل بيانات دخول لا يمر عبر الخدمة ولا يُخزَّن أبداً
  if (req.headers.has('authorization')) return;
  // رابط العودة من الموقع يحمل كلمة مرور التطبيق في العنوان: شبكة فقط، بلا تخزين
  if (url.origin === self.location.origin && /editor\.html$/.test(url.pathname) && url.search) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // واجهة ووردبريس والموجز: شبكة فقط، بلا تخزين، حتى تظهر الحذف والتعديل فوراً
  if (url.hostname === 'ahwal.sa' && (url.pathname.startsWith('/wp-json/') || url.pathname === '/feed' || url.pathname.startsWith('/feed'))) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // ملفات التطبيق: شبكة أولاً عند الاتصال، واللقطة المخزّنة احتياط دون اتصال فقط
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic' && !url.search) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || Promise.reject(new Error('offline'))))
  );
});
