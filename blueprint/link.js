// The old address of the BluePrint web app. A browser that signed in here keeps its device key (IndexedDB, this origin
// only), so this page can make a link code for it: the new address (its own origin, new key) then joins the same account.
const SERVICE = "https://sills-blueprint.kelleysills.workers.dev";
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const $ = (id) => document.getElementById(id);

function loadKey() {
  return new Promise((resolve) => {
    const r = indexedDB.open("sills-blueprint", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) return resolve(null);
      const t = db.transaction("kv").objectStore("kv").get("device");
      t.onsuccess = () => resolve(t.result || null); t.onerror = () => resolve(null);
    };
  });
}
async function call(kp, method, path, body) {
  const text = JSON.stringify(body ?? {});
  const pk = hex(await crypto.subtle.exportKey("raw", kp.publicKey));
  const ts = String(Date.now());
  const sig = hex(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, enc.encode(`sills-bp1|${method}|${path}|${ts}|${await sha(text)}`)));
  const r = await fetch(SERVICE + path, { method, headers: { "x-bp-pk": pk, "x-bp-ts": ts, "x-bp-sig": sig, "content-type": "application/json" }, body: text });
  let j = null; try { j = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, json: j, error: (j && j.error) || "Service error " + r.status };
}

(async () => {
  const kp = await loadKey();
  if (!kp) { $("msg").textContent = "No BluePrint account in this browser. Taking you to the new address..."; setTimeout(() => location.replace($("go").href), 1500); return; }
  let me;
  try { me = await call(kp, "POST", "/me", {}); } catch { me = { ok: false, error: "Can't reach the BluePrint service" }; }
  if (!me.ok) { $("msg").innerHTML = me.status === 401 ? "This browser never finished signing in. Start fresh at the new address." : `<span class="err">${me.error}</span>`; return; }
  $("msg").hidden = true; $("acct").hidden = false;
  $("who").textContent = me.json.user.name;
  const orgs = (me.json.orgs || []).map((o) => o.name);
  $("orgs").textContent = orgs.length ? " (" + orgs.join(", ") + ")" : "";
  $("get").onclick = async () => {
    $("get").disabled = true;
    const r = await call(kp, "POST", "/me/link", {});
    $("get").disabled = false;
    if (!r.ok) { $("code").textContent = r.error; $("out").hidden = false; return; }
    $("code").textContent = r.json.code; $("out").hidden = false;
    try { await navigator.clipboard.writeText(r.json.code); } catch {}
  };
})();
