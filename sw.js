// Sills Licence Manager service worker: the app works offline; the revocation list always comes from the network.
const CACHE = "sills-keys-v18";
const SHELL = ["./", "./index.html", "./app.css", "./app.js", "./core.js", "./holiday.js", "./update.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                         // revoked.txt etc.: straight to the network
  // network first (so updates land), cached copy when offline
  if (e.request.method !== "GET") return;
  if (url.pathname.endsWith("/version.json")) return;                  // the update check goes straight to the network
  // a unique query string skips GitHub Pages' CDN cache too, so an update shows on the very next open
  const fresh = url.href + (url.search ? "&" : "?") + "_=" + Date.now();
  e.respondWith(fetch(fresh, { cache: "no-store" }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))));
});

// alerts from the activation service arrive as empty pushes: show a generic notice, details load inside the app
self.addEventListener("push", (e) => {
  e.waitUntil(self.registration.showNotification("Sills Licence Manager", {
    body: "New licence activity - a customer may be asking for another computer. Tap to review.",
    icon: "icon-192.png", badge: "icon-192.png", tag: "sills-activity", renotify: true,
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { c.postMessage("inbox"); return c.focus(); }
    return self.clients.openWindow("./?tab=keys");
  }));
});
