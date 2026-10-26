/* Incognitho — detection.
   Faces: MediaPipe BlazeFace run on the whole frame and on zoomed tiles (finds small, distant faces).
   Plates: vehicles from MediaPipe EfficientDet, then a classical plate search inside each vehicle
   (vertical-edge density, plate proportions, character transitions). Optional whole-frame plate search. */
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const OBJ_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

export const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i + 1e-9);
};
export function nms(list, thr = .3) {
  list.sort((a, b) => b.score - a.score); const out = [];
  for (const d of list) if (!out.some(o => iou(o, d) > thr || contains(o, d))) out.push(d);
  return out;
}
const contains = (a, b) => b.x >= a.x - 2 && b.y >= a.y - 2 && b.x + b.w <= a.x + a.w + 2 && b.y + b.h <= a.y + a.h + 2 && b.w * b.h < a.w * a.h * .7;

let face = null, obj = null, loading = null;
export const status = { face: 'off', obj: 'off', error: null };
export function load(onStatus = () => {}) {
  if (loading) return loading;
  loading = (async () => {
    try {
      onStatus('Scarico i modelli di riconoscimento (solo la prima volta)…');
      const mp = await import(MP + '/vision_bundle.mjs');
      const fs = await mp.FilesetResolver.forVisionTasks(MP + '/wasm');
      const make = async (Cls, opts) => {
        try { return await Cls.createFromOptions(fs, Object.assign({}, opts, { baseOptions: { modelAssetPath: opts.model, delegate: 'GPU' } })); }
        catch (e) { return await Cls.createFromOptions(fs, Object.assign({}, opts, { baseOptions: { modelAssetPath: opts.model, delegate: 'CPU' } })); }
      };
      face = await make(mp.FaceDetector, { model: FACE_MODEL, runningMode: 'IMAGE', minDetectionConfidence: .5, minSuppressionThreshold: .3 }); status.face = 'ok';
      onStatus('Volti pronti. Preparo il rilevatore di veicoli…');
      obj = await make(mp.ObjectDetector, { model: OBJ_MODEL, runningMode: 'IMAGE', scoreThreshold: .3, maxResults: 15, categoryAllowlist: ['car', 'truck', 'bus', 'motorcycle'] }); status.obj = 'ok';
      onStatus(null);
    } catch (e) {
      console.warn(e); status.error = e; if (status.face !== 'ok') status.face = 'err'; if (status.obj !== 'ok') status.obj = 'err';
      onStatus('Non riesco a scaricare i modelli (serve internet la prima volta). Puoi comunque oscurare a mano.');
    }
  })();
  return loading;
}

const tileCv = document.createElement('canvas'), tileCtx = tileCv.getContext('2d');
function runFace(src, sx, sy, sw, sh, W, H, out, minScore) {
  tileCv.width = Math.round(sw); tileCv.height = Math.round(sh);
  tileCtx.drawImage(src, sx, sy, sw, sh, 0, 0, tileCv.width, tileCv.height);
  const r = face.detect(tileCv);
  for (const d of r.detections || []) {
    const b = d.boundingBox, s = d.categories && d.categories[0] ? d.categories[0].score : .5;
    if (s < minScore) continue;
    const k = sw / tileCv.width;
    // BlazeFace boxes are tight (eyes to chin): grow to cover hair, ears and chin
    let w = b.width * k, h = b.height * k, x = sx + b.originX * k, y = sy + b.originY * k;
    const gx = w * .22, gyT = h * .38, gyB = h * .14;
    x -= gx; w += gx * 2; y -= gyT; h += gyT + gyB;
    out.push({ x: x / W, y: y / H, w: w / W, h: h / H, score: s, kind: 'face' });
  }
}
/* src: canvas with the frame at analysis size. level: 0 fast, 1 normal, 2 deep */
export function faces(src, level = 1) {
  if (!face) return [];
  const W = src.width, H = src.height, out = [];
  runFace(src, 0, 0, W, H, W, H, out, .55);
  if (level >= 1) {
    const n = level >= 2 ? 3 : 2, ov = .2, tw = W / (n - (n - 1) * ov), th = H / (n - (n - 1) * ov);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) runFace(src, i * tw * (1 - ov), j * th * (1 - ov), tw, th, W, H, out, .6);
    if (level >= 2) runFace(src, W * .25, H * .25, W * .5, H * .5, W, H, out, .6);
  }
  return nms(out, .25).filter(d => d.w > 0 && d.h > 0);
}
export function vehicles(src) {
  if (!obj) return [];
  const W = src.width, H = src.height, r = obj.detect(src);
  return (r.detections || []).map(d => ({ x: d.boundingBox.originX / W, y: d.boundingBox.originY / H, w: d.boundingBox.width / W, h: d.boundingBox.height / H, score: d.categories[0].score, cat: d.categories[0].categoryName }));
}

/* ---------- plate search ---------- */
// gray: Uint8Array W*H. roi in pixels. returns candidates in normalised frame coords
export function platesIn(gray, W, H, roi, strict) {
  const RW = Math.min(strict ? 420 : 280, Math.max(60, Math.round(roi.w))), sc = roi.w / RW, RH = Math.max(20, Math.round(roi.h / sc));
  const g = new Float32Array(RW * RH);
  for (let y = 0; y < RH; y++) { const sy = Math.min(H - 1, Math.max(0, Math.round(roi.y + y * sc))); for (let x = 0; x < RW; x++) { const sx = Math.min(W - 1, Math.max(0, Math.round(roi.x + x * sc))); g[y * RW + x] = gray[sy * W + sx]; } }
  // vertical edges
  const e = new Float32Array(RW * RH); let mean = 0;
  for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) { const v = Math.abs(g[y * RW + x + 1] - g[y * RW + x - 1]); e[y * RW + x] = v; mean += v; }
  mean /= RW * RH;
  const thr = Math.max(28, mean * 2.6), b = new Uint8Array(RW * RH);
  for (let i = 0; i < b.length; i++) b[i] = e[i] > thr ? 1 : 0;
  // close gaps between characters (horizontal) and strokes (vertical)
  const kx = Math.max(2, Math.round(RW / 45)), d = new Uint8Array(RW * RH);
  for (let y = 0; y < RH; y++) { let run = -1e9; for (let x = 0; x < RW; x++) { if (b[y * RW + x]) run = x; if (x - run <= kx) d[y * RW + x] = 1; } let r2 = 1e9; for (let x = RW - 1; x >= 0; x--) { if (b[y * RW + x]) r2 = x; if (r2 - x <= kx) d[y * RW + x] = 1; } }
  const d2 = new Uint8Array(RW * RH);
  for (let y = 1; y < RH - 1; y++) for (let x = 0; x < RW; x++) d2[y * RW + x] = d[(y - 1) * RW + x] | d[y * RW + x] | d[(y + 1) * RW + x];
  // connected components
  const lab = new Int32Array(RW * RH), out = []; let L = 0; const q = new Int32Array(RW * RH);
  for (let i = 0; i < d2.length; i++) {
    if (!d2[i] || lab[i]) continue; L++; let qh = 0, qt = 0; q[qt++] = i; lab[i] = L;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    while (qh < qt) { const c = q[qh++], cx = c % RW, cy = c / RW | 0; n++; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const nb of [c - 1, c + 1, c - RW, c + RW]) { if (nb < 0 || nb >= d2.length || lab[nb] || !d2[nb]) continue; if (Math.abs((nb % RW) - cx) > 1) continue; lab[nb] = L; q[qt++] = nb; } }
    // refine: the blob may have swallowed nearby edges (bumper, car outline). Keep the densest band of rows
    // with edges, then the dense run of columns inside that band.
    if (x1 - x0 > 12 && y1 - y0 > 4) {
      const rows = []; let rmax = 0;
      for (let y = y0; y <= y1; y++) { let c = 0; for (let x = x0; x <= x1; x++) c += b[y * RW + x]; rows.push(c); if (c > rmax) rmax = c; }
      let best = null, s = -1;
      for (let i = 0; i <= rows.length; i++) { const on = i < rows.length && rows[i] > rmax * .3; if (on && s < 0) s = i; if (!on && s >= 0) { let sum = 0; for (let k = s; k < i; k++) sum += rows[k]; if (!best || sum > best.sum) best = { a: s, b: i - 1, sum }; s = -1; } }
      if (best) { y1 = y0 + best.b; y0 = y0 + best.a; }
      const cols = []; let cmax = 0;
      for (let x = x0; x <= x1; x++) { let c = 0; for (let y = y0; y <= y1; y++) c += b[y * RW + x]; cols.push(c); }
      const sm = cols.map((_, i) => { let a = 0; for (let k = Math.max(0, i - kx); k <= Math.min(cols.length - 1, i + kx); k++) a += cols[k]; return a; });
      for (const v of sm) if (v > cmax) cmax = v;
      let bc = null; s = -1;
      for (let i = 0; i <= sm.length; i++) { const on = i < sm.length && sm[i] > cmax * .25; if (on && s < 0) s = i; if (!on && s >= 0) { let sum = 0; for (let k = s; k < i; k++) sum += sm[k]; if (!bc || sum > bc.sum) bc = { a: s, b: i - 1, sum }; s = -1; } }
      if (bc) { let a = bc.a, z = bc.b; while (a < z && cols[a] === 0) a++; while (z > a && cols[z] === 0) z--; x1 = x0 + z; x0 = x0 + a; }
      n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) n += d2[y * RW + x];
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, ar = w / h, fill = n / (w * h);
    if (h < 5 || w < 16 || ar < 1.8 || ar > 9.5 || fill < .35) continue;
    if (w > RW * (strict ? .5 : .75) || h > RH * .5) continue;
    // plate test: bright background with dark characters → many transitions on the middle rows
    let sum = 0, sq = 0, cnt = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = g[y * RW + x]; sum += v; sq += v * v; cnt++; }
    const m = sum / cnt, sd = Math.sqrt(Math.max(0, sq / cnt - m * m));
    let trans = 0;
    for (const fy of [.4, .5, .6]) { const y = Math.round(y0 + h * fy); let prev = 0; for (let x = x0; x <= x1; x++) { const s = g[y * RW + x] > m ? 1 : -1; if (prev && s !== prev) trans++; prev = s; } }
    trans /= 3;
    if (trans < 7 || trans > 48 || sd < 28) continue;
    const score = Math.min(1, (trans / 20) * .5 + Math.min(1, sd / 70) * .3 + (1 - Math.abs(ar - 4.5) / 4) * .2);
    if (strict && score < .62) continue;
    // the dense part is often just the characters: give the box real plate proportions (≈ 4.5:1)
    let ph = h, py = y0; if (ar > 5) { ph = w / 4.6; py = y0 + h / 2 - ph / 2; }
    const pad = .12;
    out.push({ x: (roi.x + (x0 - w * pad) * sc) / W, y: (roi.y + (py - ph * pad * 1.6) * sc) / H, w: (w * (1 + pad * 2)) * sc / W, h: (ph * (1 + pad * 3.2)) * sc / H, score, kind: 'plate' });
  }
  return out;
}
export function plates(gray, W, H, cars, wholeFrame) {
  let out = [];
  for (const v of cars) {
    const roi = { x: (v.x + v.w * .04) * W, y: (v.y + v.h * .3) * H, w: v.w * .92 * W, h: v.h * .72 * H };
    if (roi.w < 40 || roi.h < 20) continue;
    const c = platesIn(gray, W, H, roi, false).sort((a, b) => b.score - a.score);
    out.push(...c.slice(0, 1));
  }
  if (wholeFrame) {
    // scan three overlapping horizontal bands so plates of any size have enough pixels
    for (const [y, h] of [[0, .55], [.3, .45], [.5, .5]]) out.push(...platesIn(gray, W, H, { x: 0, y: y * H, w: W, h: h * H }, true));
  }
  return nms(out, .2);
}
export const ready = () => !!face || !!obj;
