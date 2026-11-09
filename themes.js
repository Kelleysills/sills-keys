// Holiday themes for the phone app, from the same signed themes.txt the Hubs use (releases repo). The first theme whose dates
// match today (phone's local date) dresses the app: its scene sits behind everything under a veil of the app background, its
// particles fall / rise / fly on a canvas, and its topper sits on every Sills logo. All theme art is shown as IMAGES (data:
// URLs), so nothing in a themes file can ever run code in this app. ?theme=<id> / ?theme=none forces one (testing).
import * as L from "./core.js";

const THEMES_URL = "https://raw.githubusercontent.com/Kelleysills/sills-audio-releases/main/themes.txt";
const HEADER = "SILLS-THEMES 1";
const CACHE = "sills.themes";

// ---------------------------------------------------------------- dates (same rules as the Hub)
const DAY = 86400000;
const dayOf = (y, m, d) => Math.floor(Date.UTC(y, m, d) / DAY);
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayOf(y, month - 1, day);
}
function ruleDay(rule, y) {
  rule = String(rule || "").trim().toLowerCase();
  const off = (s) => { const m = s.match(/([+-]\d+)$/); return m ? Number(m[1]) : 0; };
  if (rule.startsWith("easter")) return easter(y) + off(rule.slice(6));
  if (rule.startsWith("nth:")) {
    const [n, dowS, monthPart] = rule.slice(4).split(":");
    const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf((dowS || "").slice(0, 3));
    const mm = String(monthPart || "").match(/^(\d+)([+-]\d+)?$/);
    if (dow < 0 || !mm) return -1;
    const month = Number(mm[1]), o = mm[2] ? Number(mm[2]) : 0, N = Number(n);
    if (N > 0) { const first = dayOf(y, month - 1, 1), fd = new Date(first * DAY).getUTCDay(); return first + ((dow - fd + 7) % 7) + 7 * (N - 1) + o; }
    const last = dayOf(y, month, 1) - 1, ld = new Date(last * DAY).getUTCDay();
    return last - ((ld - dow + 7) % 7) + o;
  }
  const m = rule.match(/^(\d{1,2})-(\d{1,2})(\+\d+)?$/);
  return m ? dayOf(y, Number(m[1]) - 1, Number(m[2])) + (m[3] ? Number(m[3]) : 0) : -1;
}
function matches(when, now) {
  const today = dayOf(now.getFullYear(), now.getMonth(), now.getDate());
  for (const r of when || []) {
    for (let y = now.getFullYear() - 1; y <= now.getFullYear(); ++y) {
      const a = ruleDay(r.from, y); let b = ruleDay(r.to || r.from, y);
      if (a < 0 || b < 0) continue;
      if (b < a) b = ruleDay(r.to, y + 1);
      if (today >= a && today <= b) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- loading
async function loadThemes() {
  let doc = null;
  try { const v = await L.verifySignedDoc(localStorage.getItem(CACHE) || "", HEADER); if (v.ok) doc = v.doc; } catch {}
  const fresh = (async () => {
    try {
      const res = await fetch(THEMES_URL + "?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return null;
      const text = await res.text();
      const v = await L.verifySignedDoc(text, HEADER);
      if (!v.ok) return null;
      if (!doc || v.seq >= (doc.seq || 0)) { try { localStorage.setItem(CACHE, text); } catch {} return v.doc; }
    } catch {}
    return null;
  })();
  if (doc) { fresh.then((d) => { if (d && JSON.stringify(d) !== JSON.stringify(doc)) location.reload(); }); return doc; }   // newer themes: re-dress
  const d = await fresh;
  if (d) return d;
  try { return await (await fetch("themes-default.json", { cache: "no-store" })).json(); } catch { return null; }
}
function pick(doc) {
  const force = new URLSearchParams(location.search).get("theme");
  if (force === "none" || !doc || !Array.isArray(doc.themes)) return null;
  return doc.themes.find((t) => (force ? t.id === force : matches(t.when, new Date()))) || null;
}

// ---------------------------------------------------------------- scene image
const dataUrl = (svgText) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
const inner = (svgText) => String(svgText || "").replace(/^[\s\S]*?<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
const attr = (v) => String(v).replace(/[^#\w.\- ]/g, "");
function lightEl(l, i) {
  const style = `animation-delay:-${Number(l.phase || 0).toFixed(2)}s`;
  const c = attr(l.color || "#ffc96b");
  if (l.shape === "circle") return `<circle class="w" cx="${+l.cx}" cy="${+l.cy}" r="${+l.r}" fill="${c}" style="${style}"/>`;
  if (l.shape === "path") return `<path class="w" d="${attr(l.d)}" fill="${c}" style="${style}"/>`;
  return `<rect class="w" x="${+l.x}" y="${+l.y}" width="${+l.w}" height="${+l.h}" rx="${+(l.r || 0)}" fill="${c}" style="${style}"/>`;
}
function sceneSvg(sc) {
  const glows = (sc.glows || []).map((g, i) => ({ g, id: "g" + i }));
  const defs = glows.map(({ g, id }) => `<radialGradient id="${id}"><stop offset="0" stop-color="${attr(g.color || "#ffb347")}" stop-opacity="0.35"/><stop offset="1" stop-color="${attr(g.color || "#ffb347")}" stop-opacity="0"/></radialGradient>`).join("");
  const lights = (sc.lights || []);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 230 ${+(sc.h || 200)}" width="230" height="${+(sc.h || 200)}">`
    + `<style>@keyframes f{0%,100%{opacity:1}42%{opacity:.78}48%{opacity:.96}71%{opacity:.86}}`
    + `@keyframes s{0%{transform:translate(0,0) scale(.6);opacity:.45}100%{transform:translate(-9px,-28px) scale(1.7);opacity:0}}`
    + `.w{animation:f 3.2s ease-in-out infinite;filter:drop-shadow(0 0 3px #ffb347)}.p{transform-box:fill-box;transform-origin:center;animation:s 3.6s ease-out infinite}</style>`
    + `<defs>${defs}</defs>`
    + glows.map(({ g, id }) => `<circle cx="${+g.x}" cy="${+g.y}" r="${+g.r}" fill="url(#${id})"/>`).join("")
    + inner(sc.back)
    + (sc.puffs || []).map((p) => `<circle class="p" cx="${+p.x}" cy="${+p.y}" r="2.5" fill="${attr(p.color || "#c9d1dd")}" style="animation-delay:-${Number(p.phase || 0).toFixed(2)}s"/>`).join("")
    + lights.filter((l) => l.layer !== "front").map(lightEl).join("")
    + inner(sc.front)
    + lights.filter((l) => l.layer === "front").map(lightEl).join("")
    + `</svg>`;
}

// ---------------------------------------------------------------- particles
function startParticles(canvas, emitters) {
  const ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sprites = emitters.map((e) => { if (!e.svg) return null; const im = new Image(); im.src = dataUrl(e.svg); return im; });
  let w = 0, h = 0, parts = [], works = [], last = performance.now(), running = false, t = 0;
  const R = (a, b) => a + Math.random() * (b - a);
  const scale = () => Math.max(1, Math.min(2.2, w / 230 * 0.9));   // phone screens are wider than the Hub panel
  function spawn(p, e, top) {
    const [s0, s1] = e.size || [1.5, 4], [v0, v1] = e.speed || [40, 110];
    const size = R(s0, s1), near = (size - s0) / Math.max(0.01, s1 - s0);
    Object.assign(p, { size: size * scale(), v: (v0 + near * (v1 - v0) * R(0.7, 1)) * h / 760, a: 0.45 + 0.45 * near, x: Math.random() * w,
      y: top === "top" ? -10 : top === "bottom" ? h + 8 : Math.random() * h, sw: R(4, 11), hz: R(0.08, 0.18), ph: Math.random() * 6.28,
      rot: Math.random() * 6.28, vr: (e.spin ?? (e.shape === "rect" ? 4 : 0)) * R(-1, 1), dir: Math.random() < 0.5 ? 1 : -1,
      c: (e.colors || ["#fff"])[Math.floor(Math.random() * (e.colors || ["#fff"]).length)] });
    if (e.kind === "twinkle") { p.y = Math.random() * h * 0.6; p.hz = R(0.3, 0.9); }
    if (e.kind === "fly") { p.x = p.dir > 0 ? -20 : w + 20; p.y = R(20, h * 0.5); if (top === "init") p.x = Math.random() * w; }
  }
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    parts = []; works = [];
    emitters.forEach((e, i) => {
      const n = Math.round((e.count || 30) * Math.min(1.6, Math.max(0.6, (w * h) / (230 * 760))));
      if (e.kind === "fireworks") { for (let k = 0; k < (e.count || 3); ++k) works.push({ e: i, wait: Math.random() * 2.5, sparks: [] }); return; }
      for (let k = 0; k < n; ++k) { const p = { e: i }; spawn(p, e, "init"); parts.push(p); }
    });
    if (still) draw();
  }
  function stepWorks(dt) {
    for (const fw of works) {
      const e = emitters[fw.e], cols = e.colors || ["#fff"];
      if (fw.wait > 0) { fw.wait -= dt; if (fw.wait <= 0) Object.assign(fw, { rocket: true, x: R(20, w - 20), y: h * 0.72, ty: R(60, h * 0.35), vy: (e.speed?.[1] || 90) * 2.4 * h / 760, c: cols[Math.floor(Math.random() * cols.length)] }); }
      else if (fw.rocket) {
        fw.y -= fw.vy * dt;
        if (fw.y <= fw.ty) {
          fw.rocket = false;
          const n = 22 + Math.floor(Math.random() * 10), sc = scale();
          for (let i = 0; i < n; ++i) { const a = 6.283 * i / n + Math.random() * 0.2, sp = R(30, 68) * sc; fw.sparks.push({ x: fw.x, y: fw.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: R(1, 1.6), c: Math.random() < 0.75 ? fw.c : cols[Math.floor(Math.random() * cols.length)] }); }
        }
      }
      for (const s of fw.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += (e.gravity || 70) * dt; s.vx *= 0.985; s.life -= dt * 0.75; }
      fw.sparks = fw.sparks.filter((s) => s.life > 0);
      if (!fw.rocket && fw.wait <= 0 && !fw.sparks.length) fw.wait = R(0.6, 2.8);
    }
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const fw of works) {
      if (fw.rocket && fw.wait <= 0) { ctx.globalAlpha = 0.9; ctx.fillStyle = fw.c; ctx.beginPath(); ctx.arc(fw.x, fw.y, 1.5, 0, 6.283); ctx.fill(); }
      for (const s of fw.sparks) { ctx.globalAlpha = Math.min(1, s.life); ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(s.x, s.y, 1.3, 0, 6.283); ctx.fill(); }
    }
    for (const p of parts) {
      const e = emitters[p.e], sp = sprites[p.e];
      let a = p.a, x = p.x;
      if (e.kind === "twinkle") a *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(p.ph + t * p.hz * 6.283));
      else if (e.kind !== "fly") x += p.sw * Math.sin(p.ph + t * p.hz * 6.283);
      ctx.globalAlpha = a;
      if (sp && sp.complete) {
        const flap = e.kind === "fly" ? 0.55 + 0.45 * Math.abs(Math.sin(t * 9 + p.ph)) : 1;
        ctx.save(); ctx.translate(x, p.y); if (e.kind !== "fly") ctx.rotate(p.rot * 0.25); ctx.scale(e.kind === "fly" && p.dir < 0 ? -1 : 1, flap);
        ctx.drawImage(sp, -p.size / 2, -p.size / 2, p.size, p.size); ctx.restore();
      } else if (e.shape === "rect") {
        ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.rot * 0.5); ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.cos(p.rot)));
        ctx.fillStyle = p.c; ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6); ctx.restore();
      } else { ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(x, p.y, p.size / 2, 0, 6.283); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    for (const p of parts) {
      const e = emitters[p.e];
      if (e.kind === "fall") { p.y += p.v * dt; p.rot += p.vr * dt; if (p.y > h + 10) spawn(p, e, "top"); }
      else if (e.kind === "rise") { p.y -= p.v * dt; p.rot += p.vr * dt; if (p.y < -12) spawn(p, e, "bottom"); }
      else if (e.kind === "fly") { p.x += p.v * p.dir * dt; if (p.x < -24 || p.x > w + 24) spawn(p, e, "fly"); }
    }
    stepWorks(dt);
    draw();
    requestAnimationFrame(frame);
  }
  const start = () => { if (still || running || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(frame); };
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => { if (document.hidden) running = false; else start(); });
  resize(); start();
}

// ---------------------------------------------------------------- dress the app
function dress(th) {
  const layer = document.getElementById("holiday");
  if (!layer) return;
  document.body.classList.add("holiday");
  document.body.dataset.theme = attr(th.id);
  layer.hidden = false;
  if (th.scene) document.getElementById("themeScene").src = dataUrl(sceneSvg(th.scene));
  startParticles(document.getElementById("snow"), th.particles || []);
  const tp = th.topper;
  if (tp && tp.svg) {
    const ph = Object.assign({ x: -14, y: -30, w: 66, angle: -18 }, tp.phone || {});
    const src = dataUrl(tp.svg);
    document.querySelectorAll("img.logo").forEach((img) => {
      if (img.parentNode.classList.contains("hatWrap")) return;
      const wrap = document.createElement("span");
      wrap.className = "hatWrap " + img.className;
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
      const hat = document.createElement("img");
      hat.className = "hat"; hat.alt = ""; hat.src = src;
      Object.assign(hat.style, { left: ph.x + "%", top: ph.y + "%", width: ph.w + "%", transform: `rotate(${ph.angle}deg)` });   // CSSOM: allowed by the CSP
      wrap.appendChild(hat);
    });
  }
}

loadThemes().then((doc) => { const th = pick(doc); if (th) dress(th); }).catch(() => {});
