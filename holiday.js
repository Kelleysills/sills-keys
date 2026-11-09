// Holiday look: Nov 1 - Dec 31 (phone's local date), every year. ?holiday=1 / ?holiday=0 forces it on / off.
(function () {
  const force = new URLSearchParams(location.search).get("holiday");
  const month = new Date().getMonth();   // 0 = January
  const on = force === "1" || (force !== "0" && (month === 10 || month === 11));
  const layer = document.getElementById("holiday");
  if (!on || !layer) return;
  document.body.classList.add("holiday");
  layer.hidden = false;

  const canvas = document.getElementById("snow"), ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0, h = 0, flakes = [], last = performance.now(), running = false;
  function spawn(f, top) {
    const near = Math.random() < 0.35;
    f.r = near ? 1.3 + Math.random() * 0.9 : 0.6 + Math.random() * 0.6;
    f.v = h / (near ? 7 + Math.random() * 4 : 11 + Math.random() * 7);
    f.a = near ? 0.85 : 0.45 + Math.random() * 0.2;
    f.x = Math.random() * w; f.y = top ? -6 : Math.random() * h;
    f.sw = 4 + Math.random() * 7; f.hz = 0.08 + Math.random() * 0.1; f.ph = Math.random() * 6.28;
    return f;
  }
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(140, w * h / 6000));
    flakes = Array.from({ length: n }, () => spawn({}, false));
    if (still) draw(0);
  }
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    for (const f of flakes) {
      ctx.globalAlpha = f.a;
      ctx.beginPath(); ctx.arc(f.x + f.sw * Math.sin(f.ph + t * f.hz * 6.283), f.y, f.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    for (const f of flakes) { f.y += f.v * dt; if (f.y > h + 6) spawn(f, true); }
    draw(now / 1000);
    requestAnimationFrame(frame);
  }
  function start() { if (still || running || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => { if (document.hidden) running = false; else start(); });
  resize(); start();
})();
