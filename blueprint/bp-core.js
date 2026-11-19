// Sills BluePrint web - core: device key, signed requests, uploads / downloads, song model + merge.
// Mirrors Source/BluePrint/BPCore.cpp in the suite repo (same signing message, same song document, same merge rules).
// The browser's key is an Ed25519 WebCrypto key made on first use and kept non-extractable in IndexedDB: it never
// leaves this browser. Another computer/phone of yours joins your account with a link code.

export const DEFAULT_SERVICE = "https://sills-blueprint.kelleysills.workers.dev";
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

export function serviceUrl() {
  const q = new URLSearchParams(location.search).get("service");
  if (q) localStorage.setItem("bp.service", q);
  return (localStorage.getItem("bp.service") || DEFAULT_SERVICE).replace(/\/+$/, "");
}

// ------------------------------------------------------------------------------------------------ identity
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("sills-blueprint", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction("kv").objectStore("kv").get(key); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite").objectStore("kv").put(val, key); t.onsuccess = () => res(); t.onerror = () => rej(t.error); });
}

export async function loadIdentity() {
  let kp = await idbGet("device");
  if (!kp) {
    try { kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); }
    catch { throw new Error("This browser can't make secure keys (Ed25519). Update Chrome, Edge, Safari or Firefox and try again."); }
    await idbPut("device", kp);
  }
  const pk = hex(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { pk, sign: async (msg) => hex(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, enc.encode(msg))) };
}

// ------------------------------------------------------------------------------------------------ client
export class Client {
  constructor(identity, base = serviceUrl()) { this.id = identity; this.base = base; }
  async headers(method, path, bodyHash) {
    const ts = String(Date.now());
    return { "x-bp-pk": this.id.pk, "x-bp-ts": ts, "x-bp-sig": await this.id.sign(`sills-bp1|${method}|${path}|${ts}|${bodyHash}`) };
  }
  async call(method, path, body) {
    const hasBody = method !== "GET" && method !== "DELETE";
    const text = hasBody ? JSON.stringify(body ?? {}) : "";
    const h = await this.headers(method, path, await sha256Hex(text));
    if (hasBody) h["content-type"] = "application/json";
    let r;
    try { r = await fetch(this.base + path, { method, headers: h, body: hasBody ? text : undefined }); }
    catch { return { status: 0, ok: false, error: "Can't reach the BluePrint service - check your connection" }; }
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, json, error: r.ok ? "" : (json && json.error) || `Service error ${r.status}` };
  }
  /** Upload a File/Blob into an org's storage (deduped by SHA-256). progress(done, total). Returns the hash. */
  async uploadFile(orgId, file, progress) {
    const buf = await file.arrayBuffer();
    const sha = await sha256Hex(buf);
    const start = await this.call("POST", `/orgs/${orgId}/uploads`, { sha, size: buf.byteLength });
    if (!start.ok) throw new Error(start.error);
    if (start.json.exists) { progress && progress(buf.byteLength, buf.byteLength); return sha; }
    const partSize = Math.max(5 << 20, start.json.partSize || 32 << 20);
    const parts = [];
    for (let n = 1, off = 0; off < buf.byteLength || n === 1; n++) {
      const chunk = new Uint8Array(buf, off, Math.min(partSize, buf.byteLength - off));
      const path = `/uploads/${start.json.uploadId}/${n}`;
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        const h = await this.headers("PUT", path, "-");
        try { res = await fetch(this.base + path, { method: "PUT", headers: { ...h, "content-type": "application/octet-stream" }, body: chunk }); } catch { res = null; }
        if (res && res.ok) break;
      }
      if (!res || !res.ok) throw new Error("Upload failed" + (res ? ` (${res.status})` : ""));
      parts.push(await res.json());
      off += chunk.byteLength;
      progress && progress(off, buf.byteLength);
      if (buf.byteLength === 0) break;
    }
    const fin = await this.call("POST", `/uploads/${start.json.uploadId}/complete`, { parts });
    if (!fin.ok) throw new Error(fin.error);
    return sha;
  }
  async download(orgId, sha) {
    const path = `/orgs/${orgId}/blobs/${sha}`;
    const r = await fetch(this.base + path, { headers: await this.headers("GET", path, await sha256Hex("")) });
    if (!r.ok) { let e = "Download failed"; try { e = (await r.json()).error || e; } catch {} throw new Error(e); }
    return r.blob();
  }
}

// ------------------------------------------------------------------------------------------------ song model
export const SECTION_TYPES = ["Intro", "Verse", "Pre-Hook", "Hook", "Bridge", "Breakdown", "Interlude", "Skit", "Outro"];
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
export const clone = (v) => (v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function newSection(type, bars = 8) {
  return { id: newId(), type, name: "", bars, artist: "", color: "", lines: [{ text: "", t: -1 }] };
}
export function makeDefault() {
  const d = { v: 1, bpm: 90, key: "", timeSig: "4/4", status: "Writing", themes: [], notes: "",
    sections: [newSection("Intro", 4), newSection("Verse", 16), newSection("Hook", 8), newSection("Verse", 16), newSection("Hook", 8), newSection("Outro", 4)],
    samples: [], links: [], sync: { offset: 0 }, canvas: { open: true } };
  renumber(d);
  return d;
}
export const sectionLabel = (s) => s.name || s.type;
export function renumber(doc) {
  const counts = {}, seen = {};
  for (const s of doc.sections || []) counts[s.type] = (counts[s.type] || 0) + 1;
  for (const s of doc.sections || []) {
    seen[s.type] = (seen[s.type] || 0) + 1;
    if (!s.customName) s.name = counts[s.type] > 1 ? `${s.type} ${seen[s.type]}` : s.type;
  }
}
export const linesToText = (s) => (s.lines || []).map((l) => l.text).join("\n");
export function setLinesFromText(s, text) {
  const old = s.lines || [];
  const rows = text.split("\n");
  let search = 0;
  s.lines = rows.map((row) => {
    let t = -1;
    for (let j = search; j < old.length; j++) if (old[j].text === row) { t = old[j].t ?? -1; search = j + 1; break; }
    return { text: row, t };
  });
}
/** Section-level three-way merge (same rules as the desktop app). */
export function merge(base, mine, theirs) {
  const out = clone(theirs);
  for (const [k, v] of Object.entries(mine)) if (k !== "sections" && !same(v, base[k])) out[k] = clone(v);
  const idx = (d) => new Map((d.sections || []).map((s) => [s.id, s]));
  const B = idx(base), M = idx(mine), T = idx(theirs);
  const result = [];
  for (const ts of theirs.sections || []) {
    const id = ts.id, inBase = B.has(id), inMine = M.has(id);
    if (inBase && !inMine) { if (!same(ts, B.get(id))) result.push(clone(ts)); continue; }
    if (!inMine) { result.push(clone(ts)); continue; }
    const iChanged = !inBase || !same(M.get(id), B.get(id)), theyChanged = !inBase || !same(ts, B.get(id));
    if (iChanged && theyChanged && !same(M.get(id), ts)) {
      result.push(clone(M.get(id)));
      result.push({ ...clone(ts), id: newId(), name: sectionLabel(ts) + " (their version)", customName: true });
    } else result.push(clone(iChanged ? M.get(id) : ts));
  }
  const ms = mine.sections || [];
  ms.forEach((s, i) => {
    if (B.has(s.id) || T.has(s.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0 && !at; j--) { const k = result.findIndex((r) => r.id === ms[j].id); if (k >= 0) at = k + 1; }
    result.splice(at, 0, clone(s));
  });
  out.sections = result;
  return out;
}
export function lineAt(doc, t) {
  let best = [-1, -1], bestT = -1e9;
  (doc.sections || []).forEach((s, si) => (s.lines || []).forEach((l, li) => { if (l.t >= 0 && l.t <= t && l.t >= bestT) { bestT = l.t; best = [si, li]; } }));
  return best;
}
export function formatTime(s) {
  if (s < 0) return "--";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
export function parseTime(text) {
  const t = String(text).trim();
  if (!t || t === "--") return -1;
  if (t.includes(":")) { const [m, s] = t.split(":"); return Number(m) * 60 + Number(s); }
  return /^[\d.]+$/.test(t) ? Number(t) : -1;
}
export function humanBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}
export const sectionColour = (t) => ({ Hook: "#3d8af7", Verse: "#6b7686", "Pre-Hook": "#5aa1a8", Bridge: "#9a6cd8", Intro: "#4e5560", Outro: "#4e5560",
  Breakdown: "#c7853a", Skit: "#7d8a4a", Interlude: "#7d8a4a" }[t] || "#5d6470");
