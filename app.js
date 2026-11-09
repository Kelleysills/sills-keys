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
  wire();
  if (ls.get("sills.vault")) showLock(); else show("setup");
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
  $("passInput").value = ""; $("pin1").value = ""; $("pin2").value = "";
  enterMain();
}

// ------------------------------------------------------------------ lock
let pinBuf = "";
function showLock(msg) {
  state.aes = null; state.pass = null; state.passText = ""; state.master = null;
  pinBuf = ""; drawPin();
  $("lockMsg").textContent = msg || "Enter your PIN";
  show("lock");
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
    const key = await deriveKey(pinBuf, salt);
    const inner = await unseal(key, v);
    state.aes = key; state.salt = salt; state.passText = inner.passText; state.data = inner.data || { rows: [], nextN: 1 };
    state.pass = await L.parseAdminPass(state.passText);
    ls.set("sills.fails", { n: 0, until: 0 });
    enterMain();
  } catch {
    const n = fails.n + 1;
    ls.set("sills.fails", { n, until: n >= 5 ? Date.now() + 30000 * Math.pow(2, n - 5) : 0 });
    $("lockMsg").textContent = n >= 5 ? "Wrong PIN - locked for a while" : "Wrong PIN";
    pinBuf = ""; drawPin();
    navigator.vibrate?.(120);
  }
}

// ------------------------------------------------------------------ main
function enterMain() {
  show("main");
  state.lastActive = Date.now();
  fillWhat();
  updateSerial();
  renderPassCard();
  renderKeys();
  refreshMasters().then(() => refreshRevocations(false));
  renderMaster(); renderAdmins(); renderAlerts();
  if (new URLSearchParams(location.search).get("tab") === "keys") tab("keys");
  $("lockAfter").value = String(ls.get("sills.lockAfter", 300));
  if (state.pass && state.pass.ended) toast(state.pass.error + " Make a new pass on your PC.");
}

function tab(name) {
  for (const t of ["issue", "keys", "admins", "check", "settings"]) $("tab-" + t).hidden = t !== name;
  document.querySelectorAll("nav.bottom button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("topTitle").textContent = { issue: "Issue a key", keys: "Keys", admins: "God mode", check: "Check a key", settings: "Settings" }[name];
  if (name === "keys") { renderKeys(); loadInbox(); syncLedger(false); }
  if (name === "admins") renderAdmins();
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
    const d = Math.max(1, parseInt($("days").value || "0", 10));
    const from = state.replacing && state.replacing.lastDay && state.replacing.lastDay > new Date() ? state.replacing.lastDay : new Date();
    req.lastDay = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
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
      + `<div class="what">${esc(r.products)} - ${esc(r.type)}${r.expires !== "never" ? " - ends " + esc(r.expires) : ""}${r.source === "pc" ? " - PC" : ""}</div></div>`
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
    + (info.valid ? "" : `<p class="note err">${esc(info.error)}</p>`);
  const isRevoked = st === "REVOKED";
  $("shRevoke").hidden = isRevoked; $("shRestore").hidden = !isRevoked;
  $("shRevoke").disabled = $("shRestore").disabled = !canMaster();
  $("shMasterHint").hidden = canMaster();
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
  $("days").value = info.type === 2 ? 30 : 30;
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
async function refreshMasters() {
  try {
    const res = await fetch(MASTERS_URL, { cache: "no-store" });
    const v = res.ok ? await L.verifyTrustedMasters(await res.text()) : { ok: false };
    const cached = ls.get("sills.masters");
    if (v.ok && (!cached || !cached.ok || v.seq >= cached.seq)) { state.masters = v; ls.set("sills.masters", v); }
    else state.masters = cached;
  } catch { state.masters = ls.get("sills.masters"); }
  L.setExtraRoots(state.masters && state.masters.ok ? state.masters.masters.map((m) => m.hex) : []);
  renderMaster(); fillWhat(); renderKeys();
}
async function askPassphrase(title, twice) {
  return new Promise((resolve) => {
    $("ppTitle").textContent = title;
    $("pp1").value = ""; $("pp2").value = ""; $("pp2Row").hidden = !twice;
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
}
const LEDGER_API = "https://api.github.com/repos/Kelleysills/sills-ledger/contents/";
async function ghFetch(path, opts = {}, base = API) {
  const res = await fetch(base + path, { ...opts, headers: { Authorization: "Bearer " + state.data.ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
  if (!res.ok && res.status !== 404) throw new Error(res.status === 401 ? "GitHub token rejected" : res.status === 403 ? (base === API ? "token can't write to the releases repo" : "token can't reach sills-ledger") : "GitHub " + res.status);
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
  if (!state.data.ghToken) { syncStatus("No GitHub token yet - add it in Settings > Master mode.", true); if (loud) toast("Add your GitHub token in Settings first."); return; }
  syncing = true; syncStatus("Syncing with your PC's list...");
  try {
    // a token without access to a private repo gets "404 not found", not 403 - check the repo itself first
    const repoRes = await fetch("https://api.github.com/repos/Kelleysills/sills-ledger", { cache: "no-store", headers: { Authorization: "Bearer " + state.data.ghToken, Accept: "application/vnd.github+json" } });
    if (repoRes.status === 401) throw new Error("GitHub token rejected - make a new one");
    if (!repoRes.ok) throw new Error("your token can't see sills-ledger - edit the token on GitHub and add that repo (Contents: Read and write)");
    const cur = await ghFetch("keys.csv?ref=main", { cache: "no-store" }, LEDGER_API);
    let sha, text = "";
    if (cur.status !== 404) { const j = await cur.json(); sha = j.sha; text = b64ToText(j.content); }
    const remote = new Map();
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const c = parseCsvLine(line); const serial = Number(c[0]);
      if (serial > 0 && c[6]) remote.set(serial, { line, c });
    }
    let added = 0, changed = false;
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
      const putRes = await ghFetch("keys.csv", { method: "PUT", body: JSON.stringify({ message: `Sync key ledger (phone, ${outgoing.length})`, content: textToB64(body), ...(sha ? { sha, branch: "main" } : {}) }) }, LEDGER_API);   // an empty repo has no main yet
      if (!putRes.ok) throw new Error("couldn't save to sills-ledger (GitHub " + putRes.status + ") - the token needs Contents: Read and write");
    }
    if (changed) { state.data.rows.sort((a, b) => (b.issued || "").localeCompare(a.issued || "") || b.serial - a.serial); await save(); }
    state.data.lastSync = Date.now();
    renderKeys();
    syncStatus(`Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${remote.size} key${remote.size === 1 ? "" : "s"} in the shared list` + (added ? `, ${added} new here.` : "."));
    if (loud) toast(`Key list synced${added ? ` - ${added} new from your PC` : ""}.`);
  } catch (e) { syncStatus("Sync failed: " + e.message, true); if (loud) toast("Sync: " + e.message); }
  finally { syncing = false; }
}

/** add (revoke) or remove (restore) serials in the published list, signed with this phone's master key */
async function changeRevocations(serials, revoke) {
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
const actUrl = () => (ls.get("sills.actUrl", "") || "").replace(/\/+$/, "");
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
    const [r, e] = await Promise.all([adminCall("requests"), adminCall("events")]);
    $("reqList").innerHTML = r.requests.length ? r.requests.map((x) =>
      `<div class="req"><div><b>#${x.serial}</b> ${esc(x.licensee)} wants a 2nd computer: <b>${esc(x.pending.name)}</b>`
      + (x.pending.note ? `<div class="dim">"${esc(x.pending.note)}"</div>` : "") + `<div class="dim">${when(x.pending.at)} - now on ${esc(x.machines.map((m) => m.name).join(", ") || "none")}</div></div>`
      + `<div class="row"><button class="primaryLite" data-approve="${x.serial}">Approve</button><button data-deny="${x.serial}">Deny</button></div></div>`).join("")
      : `<p class="small dim">No requests waiting.</p>`;
    const label = { activated: "activated on", blocked: "was blocked on", request: "asked for" };
    $("evList").innerHTML = e.events.slice(0, 40).map((x) => `<div>${when(x.at)} - #${x.serial} ${esc(x.licensee)} ${label[x.type] || x.type} ${esc(x.name || "")}</div>`).join("") || "Nothing yet.";
    const n = r.requests.length;
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
function renderAdmins() {
  fillAdminScope();
  const rv = state.rev && state.rev.serials ? state.rev.serials : [];
  const list = state.data.admins || [];
  $("adminList").innerHTML = list.length ? list.map((a) => {
    const off = rv.includes(L.adminRevocationId(a.id));
    return `<div class="item" data-admin="${a.id}"><div class="ser">A${a.id}</div><div class="who"><div class="name">${esc(a.name)}</div><div class="what">${esc(a.scope)} - made ${esc(a.made)}</div></div>`
      + `<span class="badge ${off ? "bad" : "good"}">${off ? "OFF" : "ON"}</span></div>`;
  }).join("") : `<div class="empty">God-mode passes made on this phone show up here.<br>To switch off one made on your PC, type its number below.</div>`;
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
  const id = state.data.nextAdmin || PHONE_ADMIN_BASE;
  let pass;
  try { pass = await L.makeAdminPass(name, id, allowP, allowB, lastDay, state.master); } catch (e) { toast(e.message); return; }
  const p = await L.parseAdminPass(pass);
  if (!p.valid) { toast(p.error); return; }
  state.data.admins = [{ id, name, scope: p.scopeText, made: L.isoDay(new Date()), pass }, ...(state.data.admins || [])];
  state.data.nextAdmin = id + 1;
  await save();
  $("adName").value = "";
  $("adResult").hidden = false;
  $("adResKey").textContent = pass;
  $("adResInfo").textContent = `God mode for ${name} (admin #${id}): can issue ${p.scopeText}. They paste it into their Hub's Licence page (or this app).`;
  state.lastPass = pass;
  await copyText(pass, "Pass copied.");
  renderAdmins();
}
async function adminSwitch(id, off) {
  if (!id) return;
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
  document.querySelectorAll("#dayChips button").forEach((b) => (b.onclick = () => { $("days").value = b.dataset.d; }));
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
  $("reqList").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.approve) decide(b.dataset.approve, true); if (b.dataset.deny) decide(b.dataset.deny, false); });
  $("actUrl").addEventListener("change", () => { const v = $("actUrl").value.trim(); if (v && !/^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/i.test(v)) { toast("That should look like https://....workers.dev"); return; } ls.set("sills.actUrl", v); renderAlerts(); });
  $("alertsOn").onclick = () => alerts(true);
  $("alertsOff").onclick = () => alerts(false);
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data === "inbox" && state.aes) tab("keys"); });
  $("shRestore").onclick = () => sheetRevoke(false);
  $("makeMaster").onclick = makeMaster;
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
  $("adOff").onclick = () => adminSwitch(parseInt($("adId").value || "0", 10), true);
  $("adOn").onclick = () => adminSwitch(parseInt($("adId").value || "0", 10), false);
  $("adminList").addEventListener("click", async (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const a = (state.data.admins || []).find((x) => x.id === Number(it.dataset.admin)); if (!a) return;
    $("adId").value = a.id; state.lastPass = a.pass;
    $("adResult").hidden = false; $("adResKey").textContent = a.pass; $("adResInfo").textContent = `${a.name} (admin #${a.id}): ${a.scope}.`;
  });
  $("checkBtn").onclick = check;
  $("nextSerial").addEventListener("change", async () => { const n = Math.max(1, Math.min(1048575, parseInt($("nextSerial").value || "1", 10))); state.data.nextN = n; await save(); updateSerial(); });
  $("importCsv").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ""; });
  $("exportCsv").onclick = exportCsv;
  $("refreshRev").onclick = () => refreshRevocations(true);
  $("lockAfter").onchange = () => ls.set("sills.lockAfter", Number($("lockAfter").value));
  $("replacePass").onclick = () => { show("setup"); $("passInfo").textContent = "Paste the new pass and choose a PIN. Your key list stays."; };
  $("changePin").onclick = () => { show("setup"); $("passInput").value = state.passText; checkPassInput(); };
  $("eraseAll").onclick = () => {
    if (!confirm("Erase the admin pass and every key stored on this phone? Keys you've already given out keep working.")) return;
    ls.del("sills.vault"); ls.del("sills.fails");
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
