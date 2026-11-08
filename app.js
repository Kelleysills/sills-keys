// Sills Licence Manager (phone). Holds one admin pass, encrypted with a PIN; issues, looks up and re-issues keys.
import * as L from "./core.js";

const $ = (id) => document.getElementById(id);
const REVOKED_URL = "https://raw.githubusercontent.com/Kelleysills/sills-audio-releases/main/revoked.txt";
const ls = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast("Couldn't save on this phone (storage full or blocked)."); } },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// ------------------------------------------------------------------ vault: admin pass + key list, AES-GCM under a PIN-derived key
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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

const state = { aes: null, salt: null, pass: null, passText: "", data: { rows: [], nextN: 1 }, rev: null, replacing: null, keep: null, lastActive: Date.now(), type: 1 };

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
  state.aes = null; state.pass = null; state.passText = "";
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
  refreshRevocations(false);
  $("lockAfter").value = String(ls.get("sills.lockAfter", 300));
  if (state.pass && state.pass.ended) toast(state.pass.error + " Make a new pass on your PC.");
}

function tab(name) {
  for (const t of ["issue", "keys", "check", "settings"]) $("tab-" + t).hidden = t !== name;
  document.querySelectorAll("nav.bottom button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("topTitle").textContent = { issue: "Issue a key", keys: "Keys", check: "Check a key", settings: "Settings" }[name];
  if (name === "keys") renderKeys();
  window.scrollTo(0, 0);
}

// what this pass may issue: editions inside its suites, then single plug-ins inside its scope
function fillWhat(keepLabel) {
  const sel = $("what"); sel.innerHTML = "";
  const p = state.pass;
  if (!p) return;
  const allowedAll = p.allowedProducts | L.productsCoveredBy(p.allowedBundles);
  for (const e of L.EDITIONS) if ((e.bundles & ~p.allowedBundles) === 0) sel.add(new Option(e.label, "e:" + e.id));
  for (const pr of L.PRODUCTS) if ((pr.bit & ~allowedAll) === 0) sel.add(new Option(pr.name.replace(/^Sills /, "") + " only", "p:" + pr.bit));
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
  try { key = await L.issueKey(req, state.pass); } catch (e) { toast(e.message); return; }
  const info = await L.verifyKey(key);
  const row = {
    serial: info.serial, issued: L.isoDay(new Date()), licensee: info.licensee, type: info.typeName, products: info.productText,
    expires: info.lastDay ? L.isoDay(info.lastDay) : "never", key, note: state.replacing ? "replaces #" + state.replacing.serial : "", source: "phone", issuer: info.issuerId,
  };
  if (state.replacing) {
    const old = state.data.rows.find((r) => r.serial === state.replacing.serial);
    if (old) old.note = "replaced by #" + info.serial + " - revoke on PC";
  }
  state.data.rows.unshift(row);
  state.data.nextN += 1;
  await save();
  $("resTitle").textContent = `Key #${info.serial}`;
  $("resKey").textContent = key;
  $("resInfo").textContent = `${info.licensee} - ${info.typeName} - ${info.productText}` + (info.lastDay ? ` - ends ${L.isoDay(info.lastDay)}` : "")
    + (state.replacing ? `\nReplaces #${state.replacing.serial}: revoke that one on your PC (Licence manager > Keys).` : "");
  $("result").hidden = false;
  state.lastKey = { key, info };
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
  }).join("") : `<div class="empty">No keys yet.<br>Keys you issue here show up in this list. Import your PC's list in Settings to see those too.</div>`;
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
  $("replaceBanner").innerHTML = `<span class="grow">Changing key #${r.serial}. You'll get a new key; revoke #${r.serial} on your PC afterwards.</span><button id="cancelReplace">Cancel</button>`;
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
    + `<div>Issued by</div><div>${i.issuerId ? "admin #" + i.issuerId : "Sills Audio (PC)"}</div></div>`;
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

// ------------------------------------------------------------------ helpers / wiring
let toastTimer;
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200); }
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast("Copied."); } catch { toast("Couldn't copy - long-press the key to select it."); } }
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
    state.aes = null; state.pass = null; state.data = { rows: [], nextN: 1 };
    show("setup");
  };
  // auto lock
  const touch = () => (state.lastActive = Date.now());
  ["pointerdown", "keydown", "scroll"].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  setInterval(() => { if (state.aes && Date.now() - state.lastActive > ls.get("sills.lockAfter", 300) * 1000) showLock("Locked after inactivity"); }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.aes && Date.now() - state.lastActive > ls.get("sills.lockAfter", 300) * 1000) showLock("Locked"); });
}

boot();
