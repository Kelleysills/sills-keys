// Sills Licence Manager (phone). Holds an admin pass (and optionally this phone's own master key), encrypted with a PIN;
// issues, looks up, re-issues and revokes keys, and makes / switches off god-mode passes.
import * as L from "./core.js";

const $ = (id) => document.getElementById(id);
const REPO = "Kelleysills/sills-audio-releases";
const REVOKED_URL = `https://raw.githubusercontent.com/${REPO}/main/revoked.txt`;
const MASTERS_URL = `https://raw.githubusercontent.com/${REPO}/main/masters.txt`;
const API = `https://api.github.com/repos/${REPO}/contents/`;
const PHONE_ADMIN_BASE = 2048;   // god-mode passes made on the phone use admin ids 2048+ (the PC counts up from 1)
const ls = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast("Couldn't save on this phone (storage full or blocked)."); } },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// ------------------------------------------------------------------ vault: admin pass + key list, AES-GCM under a PIN-derived key
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pin, salt, iterations = 310000) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

const state = { aes: null, salt: null, pass: null, passText: "", data: { rows: [], nextN: 1 }, rev: null, replacing: null, keep: null, lastActive: Date.now(), type: 1,
  master: null /* unlocked master secret (memory only) */, masters: null /* verified masters.txt */ };
const masterPub = () => state.data.master ? state.data.master.pub : null;
const masterTrusted = () => !!(masterPub() && state.masters && state.masters.ok && state.masters.masters.some((m) => m.hex === masterPub()));
const canMaster = () => !!(state.master && masterTrusted());

async function save() {
  if (!state.aes) return;
  const box = await seal(state.aes, { passText: state.passText, data: state.data });
  ls.set("sills.vault", { v: 1, salt: b64(state.salt), ...box });
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (!(await L.ed25519Supported())) {
    document.body.innerHTML = '<div class="screen center"><h1>Update Chrome</h1><p class="dim">This phone\'s browser can\'t do Ed25519 signatures yet. Update Chrome (version 137 or newer) and open this page again.</p></div>';
    return;
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  state.rev = ls.get("sills.rev");
  // trusted phones (masters.txt) from the last visit first: a pass re-made by a phone master only checks out with them
  const cachedMasters = ls.get("sills.masters");
  if (cachedMasters && cachedMasters.ok) { state.masters = cachedMasters; L.setExtraRoots(cachedMasters.masters.map((m) => m.hex)); }
  loadMasters();
  wire();
  if (ls.get("sills.vault")) showLock(); else { show("setup"); renderPassReq(); pollPassReq(); }
}

function show(which) {
  for (const id of ["lock", "setup", "main"]) $(id).hidden = id !== which;
}

// ------------------------------------------------------------------ setup
async function checkPassInput() {
  const t = $("passInput").value.trim();
  if (!t) { $("passInfo").textContent = ""; return null; }
  const p = await L.parseAdminPass(t);
  $("passInfo").textContent = p.valid ? (p.ended ? p.error : `Pass for ${p.name} (admin #${p.adminId}): can issue ${p.scopeText}.`) : p.error;
  $("passInfo").className = "note " + (p.valid && !p.ended ? "" : "dim");
  return p.valid && !p.ended ? p : null;
}
async function doSetup() {
  const p = await checkPassInput();
  if (!p) { toast("Paste a valid admin pass first."); return; }
  const a = $("pin1").value, b = $("pin2").value;
  if (!/^\d{6,12}$/.test(a)) { toast("The PIN must be 6 to 12 digits."); return; }
  if (a !== b) { toast("The two PINs don't match."); return; }
  const replacing = !!state.aes;
  state.salt = crypto.getRandomValues(new Uint8Array(16));
  state.aes = await deriveKey(a, state.salt);
  if (!replacing || !state.pass || state.pass.adminId !== p.adminId) state.data.nextN = Math.max(1, ...state.data.rows.filter((r) => r.issuer === p.adminId).map((r) => (r.serial % 1048576) + 1));
  state.pass = p; state.passText = $("passInput").value.trim();
  await save();
  ls.del("sills.passreq");
  if (bioInfo()) relinkBio(a, state.salt);   // a new vault: the fingerprint must wrap the new key
  $("passInput").value = ""; $("pin1").value = ""; $("pin2").value = "";
  enterMain();
}

// ------------------------------------------------------------------ lock
let pinBuf = "";
function showLock(msg) {
  state.aes = null; state.pass = null; state.passText = ""; state.master = null;
  pinBuf = ""; drawPin();
  $("lockMsg").textContent = msg || (bioInfo() ? "Touch the sensor, or enter your PIN" : "Enter your PIN");
  show("lock");
  renderBio();
  if (bioInfo() && document.visibilityState === "visible") setTimeout(bioUnlock, 250);
}
function drawPin() {
  $("pinDots").innerHTML = Array.from({ length: Math.max(6, pinBuf.length) }, (_, i) => `<span class="${i < pinBuf.length ? "on" : ""}"></span>`).join("");
}
async function tryUnlock() {
  const fails = ls.get("sills.fails", { n: 0, until: 0 });
  if (Date.now() < fails.until) { $("lockMsg").textContent = `Too many tries - wait ${Math.ceil((fails.until - Date.now()) / 1000)} s`; pinBuf = ""; drawPin(); return; }
  const v = ls.get("sills.vault");
  try {
    const salt = unb64(v.salt);
    const pin = pinBuf;
    await openVault(await deriveKey(pin, salt), salt);
    const b = bioInfo();
    if (b && (ls.get("sills.bioStale") || (b.salt && b.salt !== v.salt))) relinkBio(pin, salt);
  } catch {
    const n = fails.n + 1;
    ls.set("sills.fails", { n, until: n >= 5 ? Date.now() + 30000 * Math.pow(2, n - 5) : 0 });
    $("lockMsg").textContent = n >= 5 ? "Wrong PIN - locked for a while" : "Wrong PIN";
    pinBuf = ""; drawPin();
    navigator.vibrate?.(120);
  }
}

async function openVault(key, salt) {
  const inner = await unseal(key, ls.get("sills.vault"));   // throws on a wrong key
  state.aes = key; state.salt = salt; state.passText = inner.passText; state.data = inner.data || { rows: [], nextN: 1 };
  state.pass = await L.parseAdminPass(state.passText);
  if (!state.pass.valid && state.passText) { await loadMasters(); state.pass = await L.parseAdminPass(state.passText); }
  // master mode kept unlocked inside the vault (Settings > Master mode > Keep master unlocked)
  if (state.data.masterKeep) { try { state.master = L.hexToBytes(state.data.masterKeep); } catch { state.master = null; } }
  ls.set("sills.fails", { n: 0, until: 0 });
  enterMain();
}

// ------------------------------------------------------------------ fingerprint / face unlock (passkey + PRF)
// The passkey's PRF output is an AES key that wraps the vault key itself - the biometric really unlocks the data,
// it isn't a screen in front of the PIN. The PIN keeps working as the fallback.
const PRF_SALT = new TextEncoder().encode("sills-licence-manager vault v1".padEnd(32, "."));
const bioInfo = () => ls.get("sills.bio", null);
async function vaultKeyBits(pin, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, base, 256));
}
async function prfKey(bytes) { return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
async function bioGet(idB64) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: "required", timeout: 60000,
    allowCredentials: [{ type: "public-key", id: unb64(idB64) }], extensions: { prf: { eval: { first: PRF_SALT } } } } });
  const r = cred.getClientExtensionResults().prf?.results?.first;
  if (!r) throw new Error("this phone's passkeys can't unlock data (no PRF)");
  return new Uint8Array(r);
}
async function enableBio() {
  if (!window.PublicKeyCredential) { toast("This browser has no fingerprint / passkey support."); return; }
  const pin = await askPassphrase("Enter your PIN to turn on fingerprint / face unlock", false, true);
  if (!pin) return;
  const v = ls.get("sills.vault"), salt = unb64(v.salt);
  let raw;
  try { raw = await vaultKeyBits(pin, salt); await unseal(await prfKey(raw), v); } catch { toast("Wrong PIN."); return; }
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: "Sills Licence Manager", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Sills licence manager", displayName: "Sills Licence Manager" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, timeout: 60000,
      extensions: { prf: { eval: { first: PRF_SALT } } } } });
    const ext = cred.getClientExtensionResults().prf;
    if (ext && ext.enabled === false) throw new Error("this phone's passkeys can't unlock data (no PRF)");
    const id = b64(new Uint8Array(cred.rawId));
    const out = ext?.results?.first ? new Uint8Array(ext.results.first) : await bioGet(id);   // some phones only answer PRF on sign-in
    const box = await seal(await prfKey(out), { k: L.bytesToHex(raw) });
    ls.set("sills.bio", { id, salt: v.salt, ...box });
    ls.del("sills.bioStale");
    toast("Fingerprint / face unlock is on.");
  } catch (e) { toast(e.name === "NotAllowedError" ? "Cancelled." : "Couldn't turn it on: " + e.message); }
  renderBio();
}
function disableBio() { ls.del("sills.bio"); renderBio(); toast("Fingerprint / face unlock is off - use your PIN."); }
let bioBusy = false;
async function bioUnlock() {
  const b = bioInfo(); if (!b || bioBusy) return;
  bioBusy = true;
  try {
    const out = await bioGet(b.id);
    const inner = await unseal(await prfKey(out), b);
    const v = ls.get("sills.vault"), salt = unb64(v.salt);
    const key = await crypto.subtle.importKey("raw", L.hexToBytes(inner.k), "AES-GCM", false, ["encrypt", "decrypt"]);
    await openVault(key, salt);
  } catch (e) {
    if (e.name !== "NotAllowedError") {
      $("lockMsg").textContent = "Fingerprint needs re-linking - enter your PIN once";
      ls.set("sills.bioStale", true);   // the PIN unlock re-links it (one fingerprint touch)
    } else $("lockMsg").textContent = "Touch the fingerprint button to try again, or enter your PIN";
  } finally { bioBusy = false; }
}
/** Re-wrap the vault key for the existing passkey (after a new PIN / pass or a failed fingerprint unlock). */
async function relinkBio(pin, salt) {
  const b = bioInfo(); if (!b) return;
  try {
    const raw = await vaultKeyBits(pin, salt);
    const out = await bioGet(b.id);
    const box = await seal(await prfKey(out), { k: L.bytesToHex(raw) });
    ls.set("sills.bio", { id: b.id, salt: b64(salt), ...box });
    ls.del("sills.bioStale");
    toast("Fingerprint unlock is linked again.");
  } catch (e) {
    if (e.name !== "NotAllowedError") toast("Fingerprint unlock needs turning off and on again (Settings).");
  }
}
function renderBio() {
  const on = !!bioInfo();
  if ($("bioState")) $("bioState").textContent = on ? "On - unlock with your fingerprint or face; the PIN still works." : "Off - unlock with your PIN.";
  if ($("bioOn")) $("bioOn").hidden = on;
  if ($("bioOff")) $("bioOff").hidden = !on;
  if ($("bioBtn")) $("bioBtn").hidden = !on;
}

// ------------------------------------------------------------------ main
function enterMain() {
  show("main");
  state.lastActive = Date.now();
  fillWhat();
  updateSerial();
  renderPassCard();
  renderKeys();
  refreshMasters().then(() => { refreshRevocations(false); refreshPolicy(); });
  renderMaster(); renderAdmins(); renderAlerts(); renderBio(); renderPolicy();
  { const t = new URLSearchParams(location.search).get("tab"); if (t === "keys" || t === "settings") tab(t); }
  $("lockAfter").value = String(ls.get("sills.lockAfter", 300));
  if (state.pass && state.pass.ended) toast(state.pass.error + " Make a new pass on your PC.");
  setTimeout(ensureAlerts, 1500);
  setTimeout(() => { const rv = new URLSearchParams(location.search).get("review"); reviewRequest(rv || null); }, 1200);
}
/** Keep this phone signed up for alerts: re-registers the subscription with the service on every unlock (it can get lost). */
async function ensureAlerts() {
  try {
    if (ls.get("sills.alerts", null) === false || !canMaster() || !("Notification" in self)) return;   // on unless you turned alerts off
    if (Notification.permission === "default") { $("alertsAsk").hidden = false; return; }   // needs one tap (browsers ask on a tap)
    if (Notification.permission !== "granted") return;
    ls.set("sills.alerts", true);
    const reg = await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    if (!s) {
      const info = await (await fetch(actUrl())).json();
      if (!info.vapid) return;
      s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(info.vapid) });
    }
    const sub = s.toJSON();
    await adminCall("subscribe", await subHash(sub), { sub });
  } catch { /* offline: next unlock */ }
}

function tab(name) {
  for (const t of ["issue", "keys", "admins", "check", "settings"]) $("tab-" + t).hidden = t !== name;
  document.querySelectorAll("nav.bottom button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("topTitle").textContent = { issue: "Issue a key", keys: "Keys", admins: "God mode", check: "Check a key", settings: "Settings" }[name];
  if (name === "keys") { renderKeys(); loadInbox(); syncLedger(false); }
  if (name === "admins") { renderAdmins(); syncAdmins(); }
  if (name === "settings") { renderRequests(); requestAnimationFrame(() => { if (document.getElementById("updList")) fitReqList(); }); }
  window.scrollTo(0, 0);
}

// what this pass may issue: editions inside its suites, then single plug-ins inside its scope
function fillWhat(keepLabel) {
  const sel = $("what"); sel.innerHTML = "";
  const p = state.pass;
  if (!p) return;
  const all = canMaster();
  const allowedAll = p.allowedProducts | L.productsCoveredBy(p.allowedBundles);
  for (const e of L.EDITIONS) if (all || (e.bundles & ~p.allowedBundles) === 0) sel.add(new Option(e.label, "e:" + e.id));
  for (const pr of L.PRODUCTS) if (all || (pr.bit & ~allowedAll) === 0) sel.add(new Option(pr.name.replace(/^Sills /, "") + " only", "p:" + pr.bit));
  if (keepLabel) sel.add(new Option("Keep as is: " + keepLabel, "keep"), 0);
  if (!sel.options.length) sel.add(new Option("This pass can't issue anything", ""));
  sel.selectedIndex = 0;
}
function selectedWhat() {
  const v = $("what").value;
  if (v === "keep" && state.keep) return { products: state.keep.products, bundles: state.keep.bundles };
  if (v.startsWith("e:")) return { products: 0, bundles: L.EDITIONS.find((e) => "e:" + e.id === v).bundles };
  if (v.startsWith("p:")) return { products: Number(v.slice(2)), bundles: 0 };
  return null;
}
const serialFor = (n) => state.pass.adminId * 1048576 + n;
function updateSerial() {
  if (!state.pass) return;
  $("serialPreview").textContent = `Serial #${serialFor(state.data.nextN)} - issued by ${state.pass.name} (admin #${state.pass.adminId})`;
  $("nextSerial").value = state.data.nextN;
}
function setType(v) {
  state.type = v;
  document.querySelectorAll("#typeSeg button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === v));
  $("daysRow").hidden = v !== 2;
}

async function issue() {
  const what = selectedWhat();
  const licensee = $("licensee").value.trim();
  if (!licensee) { toast("Type the licensee's name."); return; }
  if (!what) { toast("This pass can't issue anything."); return; }
  const req = { licensee, type: state.type, ...what, serial: serialFor(state.data.nextN) };
  if (state.type === 2) {
    if ($("endDate").value) { const [y, m, dd] = $("endDate").value.split("-").map(Number); req.lastDay = new Date(y, m - 1, dd); }
    else {
      const d = Math.max(1, parseInt($("days").value || "0", 10));
      const from = state.replacing && state.replacing.lastDay && state.replacing.lastDay > new Date() ? state.replacing.lastDay : new Date();
      req.lastDay = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
    }
    if (req.lastDay < new Date(new Date().toDateString())) { toast("The end date is in the past."); return; }
  }
  let key;
  try {
    if (L.passAllows(state.pass, req) || !canMaster()) key = await L.issueKey(req, state.pass);
    else key = await L.issueMasterKey(req, state.master);   // beyond the pass: signed with this phone's master key
  } catch (e) { toast(e.message); return; }
  const info = await L.verifyKey(key);
  const row = {
    serial: info.serial, issued: L.isoDay(new Date()), licensee: info.licensee, type: info.typeName, products: info.productText,
    expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key, note: state.replacing ? "replaces #" + state.replacing.serial : "", source: "phone", issuer: info.issuerId,
  };
  const replaced = state.replacing ? state.replacing.serial : 0;
  if (state.replacing) {
    const old = state.data.rows.find((r) => r.serial === state.replacing.serial);
    if (old) old.note = "replaced by #" + info.serial;
  }
  state.data.rows.unshift(row);
  state.data.nextN += 1;
  await save();
  $("resTitle").textContent = `Key #${info.serial}`;
  $("resKey").textContent = key;
  $("resInfo").textContent = `${info.licensee} - ${info.typeName} - ${info.productText}` + (info.lastDay ? ` - ends ${L.isoDay(info.lastDay)}` : "")
    + (replaced ? `\nReplaces #${replaced}.` : "");
  $("result").hidden = false;
  state.lastKey = { key, info };
  await copyText(key, "Key copied.");
  syncLedger(false);
  if (replaced && canMaster() && state.data.ghToken) {
    $("resInfo").textContent += " Revoking the old key...";
    const ok = await changeRevocations([replaced], true);
    $("resInfo").textContent = $("resInfo").textContent.replace(" Revoking the old key...", ok ? ` #${replaced} revoked.` : ` Couldn't revoke #${replaced} - do it from Keys.`);
  } else if (replaced) $("resInfo").textContent += ` Revoke #${replaced} from Keys (master mode) or on your PC.`;
  clearReplace();
  updateSerial();
  $("result").scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearReplace() {
  state.replacing = null; state.keep = null;
  $("replaceBanner").hidden = true;
  $("issueBtn").textContent = "Generate key";
  fillWhat();
}

// ------------------------------------------------------------------ keys
function statusOf(row, info) {
  const rv = state.rev && state.rev.serials ? state.rev.serials : [];
  if (rv.includes(row.serial)) return ["REVOKED", "bad"];
  if (row.revoked) return ["REVOKED", "bad"];
  if (row.issuer && rv.includes(L.adminRevocationId(row.issuer))) return ["ISSUER OFF", "bad"];
  if (row.expires && row.expires !== "never" && new Date(row.expires + "T23:59:59") < new Date()) return ["EXPIRED", "warn"];
  if ((row.note || "").startsWith("replaced by")) return ["REPLACED", "warn"];
  return ["ACTIVE", "good"];
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function renderKeys() {
  const q = $("search").value.trim().toLowerCase();
  const rows = state.data.rows.filter((r) => !q || r.licensee.toLowerCase().includes(q) || String(r.serial).startsWith(q) || (r.products || "").toLowerCase().includes(q));
  $("keyList").innerHTML = rows.length ? rows.map((r) => {
    const [st, cls] = statusOf(r);
    return `<div class="item" data-serial="${r.serial}"><div class="ser">#${r.serial}</div><div class="who"><div class="name">${esc(r.licensee)}</div>`
      + `<div class="what">${esc(r.products)} - ${esc(r.type)}${r.expires !== "never" ? " - ends " + esc(r.expires) : ""}${r.source === "pc" ? " - PC" : ""}</div>`
      + installLine(r.serial) + `</div>`
      + `<span class="badge ${cls}">${st}</span></div>`;
  }).join("") : `<div class="empty">No keys yet.<br>${state.data.ghToken ? "Your PC's keys arrive once its Hub (0.4.24 or later) has synced - then tap Sync with PC." : "Add your GitHub token in Settings, then tap Sync with PC to bring in your PC's keys."}</div>`;
  renderRevInfo();
}
function renderRevInfo() {
  const r = state.rev;
  const t = r && r.ok ? `Revocation list from ${r.updated || "?"} (checked ${new Date(r.fetched).toLocaleString()}): ${r.serials.length} revoked.` : "Revocation list not loaded yet - statuses may be out of date.";
  $("revInfo").textContent = t; $("revCard").textContent = t;
}
async function refreshRevocations(loud) {
  try {
    const res = await fetch(REVOKED_URL, { cache: "no-store" });
    const text = await res.text();
    const v = await L.verifyRevocationList(text);
    if (!v.ok) throw new Error("bad signature");
    state.rev = { ...v, fetched: Date.now() };
    ls.set("sills.rev", state.rev);
    if (loud) toast("Revocation list updated.");
  } catch (e) { if (loud) toast("Couldn't load the revocation list (" + e.message + ")."); }
  renderKeys();
}

let sheetRow = null;
async function openSheet(serial) {
  const r = state.data.rows.find((x) => x.serial === serial);
  if (!r) return;
  sheetRow = r;
  const info = await L.verifyKey(r.key);
  const [st, cls] = statusOf(r);
  $("sheetContent").innerHTML = `<div class="cardHead"><span>Key #${r.serial}</span><span class="badge ${cls}">${st}</span></div>`
    + `<div class="kv"><div>Licensee</div><div>${esc(info.licensee || r.licensee)}</div><div>Gets</div><div>${esc(info.productText || r.products)}</div>`
    + `<div>Type</div><div>${esc(info.typeName || r.type)}</div><div>Issued</div><div>${esc(r.issued)}</div>`
    + `<div>Ends</div><div>${esc(r.expires)}</div><div>Issued by</div><div>${info.issuerId ? "admin #" + info.issuerId : "Sills Audio (PC)"}</div>`
    + (r.note ? `<div>Note</div><div>${esc(r.note)}</div>` : "") + `</div><pre class="key">${esc(r.key)}</pre>`
    + (info.valid ? "" : `<p class="note err">${esc(info.error)}</p>`) + installDetail(r.serial);
  const isRevoked = st === "REVOKED";
  $("shRevoke").hidden = isRevoked; $("shRestore").hidden = !isRevoked;
  const adminOnly = !state.data.ghToken, locked = adminOnly && isProtectedRow(r);
  $("shRevoke").disabled = $("shRestore").disabled = adminOnly ? (locked || !(state.pass && state.pass.valid)) : !canMaster();
  $("shReissue").disabled = locked;
  $("shMasterHint").hidden = canMaster() || (adminOnly && !locked);
  $("shMasterHint").textContent = locked ? "This key is protected - only Sills Audio can change it." : "Revoke, restore and computers need master mode (Settings).";
  $("shPcs").hidden = true; $("shComputers").disabled = !canMaster() || !actUrl();
  $("sheet").hidden = false;
}
async function startReissue() {
  const r = sheetRow; if (!r) return;
  const info = await L.verifyKey(r.key);
  $("sheet").hidden = true;
  tab("issue");
  $("licensee").value = info.licensee || r.licensee;
  // pick the matching option, or keep exactly what the key has
  const ed = info.bundles ? L.EDITIONS.find((e) => e.bundles === info.bundles) : null;
  const single = !info.bundles ? L.PRODUCTS.find((p) => p.bit === info.products) : null;
  state.keep = null;
  fillWhat();
  const want = ed ? "e:" + ed.id : single ? "p:" + single.bit : null;
  if (want && [...$("what").options].some((o) => o.value === want)) $("what").value = want;
  else { state.keep = { products: info.products, bundles: info.bundles }; fillWhat(info.productText); }
  setType(info.type || 1);
  state.replacing = { serial: r.serial, lastDay: info.lastDay || null };
  $("days").value = 30;
  $("endDate").value = info.lastDay ? L.isoDay(info.lastDay) : "";
  $("daysLabel").textContent = info.type === 2 ? `Add days (ends ${info.lastDay ? L.isoDay(info.lastDay) : "?"} now)` : "Length";
  $("replaceBanner").hidden = false;
  $("replaceBanner").innerHTML = `<span class="grow">Changing key #${r.serial}. You'll get a new key` + (canMaster() ? ` and #${r.serial} is revoked automatically.` : `; revoke #${r.serial} afterwards.`) + `</span><button id="cancelReplace">Cancel</button>`;
  $("cancelReplace").onclick = () => { clearReplace(); $("daysLabel").textContent = "Length"; };
  $("issueBtn").textContent = "Re-issue key";
  $("result").hidden = true;
}

// ------------------------------------------------------------------ check
async function check() {
  const t = $("checkInput").value.trim();
  if (!t) return;
  const i = await L.verifyKey(t);
  const box = $("checkResult");
  box.hidden = false;
  if (!i.valid) { box.innerHTML = `<div class="cardHead"><span>Not valid</span><span class="badge bad">INVALID</span></div><p class="dim">${esc(i.error)}</p>`; return; }
  const row = { serial: i.serial, issuer: i.issuerId, expires: i.lastDay ? L.isoDay(i.lastDay) : "never", note: "" };
  const [st, cls] = statusOf(row);
  box.innerHTML = `<div class="cardHead"><span>Key #${i.serial}</span><span class="badge ${cls}">${st}</span></div>`
    + `<div class="kv"><div>Licensee</div><div>${esc(i.licensee)}</div><div>Gets</div><div>${esc(i.productText)}</div><div>Type</div><div>${esc(i.typeName)}</div>`
    + `<div>Issued</div><div>${L.isoDay(i.issued)}</div><div>Ends</div><div>${i.lastDay ? L.isoDay(i.lastDay) : "never"}</div>`
    + `<div>Issued by</div><div>${i.issuerId ? "admin #" + i.issuerId : "Sills Audio (master)"}</div></div>`;
}

// ------------------------------------------------------------------ settings
function renderPassCard() {
  const p = state.pass;
  $("passCard").innerHTML = p ? `<div class="kv"><div>Name</div><div>${esc(p.name)}</div><div>Admin</div><div>#${p.adminId}</div><div>Can issue</div><div>${esc(p.scopeText)}</div></div>`
    + (p.ended ? `<p class="note err">${esc(p.error)}</p>` : "") : "No pass";
}
function csvCell(s) { s = String(s ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function exportCsv() {
  const lines = ["serial,issued,licensee,type,products,expires,key,note"];
  for (const r of state.data.rows.filter((x) => x.source === "phone").slice().reverse())
    lines.push([r.serial, r.issued, csvCell(r.licensee), r.type, csvCell(r.products), r.expires, r.key, csvCell(r.note)].join(","));
  const text = lines.join("\n") + "\n";
  const file = new File([text], `phone-issued-keys-${L.isoDay(new Date())}.csv`, { type: "text/csv" });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Keys issued on my phone" }); return; } catch {} }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; ++i) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; ++i; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}
async function importCsv(file) {
  const text = await file.text();
  let added = 0, skipped = 0;
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const c = parseCsvLine(line);
    const key = (c[6] || "").trim();
    const info = await L.verifyKey(key);
    if (!info.valid && !info.expired) { ++skipped; continue; }
    if (state.data.rows.some((r) => r.serial === info.serial)) { const r = state.data.rows.find((x) => x.serial === info.serial); if (c[7]) r.note = c[7]; continue; }
    state.data.rows.push({ serial: info.serial, issued: c[1], licensee: info.licensee, type: info.typeName, products: info.productText,
      expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key, note: c[7] || "", source: "pc", issuer: info.issuerId });
    ++added;
  }
  state.data.rows.sort((a, b) => (b.issued || "").localeCompare(a.issued || "") || b.serial - a.serial);
  await save();
  renderKeys();
  toast(`Imported ${added} key${added === 1 ? "" : "s"}` + (skipped ? `, skipped ${skipped} unreadable` : "") + ".");
}

// ------------------------------------------------------------------ master mode
/** Fetch masters.txt (signed by the PC key) and trust the phones in it. */
async function loadMasters() {
  try {
    const res = await fetch(MASTERS_URL, { cache: "no-store" });
    const v = res.ok ? await L.verifyTrustedMasters(await res.text()) : { ok: false };
    const cached = ls.get("sills.masters");
    if (v.ok && (!cached || !cached.ok || v.seq >= cached.seq)) { state.masters = v; ls.set("sills.masters", v); }
    else state.masters = cached;
  } catch { state.masters = ls.get("sills.masters"); }
  L.setExtraRoots(state.masters && state.masters.ok ? state.masters.masters.map((m) => m.hex) : []);
}
async function refreshMasters() {
  await loadMasters();
  if (state.aes && state.passText && !(state.pass && state.pass.valid)) {   // the pass couldn't be checked before: try again
    state.pass = await L.parseAdminPass(state.passText);
    renderPassCard(); updateSerial();
  }
  renderMaster(); fillWhat(); renderKeys();
}
async function askPassphrase(title, twice, numeric = false) {
  return new Promise((resolve) => {
    $("ppTitle").textContent = title;
    $("pp1").value = ""; $("pp2").value = ""; $("pp2Row").hidden = !twice;
    $("pp1").inputMode = numeric ? "numeric" : "text";
    $("ppSheet").hidden = false; $("pp1").focus();
    $("ppOk").onclick = () => {
      const a = $("pp1").value;
      if (twice && a.length < 10) { toast("Use at least 10 characters."); return; }
      if (twice && a !== $("pp2").value) { toast("The two don't match."); return; }
      $("ppSheet").hidden = true; resolve(a);
    };
    $("ppCancel").onclick = () => { $("ppSheet").hidden = true; resolve(null); };
  });
}
async function makeMaster() {
  if (state.data.master && !confirm("Replace this phone's master key? The old one stops working once you remove it in the Hub.")) return;
  const pp = await askPassphrase("Choose a master passphrase (10+ characters). It protects this phone's master key - separate from your PIN.", true);
  if (!pp) return;
  const m = await L.generateMaster();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pp, salt, 600000);
  const box = await seal(key, { secret: L.bytesToHex(m.secret) });
  state.data.master = { pub: m.publicHex, salt: b64(salt), ...box, made: L.isoDay(new Date()) };
  state.master = m.secret;
  if (state.data.keepMaster !== false) state.data.masterKeep = L.bytesToHex(m.secret);
  await save();
  renderMaster();
  await copyText(m.publicHex, "Master key copied - paste it in the Hub.");
}
async function unlockMaster() {
  if (!state.data.master) return false;
  if (state.master) return true;
  const pp = await askPassphrase("Master passphrase", false);
  if (!pp) return false;
  try {
    const key = await deriveKey(pp, unb64(state.data.master.salt), 600000);
    const inner = await unseal(key, state.data.master);
    state.master = L.hexToBytes(inner.secret);
    if (state.data.keepMaster !== false) { state.data.masterKeep = inner.secret; await save(); }
    renderMaster(); fillWhat(); renderKeys(); renderAdmins(); if (!$("tab-keys").hidden) loadInbox();
    toast(masterTrusted() ? "Master mode on." : "Unlocked - but your PC hasn't trusted this phone yet.");
    return true;
  } catch { toast("Wrong passphrase."); return false; }
}
function renderMaster() {
  const m = state.data.master;
  const st = !m ? "This phone isn't a master yet." : !masterTrusted() ? "Waiting for your PC: in the Hub, Licence manager > Admins > Second masters, paste this key and press Trust phone."
    : state.master ? "Master mode is ON - full control from this phone." : "Trusted by your PC. Unlock it with your master passphrase to revoke, restore and make god-mode passes.";
  $("masterState").textContent = st;
  $("masterPub").textContent = m ? m.pub : "";
  $("masterPub").hidden = !m;
  $("copyMasterPub").hidden = !m;
  $("makeMaster").textContent = m ? "Replace master key" : "Make this phone a master";
  $("unlockMaster").hidden = !m || !!state.master;
  $("ghToken").value = state.data.ghToken ? "********" : "";
  $("masterBadge").hidden = !canMaster();
  $("keepMaster").checked = state.data.keepMaster !== false;
}
// ------------------------------------------------------------------ licence policy (rules pulled from GitHub)
const POLICY_URL = `https://raw.githubusercontent.com/${REPO}/main/policy.txt`;
let policy = (ls.get("sills.policy", null) || {}).policy || {};
const pol = (path, fallback) => { let v = policy; for (const k of path.split(".")) { if (v == null || typeof v !== "object") return fallback; v = v[k]; } return v === undefined ? fallback : v; };
async function refreshPolicy() {
  try {
    const res = await fetch(POLICY_URL, { cache: "no-store" });
    if (res.ok) {
      const v = await L.verifyPolicy(await res.text());
      const cached = ls.get("sills.policy", null);
      if (v.ok && (!cached || v.seq >= (cached.seq || 0))) { ls.set("sills.policy", v); policy = v.policy; }
    }
  } catch {}
  renderPolicy(); renderAdmins();
}
function renderPolicy() {
  if (!$("policyState")) return;
  const seq = pol("seq", 0);
  $("policyState").innerHTML = seq ? `Rules version ${seq}: up to ${pol("activation.maxComputers", 2)} computers per key, activation lasts ${pol("activation.tokenDays", 45)} days, `
    + `${(pol("admins.hidden", []) || []).length} admin(s) hidden, key list ${pol("ledger.enabled", true) ? "synced" : "not synced"}.` : "No rules published yet - your Hub publishes them on its next check.";
}
/** Change the published rules (signed with this phone's master key); the PC's Hub pulls them into Keys\\policy.json. */
async function changePolicy(mutate, what) {
  if (!canMaster() && !((await unlockMaster()) && canMaster())) { toast("Master mode is needed for that."); return false; }
  if (!state.data.ghToken) { toast("Add your GitHub token in Settings first."); return false; }
  try {
    const cur = await ghFetch("policy.txt?ref=main", { cache: "no-store" });
    let sha, p = JSON.parse(JSON.stringify(policy || {}));
    if (cur.status !== 404) {
      const j = await cur.json(); sha = j.sha;
      const v = await L.verifyPolicy(b64ToText(j.content));
      if (!v.ok) throw new Error("the published rules' signature doesn't check out");
      p = v.policy;
    }
    mutate(p);
    p.seq = (p.seq || 0) + 1;
    const text = await L.signPolicy(p, state.master);
    const put = await ghFetch("policy.txt", { method: "PUT", body: JSON.stringify({ message: "Licence policy: " + what + " (phone)", content: textToB64(text), ...(sha ? { sha, branch: "main" } : {}) }) });
    if (!put.ok) throw new Error("GitHub " + put.status);
    const v = await L.verifyPolicy(text); ls.set("sills.policy", v); policy = v.policy;
    renderPolicy(); renderAdmins();
    return true;
  } catch (e) { toast("Rules not saved: " + e.message); return false; }
}
const adminShown = (id) => { const m = pol("admins.displayNumbers", {}) || {}; return m[String(id)] != null ? Number(m[String(id)]) : id; };
const adminFromShown = (n) => { const m = pol("admins.displayNumbers", {}) || {}; for (const [k, v] of Object.entries(m)) if (Number(v) === n) return Number(k); return m[String(n)] != null ? -1 : n; };
const adminHidden = (id) => (pol("admins.hidden", []) || []).map(Number).includes(id);

const LEDGER_API_FOR = () => `https://api.github.com/repos/${pol("ledger.repo", "Kelleysills/sills-ledger")}/contents/`;
async function ghFetch(path, opts = {}, base = API) {
  const res = await fetch(base + path, { ...opts, headers: { Authorization: "Bearer " + state.data.ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 404) throw new Error(res.status === 401 ? "GitHub token rejected" : res.status === 403 ? (base === API ? "token can't write to the releases repo" : "token can't reach the ledger repo") : "GitHub " + res.status);
  return res;
}
// ------------------------------------------------------------------ shared key list (private repo sills-ledger, keys.csv)
// The Hub on your PC merges its issued-keys.csv in; the phone merges its own keys - one list everywhere.
const b64ToText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const textToB64 = (t) => { const u = new TextEncoder().encode(t); let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); };
function rowToCsv(r) { return [r.serial, r.issued, csvCell(r.licensee), r.type, csvCell(r.products), r.expires, r.key, csvCell(r.note)].join(","); }
let syncing = false;
function syncStatus(t, bad) { const el = $("syncState"); if (el) { el.textContent = t; el.classList.toggle("err", !!bad); } }
async function syncLedger(loud) {
  if (syncing) return;
  if (!state.data.ghToken) { if (state.pass && state.pass.valid) { await shareKeys(loud); return readLedger(loud); } syncStatus("No GitHub token yet - add it in Settings > Master mode.", true); if (loud) toast("Add your GitHub token in Settings first."); return; }
  if (!pol("ledger.enabled", true)) { syncStatus("Key list sync is switched off in your licence rules."); return; }
  syncing = true; syncStatus("Syncing with your PC's list...");
  try {
    // a token without access to a private repo gets "404 not found", not 403 - check the repo itself first
    const repoRes = await fetch("https://api.github.com/repos/" + pol("ledger.repo", "Kelleysills/sills-ledger"), { cache: "no-store", headers: { Authorization: "Bearer " + state.data.ghToken, Accept: "application/vnd.github+json" } });
    if (repoRes.status === 401) throw new Error("GitHub token rejected - make a new one");
    if (!repoRes.ok) throw new Error("your token can't see sills-ledger - edit the token on GitHub and add that repo (Contents: Read and write)");
    const cur = await ghFetch(pol("ledger.keysFile", "keys.csv") + "?ref=main", { cache: "no-store" }, LEDGER_API_FOR());
    let sha, text = "";
    if (cur.status !== 404) { const j = await cur.json(); sha = j.sha; text = b64ToText(j.content); }
    const remote = new Map();
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const c = parseCsvLine(line); const serial = Number(c[0]);
      if (serial > 0 && c[6]) remote.set(serial, { line, c });
    }
    let added = 0, changed = false;
    // keys admins shared through the activation service (admins without GitHub access) join the list here
    if (canMaster()) {
      try {
        const ak = await adminCall("adminkeys");
        for (const r of ak.rows || []) {
          if (remote.has(r.serial) || state.data.rows.some((x) => x.serial === r.serial)) continue;
          const info = await L.verifyKey(r.key);
          if (!info.valid && !info.expired) continue;
          state.data.rows.push({ serial: info.serial, issued: r.issued, licensee: info.licensee, type: info.typeName, products: info.productText,
            expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key: r.key, note: r.note || "", source: "admin", issuer: info.issuerId });
          ++added; changed = true;
        }
      } catch { /* service unreachable: next time */ }
    }
    for (const [serial, { c }] of remote) {
      const mine = state.data.rows.find((r) => r.serial === serial);
      if (mine) { if ((c[7] || "").length > (mine.note || "").length) { mine.note = c[7]; changed = true; } continue; }
      const info = await L.verifyKey(c[6].trim());
      if (!info.valid && !info.expired) continue;
      state.data.rows.push({ serial, issued: c[1], licensee: info.licensee, type: info.typeName, products: info.productText,
        expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key: c[6].trim(), note: c[7] || "", source: (serial >>> 20) === (state.pass?.adminId ?? -1) ? "phone" : "pc", issuer: info.issuerId });
      ++added; changed = true;
    }
    // push what the shared list doesn't have yet (or has with a shorter note)
    const outgoing = state.data.rows.filter((r) => { const x = remote.get(r.serial); return !x || (r.note || "").length > (x.c[7] || "").length; });
    if (outgoing.length) {
      const all = new Map(remote); for (const r of outgoing) all.set(r.serial, { line: rowToCsv(r) });
      const body = "serial,issued,licensee,type,products,expires,key,note\n" + [...all.keys()].sort((a, b) => a - b).map((k) => all.get(k).line).join("\n") + "\n";
      const putRes = await ghFetch(pol("ledger.keysFile", "keys.csv"), { method: "PUT", body: JSON.stringify({ message: `Sync key ledger (phone, ${outgoing.length})`, content: textToB64(body), ...(sha ? { sha, branch: "main" } : {}) }) }, LEDGER_API_FOR());   // an empty repo has no main yet
      if (!putRes.ok) throw new Error("couldn't save to sills-ledger (GitHub " + putRes.status + ") - the token needs Contents: Read and write");
    }
    if (changed) { state.data.rows.sort((a, b) => (b.issued || "").localeCompare(a.issued || "") || b.serial - a.serial); await save(); }
    state.data.lastSync = Date.now();
    if (canMaster()) ownerServiceSync().catch(() => {});   // admins' read-only copy + their revoke requests
    renderKeys();
    syncStatus(`Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${remote.size} key${remote.size === 1 ? "" : "s"} in the shared list` + (added ? `, ${added} new here.` : "."));
    if (loud) toast(`Key list synced${added ? ` - ${added} new from your PC` : ""}.`);
  } catch (e) { syncStatus("Sync failed: " + e.message, true); if (loud) toast("Sync: " + e.message); }
  finally { syncing = false; }
}

/** add (revoke) or remove (restore) serials in the published list, signed with this phone's master key */
async function changeRevocations(serials, revoke) {
  // no GitHub access (admins, demi-god masters): a request the owner's devices sign and publish; protected keys are refused
  if (!state.data.ghToken) return canMaster() ? masterQueue(serials, revoke) : adminRevoke(serials, revoke);
  if (!canMaster()) { if (!(await unlockMaster()) || !canMaster()) { toast("Master mode is needed for that."); return false; } }
  if (!state.data.ghToken) { toast("Add your GitHub token in Settings > Master mode first."); tab("settings"); return false; }
  try {
    const cur = await ghFetch("revoked.txt?ref=main", { cache: "no-store" });
    let list = [], sha;
    if (cur.status !== 404) {
      const j = await cur.json(); sha = j.sha;
      const text = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
      const v = await L.verifyRevocationList(text);
      if (!v.ok) throw new Error("the published list's signature doesn't check out");
      list = v.serials;
    }
    const set = new Set(list);
    for (const s of serials) revoke ? set.add(s >>> 0) : set.delete(s >>> 0);
    const text = await L.signRevocationList([...set], state.master);
    const content = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    await ghFetch("revoked.txt", { method: "PUT", body: JSON.stringify({ message: (revoke ? "Revoke " : "Restore ") + serials.join(", ") + " (phone)", content, sha, branch: "main" }) });
    const v = await L.verifyRevocationList(text);
    state.rev = { ...v, fetched: Date.now() }; ls.set("sills.rev", state.rev);
    renderKeys(); renderAdmins();
    return true;
  } catch (e) { toast("Not published: " + e.message); return false; }
}
async function sheetRevoke(revoke) {
  const r = sheetRow; if (!r) return;
  if (revoke && !confirm(`Revoke key #${r.serial} (${r.licensee})? It stops working on every computer at its next Hub check.`)) return;
  if (await changeRevocations([r.serial], revoke)) { toast(revoke ? `#${r.serial} revoked.` : `#${r.serial} restored.`); openSheet(r.serial); }
}

// ------------------------------------------------------------------ activation service: requests, alerts, computers
const DEFAULT_ACT_URL = "https://sills-activation.kelleysills.workers.dev";
const actUrl = () => (ls.get("sills.actUrl", "") || DEFAULT_ACT_URL).replace(/\/+$/, "");
async function adminCall(action, serial = "", extra = {}) {
  if (!actUrl()) throw new Error("add the activation service address in Settings");
  if (!canMaster() && !((await unlockMaster()) && canMaster())) throw new Error("master mode is needed");
  const ts = Math.floor(Date.now() / 1000);
  const sig = await L.signBytes(state.master, new TextEncoder().encode(`sills-admin|${action}|${serial}|${ts}`));
  const res = await fetch(actUrl() + "/admin/" + action, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ts, serial: serial === "" ? undefined : serial, sig: L.bytesToHex(sig), ...extra }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j;
}
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
async function loadInbox(loud) {
  $("inbox").hidden = !(actUrl() && state.data.master);
  if ($("inbox").hidden || !canMaster()) { if (!$("inbox").hidden) $("reqList").innerHTML = `<p class="small dim">Unlock master mode to see requests.</p>`; return; }
  try {
    const [r, e, pr] = await Promise.all([adminCall("requests"), adminCall("events"), adminCall("passreqs").catch(() => ({ requests: [] }))]);
    adminCall("status").then((st) => { state.install = st.keys || {}; renderKeys(); }).catch(() => {});
    state.passReqs = pr.requests;
    const passHtml = pr.requests.map((x) =>
      `<div class="req"><div><b>${esc(x.name)}</b> wants a phone pass` + (x.note ? `<div class="dim">"${esc(x.note)}"</div>` : "") + `<div class="dim">${when(x.at)}</div></div>`
      + `<div class="row"><button class="primaryLite" data-passok="${x.id}">Approve...</button><button data-passno="${x.id}">Deny</button></div></div>`).join("");
    $("reqList").innerHTML = passHtml + (r.requests.length ? r.requests.map((x) =>
      `<div class="req"><div><b>#${x.serial}</b> ${esc(x.licensee)} wants a 2nd computer: <b>${esc(x.pending.name)}</b>`
      + (x.pending.note ? `<div class="dim">"${esc(x.pending.note)}"</div>` : "") + `<div class="dim">${when(x.pending.at)} - now on ${esc(x.machines.map((m) => m.name).join(", ") || "none")}</div></div>`
      + `<div class="row"><button class="primaryLite" data-approve="${x.serial}">Approve</button><button data-deny="${x.serial}">Deny</button></div></div>`).join("")
      : (passHtml ? "" : `<p class="small dim">No requests waiting.</p>`));
    const label = { activated: "activated on", blocked: "was blocked on", request: "asked for", passreq: "asked for", revokereq: "asked to revoke", restorereq: "asked to restore", updatereq: "asked for an update:" };
    $("evList").innerHTML = e.events.slice(0, 40).map((x) => `<div>${when(x.at)} - ${x.serial ? "#" + x.serial + " " : ""}${esc(x.licensee)} ${label[x.type] || x.type} ${esc(x.name || "")}</div>`).join("") || "Nothing yet.";
    const n = r.requests.length + pr.requests.length;
    navigator.setAppBadge?.(n).catch?.(() => {});
    if (loud) toast(n ? `${n} request${n === 1 ? "" : "s"} waiting.` : "No requests waiting.");
  } catch (err) { $("reqList").innerHTML = `<p class="small dim">Couldn't reach the activation service (${esc(err.message)}).</p>`; }
}
async function decide(serial, approve) {
  try { await adminCall(approve ? "approve" : "deny", Number(serial)); toast(approve ? `#${serial}: second computer approved.` : `#${serial}: request denied.`); }
  catch (e) { toast("Didn't go through: " + e.message); }
  loadInbox();
}
async function sheetComputers() {
  const r = sheetRow; if (!r) return;
  const box = $("shPcs"); box.hidden = false; box.textContent = "Loading...";
  try {
    const j = await adminCall("info", r.serial);
    const rec = j.record;
    box.innerHTML = `<div>${rec.machines.length} of ${rec.slots} computer${rec.slots === 1 ? "" : "s"}: ${esc(rec.machines.map((m) => m.name).join(", ") || "none yet")}</div>`
      + (rec.pending ? `<div>Waiting: ${esc(rec.pending.name)}</div>` : "") + `<div class="row"><button id="shReset" class="danger">Reset computers</button></div>`;
    $("shReset").onclick = async () => {
      if (!confirm(`Forget every computer for #${r.serial}? The customer activates again on their next Hub check.`)) return;
      try { await adminCall("reset", r.serial); toast("Computers reset."); sheetComputers(); } catch (e) { toast(e.message); }
    };
  } catch (e) { box.textContent = e.message === "unknown serial" ? "This key hasn't been activated anywhere yet." : "Couldn't load: " + e.message; }
}
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function subHash(sub) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sub))));
  return L.bytesToHex(h).slice(0, 32);
}
async function alerts(on) {
  try {
    if (!actUrl()) throw new Error("add the activation service address first");
    const reg = await navigator.serviceWorker.ready;
    if (on) {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications are blocked for this site");
      const info = await (await fetch(actUrl())).json();
      if (!info.vapid) throw new Error("the service has no alerts key yet - run 4-setup-activation.bat again");
      const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(info.vapid) })).toJSON();
      await adminCall("subscribe", await subHash(sub), { sub });
      ls.set("sills.alerts", true); toast("Alerts are on.");
    } else {
      const s = await reg.pushManager.getSubscription();
      if (s) { const sub = s.toJSON(); try { await adminCall("unsubscribe", await subHash(sub), { sub }); } catch {} await s.unsubscribe(); }
      ls.set("sills.alerts", false); toast("Alerts are off.");
    }
  } catch (e) { toast("Alerts: " + e.message); }
  renderAlerts();
}
function renderAlerts() {
  $("actUrl").value = actUrl();
  $("alertsState").textContent = ls.get("sills.alerts", false) ? "Alerts are on for this phone." : "Alerts are off.";
}

// ------------------------------------------------------------------ god mode (admin passes)
function fillAdminScope() {
  const sel = $("adScope"); if (sel.options.length) return;
  for (const e of L.EDITIONS) sel.add(new Option(e.label, "e:" + e.id));
  for (const pr of L.PRODUCTS) sel.add(new Option(pr.name.replace(/^Sills /, "") + " only", "p:" + pr.bit));
}
let sharedAdmins = [];   // from sills-ledger/admins.csv (PC-made passes: metadata only)
async function syncAdmins() {
  if (!state.data.ghToken) return;
  try {
    const cur = await ghFetch(pol("ledger.adminsFile", "admins.csv") + "?ref=main", { cache: "no-store" }, LEDGER_API_FOR());
    let sha, text = "";
    if (cur.status !== 404) { const j = await cur.json(); sha = j.sha; text = b64ToText(j.content); }
    const remote = new Map();
    for (const line of text.split(/\r?\n/).slice(1)) { if (!line.trim()) continue; const c = parseCsvLine(line); const id = Number(c[0]); if (id > 0) remote.set(id, { line, c }); }
    sharedAdmins = [...remote.values()].map(({ c }) => ({ id: Number(c[0]), made: c[1], name: c[2], scope: c[3] }));
    const mine = (state.data.admins || []).filter((a) => !remote.has(a.id));
    if (mine.length) {
      const all = new Map(remote); for (const a of mine) all.set(a.id, { line: [a.id, a.made, csvCell(a.name), csvCell(a.scope)].join(",") });
      const body = "admin,created,name,scope\n" + [...all.keys()].sort((x, y) => x - y).map((k) => all.get(k).line).join("\n") + "\n";
      await ghFetch(pol("ledger.adminsFile", "admins.csv"), { method: "PUT", body: JSON.stringify({ message: "Sync admins (phone)", content: textToB64(body), ...(sha ? { sha, branch: "main" } : {}) }) }, LEDGER_API_FOR());
    }
    renderAdmins();
  } catch {}
}
function allAdmins() {
  const mine = state.data.admins || [];
  const ids = new Set(mine.map((a) => a.id));
  return [...mine, ...sharedAdmins.filter((a) => !ids.has(a.id))].filter((a) => !adminHidden(a.id)).sort((a, b) => adminShown(a.id) - adminShown(b.id));
}
function adminIsOff(id) { const rv = state.rev && state.rev.serials ? state.rev.serials : []; return rv.includes(L.adminRevocationId(id)); }
function openAdmin(a) {
  const off = adminIsOff(a.id);
  state.lastPass = a.pass || null;
  $("adDetail").hidden = false;
  $("adDetail").innerHTML = `<div class="cardHead"><span>Admin #${adminShown(a.id)} - ${esc(a.name)}</span><span class="badge ${off ? "bad" : "good"}">${off ? "OFF" : "ON"}</span></div>`
    + `<div class="kv"><div>Can issue</div><div>${esc(a.scope || "?")}</div><div>Made</div><div>${esc(a.made || "?")}${a.pass || a.requested ? " on this phone" : " on your PC"}</div>`
    + (adminShown(a.id) !== a.id ? `<div>Real number</div><div>${a.id} (inside the pass and its keys)</div>` : "") + `</div>`
    + `<div class="row"><input id="adShownAs" type="number" inputmode="numeric" min="1" value="${adminShown(a.id)}" style="max-width:110px"><button id="adRenumber">Show as this number</button></div>`
    + `<div class="row wrap">${a.pass ? `<button id="adCopyPass">Copy pass</button>` : ""}`
    + `<button id="adChange" class="primaryLite">Change scope / end date</button>`
    + (off ? `<button id="adBackOn">Back on</button><button id="adRemove" class="danger">Remove from list</button>` : `<button id="adSwitchOff" class="danger">Switch off</button>`) + `</div>`
    + `<p class="small dim">Change makes a new pass with the same admin number (send it to them; keys they already issued keep working). Switch off also stops every key they issued.</p>`;
  if (a.pass) $("adCopyPass").onclick = () => copyText(a.pass, "Pass copied.");
  $("adChange").onclick = () => startChangeAdmin(a);
  $("adRenumber").onclick = async () => {
    const n = parseInt($("adShownAs").value || "0", 10);
    if (!(n > 0)) { toast("Pick a number from 1 up."); return; }
    const clash = allAdmins().find((x) => x.id !== a.id && adminShown(x.id) === n);
    if (clash) { toast(`#${n} is already ${clash.name} - renumber that one first.`); return; }
    if (await changePolicy((p) => { p.admins = p.admins || {}; p.admins.displayNumbers = p.admins.displayNumbers || {}; if (n === a.id) delete p.admins.displayNumbers[String(a.id)]; else p.admins.displayNumbers[String(a.id)] = n; }, `admin ${a.id} shown as #${n}`))
      { toast(`${a.name} now shows as #${n} everywhere.`); openAdmin(a); }
  };
  if (off) $("adRemove").onclick = async () => {
    if (!confirm(`Remove ${a.name} (#${adminShown(a.id)}) from the lists? The pass stays switched off.`)) return;
    if (await changePolicy((p) => { p.admins = p.admins || {}; const h = new Set((p.admins.hidden || []).map(Number)); h.add(a.id); p.admins.hidden = [...h]; }, `remove admin ${a.id} from the lists`))
      { toast(`${a.name} removed from the lists.`); $("adDetail").hidden = true; }
  };
  if (off) $("adBackOn").onclick = async () => { await adminSwitch(a.id, false); openAdmin(a); };
  else $("adSwitchOff").onclick = async () => { await adminSwitch(a.id, true); openAdmin(a); };
  $("adDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function startChangeAdmin(a) {
  state.changingAdmin = a.id;
  $("adName").value = a.name;
  fillAdminScope();
  const label = (a.scope || "").split(",")[0].trim();
  const opt = [...$("adScope").options].find((o) => o.text === label || o.text.startsWith(label));
  if (opt) $("adScope").value = opt.value;
  $("adDays").value = "0";
  $("adBanner").hidden = false;
  $("adBanner").innerHTML = `<span class="grow">Changing admin #${a.id}: pick the new scope and days (0 = permanent), then make the pass.</span><button id="adCancelChange">Cancel</button>`;
  $("adCancelChange").onclick = () => { state.changingAdmin = null; $("adBanner").hidden = true; };
  $("adGo").textContent = "Make new pass for #" + adminShown(a.id);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function renderAdmins() {
  fillAdminScope();
  const rv = state.rev && state.rev.serials ? state.rev.serials : [];
  const list = allAdmins();
  $("adminList").innerHTML = list.length ? list.map((a) => {
    const off = rv.includes(L.adminRevocationId(a.id));
    return `<div class="item" data-admin="${a.id}"><div class="ser">#${adminShown(a.id)}</div><div class="who"><div class="name">${esc(a.name)}</div><div class="what">${esc(a.scope)} - made ${esc(a.made)}${a.pass || a.requested ? "" : " (PC)"}</div></div>`
      + `<span class="badge ${off ? "bad" : "good"}">${off ? "OFF" : "ON"}</span></div>`;
  }).join("") : `<div class="empty">No admins yet.${state.data.ghToken ? "" : "<br>Add your GitHub token in Settings to see the ones made on your PC."}</div>`;
  $("adGo").disabled = !canMaster();
  $("adMasterHint").hidden = canMaster();
}
async function makePass() {
  if (!canMaster() && !(await unlockMaster())) return;
  if (!canMaster()) { toast("Your PC hasn't trusted this phone as a master yet."); return; }
  const name = $("adName").value.trim();
  if (!name) { toast("Type the admin's name."); return; }
  const v = $("adScope").value;
  let allowP = 0, allowB = 0;
  if (v.startsWith("e:")) allowB = L.EDITIONS.find((e) => "e:" + e.id === v).bundles; else allowP = Number(v.slice(2));
  const days = parseInt($("adDays").value || "0", 10);
  const lastDay = days > 0 ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + days) : null;
  const changing = state.changingAdmin || null;
  const id = changing || state.data.nextAdmin || phoneIdBase();
  const req = state.approvingReq || null;
  if (req && !changing) {   // approving a phone pass request: certify THEIR key; their secret never leaves their phone
    try {
      const cert = await L.certifyAdmin(id, L.hexToBytes(req.pk), allowP, allowB, lastDay, state.master);
      await adminCall("passapprove", req.id, { cert: L.bytesToHex(cert), name });
      const scope = (allowB ? L.EDITIONS.find((e) => e.bundles === allowB)?.label || "edition" : "selected plug-ins") + (lastDay ? ", until " + L.isoDay(lastDay) : ", permanent");
      state.data.admins = [{ id, name, scope, made: L.isoDay(new Date()), requested: true }, ...(state.data.admins || []).filter((x) => x.id !== id)];
      state.data.nextAdmin = id + 1;
      state.approvingReq = null; $("adBanner").hidden = true; $("adGo").textContent = "Make god-mode pass";
      await save(); $("adName").value = "";
      toast(`${name} is approved - their phone unlocks on its own (admin #${id}).`);
      renderAdmins(); syncAdmins(); loadInbox();
    } catch (e) { toast("Didn't go through: " + e.message); }
    return;
  }
  let pass;
  try { pass = await L.makeAdminPass(name, id, allowP, allowB, lastDay, state.master); } catch (e) { toast(e.message); return; }
  const p = await L.parseAdminPass(pass);
  if (!p.valid) { toast(p.error); return; }
  state.data.admins = [{ id, name, scope: p.scopeText, made: L.isoDay(new Date()), pass }, ...(state.data.admins || []).filter((x) => x.id !== id)];
  if (!changing) state.data.nextAdmin = id + 1;
  state.changingAdmin = null; $("adBanner").hidden = true; $("adGo").textContent = "Make god-mode pass";
  await save();
  $("adName").value = "";
  $("adResult").hidden = false;
  $("adResKey").textContent = pass;
  $("adResInfo").textContent = (changing ? `New pass for admin #${id} (${name}): ` : `God mode for ${name} (admin #${id}): `) + `can issue ${p.scopeText}. They paste it into their Hub's Licence page (or this app).`;
  state.lastPass = pass;
  await copyText(pass, "Pass copied.");
  renderAdmins();
  syncAdmins();
}
async function adminSwitch(id, off) {
  if (!id) return;
  if (!state.data.ghToken && (pol("admins.protected.admins", []) || []).map(Number).includes(id)) { toast(`Admin #${adminShown(id)} is protected - only Sills Audio can switch it.`); return; }
  if (off && !confirm(`Switch off admin #${id}? Every key they issued stops working too.`)) return;
  if (await changeRevocations([L.adminRevocationId(id)], off)) toast(off ? `Admin #${id} switched off.` : `Admin #${id} back on.`);
}

// ------------------------------------------------------------------ helpers / wiring
let toastTimer;
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200); }
async function copyText(t, msg = "Copied.") { try { await navigator.clipboard.writeText(t); toast(msg); return true; } catch { toast("Couldn't copy - long-press the key to select it."); return false; } }
async function shareKey(key, info) {
  const text = `Your Sills Audio licence key:\n\n${key}\n\nOpen Sills Audio Hub > Licence, paste the key and press Activate.`;
  if (navigator.share) { try { await navigator.share({ title: "Sills Audio licence key", text }); return; } catch { return; } }
  copyText(text);
}

function wire() {
  // keypad
  const pad = $("keypad");
  pad.innerHTML = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "erase", "0", "ok"].map((k) =>
    `<button data-k="${k}" class="${k.length > 1 ? "fn" : ""}">${k === "erase" ? "Delete" : k === "ok" ? "Unlock" : k}</button>`).join("");
  pad.addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.k; if (!k) return;
    if (k === "erase") pinBuf = pinBuf.slice(0, -1);
    else if (k === "ok") { if (pinBuf.length >= 6) tryUnlock(); return; }
    else if (pinBuf.length < 12) pinBuf += k;
    drawPin();
  });
  document.addEventListener("keydown", (e) => {
    if ($("lock").hidden) return;
    if (/^\d$/.test(e.key) && pinBuf.length < 12) { pinBuf += e.key; drawPin(); }
    else if (e.key === "Backspace") { pinBuf = pinBuf.slice(0, -1); drawPin(); }
    else if (e.key === "Enter" && pinBuf.length >= 6) tryUnlock();
  });
  $("passInput").addEventListener("input", checkPassInput);
  $("setupGo").onclick = doSetup;
  $("lockBtn").onclick = () => showLock("Locked");
  document.querySelectorAll("nav.bottom button").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  document.querySelectorAll("#typeSeg button").forEach((b) => (b.onclick = () => setType(Number(b.dataset.v))));
  // days and the end date stay in step: either one can be typed
  const endFromDays = () => {
    const d = Math.max(1, parseInt($("days").value || "0", 10));
    const from = state.replacing && state.replacing.lastDay && state.replacing.lastDay > new Date() ? state.replacing.lastDay : new Date();
    $("endDate").value = L.isoDay(new Date(from.getFullYear(), from.getMonth(), from.getDate() + d));
  };
  document.querySelectorAll("#dayChips button").forEach((b) => (b.onclick = () => { $("days").value = b.dataset.d; endFromDays(); }));
  $("days").addEventListener("input", endFromDays);
  $("issueBtn").onclick = issue;
  $("resCopy").onclick = () => state.lastKey && copyText(state.lastKey.key);
  $("resShare").onclick = () => state.lastKey && shareKey(state.lastKey.key, state.lastKey.info);
  $("search").addEventListener("input", renderKeys);
  $("keyList").addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) openSheet(Number(it.dataset.serial)); });
  $("shClose").onclick = () => ($("sheet").hidden = true);
  $("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; });
  $("shCopy").onclick = () => sheetRow && copyText(sheetRow.key);
  $("shShare").onclick = () => sheetRow && shareKey(sheetRow.key);
  $("shReissue").onclick = startReissue;
  $("shRevoke").onclick = () => sheetRevoke(true);
  $("shComputers").onclick = sheetComputers;
  $("inboxRefresh").onclick = () => loadInbox(true);
  $("syncKeys").onclick = () => syncLedger(true);
  $("reqList").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.approve) decide(b.dataset.approve, true); if (b.dataset.deny) decide(b.dataset.deny, false);
    if (b.dataset.passok) startPassApproval(b.dataset.passok); if (b.dataset.passno) denyPass(b.dataset.passno); });
  $("rqGo").onclick = requestPass;
  $("rqCancel").onclick = () => { ls.del("sills.passreq"); renderPassReq(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("setup").hidden) pollPassReq(); });
  $("actUrl").addEventListener("change", () => { const v = $("actUrl").value.trim(); if (v && !/^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/i.test(v)) { toast("That should look like https://....workers.dev"); return; } ls.set("sills.actUrl", v); renderAlerts(); });
  $("alertsOn").onclick = () => alerts(true);
  $("alertsOff").onclick = () => alerts(false);
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data === "inbox" && state.aes) tab("keys"); if (e.data === "tab:settings" && state.aes) tab("settings");
    if (typeof e.data === "string" && e.data.startsWith("review:") && state.aes) { tab("settings"); reviewRequest(e.data.slice(7)); } });
  $("shRestore").onclick = () => sheetRevoke(false);
  $("makeMaster").onclick = makeMaster;
  $("keepMaster").onchange = async () => {
    state.data.keepMaster = $("keepMaster").checked;
    if (!state.data.keepMaster) delete state.data.masterKeep;
    else if (state.master) state.data.masterKeep = L.bytesToHex(state.master);
    await save();
    toast(state.data.keepMaster ? "Master mode stays unlocked on this phone." : "Master mode will ask for the passphrase each time.");
  };
  $("bioOn").onclick = enableBio;
  $("bioOff").onclick = disableBio;
  $("bioBtn").onclick = bioUnlock;
  $("unlockMaster").onclick = unlockMaster;
  $("copyMasterPub").onclick = () => masterPub() && copyText(masterPub(), "Master key copied.");
  $("refreshMasters").onclick = () => refreshMasters().then(() => toast(masterTrusted() ? "Your PC trusts this phone." : "Not trusted yet."));
  $("ghToken").addEventListener("change", async () => {
    const t = $("ghToken").value.trim();
    if (t === "********") return;
    state.data.ghToken = t || null; await save(); renderMaster(); toast(t ? "Token saved (encrypted on this phone)." : "Token removed.");
  });
  $("adGo").onclick = makePass;
  $("adCopy").onclick = () => state.lastPass && copyText(state.lastPass);
  $("adShare").onclick = () => state.lastPass && navigator.share && navigator.share({ title: "Sills Audio god-mode pass", text: state.lastPass }).catch(() => {});
  const boxAdmin = () => { const t = ($("adId").value || "").trim(); if (/^a/i.test(t)) return parseInt(t.slice(1), 10); const id = adminFromShown(parseInt(t || "0", 10)); if (id < 0) toast("That number is ambiguous - type A and the real number."); return id; };
  $("adOff").onclick = () => adminSwitch(boxAdmin(), true);
  $("adOn").onclick = () => adminSwitch(boxAdmin(), false);
  $("adminList").addEventListener("click", async (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const a = allAdmins().find((x) => x.id === Number(it.dataset.admin)); if (!a) return;
    $("adId").value = adminShown(a.id);
    openAdmin(a);
  });
  $("checkBtn").onclick = check;
  $("nextSerial").addEventListener("change", async () => { const n = Math.max(1, Math.min(1048575, parseInt($("nextSerial").value || "1", 10))); state.data.nextN = n; await save(); updateSerial(); });
  $("importCsv").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ""; });
  $("exportCsv").onclick = exportCsv;
  $("refreshRev").onclick = () => refreshRevocations(true);
  $("lockAfter").onchange = () => ls.set("sills.lockAfter", Number($("lockAfter").value));
  $("replacePass").onclick = () => { show("setup"); renderPassReq(); $("passInfo").textContent = "Paste the new pass and choose a PIN. Your key list stays."; };
  $("changePin").onclick = () => { show("setup"); $("passInput").value = state.passText; checkPassInput(); };
  $("eraseAll").onclick = () => {
    if (!confirm("Erase the admin pass and every key stored on this phone? Keys you've already given out keep working.")) return;
    ls.del("sills.vault"); ls.del("sills.fails"); ls.del("sills.bio");
    state.aes = null; state.pass = null; state.master = null; state.data = { rows: [], nextN: 1 };
    show("setup");
  };
  // auto lock
  const touch = () => (state.lastActive = Date.now());
  ["pointerdown", "keydown", "scroll"].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  setInterval(() => { if (state.aes && Date.now() - state.lastActive > ls.get("sills.lockAfter", 300) * 1000) showLock("Locked after inactivity"); }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.aes && Date.now() - state.lastActive > ls.get("sills.lockAfter", 300) * 1000) showLock("Locked"); });
}

boot();

// ------------------------------------------------------------------ phone pass requests
// New phone: make an admin key pair here, send the PUBLIC half to the activation service, wait for the owner to approve on his
// phone (he gets a notification), then join his certificate with our own secret = a working pass. The secret stays on this phone.
async function requestPass() {
  const name = $("rqName").value.trim();
  if (!name) { toast("Type your name."); return; }
  try {
    const kp = await L.generateMaster();
    const res = await fetch(actUrl() + "/pass-request", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, note: $("rqNote").value.trim(), pk: kp.publicHex }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    ls.set("sills.passreq", { id: j.id, pk: kp.publicHex, secret: L.bytesToHex(kp.secret), name, at: Date.now() });
    toast("Request sent - you'll be let in as soon as it's approved.");
  } catch (e) { toast("Couldn't send it: " + e.message); }
  renderPassReq(); pollPassReq();
}
let passPoll = 0;
async function pollPassReq() {
  const r = ls.get("sills.passreq", null);
  clearTimeout(passPoll);
  if (!r || $("setup").hidden) return;
  try {
    const res = await fetch(actUrl() + "/pass-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id, pk: r.pk }) });
    const j = await res.json();
    if (j.status === "approved" && j.cert) {
      await loadMasters();   // the cert is signed by the owner's phone: trust it first
      const text = L.passText(L.hexToBytes(j.cert), L.hexToBytes(r.secret), j.name || r.name);
      $("passInput").value = text;
      const p = await checkPassInput();
      if (p) { ls.set("sills.passreq", { ...r, done: true }); renderPassReq("Approved! Choose a PIN below to finish."); $("pin1").focus(); return; }
    } else if (j.status === "denied" || j.error === "unknown request") {
      ls.del("sills.passreq"); renderPassReq(j.status === "denied" ? "Your request was declined." : "The request expired - send a new one."); return;
    }
  } catch { /* offline: try again later */ }
  renderPassReq();
  passPoll = setTimeout(pollPassReq, 8000);
}
function renderPassReq(msg) {
  const r = ls.get("sills.passreq", null);
  const waiting = !!(r && !r.done);
  $("rqForm").hidden = waiting;
  $("rqWait").hidden = !waiting;
  if (waiting) $("rqWaitText").textContent = `Waiting for approval (asked as "${r.name}")...`;
  if (msg !== undefined) $("rqStatus").textContent = msg;
}
async function startPassApproval(id) {
  const req = (state.passReqs || []).find((x) => x.id === id);
  if (!req) return;
  state.approvingReq = req; state.changingAdmin = null;
  tab("admins");
  $("adName").value = req.name; $("adDays").value = "0";
  $("adBanner").textContent = `Approving ${req.name}'s phone: pick what they may issue, then press Approve.`;
  $("adBanner").hidden = false;
  $("adGo").textContent = "Approve " + req.name;
}
async function denyPass(id) {
  try { await adminCall("passdeny", id); toast("Request declined."); } catch (e) { toast("Didn't go through: " + e.message); }
  loadInbox();
}

// ------------------------------------------------------------------ admins without GitHub: share issued keys with the owner
// Signed with this phone's admin pass; the activation service only accepts keys this admin really issued, and only the owner
// (master) can read them back. Admins never see other people's keys and can't remove anything.
async function shareKeys(loud) {
  if (!state.pass || !state.pass.valid) return;
  const rows = state.data.rows.filter((r) => r.issuer === state.pass.adminId).map((r) => ({ serial: r.serial, issued: r.issued, licensee: r.licensee,
    type: r.type, products: r.products, expires: r.expires, key: r.key, note: r.note || "" }));
  if (!rows.length) { syncStatus("Keys you issue are shared with Sills Audio automatically."); return; }
  try {
    const ts = Math.floor(Date.now() / 1000);
    const h = L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)))));
    const sig = await L.signBytes(state.pass.secret, new TextEncoder().encode(`sills-adminkeys|${h}|${ts}`));
    const res = await fetch(actUrl() + "/admin-keys", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cert: L.bytesToHex(state.pass.cert), rows, ts, sig: L.bytesToHex(sig) }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    syncStatus(`Shared with Sills Audio ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${j.total} key${j.total === 1 ? "" : "s"}.`);
    if (loud) toast("Your keys are shared with Sills Audio.");
  } catch (e) { syncStatus("Couldn't share your keys yet (" + e.message + ") - it retries next time.", true); }
}

// ------------------------------------------------------------------ admins: read the whole list, ask for revokes (protected keys excluded)
function isProtectedRow(r) {
  const pr = pol("admins.protected", {}) || {};
  if ((pr.serials || []).map(Number).includes(r.serial)) return true;
  const who = String(r.licensee || "").toLowerCase();
  return (pr.licensees || []).some((n) => n && who.startsWith(String(n).toLowerCase().trim()));
}
async function signAsAdmin(purpose, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const h = L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))));
  const sig = await L.signBytes(state.pass.secret, new TextEncoder().encode(`sills-${purpose}|${h}|${ts}`));
  return { cert: L.bytesToHex(state.pass.cert), ts, sig: L.bytesToHex(sig) };
}
async function readLedger(loud) {
  if (!state.pass || !state.pass.valid) return;
  try {
    const res = await fetch(actUrl() + "/ledger-read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await signAsAdmin("ledger-read", "")) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    let added = 0;
    if (Array.isArray(j.admins)) { sharedAdmins = j.admins; renderAdmins(); }
    if (j.status) state.install = j.status;
    for (const r of j.rows || []) {
      const mine = state.data.rows.find((x) => x.serial === r.serial);
      if (mine) { if ((r.note || "").length > (mine.note || "").length) mine.note = r.note; continue; }
      const info = await L.verifyKey(r.key);
      if (!info.valid && !info.expired) continue;
      state.data.rows.push({ serial: info.serial, issued: r.issued, licensee: info.licensee, type: info.typeName, products: info.productText,
        expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key: r.key, note: r.note || "", source: "shared", issuer: info.issuerId });
      ++added;
    }
    state.data.rows.sort((a, b) => (b.issued || "").localeCompare(a.issued || "") || b.serial - a.serial);
    await save(); renderKeys();
    syncStatus(`Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${(j.rows || []).length} keys in the Sills Audio list` + (added ? `, ${added} new here.` : "."));
    if (loud) toast("Key list synced.");
  } catch (e) { syncStatus("Couldn't load the key list (" + e.message + ").", true); }
}
async function adminRevoke(serials, revoke) {
  const list = serials.map(Number).filter((n) => n > 0 && n < 0x80000000);
  const blocked = list.filter((n) => { const r = state.data.rows.find((x) => x.serial === n); return !r || isProtectedRow(r); });
  if (blocked.length) { toast("Protected key - only Sills Audio can change #" + blocked.join(", #") + "."); return false; }
  try {
    const res = await fetch(actUrl() + "/admin-revoke", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ serials: list, revoke, ...(await signAsAdmin("revoke", JSON.stringify({ serials: list, revoke }))) }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    if (j.refused && j.refused.length) toast("Protected - not changed: #" + j.refused.join(", #"));
    else toast((revoke ? "Revoke" : "Restore") + " sent - it takes effect as soon as Sills Audio confirms it (usually within minutes).");
    return !!(j.queued && j.queued.length);
  } catch (e) { toast("Didn't go through: " + e.message); return false; }
}
/** Owner: keep the admins' read-only copy current and carry out their revoke / restore requests (signed here, published to GitHub). */
async function ownerServiceSync() {
  const rows = state.data.rows.map((r) => ({ serial: r.serial, issued: r.issued, licensee: r.licensee, type: r.type, products: r.products, expires: r.expires, key: r.key, note: r.note || "" }));
  const admins = allAdmins().map((a) => ({ id: a.id, name: a.name, scope: a.scope || "", made: a.made || "" }));   // never the passes themselves
  const h = L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ rows, admins }))))).slice(0, 32);
  await adminCall("ledgerput", h, { rows, admins });
  const q = (await adminCall("revq")).queue || [];
  if (!q.length) return;
  const done = [];
  const isProt = (x) => x.serial >= 0x80000000 ? (pol("admins.protected.admins", []) || []).map(Number).includes(x.serial - 0x80000000)
    : isProtectedRow(state.data.rows.find((r) => r.serial === x.serial) || { serial: x.serial, licensee: "" });
  for (const revoke of [true, false]) {
    const items = q.filter((x) => x.revoke === revoke && !isProt(x));
    if (items.length && (await changeRevocations(items.map((x) => x.serial), revoke))) done.push(...items.map((x) => x.qid));
  }
  // protected ones that slipped in are dropped
  for (const x of q) if (isProt(x)) done.push(x.qid);
  if (done.length) {
    const dh = L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(done))))).slice(0, 32);
    await adminCall("revqdone", dh, { done });
    toast(`Applied ${done.length} admin request${done.length === 1 ? "" : "s"}.`);
  }
}

/** Each trusted phone gets its own block of admin ids (2048+256 per phone, in masters.txt order) so two phones never clash. */
function phoneIdBase() {
  const base = pol("admins.phoneIdBase", PHONE_ADMIN_BASE);
  const idx = state.masters && state.masters.ok ? state.masters.masters.findIndex((m) => m.hex === masterPub()) : -1;
  return base + 256 * Math.max(0, idx);
}
/** Demi-god master without GitHub: revoke / restore / switch admins through the activation service (protected ones refused there). */
async function masterQueue(serials, revoke) {
  const list = serials.map(Number).filter((n) => n > 0);
  const blocked = list.filter((n) => n < 0x80000000 && isProtectedRow(state.data.rows.find((x) => x.serial === n) || { serial: n, licensee: "" }));
  if (blocked.length) { toast("Protected key - only Sills Audio can change #" + blocked.join(", #") + "."); return false; }
  try {
    const h = L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ serials: list, revoke }))))).slice(0, 32);
    const j = await adminCall("queuerevoke", h, { serials: list, revoke });
    if (j.refused && j.refused.length) toast("Protected - not changed: " + j.refused.map((n) => n >= 0x80000000 ? "admin #" + adminShown(n - 0x80000000) : "#" + n).join(", "));
    else toast((revoke ? "Switch-off / revoke" : "Restore") + " sent - it takes effect as soon as Sills Audio confirms it (usually within minutes).");
    return !!(j.queued && j.queued.length);
  } catch (e) { toast("Didn't go through: " + e.message); return false; }
}

// ------------------------------------------------------------------ install status (from the activation service)
const PRODUCT_NAMES = { "hub": "Hub", "mixcoach": "Mix Coach", "mixcoach-ara": "Mix Coach ARA", "console": "Console Strip", "buscomp": "Bus Comp",
  "eq": "Sills EQ", "comp": "Sills Comp", "vintageeq": "Vintage EQ", "chamber": "Chamber", "tune": "Tune", "headless-horseman": "Headless Horseman",
  "finisher": "Finisher", "suite": "Ultimate Suite", "production-suite": "Production Suite", "mixing-suite": "Mixing Suite", "mastering-suite": "Mastering Suite" };
function ago(t) {
  const m = Math.max(0, (Date.now() - t) / 60000);
  return m < 90 ? Math.round(m) + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
}
function installLine(serial) {
  const st = (state.install || {})[serial];
  if (!state.install) return "";
  if (!st || !st.machines.length) return `<div class="inst none">Not installed yet${st && st.pending ? " - asked for a 2nd computer" : ""}</div>`;
  const seen = Math.max(...st.machines.map((m) => m.seen || m.at || 0));
  const fresh = Date.now() - seen < 3 * 86400000;
  return `<div class="inst ${fresh ? "on" : "old"}">Installed on ${st.machines.length} of ${st.slots} - seen ${ago(seen)}${st.pending ? " - wants a 2nd computer" : ""}</div>`;
}
function installDetail(serial) {
  const st = (state.install || {})[serial];
  if (!state.install) return "";
  if (!st || !st.machines.length) return `<div class="instCard"><b>Not installed yet</b><div class="dim">The key hasn't been put into a Sills Audio Hub.</div></div>`;
  return `<div class="instCard"><b>Installed on ${st.machines.length} of ${st.slots} computer${st.slots === 1 ? "" : "s"}</b>` + st.machines.map((m) =>
    `<div class="instPc"><div><b>${esc(m.name)}</b> <span class="dim">- seen ${ago(m.seen || m.at)}</span></div>`
    + `<div class="dim">Activated ${new Date(m.at).toLocaleDateString()}${m.hub ? " - Hub " + esc(m.hub) : ""}${m.os ? " - " + esc(m.os) : ""}</div>`
    + (m.products && m.products.length ? `<div class="chips">${m.products.map((p) => `<span class="chip">${esc(PRODUCT_NAMES[p.id] || p.id)} ${esc(p.v)}</span>`).join("")}</div>`
                                       : `<div class="dim">Plug-in list arrives with its next check-in (Hub 0.4.28+).</div>`) + `</div>`).join("") + `</div>`;
}

// ------------------------------------------------------------------ update requests (owner): kept by the activation service
// (moved from requests.json in sills-ledger in phone 1.11 - the cloud build assistant can't reach that repo). A scheduled Claude
// task checks them every hour, plans / builds on the PC and marks each request's status; this phone checks every 5 s while open.
const REQ_FILE = "requests.json";
const reqHash = async (v) => L.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))))).slice(0, 32);
const reqOwner = () => !!(actUrl() && state.data.master);
async function importLedgerRequests() {   // once per phone: copy over what requests.json in sills-ledger still had
  if (ls.get("sills.reqImported", false) || !state.data.ghToken) return;
  try {
    const res = await ghFetch(REQ_FILE + "?ref=main", { cache: "no-store" }, LEDGER_API_FOR());
    let list = [];
    if (res.ok) { try { list = JSON.parse(b64ToText((await res.json()).content)); } catch {} }
    if (Array.isArray(list) && list.length) { const requests = list.slice(-300); await adminCall("reqimport", await reqHash({ requests }), { requests }); }
    ls.set("sills.reqImported", true);
  } catch {}   // try again next time
}
async function loadRequests() {
  await importLedgerRequests();
  const list = (await adminCall("reqget")).requests;
  return Array.isArray(list) ? list : [];
}
async function reqEdit(edits) {
  const list = (await adminCall("reqedit", await reqHash(edits), { edits, from: "phone" })).requests;
  return Array.isArray(list) ? list : [];
}
const REQ_LABEL = { awaiting: ["Needs your OK", "bad"], approved: ["Approved - building next run", "warn"], rejected: ["Rejected", ""], queued: ["Queued", "warn"], working: ["Claude is on it", "warn"], built: ["Built - installing on your PC", "good"], done: ["Done", "good"], question: ["Needs you", "bad"], failed: ["Didn't work", "bad"] };
let reqBusy = false, reqShownJson = "";
const reqSeen = new Set();   // plans the pop-up already opened for (Later doesn't bring it back every 5 s)
const reqPick = {};   // inline feature ticks per request id, so the 5-second redraw doesn't undo them
function reqItem(r) {
  const [label, cls] = REQ_LABEL[r.status] || [r.status, ""];
  const id = esc(r.id), feats = Array.isArray(r.features) ? r.features : [], picks = reqPick[r.id] || {};
  let h = `<div class="reqItem"><div><span class="badge ${cls}">${esc(label)}</span> <span class="dim">${when(r.at)}${r.version ? " - v" + esc(r.version) : ""}</span></div>`
    + `<div class="reqText">${esc(r.text)}</div>`;
  if (r.plan && ["awaiting", "approved", "working"].includes(r.status)) h += `<div class="dim">Plan: ${esc(r.plan)}</div>`;
  if (r.reply) h += `<div class="dim">Claude: ${esc(r.reply)}</div>`;
  if (r.status === "awaiting") {
    if (feats.length) h += `<div class="reqFeats">` + feats.map((f, i) => {
      const fid = String(f.id || i), on = fid in picks ? picks[fid] : f.on !== false;
      return `<label class="feat"><input type="checkbox" data-rid="${id}" data-fid="${esc(fid)}" ${on ? "checked" : ""}><span>${esc(f.label || fid)}</span></label>`;
    }).join("") + `</div>`;
    h += `<div class="row reqBtns"><button class="primaryLite small" data-ok="${id}">Approve</button><button class="danger small" data-no="${id}">Reject</button><button class="small" data-review="${id}">Note</button></div>`;
  } else if (r.status === "queued" || r.status === "question") {
    h += `<div class="row reqBtns"><button class="danger small" data-cancel="${id}" data-st="${esc(r.status)}">Cancel request</button></div>`;
  }
  return h + `</div>`;
}
/** The list scrolls and is cut to about 4 requests high (newest first). */
function fitReqList() {
  const l = $("updList"), items = l.querySelectorAll(".reqItem");
  if (items.length <= 4) { l.style.maxHeight = "none"; return; }
  const top = items[4].offsetTop;   // #updList is position: relative, so this is the 5th item's top inside the list
  l.style.maxHeight = top > 40 ? top + "px" : "";   // hidden tab (0) -> the CSS default
}
function drawRequests(list) {
  const recent = list.slice(-100);
  const js = JSON.stringify(recent);
  if (js === reqShownJson) { fitReqList(); return; }
  reqShownJson = js;
  const l = $("updList"), scroll = l.scrollTop;
  l.innerHTML = recent.slice().reverse().map(reqItem).join("") || `<p class="dim">No requests yet.</p>`;
  l.scrollTop = scroll;
  fitReqList();
}
/** quiet = the 5-second check: no unlock prompt, no error text, and a newly waiting plan opens the approval pop-up. */
async function renderRequests(quiet) {
  const card = $("reqCard");
  card.hidden = !reqOwner();
  if (card.hidden || reqBusy) return;
  if (!canMaster()) { if (!quiet) { reqShownJson = ""; $("updList").innerHTML = `<p class="small dim">Unlock master mode to see your update requests.</p>`; } return; }
  reqBusy = true;
  try {
    const list = await loadRequests();
    drawRequests(list);
    const waiting = list.find((r) => r.status === "awaiting" && !reqSeen.has(r.id));
    if (quiet && waiting && $("reqSheet").hidden) openReview(waiting);
  } catch (e) {
    if (!quiet) { reqShownJson = ""; $("updList").textContent = /unknown serial/.test(e.message)
      ? "The activation service needs updating: run 4-setup-activation.bat on your PC once." : "Couldn't load requests: " + e.message; }
  }
  reqBusy = false;
}
setInterval(() => { if (document.visibilityState === "visible" && canMaster() && reqOwner()) renderRequests(true); }, 5000);
async function sendRequest() {
  const text = $("reqText").value.trim();
  if (!text) { toast("Type what you'd like changed."); return; }
  $("reqSend").disabled = true;
  try {
    const list = await reqEdit([{ add: text }]);
    drawRequests(list);
    $("reqText").value = ""; toast("Sent - Claude picks it up within the hour.");
  } catch (e) { toast("Didn't send: " + e.message); }
  $("reqSend").disabled = false;
}
{ const b = document.getElementById("reqSend"); if (b) b.onclick = sendRequest; }
{ const b = document.getElementById("alertsAskBtn"); if (b) b.onclick = async () => { $("alertsAsk").hidden = true; await alerts(true); }; }
// tap twice for anything that can't be undone (Reject / Cancel): the first tap arms the button for 3 seconds
function armed(b, text) {
  if (b.dataset.armed) return true;
  b.dataset.armed = "1"; const was = b.textContent; b.textContent = text;
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = was; } }, 3000);
  return false;
}
{ const l = document.getElementById("updList");
  if (l) {
    l.addEventListener("change", (e) => { const c = e.target; if (! c.dataset || ! c.dataset.rid) return; (reqPick[c.dataset.rid] ||= {})[c.dataset.fid] = c.checked; });
    l.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.review) { reviewRequest(b.dataset.review); return; }
      if (b.dataset.ok) {
        const id = b.dataset.ok, boxes = [...l.querySelectorAll("input[data-rid]")].filter((c) => c.dataset.rid === id);
        const include = boxes.filter((c) => c.checked).map((c) => c.dataset.fid);
        if (boxes.length && !include.length) { toast("Tick at least one part, or tap Reject."); return; }
        b.disabled = true; await decideRequest(id, "approved", boxes.length ? include : undefined); delete reqPick[id]; b.disabled = false; return;
      }
      if (b.dataset.no) { if (!armed(b, "Sure?")) return; b.disabled = true; await decideRequest(b.dataset.no, "rejected"); return; }
      if (b.dataset.cancel) {
        if (!armed(b, "Tap again to cancel")) return;
        b.disabled = true;
        try {
          const list = await reqEdit([{ id: b.dataset.cancel, set: { status: "rejected", reply: "Cancelled from the phone." }, ifStatus: b.dataset.st }]);
          drawRequests(list); toast("Request cancelled.");
        } catch (err) { toast("Didn't go through: " + err.message); b.disabled = false; }
      }
    });
  } }
async function decideRequest(id, status, include, note) {
  try {
    const set = { status };
    if (Array.isArray(include)) set.include = include;
    if (note) set.note = note;
    const list = await reqEdit([{ id, set, ifStatus: "awaiting" }]);
    drawRequests(list);
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error("request not found");
    if (r.status !== status) toast("That request was already decided (" + ((REQ_LABEL[r.status] || [r.status])[0]) + ").");
    else toast(status === "approved" ? "Approved - Claude builds it on its next run (within the hour)." : "Rejected.");
  } catch (e) { toast("Didn't go through: " + e.message); }
}

// ------------------------------------------------------------------ approval pop-up (opens by itself when a plan is waiting)
let reviewing = null;
async function reviewRequest(id) {
  if (!reqOwner() || !canMaster()) return;
  let list;
  try { list = await loadRequests(); } catch { return; }
  const r = id ? list.find((x) => x.id === id) : list.find((x) => x.status === "awaiting");
  if (!r || r.status !== "awaiting") { if (id) toast("That request has already been decided."); return; }
  openReview(r);
}
function openReview(r) {
  reviewing = r; reqSeen.add(r.id);
  $("rsAsk").textContent = "You asked: " + r.text;
  $("rsWhen").textContent = when(r.at);
  $("rsPlan").textContent = r.plan || "(no plan text)";
  const feats = Array.isArray(r.features) ? r.features : [];
  $("rsFeatWrap").hidden = !feats.length;
  $("rsFeatures").innerHTML = feats.map((f, i) => `<label class="feat"><input type="checkbox" data-fid="${esc(f.id || String(i))}" ${f.on === false ? "" : "checked"}><span>${esc(f.label || f.id)}</span></label>`).join("");
  $("rsNote").value = "";
  $("reqSheet").hidden = false;
}
function closeReview() { $("reqSheet").hidden = true; reviewing = null; }
{ const g = (id) => document.getElementById(id);
  if (g("rsApprove")) {
    g("rsApprove").onclick = async () => {
      if (!reviewing) return;
      const boxes = [...document.querySelectorAll("#rsFeatures input[data-fid]")];
      const include = boxes.filter((b) => b.checked).map((b) => b.dataset.fid);
      if (boxes.length && !include.length) { toast("Tick at least one part, or tap Reject."); return; }
      const id = reviewing.id, note = g("rsNote").value.trim();
      closeReview();
      await decideRequest(id, "approved", boxes.length ? include : undefined, note);
    };
    g("rsReject").onclick = async () => { if (!reviewing) return; const id = reviewing.id, note = g("rsNote").value.trim(); closeReview(); await decideRequest(id, "rejected", undefined, note); };
    g("rsLater").onclick = closeReview;
    g("reqSheet").addEventListener("click", (e) => { if (e.target.id === "reqSheet") closeReview(); });
  } }
