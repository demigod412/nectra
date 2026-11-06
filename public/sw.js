/* NECTRA service worker — offline shell + web push
   - App shell (HTML/CSS/JS/icons) is cached so the app opens offline.
   - Pages: network-first, falling back to cache, then /offline.html.
   - API calls are never cached (always live data).
   - Push events show notifications; clicking opens the linked page. */
const VERSION = 'nectra-v2.7.0';
const SHELL = [
  '/', '/index.html', '/dashboard.html', '/bot.html', '/wallets.html', '/deposit.html', '/withdraw.html', '/approvals.html', '/loans.html',
  '/portfolio.html', '/plans.html', '/referrals.html', '/notifications.html', '/settings.html', '/status.html', '/login.html', '/register.html', '/offline.html',
  '/assets/css/nectra.css', '/assets/js/data.js', '/assets/js/api.js', '/assets/js/core.js', '/assets/js/charts.js', '/assets/js/copilot.js', '/assets/js/pages.js',
  '/assets/favicon.svg', '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/offline.html'))));
    return;
  }
  // static assets: stale-while-revalidate
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; }).catch(() => cached);
    return cached || net;
  }));
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { title: 'NECTRA', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NECTRA', {
    body: d.body || '', icon: '/assets/icons/icon-192.png', badge: '/assets/icons/icon-192.png',
    tag: d.type || 'nectra', renotify: true, data: { link: d.link || '/notifications.html' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = new URL((e.notification.data && e.notification.data.link) || '/notifications.html', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => c.url.startsWith(location.origin));
    if (w) { w.navigate(link); return w.focus(); }
    return self.clients.openWindow(link);
  }));
});
