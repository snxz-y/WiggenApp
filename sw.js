// Kill switch. index.html no longer registers a service worker, but one was
// registered briefly in June 2026 and would keep serving a stale cached app.
// Browsers re-fetch this file on navigation; this version clears all caches and
// unregisters itself. Safe to delete once no device could still have the old one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
