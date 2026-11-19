// BluePrint moved to its own site. Browsers that installed the old copy here update to this worker, which clears the
// old BluePrint cache, removes itself and reloads the page (which forwards to the new address). Licence manager caches
// ("sills-keys...") are never touched.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("sills-blueprint")) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
