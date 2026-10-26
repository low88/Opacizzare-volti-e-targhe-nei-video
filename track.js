/* Incognitho — tracks and the appearance tracker.
   Boxes are normalised (0..1). A track is a list of (time, box) keyframes; boxes in between are interpolated. */
import { iou } from './detect.js';

let nextId = 1;
export const STYLES = ['blur', 'pixel', 'emoji', 'black', 'color'];
export class Track {
  constructor(kind, t, box, style) {
    this.id = nextId++; this.kind = kind; this.t = [t]; this.b = [box]; this.on = true;
    this.style = Object.assign({ mode: kind === 'plate' ? 'pixel' : 'blur', strength: .6, emoji: '😎', color: '#111111' }, style || {});
    this.vel = { x: 0, y: 0 }; this.miss = 0; this.tmpl = null; this.thumb = null; this.hits = 1; this.score = box.score || 1;
  }
  get t0() { return this.t[0]; } get t1() { return this.t[this.t.length - 1]; }
  add(t, box) {
    // keep sorted by time; replace a key at (almost) the same time
    let i = this.t.length; while (i > 0 && this.t[i - 1] > t + 1e-4) i--;
    if (i > 0 && Math.abs(this.t[i - 1] - t) < 1e-3) { this.b[i - 1] = box; return; }
    this.t.splice(i, 0, t); this.b.splice(i, 0, box);
  }
  boxAt(t, pad = .25) {
    const T = this.t, n = T.length; if (!n) return null;
    if (t < T[0] - pad || t > T[n - 1] + pad) return null;
    if (t <= T[0]) return this.b[0]; if (t >= T[n - 1]) return this.b[n - 1];
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const a = this.b[lo], b = this.b[hi], k = (t - T[lo]) / (T[hi] - T[lo] || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
  }
  predict(t) { const n = this.t.length, b = this.b[n - 1], dt = t - this.t[n - 1]; return { x: b.x + this.vel.x * dt, y: b.y + this.vel.y * dt, w: b.w, h: b.h }; }
  smooth() {   // light temporal smoothing of the keyframes (removes detector jitter)
    const n = this.b.length; if (n < 3) return; const src = this.b.map(b => Object.assign({}, b));
    for (let i = 0; i < n; i++) { let s = { x: 0, y: 0, w: 0, h: 0 }, c = 0; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) { if (Math.abs(this.t[k] - this.t[i]) > .5) continue; s.x += src[k].x + src[k].w / 2; s.y += src[k].y + src[k].h / 2; s.w += src[k].w; s.h += src[k].h; c++; }
      const w = Math.max(src[i].w, s.w / c), h = Math.max(src[i].h, s.h / c); this.b[i] = { x: s.x / c - w / 2, y: s.y / c - h / 2, w, h }; }
  }
  toJSON() { return { id: this.id, kind: this.kind, t: this.t, b: this.b, on: this.on, style: this.style }; }
}

/* ---------- appearance tracker: normalised cross-correlation on a grey frame ---------- */
const TS = 32;   // template size
export function grab(gray, W, H, box) {
  const bx = box.x * W, by = box.y * H, bw = box.w * W, bh = box.h * H;
  const tw = TS, th = Math.max(8, Math.round(TS * bh / Math.max(1, bw)));
  const th2 = Math.min(th, 48), out = new Float32Array(tw * th2); let s = 0;
  for (let y = 0; y < th2; y++) for (let x = 0; x < tw; x++) { const sx = Math.min(W - 1, Math.max(0, bx + (x + .5) * bw / tw | 0)), sy = Math.min(H - 1, Math.max(0, by + (y + .5) * bh / th2 | 0)); const v = gray[sy * W + sx]; out[y * tw + x] = v; s += v; }
  const m = s / out.length; let q = 0; for (let i = 0; i < out.length; i++) { out[i] -= m; q += out[i] * out[i]; }
  return { d: out, w: tw, h: th2, n: Math.sqrt(q) || 1 };
}
function ncc(gray, W, H, tp, cx, cy, bw, bh) {
  const x0 = cx - bw / 2, y0 = cy - bh / 2, sx = bw / tp.w, sy = bh / tp.h; let s = 0, s2 = 0, sp = 0; const n = tp.w * tp.h;
  const buf = ncc.buf || (ncc.buf = new Float32Array(48 * 48));
  for (let y = 0; y < tp.h; y++) { const py = Math.min(H - 1, Math.max(0, y0 + (y + .5) * sy | 0)) * W; for (let x = 0; x < tp.w; x++) { const v = gray[py + Math.min(W - 1, Math.max(0, x0 + (x + .5) * sx | 0))]; buf[y * tp.w + x] = v; s += v; } }
  const m = s / n; for (let i = 0; i < n; i++) { const v = buf[i] - m; s2 += v * v; sp += v * tp.d[i]; }
  return sp / (Math.sqrt(s2) * tp.n + 1e-6);
}
/* find the template near a predicted box; returns {box, score} in normalised coords */
export function follow(gray, W, H, tp, pred) {
  const bw = pred.w * W, bh = pred.h * H, cx = (pred.x + pred.w / 2) * W, cy = (pred.y + pred.h / 2) * H;
  let best = { s: -2, x: cx, y: cy, k: 1 };
  const R = Math.max(6, Math.max(bw, bh) * .55), st = Math.max(1, Math.round(R / 10));
  for (const k of [1, .93, 1.07]) for (let dy = -R; dy <= R; dy += st) for (let dx = -R; dx <= R; dx += st) { const s = ncc(gray, W, H, tp, cx + dx, cy + dy, bw * k, bh * k); if (s > best.s) best = { s, x: cx + dx, y: cy + dy, k }; }
  for (let dy = -st; dy <= st; dy++) for (let dx = -st; dx <= st; dx++) { const s = ncc(gray, W, H, tp, best.x + dx, best.y + dy, bw * best.k, bh * best.k); if (s > best.s) best = { s, x: best.x + dx, y: best.y + dy, k: best.k }; }
  const w = bw * best.k / W, h = bh * best.k / H;
  return { box: { x: best.x / W - w / 2, y: best.y / H - h / 2, w, h }, score: best.s };
}
export function blendTemplate(tp, nt, a = .15) { for (let i = 0; i < tp.d.length && i < nt.d.length; i++) tp.d[i] = tp.d[i] * (1 - a) + nt.d[i] * a; let q = 0; for (const v of tp.d) q += v * v; tp.n = Math.sqrt(q) || 1; }

/* ---------- associate one analysed frame ---------- */
export function step(tracks, dets, t, gray, W, H, opt) {
  const live = tracks.filter(tr => tr.kind !== 'manual' && !tr.closed);
  const used = new Set();
  const pairs = [];
  for (const tr of live) { const p = tr.predict(t); dets.forEach((d, j) => { if (d.kind !== tr.kind) return; const o = iou(p, d), dc = Math.hypot(p.x + p.w / 2 - d.x - d.w / 2, p.y + p.h / 2 - d.y - d.h / 2) / Math.max(p.w, p.h, .01); const sc = o > .1 ? o + 1 : dc < .9 ? 1 - dc : -1; if (sc > 0) pairs.push({ tr, j, sc }); }); }
  pairs.sort((a, b) => b.sc - a.sc);
  const done = new Set();
  for (const { tr, j } of pairs) {
    if (done.has(tr) || used.has(j)) continue; done.add(tr); used.add(j);
    const d = dets[j], n = tr.t.length, last = tr.b[n - 1], dt = t - tr.t[n - 1];
    if (dt > 0) { tr.vel.x = tr.vel.x * .5 + ((d.x - last.x) / dt) * .5; tr.vel.y = tr.vel.y * .5 + ((d.y - last.y) / dt) * .5; }
    tr.add(t, { x: d.x, y: d.y, w: d.w, h: d.h }); tr.miss = 0; tr.hits++; tr.score = Math.max(tr.score, d.score || 0);
    if (gray) { const nt = grab(gray, W, H, d); if (tr.tmpl) blendTemplate(tr.tmpl, nt, .3); else tr.tmpl = nt; }
  }
  // lost for a moment: follow its appearance
  for (const tr of live) {
    if (done.has(tr)) continue;
    tr.miss++;
    if (gray && tr.tmpl && t - tr.t1 < opt.maxGap) {
      const f = follow(gray, W, H, tr.tmpl, tr.predict(t));
      if (f.score > .62) { tr.add(t, f.box); continue; }
    }
    if (t - tr.t1 > opt.maxGap) tr.closed = true;
  }
  dets.forEach((d, j) => {
    if (used.has(j)) return;
    const tr = new Track(d.kind, t, { x: d.x, y: d.y, w: d.w, h: d.h, score: d.score }, opt.style && opt.style[d.kind]);
    if (gray) tr.tmpl = grab(gray, W, H, d);
    tracks.push(tr);
  });
}
/* drop flickers: a face/plate seen only once in a video is usually noise (photos keep everything) */
export function clean(tracks, isPhoto) {
  return tracks.filter(tr => tr.kind === 'manual' || isPhoto || tr.hits >= 2 || (tr.score > .85 && tr.t1 - tr.t0 >= 0));
}
