// Sills Audio licence core for the phone licence manager (browser + Node 20+).
// Mirrors Source/Common/License.cpp byte for byte: Crockford base32 keys, Ed25519 (WebCrypto), admin-pass chain.
// Keep in sync with License.cpp / License.h (product bits, suitesOf, bundlesFor).

export const PUBLIC_KEY_HEX = "8075bb96c8b258fc06ba959a6e63e0ba0583b3454456ff9087b7d3e40f11dd9c";

export const KeyType = { Perpetual: 1, Subscription: 2, NotForResale: 3 };
export const typeName = (t) => ({ 1: "Perpetual", 2: "Subscription", 3: "Not for resale" })[t] || "Unknown";

// product bits (License.h)
export const PRODUCTS = [
  { bit: 1 << 0, id: "suite", name: "Ultimate Suite rack", suites: 4 },
  { bit: 1 << 1, id: "mixcoach", name: "Mix Coach", suites: 2 | 4 },
  { bit: 1 << 2, id: "console", name: "Console Strip", suites: 1 | 2 },
  { bit: 1 << 3, id: "buscomp", name: "Bus Comp", suites: 2 | 4 },
  { bit: 1 << 4, id: "eq", name: "Sills EQ", suites: 2 | 4 },
  { bit: 1 << 5, id: "comp", name: "Sills Comp", suites: 1 | 2 },
  { bit: 1 << 6, id: "vintageeq", name: "Sills Vintage EQ", suites: 1 | 2 | 4 },
  { bit: 1 << 7, id: "chamber", name: "Sills Chamber", suites: 1 | 2 },
  { bit: 1 << 8, id: "tune", name: "Sills Tune", suites: 1 | 8 },
  { bit: 1 << 9, id: "production-suite", name: "Production Suite plug-in", suites: 1 },
  { bit: 1 << 10, id: "mixing-suite", name: "Mixing Suite plug-in", suites: 2 },
  { bit: 1 << 11, id: "mastering-suite", name: "Mastering Suite plug-in", suites: 4 },
  { bit: 1 << 12, id: "headless-horseman", name: "Headless Horseman", suites: 0 },
  { bit: 1 << 13, id: "finisher", name: "Sills Finisher", suites: 0 },
];
export const ALL_PRODUCTS = 0xffff;
export const Bundle = { Production: 1, Mixing: 2, Mastering: 4, Misc: 8, RackAccess: 16, Future: 128 };
export const EDITIONS = [
  { id: "ultimate", name: "Ultimate Suite", label: "Ultimate Suite - everything, incl. future plug-ins", bundles: 128 | 1 | 2 | 4 | 8 | 16 },
  { id: "total", name: "Total", label: "Total - all suites + modular rack", bundles: 1 | 2 | 4 | 8 | 16 },
  { id: "production", name: "Production Suite", label: "Production Suite", bundles: 1 },
  { id: "mixing", name: "Mixing Suite", label: "Mixing Suite (incl. Mix Coach)", bundles: 2 },
  { id: "mastering", name: "Mastering Suite", label: "Mastering Suite (incl. modular rack)", bundles: 4 | 16 },
];

export function productsCoveredBy(bundles) {
  if (bundles & Bundle.Future) return ALL_PRODUCTS;
  let m = 0;
  for (const p of PRODUCTS) {
    if (p.bit === 1) { if (bundles & Bundle.RackAccess) m |= p.bit; continue; }
    if (bundles & p.suites) m |= p.bit;
  }
  return m;
}

export function editionName(bundles) {
  if (!bundles) return "";
  const e = EDITIONS.find((x) => x.bundles === bundles);
  if (e) return e.name;
  const parts = [];
  if (bundles & Bundle.Production) parts.push("Production Suite");
  if (bundles & Bundle.Mixing) parts.push("Mixing Suite");
  if (bundles & Bundle.Mastering) parts.push("Mastering Suite");
  if (bundles & Bundle.Misc) parts.push("Misc Suite");
  if (bundles & Bundle.RackAccess) parts.push("modular rack");
  return parts.join(" + ");
}

export function productNames(products, bundles = 0) {
  if (products === ALL_PRODUCTS || (bundles & Bundle.Future)) return "All Sills Audio plug-ins (current and future)";
  if (bundles) return editionName(bundles) + ": " + productNames(productsCoveredBy(bundles));
  return PRODUCTS.filter((p) => products & p.bit).map((p) => p.name).join(", ");
}

// ---- dates: whole days since 1 Jan 2026 in the local calendar (License.cpp dayNumber / fromDay)
const DAY0 = Date.UTC(2026, 0, 1);
export function dayNumber(date) {
  const d = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(0, Math.min(65535, Math.round((d - DAY0) / 86400000)));
}
export function fromDay(n) { return new Date(2026, 0, 1 + n); }
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---- encodings
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function b32encode(bytes) {
  let out = "", buf = 0, bits = 0;
  for (const b of bytes) {
    buf = ((buf << 8) | b) >>> 0; bits += 8;
    while (bits >= 5) { out += ALPHA[(buf >>> (bits - 5)) & 31]; bits -= 5; }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHA[(buf << (5 - bits)) & 31];
  return out;
}
export function b32decode(text) {
  const out = []; let buf = 0, bits = 0;
  for (let c of text.toUpperCase()) {
    if (c === "O") c = "0";
    if (c === "I" || c === "L") c = "1";
    const v = ALPHA.indexOf(c);
    if (v < 0) return null;
    buf = ((buf << 5) | v) >>> 0; bits += 5;
    if (bits >= 8) { out.push((buf >>> (bits - 8)) & 0xff); bits -= 8; }
    buf &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}
export const groupKey = (body) => "SILLS" + body.match(/.{1,5}/g).map((g) => "-" + g).join("");
export const hexToBytes = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder(), dec = new TextDecoder();
function b64ToBytes(s) { const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }

// ---- Ed25519 through WebCrypto (Chrome 137+, Safari 17+, Firefox 129+, Node 20+)
const subtle = globalThis.crypto.subtle;
const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");
export async function ed25519Supported() {
  try { await subtle.importKey("raw", hexToBytes(PUBLIC_KEY_HEX), { name: "Ed25519" }, false, ["verify"]); return true; }
  catch { return false; }
}
// extra master keys the PC master trusts (masters.txt); set by the app after verifying that file
let extraRoots = [];
export function setExtraRoots(hexList) { extraRoots = (hexList || []).filter((h) => /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase()); }
export const trustedRootHexes = () => [PUBLIC_KEY_HEX, ...extraRoots];
async function verifyAnyRoot(sig, msg, onlyHex) {
  for (const h of onlyHex ? [onlyHex] : trustedRootHexes()) if (await verifySig(hexToBytes(h), sig, msg)) return true;
  return false;
}
async function verifySig(pub, sig, msg) {
  const k = await subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  return subtle.verify({ name: "Ed25519" }, k, sig, msg);
}
async function sign(secret64, msg) {
  const pk8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pk8.set(PKCS8_PREFIX); pk8.set(secret64.slice(0, 32), PKCS8_PREFIX.length);   // monocypher secret = seed || public key
  const k = await subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign({ name: "Ed25519" }, k, msg));
}

const HEADER = 14, SIG = 64, MAX_NAME = 40, CERT_BODY = 41, CERT = CERT_BODY + 64;
const u16 = (d, i) => d[i] | (d[i + 1] << 8);
const u32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/** Decode + verify a licence key (same rules as verifyKey in License.cpp). */
export async function verifyKey(keyText, publicKeyHex = null) {
  const info = { valid: false, error: "" };
  let body = keyText.toUpperCase().replace(/[\s-]/g, "");
  if (body.startsWith("SILLS")) body = body.slice(5);
  const d = body ? b32decode(body) : null;
  if (!d) { info.error = "That doesn't look like a Sills Audio key."; return info; }
  if (d.length < HEADER + SIG || (d[0] !== 1 && d[0] !== 2)) { info.error = "That key is incomplete or from an unknown format."; return info; }
  const delegated = d[0] === 2, nameLen = d[13];
  const signedLen = HEADER + nameLen + (delegated ? CERT : 0);
  if (nameLen > MAX_NAME || d.length < signedLen + SIG) { info.error = "That key is incomplete - check it was copied in full."; return info; }
  if (delegated) {
    const cert = d.slice(HEADER + nameLen, HEADER + nameLen + CERT);
    if (!(await verifyAnyRoot(cert.slice(CERT_BODY), cert.slice(0, CERT_BODY), publicKeyHex))) { info.error = "That key's issuer isn't recognised (certificate check failed)."; return info; }
    if (!(await verifySig(cert.slice(4, 36), d.slice(signedLen, signedLen + SIG), d.slice(0, signedLen)))) { info.error = "That key isn't valid (signature check failed)."; return info; }
    const allowP = u16(cert, 36), allowB = cert[38], certExp = u16(cert, 39);
    const allowedAll = allowP | productsCoveredBy(allowB);
    if ((d[12] & ~allowB) || (u16(d, 2) & ~allowedAll) || u16(d, 4) > certExp) { info.error = "That key goes beyond what its issuer was allowed to give."; return info; }
    info.issuerId = u32(cert, 0);
  } else if (!(await verifyAnyRoot(d.slice(signedLen, signedLen + SIG), d.slice(0, signedLen), publicKeyHex))) {
    info.error = "That key isn't valid (signature check failed)."; return info;
  }
  info.type = d[1];
  info.products = u16(d, 2);
  info.issued = fromDay(u16(d, 4));
  const exp = u16(d, 6);
  info.serial = u32(d, 8);
  info.bundles = d[12];
  info.licensee = dec.decode(d.slice(HEADER, HEADER + nameLen));
  info.valid = true;
  info.issuerId = info.issuerId || 0;
  if (exp) {
    info.lastDay = fromDay(exp);
    info.expired = new Date() >= new Date(info.lastDay.getFullYear(), info.lastDay.getMonth(), info.lastDay.getDate() + 1);
    if (info.expired) info.error = "This subscription key expired on " + isoDay(info.lastDay) + ".";
  }
  info.typeName = typeName(info.type);
  info.productText = productNames(info.products, info.bundles);
  return info;
}

/** Parse + check an admin pass: SILLSADMIN1.<hex cert(105)+secret(64)>.<base64 name> */
export async function parseAdminPass(text, publicKeyHex = null) {
  const a = { valid: false, error: "" };
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "SILLSADMIN1") { a.error = "That isn't a Sills Audio admin pass."; return a; }
  const blob = hexToBytes(parts[1]);
  if (blob.length !== CERT + 64) { a.error = "That admin pass is incomplete."; return a; }
  const cert = blob.slice(0, CERT), secret = blob.slice(CERT);
  if (!(await verifyAnyRoot(cert.slice(CERT_BODY), cert.slice(0, CERT_BODY), publicKeyHex))) { a.error = "That admin pass wasn't issued by Sills Audio."; return a; }
  if (bytesToHex(secret.slice(32)) !== bytesToHex(cert.slice(4, 36))) { a.error = "That admin pass is damaged."; return a; }
  a.adminId = u32(cert, 0);
  a.allowedProducts = u16(cert, 36);
  a.allowedBundles = cert[38];
  a.lastDay = fromDay(u16(cert, 39));
  a.expiryDay = u16(cert, 39);
  a.cert = cert; a.secret = secret;
  try { a.name = dec.decode(b64ToBytes(parts[2])); } catch { a.name = "?"; }
  a.valid = true;
  a.permanent = a.expiryDay >= 65535;
  a.ended = !a.permanent && dayNumber(new Date()) > a.expiryDay;
  if (a.ended) a.error = "This admin pass ended on " + isoDay(a.lastDay) + ".";
  a.scopeText = (a.allowedBundles ? editionName(a.allowedBundles) : productNames(a.allowedProducts)) + (a.permanent ? ", permanent" : ", until " + isoDay(a.lastDay));
  return a;
}

export function passAllows(pass, req) {
  if (!pass.valid || pass.ended) return false;
  const allowedAll = pass.allowedProducts | productsCoveredBy(pass.allowedBundles);
  const wanted = (req.products | productsCoveredBy(req.bundles)) & 0xffff;
  return (req.bundles & ~pass.allowedBundles) === 0 && (wanted & ~allowedAll) === 0;
}

/** Issue a key under an admin pass (issueDelegatedKey in License.cpp). req: {licensee, type, products, bundles, serial, lastDay?} */
export async function issueKey(req, pass) {
  if (!pass.valid) throw new Error(pass.error || "No admin pass.");
  if (pass.ended) throw new Error(pass.error);
  if (!passAllows(pass, req)) throw new Error("Your admin pass doesn't cover that. You can issue: " + pass.scopeText + ".");
  let name = enc.encode(req.licensee.trim()).slice(0, MAX_NAME);
  if (!name.length) throw new Error("Enter the licensee's name.");
  if (req.type === KeyType.Subscription && !req.lastDay) throw new Error("Subscriptions need an end date.");
  const total = HEADER + name.length + CERT + SIG;
  const d = new Uint8Array(total);
  const issued = dayNumber(new Date());
  const exp = req.type === KeyType.Subscription ? Math.max(1, dayNumber(req.lastDay)) : 0;
  const products = (req.products | productsCoveredBy(req.bundles)) & 0xffff;
  d[0] = 2; d[1] = req.type;
  d[2] = products & 0xff; d[3] = products >> 8;
  d[4] = issued & 0xff; d[5] = issued >> 8;
  d[6] = exp & 0xff; d[7] = exp >> 8;
  for (let i = 0; i < 4; ++i) d[8 + i] = (req.serial >>> (8 * i)) & 0xff;
  d[12] = req.bundles;
  d[13] = name.length;
  d.set(name, HEADER);
  d.set(pass.cert, HEADER + name.length);
  const sig = await sign(pass.secret, d.slice(0, HEADER + name.length + CERT));
  d.set(sig, HEADER + name.length + CERT);
  return groupKey(b32encode(d));
}

/** Verify the published revocation list; returns { ok, serials, adminsOff, updated } */
export async function verifyRevocationList(text, publicKeyHex = null) {
  const t = text.replace(/\r\n/g, "\n");
  const sigPos = t.lastIndexOf("\nsig ");
  if (!t.startsWith("SILLS-REVOKED 1\n") || sigPos < 0) return { ok: false };
  const body = t.slice(0, sigPos + 1);
  const sig = hexToBytes(t.slice(sigPos + 5).trim());
  if (sig.length !== 64 || !(await verifyAnyRoot(sig, enc.encode(body), publicKeyHex))) return { ok: false };
  const serials = body.split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
  const updated = (body.match(/^updated (.*)$/m) || [])[1] || "";
  return { ok: true, serials, updated };
}
export const adminRevocationId = (adminId) => (0x80000000 | adminId) >>> 0;

// ================================================================== master mode (this phone as a second master)
/** New master key pair, made on this phone. Returns { secret (64 bytes: seed || public), publicHex }. */
export async function generateMaster() {
  const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pk8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pk8.slice(pk8.length - 32)); secret.set(pub, 32);
  return { secret, publicHex: bytesToHex(pub) };
}

/** Master-signed key (format 1, issueKey in License.cpp): any edition / products. */
export async function issueMasterKey(req, secret64) {
  let name = enc.encode(req.licensee.trim()).slice(0, MAX_NAME);
  if (!name.length) throw new Error("Enter the licensee's name.");
  if (req.type === KeyType.Subscription && !req.lastDay) throw new Error("Subscriptions need an end date.");
  const d = new Uint8Array(HEADER + name.length + SIG);
  const issued = dayNumber(new Date());
  const exp = req.type === KeyType.Subscription ? Math.max(1, dayNumber(req.lastDay)) : 0;
  const products = (req.products | productsCoveredBy(req.bundles)) & 0xffff;
  d[0] = 1; d[1] = req.type;
  d[2] = products & 0xff; d[3] = products >> 8;
  d[4] = issued & 0xff; d[5] = issued >> 8;
  d[6] = exp & 0xff; d[7] = exp >> 8;
  for (let i = 0; i < 4; ++i) d[8 + i] = (req.serial >>> (8 * i)) & 0xff;
  d[12] = req.bundles; d[13] = name.length;
  d.set(name, HEADER);
  d.set(await sign(secret64, d.slice(0, HEADER + name.length)), HEADER + name.length);
  return groupKey(b32encode(d));
}

/** God-mode pass (makeAdminPass in License.cpp), certificate signed by this phone's master key. lastDay null = permanent. */
export async function makeAdminPass(adminName, adminId, allowP, allowB, lastDay, secret64) {
  if (!(adminId > 0 && adminId < 4096)) throw new Error("Admin id must be 1-4095.");
  const kp = await generateMaster();   // the admin's own key pair
  const cert = new Uint8Array(CERT);
  for (let i = 0; i < 4; ++i) cert[i] = (adminId >>> (8 * i)) & 0xff;
  cert.set(kp.secret.slice(32), 4);
  cert[36] = allowP & 0xff; cert[37] = allowP >> 8; cert[38] = allowB;
  const exp = lastDay ? Math.max(1, dayNumber(lastDay)) : 65535;
  cert[39] = exp & 0xff; cert[40] = exp >> 8;
  cert.set(await sign(secret64, cert.slice(0, CERT_BODY)), CERT_BODY);
  const blob = new Uint8Array(CERT + 64); blob.set(cert); blob.set(kp.secret, CERT);
  const nameB64 = btoa(String.fromCharCode(...enc.encode(adminName.trim())));
  return "SILLSADMIN1." + bytesToHex(blob) + "." + nameB64;
}

/** Ed25519 signature over raw bytes (admin calls to the activation service). */
export const signBytes = (secret64, msg) => sign(secret64, msg);

/** Same text format as signRevocationList in License.cpp. */
export async function signRevocationList(serials, secret64) {
  let body = "SILLS-REVOKED 1\nupdated " + isoDay(new Date()) + "\n";
  for (const s of [...new Set(serials)].sort((a, b) => a - b)) body += s + "\n";
  return body + "sig " + bytesToHex(await sign(secret64, enc.encode(body))) + "\n";
}

/** masters.txt: only the built-in (PC) key may sign it. Returns { ok, seq, masters: [{hex, name}] } */
export async function verifyTrustedMasters(text) {
  const t = text.replace(/\r\n/g, "\n");
  const sigPos = t.lastIndexOf("\nsig ");
  if (!t.startsWith("SILLS-MASTERS 1\n") || sigPos < 0) return { ok: false };
  const body = t.slice(0, sigPos + 1);
  const sig = hexToBytes(t.slice(sigPos + 5).trim());
  if (sig.length !== 64 || !(await verifySig(hexToBytes(PUBLIC_KEY_HEX), sig, enc.encode(body)))) return { ok: false };
  const seq = Number((body.match(/^seq (\d+)$/m) || [])[1] || 0);
  const masters = body.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-fA-F]{64}/.test(l)).map((l) => ({ hex: l.slice(0, 64).toLowerCase(), name: l.slice(64).trim() }));
  return { ok: true, seq, masters };
}
