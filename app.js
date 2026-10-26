/* Incognitho — app */
import * as D from './detect.js';
import { Track, step, clean, grab, follow, blendTemplate } from './track.js';
import { draw as drawMask, outline, EMOJI } from './mask.js';

const $ = s => document.querySelector(s);
const KIND = { face: { name: 'Volto', col: '#ffd60a', all: 'tutti i volti' }, plate: { name: 'Targa', col: '#4cc9f0', all: 'tutte le targhe' }, manual: { name: 'Area', col: '#ff5d8f', all: 'tutte le aree' } };
const MODES = [['blur', 'Sfoca'], ['pixel', 'Pixel'], ['emoji', 'Emoji'], ['black', 'Nero'], ['color', 'Colore']];
const PREC = { fast: { fps: 6, level: 0, aw: 640 }, normal: { fps: 10, level: 1, aw: 800 }, high: { fps: 15, level: 2, aw: 1024 } };

const S = { media: null, tracks: [], sel: null, showOrig: false, adding: false, busy: false, cancel: false, exporting: false, drag: null };
const view = $('#view'), vctx = view.getContext('2d');
const ana = document.createElement('canvas'), actx = ana.getContext('2d', { willReadFrequently: true });
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
window.__inc = S;   // handy for debugging

/* ---------------- small UI helpers ---------------- */
let toastT;
function toast(msg, ms = 2800) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, ms); }
function setStatus(msg) { $('#status').textContent = msg || ''; }
const modal = {
  open(title, text, { bar = true, buttons = [] } = {}) { $('#mTitle').textContent = title; $('#mText').textContent = text || ''; $('#mBarWrap').hidden = !bar; $('#mBar').style.width = '0%'; $('#mMedia').innerHTML = ''; this.buttons(buttons); $('#modal').hidden = false; },
  progress(p, text) { $('#mBar').style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%'; if (text != null) $('#mText').textContent = text; },
  text(t) { $('#mText').textContent = t; },
  buttons(list) { const b = $('#mBtns'); b.innerHTML = ''; for (const [label, fn, cls] of list) { const el = document.createElement('button'); el.className = 'btn ' + (cls || ''); el.textContent = label; el.onclick = fn; b.appendChild(el); } },
  close() { $('#modal').hidden = true; $('#mMedia').innerHTML = ''; }
};
const cancelBtn = ['Annulla', () => { S.cancel = true; modal.text('Interrompo…'); }];

/* ---------------- media ---------------- */
function seek(v, t) {
  return new Promise(res => {
    let done = false; const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
    v.addEventListener('seeked', fin);
    const d = isFinite(v.duration) ? v.duration : t + 1;
    v.currentTime = Math.max(0, Math.min(t, d - .001));
    setTimeout(fin, 4000);
  });
}
const now = () => S.media && S.media.type === 'video' ? S.media.el.currentTime : 0;
const isImage = f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|avif)$/i.test(f.name);

async function openFile(file) {
  if (!file) return;
  closeMedia();
  const url = URL.createObjectURL(file);
  try {
    if (isImage(file)) {
      const img = new Image(); img.src = url; await img.decode();
      S.media = { type: 'image', el: img, W: img.naturalWidth, H: img.naturalHeight, dur: 0, name: file.name, url };
    } else {
      const v = document.createElement('video'); v.className = 'offscreen'; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.src = url;
      document.body.appendChild(v);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Formato video non supportato da questo browser')); });
      if (!isFinite(v.duration)) { v.currentTime = 1e7; await new Promise(r => { v.ondurationchange = r; setTimeout(r, 1500); }); }
      await seek(v, 0);
      S.media = { type: 'video', el: v, W: v.videoWidth, H: v.videoHeight, dur: v.duration, name: file.name, url };
      v.addEventListener('seeked', () => { if (!S.busy && !S.exporting) render(); });
      v.addEventListener('ended', () => setPlayIcon());
    }
  } catch (e) { console.warn(e); toast(e.message || 'Non riesco ad aprire il file'); URL.revokeObjectURL(url); return; }
  const m = S.media, sc = Math.min(1, 1280 / Math.max(m.W, m.H));
  view.width = Math.round(m.W * sc); view.height = Math.round(m.H * sc);
  S.tracks = []; S.sel = null; S.adding = false;
  $('#home').hidden = true; $('#editor').hidden = false;
  $('#transport').hidden = $('#timeline').hidden = m.type !== 'video';
  $('#scrub').max = m.dur || 1; $('#scrub').value = 0;
  $('#exportBtn').textContent = m.type === 'video' ? 'Esporta ↓' : 'Salva foto ↓';
  setAdding(false); renderList(); render();
  D.load(setStatus).then(() => setStatus(D.status.face === 'ok' ? '' : 'modelli non disponibili'));
}
function closeMedia() {
  const m = S.media; if (!m) return;
  if (m.type === 'video') { m.el.pause(); m.el.remove(); }
  URL.revokeObjectURL(m.url); S.media = null; S.tracks = []; S.sel = null;
}
function goHome() { stopLive(); closeMedia(); $('#editor').hidden = true; $('#home').hidden = false; $('#file').value = ''; }

/* ---------------- rendering ---------------- */
// renders the frame with all masks into any 2d context (used for preview, video export and photo export)
function compose(ctx, W, H, t, src, showOrig) {
  ctx.drawImage(src, 0, 0, W, H);
  if (showOrig) return;
  for (const tr of S.tracks) { if (!tr.on) continue; const b = tr.boxAt(t); if (b) drawMask(ctx, W, H, src, b, tr.kind, tr.style); }
}
function render(tOverride) {
  const m = S.media; if (!m) return;
  const W = view.width, H = view.height, t = tOverride != null ? tOverride : now();
  compose(vctx, W, H, t, m.el, S.showOrig);
  const playing = m.type === 'video' && !m.el.paused;
  if (!playing && !S.exporting) {
    for (const tr of S.tracks) {
      const b = tr.boxAt(t); if (!b) continue;
      const sel = tr === S.sel; if (!sel && S.tracks.length > 12) continue;
      outline(vctx, W, H, b, tr.kind, tr.on ? KIND[tr.kind].col : '#777', sel || S.tracks.length <= 6 ? label(tr) : '', sel);
      if (sel) { vctx.fillStyle = KIND[tr.kind].col; vctx.fillRect((b.x + b.w) * W - 9, (b.y + b.h) * H - 9, 18, 18); }
    }
  }
  if (S.drag && S.drag.type === 'new') { const r = normRect(S.drag); vctx.save(); vctx.strokeStyle = KIND.manual.col; vctx.lineWidth = 2; vctx.setLineDash([6, 4]); vctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H); vctx.restore(); }
  if (m.type === 'video') { $('#time').textContent = fmt(t); if (!S.scrubbing) $('#scrub').value = t; drawTimeline(t); }
}
const label = tr => KIND[tr.kind].name + ' ' + tr.n;

/* ---------------- timeline ---------------- */
const tl = $('#timeline'), tlx = tl.getContext('2d');
const ROW = 9, TOP = 14;
function drawTimeline(t) {
  const m = S.media; if (!m || m.type !== 'video') return;
  const dpr = devicePixelRatio || 1, cw = tl.clientWidth, rows = Math.min(S.tracks.length, 20), ch = Math.max(48, TOP + rows * ROW + 8);
  if (tl.width !== Math.round(cw * dpr) || tl.height !== Math.round(ch * dpr)) { tl.width = Math.round(cw * dpr); tl.height = Math.round(ch * dpr); tl.style.height = ch + 'px'; }
  tlx.setTransform(dpr, 0, 0, dpr, 0, 0); tlx.clearRect(0, 0, cw, ch);
  const X = s => s / m.dur * cw;
  tlx.fillStyle = '#5a5e6a'; tlx.font = '10px "JetBrains Mono",monospace';
  const stepS = m.dur > 120 ? 30 : m.dur > 40 ? 10 : m.dur > 12 ? 2 : 1;
  for (let s = 0; s <= m.dur; s += stepS) { tlx.fillRect(X(s), 0, 1, 5); if (X(s) < cw - 30) tlx.fillText(fmt(s).replace(/\.\d$/, ''), X(s) + 3, 10); }
  S.tracks.slice(0, rows).forEach((tr, i) => {
    tlx.globalAlpha = tr.on ? (tr === S.sel ? 1 : .7) : .25; tlx.fillStyle = KIND[tr.kind].col;
    const x0 = X(Math.max(0, tr.t0 - .25)), x1 = X(Math.min(m.dur, tr.t1 + .25));
    tlx.fillRect(x0, TOP + i * ROW, Math.max(3, x1 - x0), ROW - 3);
  });
  tlx.globalAlpha = 1; tlx.fillStyle = '#fff'; tlx.fillRect(X(t) - 1, 0, 2, ch);
}
function tlPointer(e) {
  const m = S.media; if (!m || m.type !== 'video') return;
  const r = tl.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = e.clientY - r.top;
  const t = Math.max(0, Math.min(m.dur, x * m.dur)); m.el.pause(); setPlayIcon();
  const row = Math.floor((y - TOP) / ROW), tr = S.tracks[row];
  if (e.type === 'pointerdown' && tr && t >= tr.t0 - .5 && t <= tr.t1 + .5) { select(tr, false); }
  seek(m.el, t);
}
tl.addEventListener('pointerdown', e => { tl.setPointerCapture(e.pointerId); tlPointer(e); });
tl.addEventListener('pointermove', e => { if (e.buttons) tlPointer(e); });

/* ---------------- playback ---------------- */
function setPlayIcon() { const m = S.media; $('#playBtn').textContent = m && m.type === 'video' && !m.el.paused ? '❚❚' : '▶'; }
function loop() { const m = S.media; if (!m || m.type !== 'video' || m.el.paused || S.exporting) { render(); return; } render(); requestAnimationFrame(loop); }
$('#playBtn').onclick = async () => {
  const v = S.media && S.media.el; if (!v || S.media.type !== 'video') return;
  if (v.paused) { if (v.ended || v.currentTime >= v.duration - .05) await seek(v, 0); try { await v.play(); } catch (e) { toast('Tocca di nuovo ▶'); } requestAnimationFrame(loop); } else v.pause();
  setPlayIcon();
};
$('#scrub').addEventListener('input', e => { const v = S.media && S.media.el; if (!v) return; S.scrubbing = true; v.pause(); setPlayIcon(); v.currentTime = +e.target.value; });
$('#scrub').addEventListener('change', () => { S.scrubbing = false; });
const hold = $('#holdBtn');
hold.addEventListener('pointerdown', e => { e.preventDefault(); S.showOrig = true; render(); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, () => { if (S.showOrig) { S.showOrig = false; render(); } });
hold.addEventListener('contextmenu', e => e.preventDefault());

/* ---------------- analysis ---------------- */
function toGray(id) { const d = id.data, n = id.width * id.height, g = new Uint8Array(n); for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; return g; }
function anaFrame(src, aw) {
  const m = S.media, sc = Math.min(1, aw / Math.max(m.W, m.H)), W = Math.round(m.W * sc), H = Math.round(m.H * sc);
  if (ana.width !== W || ana.height !== H) { ana.width = W; ana.height = H; }
  actx.drawImage(src, 0, 0, W, H);
  return toGray(actx.getImageData(0, 0, W, H));
}
const thC = document.createElement('canvas'); thC.width = thC.height = 96;
function thumb(src, b) {
  const W = src.width, H = src.height, s = Math.max(b.w * W, b.h * H) * 1.15, cx = (b.x + b.w / 2) * W, cy = (b.y + b.h / 2) * H, c = thC.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, 96, 96);
  const sx = cx - s / 2, sy = cy - s / 2, x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(W, sx + s), y1 = Math.min(H, sy + s);
  if (x1 > x0 && y1 > y0) c.drawImage(src, x0, y0, x1 - x0, y1 - y0, (x0 - sx) / s * 96, (y0 - sy) / s * 96, (x1 - x0) / s * 96, (y1 - y0) / s * 96);
  return thC.toDataURL('image/jpeg', .75);
}
function defStyle(kind) { const mode = $(kind === 'face' ? '#defFace' : '#defPlate').value; return { mode, emoji: kind === 'face' ? '😎' : '🙈' }; }
function renumber() { const c = { face: 0, plate: 0, manual: 0 }; for (const tr of S.tracks) tr.n = ++c[tr.kind]; }

async function analyze() {
  const m = S.media; if (!m || S.busy) return;
  const P = PREC[$('#optPrec').value], wantF = $('#optFace').checked, wantP = $('#optPlate').checked;
  if (!wantF && !wantP) return toast('Scegli almeno Volti o Targhe');
  S.busy = true; S.cancel = false; if (m.type === 'video') { m.el.pause(); setPlayIcon(); }
  modal.open('Rilevamento', 'Preparo i modelli…', { buttons: [cancelBtn] });
  await D.load(msg => msg && modal.text(msg));
  const noFace = wantF && D.status.face !== 'ok', noCar = wantP && D.status.obj !== 'ok';
  const whole = $('#optWhole').checked || noCar;
  const opt = { maxGap: 1.2, style: { face: defStyle('face'), plate: defStyle('plate') } };
  const work = [], t0 = now();
  const times = []; if (m.type === 'image') times.push(0); else for (let t = 0; t < m.dur; t += 1 / P.fps) times.push(t);
  const started = performance.now();
  for (let i = 0; i < times.length && !S.cancel; i++) {
    const t = times[i];
    if (m.type === 'video') await seek(m.el, t);
    const gray = anaFrame(m.el, m.type === 'image' ? Math.max(P.aw, 1280) : P.aw), W = ana.width, H = ana.height;
    const dets = [];
    try {
      if (wantF && !noFace) dets.push(...D.faces(ana, m.type === 'image' ? 2 : P.level));
      if (wantP) dets.push(...D.plates(gray, W, H, noCar ? [] : D.vehicles(ana), whole));
    } catch (e) { console.warn(e); }
    step(work, dets, t, gray, W, H, opt);
    for (const tr of work) if (!tr.thumb && tr.t1 === t) tr.thumb = thumb(ana, tr.b[tr.b.length - 1]);
    const el = (performance.now() - started) / 1000, left = el / (i + 1) * (times.length - i - 1);
    const nf = work.filter(x => x.kind === 'face').length, np = work.filter(x => x.kind === 'plate').length;
    modal.progress((i + 1) / times.length, m.type === 'video' ? `${fmt(t)} / ${fmt(m.dur)} · ${nf} volti · ${np} targhe · ~${Math.ceil(left)}s` : `${nf} volti · ${np} targhe`);
    if (m.type === 'image') await sleep(0);
  }
  const kept = clean(work, m.type === 'image');
  for (const tr of kept) { tr.smooth(); tr.tmpl = null; }
  S.tracks = S.tracks.filter(tr => tr.kind === 'manual').concat(kept).sort((a, b) => a.t0 - b.t0);
  renumber();
  if (m.type === 'video') await seek(m.el, t0);
  S.busy = false; modal.close(); renderList(); render();
  const nf = kept.filter(x => x.kind === 'face').length, np = kept.filter(x => x.kind === 'plate').length;
  let msg = `${nf} ${nf === 1 ? 'volto' : 'volti'} e ${np} ${np === 1 ? 'targa' : 'targhe'}${S.cancel ? ' (interrotto)' : ''}`;
  if (noFace) msg = 'Riconoscimento volti non disponibile (serve internet la prima volta). ' + msg;
  toast(msg, 4000);
  $('#anaPanel').open = false;
}

/* follow an area through the video with the appearance tracker. dir +1 forward, -1 backward */
async function trackFrom(tr, tStart, dir, label) {
  const m = S.media, v = m.el, dt = 1 / 12;
  let box = tr.boxAt(tStart, 1e9); if (!box) return;
  await seek(v, tStart);
  let gray = anaFrame(v, 640); const W = ana.width, H = ana.height;
  const tp = grab(gray, W, H, box), tp0 = { d: tp.d.slice(), w: tp.w, h: tp.h, n: tp.n };
  let vel = { x: 0, y: 0 }, lost = false, t = tStart, n = 0;
  const total = dir > 0 ? m.dur - tStart : tStart;
  while (!S.cancel) {
    t += dir * dt; if (t < 0 || t > m.dur - .01) break;
    await seek(v, t); gray = anaFrame(v, 640);
    const pred = { x: box.x + vel.x, y: box.y + vel.y, w: box.w, h: box.h };
    let f = follow(gray, W, H, tp, pred);
    if (f.score < .5) { const f0 = follow(gray, W, H, tp0, pred); if (f0.score > f.score) f = f0; }   // try the original look
    if (f.score < .42) { lost = true; break; }
    vel = { x: (f.box.x - box.x) * .6 + vel.x * .4, y: (f.box.y - box.y) * .6 + vel.y * .4 };
    box = f.box; tr.add(t, box); n++;
    if (f.score > .72) blendTemplate(tp, grab(gray, W, H, box), .08);
    modal.progress(Math.abs(t - tStart) / (total || 1), `${label} ${fmt(t)} · ${f.score > .7 ? 'aggancio forte' : 'aggancio debole'}`);
  }
  return { lost, t, n };
}
async function followFromHere(tr) {
  const m = S.media; if (!m || m.type !== 'video' || S.busy) return;
  const t0 = now(); const b = tr.boxAt(t0, 1e9); if (!b) return;
  // drop the keys after now and re-track forward
  tr.add(t0, b); const i = tr.t.findIndex(x => x > t0 + 1e-3); if (i > 0) { tr.t.length = i; tr.b.length = i; }
  S.busy = true; S.cancel = false; m.el.pause(); setPlayIcon();
  modal.open('Inseguo ' + label(tr), '', { buttons: [cancelBtn] });
  const r = await trackFrom(tr, t0, +1, 'avanti');
  await seek(m.el, t0); S.busy = false; modal.close(); renderList(); render();
  toast(r && r.lost ? `Perso a ${fmt(r.t)}: vai lì, sposta il riquadro e premi di nuovo "Segui da qui"` : 'Fatto, seguito fino alla fine');
}
async function addManual(box) {
  const m = S.media, t0 = now();
  const tr = new Track('manual', t0, box, { mode: 'blur' });
  anaFrame(m.el, 640); tr.thumb = thumb(ana, box);
  S.tracks.push(tr); renumber(); select(tr, false); setAdding(false);
  if (m.type !== 'video') { renderList(); render(); return; }
  S.busy = true; S.cancel = false; m.el.pause(); setPlayIcon();
  modal.open('Inseguo ' + label(tr), 'Seguo l\'area nel video…', { buttons: [cancelBtn] });
  const a = await trackFrom(tr, t0, +1, 'avanti'); S.cancel = false;
  const b = await trackFrom(tr, t0, -1, 'indietro');
  await seek(m.el, t0); S.busy = false; S.cancel = false; modal.close(); renderList(); render();
  toast(a && a.lost || b && b.lost ? `Seguita da ${fmt(tr.t0)} a ${fmt(tr.t1)}. Se si perde, sposta il riquadro e "Segui da qui"` : 'Area seguita per tutto il video', 4200);
}

/* ---------------- pointer on the preview: draw / select / move / resize ---------------- */
function pt(e) { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, px: r.width, py: r.height }; }
function normRect(d) { const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1); return { x, y, w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }; }
function hit(p) {
  const t = now(), order = S.sel ? [S.sel, ...S.tracks.filter(x => x !== S.sel).reverse()] : S.tracks.slice().reverse();
  for (const tr of order) {
    const b = tr.boxAt(t); if (!b) continue;
    const hx = 22 / p.px, hy = 22 / p.py;
    if (tr === S.sel && Math.abs(p.x - (b.x + b.w)) < hx && Math.abs(p.y - (b.y + b.h)) < hy) return { tr, b, type: 'resize' };
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { tr, b, type: 'move' };
  }
  return null;
}
view.addEventListener('pointerdown', e => {
  if (!S.media || S.busy) return;
  const p = pt(e); view.setPointerCapture(e.pointerId);
  if (S.media.type === 'video' && !S.media.el.paused) { S.media.el.pause(); setPlayIcon(); }
  if (S.adding) { S.drag = { type: 'new', x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
  const h = hit(p);
  if (h) { if (h.tr !== S.sel) select(h.tr, false); S.drag = { type: h.type, tr: h.tr, b0: Object.assign({}, h.b), p0: p, moved: false }; }
  else if (S.sel) { S.sel = null; renderList(); render(); }
});
view.addEventListener('pointermove', e => {
  const d = S.drag; if (!d) return; const p = pt(e);
  if (d.type === 'new') { d.x1 = p.x; d.y1 = p.y; render(); return; }
  const dx = p.x - d.p0.x, dy = p.y - d.p0.y; if (Math.abs(dx) + Math.abs(dy) > .004) d.moved = true; if (!d.moved) return;
  let b = Object.assign({}, d.b0);
  if (d.type === 'move') { b.x += dx; b.y += dy; } else { b.w = Math.max(.02, b.w + dx); b.h = Math.max(.02, b.h + dy); }
  d.box = b; d.tr.add(now(), b); render();
});
view.addEventListener('pointerup', () => {
  const d = S.drag; S.drag = null; if (!d) return;
  if (d.type === 'new') { const r = normRect(d); if (r.w > .015 && r.h > .015) addManual(clip(r)); else render(); return; }
  if (d.moved) { d.tr.add(now(), clip(d.box)); render(); if (S.media.type === 'video' && d.tr.t.length > 1) toast('Ritocco salvato qui. "Segui da qui" per ritracciare da questo punto'); }
});
const clip = b => { const x = Math.max(-.05, b.x), y = Math.max(-.05, b.y); return { x, y, w: Math.min(1.05 - x, b.w), h: Math.min(1.05 - y, b.h) }; };
function setAdding(on) { S.adding = on; $('#stage').classList.toggle('adding', on); $('#stageHint').hidden = !on; $('#addBtn').classList.toggle('on', on); $('#addBtn').textContent = on ? 'Annulla' : '＋ Area a mano'; }
$('#addBtn').onclick = () => setAdding(!S.adding);

/* ---------------- track list ---------------- */
function select(tr, jump = true) {
  S.sel = tr; renderList();
  if (jump && tr && S.media.type === 'video' && !tr.boxAt(now())) seek(S.media.el, tr.t0); else render();
  const el = tr && document.querySelector(`.card[data-id="${tr.id}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function renderList() {
  const box = $('#tracks'); $('#count').textContent = S.tracks.length;
  if (!S.tracks.length) { box.innerHTML = '<p class="empty small">Tocca <b>⚡ Rileva</b> per trovare volti e targhe, oppure <b>＋ Area a mano</b> e disegna un riquadro su ciò che vuoi nascondere.</p>'; return; }
  const isV = S.media && S.media.type === 'video';
  box.innerHTML = S.tracks.map(tr => {
    const k = KIND[tr.kind], sel = tr === S.sel, st = tr.style;
    const range = isV ? `${fmt(tr.t0)} → ${fmt(tr.t1)}` : (tr.kind === 'face' ? 'volto' : tr.kind === 'plate' ? 'targa' : 'area');
    let body = '';
    if (sel) {
      body = `<div class="card-body">
        <div class="chips">${MODES.map(([m, n]) => `<button class="chip ${st.mode === m ? 'on' : ''}" data-mode="${m}">${n}</button>`).join('')}</div>
        ${st.mode === 'blur' || st.mode === 'pixel' ? `<label class="str">Intensità <input type="range" min="0" max="1" step="0.05" value="${st.strength}" data-act="str"></label>` : ''}
        ${st.mode === 'emoji' ? `<div class="emojis">${EMOJI.map(e => `<button class="${st.emoji === e ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>` : ''}
        ${st.mode === 'color' ? `<label class="str">Colore <input type="color" value="${st.color}" data-act="color"></label>` : ''}
        <div class="row">
          ${isV ? '<button class="btn sm" data-act="follow">↪ Segui da qui</button>' : ''}
          <button class="btn sm ghost" data-act="all">Stile a ${k.all}</button>
        </div>
      </div>`;
    }
    return `<div class="card ${sel ? 'sel' : ''} ${tr.on ? '' : 'off'}" data-id="${tr.id}" style="--k:${k.col}">
      <div class="card-h">
        ${tr.thumb ? `<img class="th" src="${tr.thumb}" alt="">` : '<div class="th"></div>'}
        <div class="meta"><b>${label(tr)}</b><span class="mono">${range} · ${MODES.find(x => x[0] === st.mode)[1]}${st.mode === 'emoji' ? ' ' + st.emoji : ''}</span></div>
        <div class="mini">
          <button data-act="toggle" title="${tr.on ? 'Mostra (non oscurare)' : 'Oscura'}">${tr.on ? '🙈' : '👁'}</button>
          <button data-act="del" title="Elimina">✕</button>
        </div>
      </div>${body}</div>`;
  }).join('');
}
$('#tracks').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const tr = S.tracks.find(x => x.id === +card.dataset.id); if (!tr) return;
  const a = e.target.closest('[data-act],[data-mode],[data-emoji]');
  if (!a) { select(tr === S.sel ? null : tr); return; }
  if (a.dataset.mode) { tr.style.mode = a.dataset.mode; }
  else if (a.dataset.emoji) { tr.style.emoji = a.dataset.emoji; }
  else switch (a.dataset.act) {
    case 'toggle': tr.on = !tr.on; break;
    case 'del': S.tracks = S.tracks.filter(x => x !== tr); if (S.sel === tr) S.sel = null; renumber(); break;
    case 'all': for (const x of S.tracks) if (x.kind === tr.kind) x.style = Object.assign({}, tr.style); toast('Stile applicato a ' + KIND[tr.kind].all); break;
    case 'follow': followFromHere(tr); return;
    default: return;
  }
  renderList(); render();
});
$('#tracks').addEventListener('input', e => {
  const card = e.target.closest('.card'); const tr = card && S.tracks.find(x => x.id === +card.dataset.id); if (!tr) return;
  if (e.target.dataset.act === 'str') tr.style.strength = +e.target.value;
  if (e.target.dataset.act === 'color') tr.style.color = e.target.value;
  render();
});
$('#tracks').addEventListener('change', e => { if (e.target.dataset.act === 'color') renderList(); });

/* ---------------- export ---------------- */
function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of list) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
const AU = {};
function audioFor(v) {
  try {
    if (!AU.ctx) AU.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (AU.el !== v) { AU.src = AU.ctx.createMediaElementSource(v); AU.out = AU.ctx.createGain(); AU.dest = AU.ctx.createMediaStreamDestination(); AU.src.connect(AU.out).connect(AU.ctx.destination); AU.src.connect(AU.dest); AU.el = v; }
    AU.ctx.resume(); return AU;
  } catch (e) { console.warn(e); return null; }
}
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
async function exportPhoto() {
  const m = S.media, sc = Math.min(1, 4096 / Math.max(m.W, m.H)), c = document.createElement('canvas');
  c.width = Math.round(m.W * sc); c.height = Math.round(m.H * sc);
  compose(c.getContext('2d'), c.width, c.height, now(), m.el, false);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
  showResult(blob, `incognitho-${stamp()}.jpg`, 'Foto pronta');
}
async function exportVideo() {
  const m = S.media, v = m.el;
  if (!window.MediaRecorder || !view.captureStream) return toast('Questo browser non può esportare video. Prova con Chrome o Safari aggiornati.');
  if (S.busy) return;
  const mime = pickMime(), sc = Math.min(1, 1920 / Math.max(m.W, m.H));
  const ow = view.width, oh = view.height;
  S.busy = S.exporting = true; S.cancel = false; v.pause(); setPlayIcon(); S.sel = null;
  view.width = Math.round(m.W * sc / 2) * 2; view.height = Math.round(m.H * sc / 2) * 2;
  const au = audioFor(v); v.muted = false;
  const stream = view.captureStream(30);
  if (au) { au.out.gain.value = 0; for (const t of au.dest.stream.getAudioTracks()) stream.addTrack(t); }
  let rec; try { rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: Math.round(Math.min(12e6, view.width * view.height * 30 * .14)) })); }
  catch (e) { rec = new MediaRecorder(stream); }
  const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  modal.open('Esporto il video', 'Lo riproduco con le maschere applicate: tieni lo schermo acceso.', { buttons: [cancelBtn] });
  let lock = null; try { lock = await navigator.wakeLock.request('screen'); } catch (e) { }
  await seek(v, 0); render(0);
  const stopped = new Promise(r => rec.onstop = r);
  rec.start(1000); v.playbackRate = 1;
  try { await v.play(); } catch (e) { toast('Tocca di nuovo Esporta'); }
  await new Promise(res => {
    let fin = false; const end = () => { if (fin) return; fin = true; res(); };
    v.onended = end;
    const tick = (n, meta) => {
      if (fin) return;
      if (S.cancel) { v.pause(); end(); return; }
      render(meta && meta.mediaTime != null ? meta.mediaTime : v.currentTime);
      modal.progress(v.currentTime / m.dur, `${fmt(v.currentTime)} / ${fmt(m.dur)}`);
      if (v.ended) { end(); return; }
      v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  });
  render(m.dur); await sleep(250);
  rec.stop(); await stopped;
  v.onended = () => setPlayIcon();
  if (au) au.out.gain.value = 1;
  try { lock && lock.release(); } catch (e) { }
  view.width = ow; view.height = oh; S.busy = S.exporting = false; v.pause(); await seek(v, 0); render();
  if (S.cancel) { modal.close(); toast('Esportazione annullata'); return; }
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0], ext = type.includes('mp4') ? 'mp4' : 'webm';
  showResult(new Blob(chunks, { type }), `incognitho-${stamp()}.${ext}`, 'Video pronto');
}
function showResult(blob, name, title) {
  const url = URL.createObjectURL(blob), isV = blob.type.startsWith('video');
  modal.open(title, `${name} · ${(blob.size / 1048576).toFixed(1)} MB`, { bar: false });
  $('#mMedia').innerHTML = isV ? `<video src="${url}" controls playsinline></video>` : `<img src="${url}" alt="">`;
  const btns = [['Chiudi', () => { modal.close(); URL.revokeObjectURL(url); }, 'ghost']];
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) btns.push(['Condividi / Salva', async () => { try { await navigator.share({ files: [file], title: 'Incognitho' }); } catch (e) { } }, '']);
  btns.push(['Scarica', () => { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }, 'primary']);
  modal.buttons(btns);
  window.__lastExport = blob;
}
$('#exportBtn').onclick = () => { if (!S.media) return; if (!S.tracks.some(t => t.on)) toast('Niente da oscurare: esporto comunque', 2000); S.media.type === 'video' ? exportVideo() : exportPhoto(); };
$('#analyzeBtn').onclick = analyze;

/* ---------------- live camera ---------------- */
const L = { active: false, facing: 'user', stream: null, tracks: [], style: { mode: 'blur', strength: .7, emoji: '😎', color: '#111' }, nextDet: 0, rec: null, recStart: 0 };
const cam = $('#cam'), lv = $('#liveView'), lctx = lv.getContext('2d');
function buildLiveUI() {
  $('#liveModes').innerHTML = MODES.filter(m => m[0] !== 'color').map(([m, n]) => `<button class="chip ${L.style.mode === m ? 'on' : ''}" data-mode="${m}">${n}</button>`).join('');
  $('#liveEmojis').hidden = L.style.mode !== 'emoji';
  $('#liveEmojis').innerHTML = EMOJI.slice(0, 12).map(e => `<button class="${L.style.emoji === e ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('');
}
$('#liveModes').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) { L.style.mode = b.dataset.mode; buildLiveUI(); } };
$('#liveEmojis').onclick = e => { const b = e.target.closest('[data-emoji]'); if (b) { L.style.emoji = b.dataset.emoji; buildLiveUI(); } };
async function openCam() {
  if (L.stream) L.stream.getTracks().forEach(t => t.stop());
  L.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: L.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  cam.srcObject = L.stream; await cam.play();
  lv.width = cam.videoWidth; lv.height = cam.videoHeight; L.tracks = [];
}
async function startLive() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Fotocamera non disponibile (serve https)');
  $('#live').hidden = false; buildLiveUI(); L.active = true;
  D.load(setStatus).then(() => setStatus(D.status.face === 'ok' ? '' : 'riconoscimento non disponibile'));
  try { await openCam(); } catch (e) { console.warn(e); toast('Non posso usare la fotocamera: controlla i permessi'); stopLive(); return; }
  requestAnimationFrame(liveLoop);
}
function stopLive() {
  if (!L.active) return; L.active = false;
  if (L.rec && L.rec.state !== 'inactive') L.rec.stop();
  if (L.stream) L.stream.getTracks().forEach(t => t.stop()); L.stream = null; $('#live').hidden = true;
}
function liveLoop(ts) {
  if (!L.active) return; requestAnimationFrame(liveLoop);
  const W = lv.width, H = lv.height; if (!W || cam.readyState < 2) return;
  const t = ts / 1000, mirror = L.facing === 'user';
  lctx.save(); if (mirror) { lctx.translate(W, 0); lctx.scale(-1, 1); } lctx.drawImage(cam, 0, 0, W, H); lctx.restore();
  if (ts >= L.nextDet && D.ready()) {
    const t0 = performance.now();
    const sc = Math.min(1, 512 / Math.max(W, H)); ana.width = Math.round(W * sc); ana.height = Math.round(H * sc);
    actx.drawImage(lv, 0, 0, ana.width, ana.height);
    const gray = toGray(actx.getImageData(0, 0, ana.width, ana.height)), dets = [];
    try {
      if ($('#liveFace').checked) dets.push(...D.faces(ana, $('#liveFar').checked ? 1 : 0));
      if ($('#livePlate').checked) dets.push(...D.plates(gray, ana.width, ana.height, D.status.obj === 'ok' ? D.vehicles(ana) : [], D.status.obj !== 'ok'));
    } catch (e) { console.warn(e); }
    step(L.tracks, dets, t, gray, ana.width, ana.height, { maxGap: .8 });
    L.tracks = L.tracks.filter(tr => !tr.closed);
    for (const tr of L.tracks) if (tr.t.length > 6) { tr.t.splice(0, tr.t.length - 6); tr.b.splice(0, tr.b.length - 6); }
    const cost = performance.now() - t0; L.nextDet = ts + Math.min(400, cost * .8);
  }
  for (const tr of L.tracks) {
    if (t - tr.t1 > .8) continue;
    const b = tr.predict(Math.min(t, tr.t1 + .15));
    if (tr.on) drawMask(lctx, W, H, lv, b, tr.kind, L.style); else outline(lctx, W, H, b, tr.kind, 'rgba(255,255,255,.5)', '', false);
  }
  if (L.rec) $('#recTime').textContent = fmt((performance.now() - L.recStart) / 1000).replace(/\.\d$/, '');
}
lv.addEventListener('click', e => {
  const r = lv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  for (const tr of L.tracks) { const b = tr.b[tr.b.length - 1]; if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { tr.on = !tr.on; return; } }
});
$('#liveBtn').onclick = startLive;
$('#liveClose').onclick = stopLive;
$('#flipBtn').onclick = async () => { L.facing = L.facing === 'user' ? 'environment' : 'user'; try { await openCam(); } catch (e) { toast('Non riesco a cambiare fotocamera'); } };
$('#snapBtn').onclick = async () => { const blob = await new Promise(r => lv.toBlob(r, 'image/jpeg', .92)); showResult(blob, `incognitho-${stamp()}.jpg`, 'Foto pronta'); };
$('#recBtn').onclick = async () => {
  if (L.rec) { L.rec.stop(); return; }
  if (!window.MediaRecorder || !lv.captureStream) return toast('Registrazione non supportata da questo browser');
  const stream = lv.captureStream(30); let mic = null;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getAudioTracks().forEach(t => stream.addTrack(t)); } catch (e) { toast('Registro senza audio'); }
  const mime = pickMime(), chunks = [];
  const rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: 6e6 }));
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    if (mic) mic.getTracks().forEach(t => t.stop()); L.rec = null; $('#recBtn').classList.remove('on'); $('#recDot').hidden = true;
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    if (chunks.length) showResult(new Blob(chunks, { type }), `incognitho-live-${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, 'Video pronto');
  };
  rec.start(1000); L.rec = rec; L.recStart = performance.now(); $('#recBtn').classList.add('on'); $('#recDot').hidden = false;
};

/* ---------------- home: open files ---------------- */
$('#file').addEventListener('change', e => openFile(e.target.files[0]));
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); });
document.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
$('#homeBtn').onclick = () => { if (!S.busy) goHome(); };
document.addEventListener('keydown', e => { if (e.code === 'Space' && S.media && S.media.type === 'video' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('#playBtn').click(); } if (e.key === 'Escape') setAdding(false); });
window.addEventListener('resize', () => render());

/* ---------------- install ---------------- */
let deferred = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; };
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('Incognitho installata'); });
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('#iosHint').hidden = false;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });

// expose a few things for automated tests
window.__incApp = { openFile, analyze, addManual, exportVideo, exportPhoto, followFromHere, render, D };
