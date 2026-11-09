// Auto-update: when the app opens or comes back to the screen, compare its version with the published one and reload
// once if a newer one is out (the service worker always fetches fresh files, so the reload shows the new version).
(function () {
  const mine = (document.querySelector('meta[name="app-version"]') || {}).content || "";
  let checking = false;
  async function check() {
    if (checking || !navigator.onLine) return;
    checking = true;
    try {
      const r = await fetch("version.json?_=" + Date.now(), { cache: "no-store" });
      const v = r.ok ? (await r.json()).v : "";
      let tried = "";
      try { tried = sessionStorage.getItem("sills.reloadedFor") || ""; } catch (e) {}
      if (v && v !== mine && tried !== v) {
        try { sessionStorage.setItem("sills.reloadedFor", v); } catch (e) {}
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        if (reg) { try { await reg.update(); } catch (e) {} }
        location.reload();
        return;
      }
    } catch (e) { /* offline or blocked: keep the current version */ }
    checking = false;
  }
  check();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
})();
