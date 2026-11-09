// Sills Licence Manager service worker: the app works offline; the revocation list always comes from the network.
const CACHE = "sills-keys-v31";
const SHELL = ["./", "./index.html", "./app.css", "./app.js", "./core.js", "./themes.js", "./themes-default.json", "./update.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
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
// (a fresh owner notice from the build assistant - "update ready for your approval" - is shown instead when there is one)
const ACT_URL = "https://sills-activation.kelleysills.workers.dev";
async function myEp() {   // first 32 hex of sha256(this phone's push endpoint) - proves to the service it's the owner's subscribed phone
  const s = await self.registration.pushManager.getSubscription();
  if (!s) return "";
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.endpoint)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let n = null, ep = "";
    try { ep = await myEp(); const j = await (await fetch(ACT_URL + "/notice?ep=" + ep, { cache: "no-store" })).json(); if (j.notice && Date.now() - j.notice.at < 180000) n = j.notice; } catch {}
    if (n && n.request)   // a plan waiting for approval: Approve / Reject buttons right on the notification (Android; iPhone
                          // shows no buttons), tapping the notification itself opens the approval pop-up in the app
      return self.registration.showNotification(n.title, { body: (n.body ? n.body + " - " : "") + (n.code ? "Approve here or tap to review" : "tap to review"),
        icon: "icon-192.png", badge: "icon-192.png", tag: "sills-notice", renotify: true, requireInteraction: true,
        actions: n.code ? [{ action: "approve", title: "Approve" }, { action: "reject", title: "Reject" }] : [],
        data: { tab: "settings", review: n.request, code: n.code || "", ep } });
    if (n) return self.registration.showNotification(n.title, { body: n.body, icon: "icon-192.png", badge: "icon-192.png", tag: "sills-notice", renotify: true, data: { tab: n.tab || "settings" } });
    return self.registration.showNotification("Sills Licence Manager", {
      body: "New licence activity - a customer may be asking for another computer. Tap to review.",
      icon: "icon-192.png", badge: "icon-192.png", tag: "sills-activity", renotify: true, data: { tab: "keys" } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (d.review && d.code && (e.action === "approve" || e.action === "reject")) {   // decided from the notification: one-time code
    const decision = e.action === "approve" ? "approved" : "rejected";
    e.waitUntil((async () => {
      let ok = false;
      try {
        const j = await (await fetch(ACT_URL + "/request-decision", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ep: d.ep || await myEp(), code: d.code, id: d.review, decision }) })).json();
        ok = !!j.ok;
      } catch {}
      if (ok) return self.registration.showNotification(decision === "approved" ? "Approved" : "Rejected", { icon: "icon-192.png", badge: "icon-192.png", tag: "sills-notice",
        body: decision === "approved" ? "Claude builds it on its next run (within the hour)." : "Claude won't build it.", data: { tab: "settings" } });
      // code already used / expired: open the app's pop-up instead
      const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of cs) { c.postMessage("review:" + d.review); return c.focus(); }
      return self.clients.openWindow("./?tab=settings&review=" + encodeURIComponent(d.review));
    })());
    return;
  }
  if (d.review) {
    e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) { c.postMessage("review:" + d.review); return c.focus(); }
      return self.clients.openWindow("./?tab=settings&review=" + encodeURIComponent(d.review));
    }));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const tab = (e.notification.data && e.notification.data.tab) || "keys";
    for (const c of cs) { c.postMessage(tab === "keys" ? "inbox" : "tab:" + tab); return c.focus(); }
    return self.clients.openWindow("./?tab=" + tab);
  }));
});
