/* Incognitho — drawing the masks. src = the full frame (video, image or canvas) already drawn on ctx. */
const tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
const tmp2 = document.createElement('canvas'), t2ctx = tmp2.getContext('2d');
export const EMOJI = ['😎', '🙂', '😶', '🤡', '👽', '🤖', '🐱', '🐶', '🦊', '🐸', '🙈', '💀', '👻', '🎭', '⭐', '❤️', '🍕', '🌚'];

function shape(ctx, kind, x, y, w, h) {
  ctx.beginPath();
  if (kind === 'face') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else { const r = Math.min(w, h) * .18; ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
}
/* ctx: target, cw/ch: its size, src: frame source, box normalised, st: style */
export function draw(ctx, cw, ch, src, box, kind, st) {
  const x = box.x * cw, y = box.y * ch, w = box.w * cw, h = box.h * ch;
  if (w < 2 || h < 2) return;
  const sx = Math.max(0, x), sy = Math.max(0, y), sw = Math.min(cw, x + w) - sx, sh = Math.min(ch, y + h) - sy;
  if (sw < 1 || sh < 1) return;
  const s = st.strength;
  ctx.save(); shape(ctx, kind, x, y, w, h); ctx.clip();
  if (st.mode === 'blur') {
    // two-step down/up sampling gives a strong, cheap, cross-browser blur; sample a margin so edges don't leak sharp pixels
    const m = Math.max(w, h) * .25, ax = Math.max(0, x - m), ay = Math.max(0, y - m), aw = Math.min(cw, x + w + m) - ax, ah = Math.min(ch, y + h + m) - ay;
    const f = 3 + s * 13, tw = Math.max(2, Math.round(aw / f)), th = Math.max(2, Math.round(ah / f));
    tmp.width = tw; tmp.height = th; tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high'; tctx.drawImage(ctx.canvas, ax, ay, aw, ah, 0, 0, tw, th);
    tmp2.width = Math.max(2, tw >> 1); tmp2.height = Math.max(2, th >> 1); t2ctx.drawImage(tmp, 0, 0, tmp2.width, tmp2.height);
    tctx.clearRect(0, 0, tw, th); tctx.drawImage(tmp2, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(tmp, 0, 0, tw, th, ax, ay, aw, ah);
  } else if (st.mode === 'pixel') {
    const blocks = Math.round(16 - s * 12), bw = Math.max(2, Math.min(blocks, Math.round(sw / 3))), bh = Math.max(2, Math.round(bw * sh / sw));
    tmp.width = bw; tmp.height = bh; tctx.imageSmoothingEnabled = true; tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, bw, bh);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, bw, bh, sx, sy, sw, sh); ctx.imageSmoothingEnabled = true;
  } else if (st.mode === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); }
  else if (st.mode === 'color') { ctx.fillStyle = st.color || '#111'; ctx.fillRect(x, y, w, h); }
  else if (st.mode === 'emoji') {
    // blur underneath, so nothing peeks around the emoji's edges
    const f = 10, tw = Math.max(2, Math.round(sw / f)), th = Math.max(2, Math.round(sh / f));
    tmp.width = tw; tmp.height = th; tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, tw, th); ctx.drawImage(tmp, 0, 0, tw, th, sx, sy, sw, sh);
    ctx.restore(); ctx.save();
    const size = Math.max(w, h) * (kind === 'face' ? 1.08 : .95);
    ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (kind === 'plate' || kind === 'manual' && w / h > 1.6) { const n = Math.max(1, Math.round(w / h)); const sz = Math.min(h * 1.05, w / n); ctx.font = `${sz}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; for (let i = 0; i < n; i++) ctx.fillText(st.emoji, x + (i + .5) * w / n, y + h / 2 + sz * .05); }
    else ctx.fillText(st.emoji, x + w / 2, y + h / 2 + size * .06);
  }
  ctx.restore();
}
export function outline(ctx, cw, ch, box, kind, color, label, selected) {
  const x = box.x * cw, y = box.y * ch, w = box.w * cw, h = box.h * ch;
  ctx.save(); ctx.lineWidth = selected ? 3 : 1.5; ctx.strokeStyle = color; ctx.setLineDash(selected ? [] : [6, 4]);
  shape(ctx, kind, x, y, w, h); ctx.stroke(); ctx.setLineDash([]);
  if (label) { ctx.font = '600 12px "JetBrains Mono",monospace'; const tw = ctx.measureText(label).width + 10; ctx.fillStyle = color; ctx.fillRect(x, y - 18, tw, 17); ctx.fillStyle = '#0b0c10'; ctx.fillText(label, x + 5, y - 5); }
  ctx.restore();
}
