// What Shape Format and WordArt add to a shape or a run of text on the page: gradient and see-through fills, shadow,
// glow, soft edges, and a text run's fill, outline, shadow, glow and reflection.
//
// Translated from wordcraft crates/render/src/lib.rs (shape fills, `effects`, `bands`) and the WordArt part of
// display/glyphs.rs at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The canvas does the blurring (shadowBlur, filter) where upstream overlays bands.
//
// `fill`: the model's fill form (core/quill/model/fill.mjs). `fx`: ShapeEffects {shadow, glow, softEdge}. A text run's
// effects are TextEffects {fill, outline, shadow, glow, reflection}. Lengths points, colours [r, g, b].

import {sanitizedShadow, sanitizedGlow, sanitizedReflection, sanitizedBevel, shadowOffset, shadowOpacity, glowOpacity} from '../../../../core/quill/model/effects.mjs';

const rgba = (c, a = 1) => `rgba(${c?.[0] ?? 0}, ${c?.[1] ?? 0}, ${c?.[2] ?? 0}, ${Math.max(0, Math.min(1, a))})`;

/** A gradient fill as a canvas gradient over the rectangle `r` (linear at an angle: 0 left to right, 90 top to bottom). */
export function gradientOf(ctx, f, r) {
  const stops = f.stops ?? [];
  let g;
  if (f.kind?.type === 'path') {
    const [l, t, rt, b] = f.kind.focus ?? [50, 50, 50, 50];
    const cx = r.x + (r.w * l) / 100, cy = r.y + (r.h * t) / 100;
    const reach = Math.max(Math.hypot(cx - r.x, cy - r.y), Math.hypot(cx - r.x - r.w, cy - r.y), Math.hypot(cx - r.x, cy - r.y - r.h), Math.hypot(cx - r.x - r.w, cy - r.y - r.h), 1);
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
    void rt; void b;
  } else {
    const a = ((f.kind?.angle ?? 90) * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const len = Math.abs(r.w * dx) + Math.abs(r.h * dy);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    g = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  }
  for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.pos / 100)), rgba(s.color, 1 - (s.transparency ?? 0) / 100));
  return g;
}

/** The canvas fill style of a fill form over `r`, or null for no fill. */
export function fillStyleOf(ctx, fill, r) {
  if (!fill) return null;
  if (Array.isArray(fill)) return rgba(fill);
  if (fill.type === 'solid') return rgba(fill.color, 1 - (fill.transparency ?? 0) / 100);
  if (fill.type === 'gradient') return gradientOf(ctx, fill, r);
  return null;
}

/**
 * Paint a shape with its effects: `fillPath()` fills and strokes it once (the caller's own drawing). Shadow and glow
 * are drawn behind it, soft edges feather its edge. `scale` is device pixels a point.
 */
export function withShapeEffects(ctx, fx, r, scale, drawBody, silhouette, pathFn = null) {
  const e = fx ?? {};
  if (e.glow) {
    const g = sanitizedGlow(e.glow);
    ctx.save();
    ctx.shadowColor = rgba(g.color, glowOpacity(g));
    ctx.shadowBlur = g.size * scale * 1.6;
    for (let i = 0; i < 2; i++) silhouette();
    ctx.restore();
  }
  if (e.shadow) {
    const s = sanitizedShadow(e.shadow), [dx, dy] = shadowOffset(s);
    ctx.save();
    ctx.shadowColor = rgba(s.color, shadowOpacity(s));
    ctx.shadowOffsetX = dx * scale;
    ctx.shadowOffsetY = dy * scale;
    ctx.shadowBlur = s.blur * scale;
    silhouette();
    ctx.restore();
  }
  // The shape drawn on a canvas of its own: soft edges and reflections need it.
  const offscreen = (flip, mask) => {
    const pad = 2, px = Math.max(1, Math.ceil(r.w * scale)) + pad * 2, py = Math.max(1, Math.ceil(r.h * scale)) + pad * 2;
    if (px * py > 16_000_000 || typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = px; c.height = py;
    const x = c.getContext('2d');
    if (!x) return null;
    if (flip) x.setTransform(scale, 0, 0, -scale, pad - r.x * scale, pad + (r.y + r.h) * scale);
    else x.setTransform(scale, 0, 0, scale, pad - r.x * scale, pad - r.y * scale);
    drawBody(x);
    x.setTransform(1, 0, 0, 1, 0, 0);
    mask(x, pad);
    return {c, pad};
  };
  const put = (o, dy = 0) => {
    ctx.save();
    ctx.scale(1 / scale, 1 / scale);
    ctx.drawImage(o.c, r.x * scale - o.pad, (r.y + dy) * scale - o.pad);
    ctx.restore();
  };
  let drawn = false;
  if (e.softEdge > 0) {
    // Masked by a blurred, smaller copy of its frame.
    const rad = Math.min(e.softEdge, r.w / 2, r.h / 2);
    const o = offscreen(false, (x, pad) => {
      x.globalCompositeOperation = 'destination-in';
      x.filter = `blur(${Math.max(rad * scale * 0.5, 0.5)}px)`;
      x.fillStyle = '#000';
      x.fillRect(pad + rad * scale, pad + rad * scale, Math.max(r.w * scale - rad * scale * 2, 1), Math.max(r.h * scale - rad * scale * 2, 1));
    });
    if (o) { put(o); drawn = true; }
  }
  if (!drawn) drawBody();
  if (e.bevel && pathFn) paintBevel(ctx, e.bevel, r, pathFn);
  if (e.reflection) {
    // A mirrored copy under the shape (its gap away) that fades from startAlpha to endAlpha over endPos of the height.
    const f = sanitizedReflection(e.reflection);
    const o = offscreen(true, (x, pad) => {
      const len = Math.max(r.h * scale * f.endPos, 1);
      x.globalCompositeOperation = 'destination-in';
      const g = x.createLinearGradient(0, pad, 0, pad + len);
      g.addColorStop(0, rgba([0, 0, 0], f.startAlpha));
      g.addColorStop(1, rgba([0, 0, 0], f.endAlpha));
      x.fillStyle = g;
      x.fillRect(0, pad, x.canvas.width, len);
    });
    if (o) put(o, r.h + f.dist);
  }
}

/** A bevel: the inside edge lit from the top left and shaded at the bottom right (a:bevelT), over the shape's path. */
function paintBevel(ctx, bevel, r, pathFn) {
  const b = sanitizedBevel(bevel);
  if (!b) return;
  const k = {softRound: 1.3, circle: 1.2, convex: 1.3, hardEdge: 0.6, cross: 0.8, angle: 1, relaxedInset: 1.1}[b.preset] ?? 1;
  const w = Math.max(Math.min(b.w, r.w / 3, r.h / 3) * k, 1);
  ctx.save();
  pathFn(ctx);
  ctx.clip();
  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.strokeStyle = g;
  ctx.lineWidth = w * 2;
  ctx.setLineDash([]);
  pathFn(ctx);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw a text run with its WordArt effects. `put(mode)` draws the run's text in the current fill style (`mode`
 * 'fill') or its outline ('stroke'); `box` is {x, y, w, size} (baseline y), `base` the run's own colour.
 */
export function paintTextEffects(ctx, fx, box, base, scale, put) {
  const {x, y, w, size} = box;
  const fill = fx.fill;
  const rect = {x, y: y - size, w: Math.max(w, 1), h: size * 1.2};
  const fillStyle = fill == null ? base : fill.type === 'none' ? null : fill.type === 'solid' ? rgba(fill.color, 1 - (fill.transparency ?? 0) / 100) : fill.type === 'gradient'
    ? gradientOf(ctx, {stops: fill.stops, kind: {type: 'linear', angle: fill.angle ?? 90}}, rect) : base;
  if (fx.glow) {
    const g = sanitizedGlow(fx.glow);
    ctx.save();
    ctx.shadowColor = rgba(g.color, glowOpacity(g));
    ctx.shadowBlur = g.size * scale * 1.2;
    ctx.fillStyle = rgba(g.color, glowOpacity(g));
    put('fill');
    put('fill');
    ctx.restore();
  }
  if (fx.shadow) {
    const s = sanitizedShadow(fx.shadow), [dx, dy] = shadowOffset(s);
    ctx.save();
    ctx.shadowColor = rgba(s.color, shadowOpacity(s));
    ctx.shadowOffsetX = dx * scale; ctx.shadowOffsetY = dy * scale; ctx.shadowBlur = s.blur * scale;
    ctx.fillStyle = fillStyle ?? 'rgba(0,0,0,0.01)';
    put('fill');
    ctx.restore();
  }
  if (fx.reflection) {
    const r = fx.reflection;
    ctx.save();
    ctx.globalAlpha *= Math.max(0, 1 - (r.transparency ?? 50) / 100) * 0.55;
    ctx.translate(0, y * 2 + (r.distance ?? 0) + size * 0.25);
    ctx.scale(1, -1);
    ctx.fillStyle = fillStyle ?? base;
    if (fillStyle !== null) put('fill');
    ctx.restore();
  }
  if (fillStyle !== null) { ctx.fillStyle = fillStyle; put('fill'); }
  if (fx.outline?.color) {
    ctx.save();
    ctx.strokeStyle = rgba(fx.outline.color, 1 - (fx.outline.transparency ?? 0) / 100);
    ctx.lineWidth = Math.max(fx.outline.width ?? 0.75, 0.25);
    ctx.lineJoin = 'round';
    put('stroke');
    ctx.restore();
  }
}

/**
 * Text warp (Shape Format › Text Effects › Transform): where the letter whose unwarped centre is (x, baseline) goes in a
 * text box `frame` {x, y, w, h}, as {dx, dy, rot (radians), sy}: an offset from where it was, a turn and a vertical
 * stretch. The twelve presets wordcraft draws bent (arch up and down, circle, wave, slants, inflate, deflate, chevrons,
 * triangles), approximated letter by letter as wordcraft's `warp.rs` bends the glyph outlines; the others draw flat.
 */
export function warpAt(preset, frame, x, baseline, size) {
  const flat = {dx: 0, dy: 0, rot: 0, sy: 1};
  const {w, h} = frame;
  if (!(w > 0 && h > 0)) return flat;
  const cx = frame.x + w / 2, cy = frame.y + h / 2;
  const s = x - cx;                       // along the line from the middle
  const u = Math.max(0, Math.min(1, (x - frame.x) / w));
  const tent = 1 - Math.abs(2 * u - 1);   // 0 at the ends, 1 in the middle
  const amp = Math.min(h * 0.22, size * 0.8);
  switch (preset) {
    case 'textArchUp': case 'textArchDown': {
      const R = w / 2.4, a = s / R, sign = preset === 'textArchUp' ? 1 : -1;
      return {dx: R * Math.sin(a) - s, dy: sign * R * (1 - Math.cos(a)), rot: sign * a, sy: 1};
    }
    case 'textCircle': {
      const R = Math.max(Math.min(w, h) / 2 - size * 0.4, size), a = s / R;
      return {dx: R * Math.sin(a) - s, dy: cy - R * Math.cos(a) + size * 0.3 - baseline, rot: a, sy: 1};
    }
    case 'textWave1': {
      const k = (2 * Math.PI) / w, y = amp * Math.sin(k * (x - frame.x));
      return {dx: 0, dy: y, rot: Math.atan(amp * k * Math.cos(k * (x - frame.x))), sy: 1};
    }
    case 'textSlantUp': case 'textSlantDown': {
      const slope = (preset === 'textSlantUp' ? -1 : 1) * 0.28;
      return {dx: 0, dy: slope * s, rot: Math.atan(slope), sy: 1};
    }
    case 'textInflate': return {dx: 0, dy: -size * 0.15 * tent, rot: 0, sy: 1 + 0.7 * tent};
    case 'textDeflate': return {dx: 0, dy: 0, rot: 0, sy: 1 - 0.45 * tent};
    case 'textChevron': return {dx: 0, dy: amp * (1 - tent), rot: 0, sy: 1};
    case 'textChevronInverted': return {dx: 0, dy: -amp * (1 - tent), rot: 0, sy: 1};
    case 'textTriangle': return {dx: 0, dy: 0, rot: 0, sy: 0.5 + 1.0 * tent};
    case 'textTriangleInverted': return {dx: 0, dy: 0, rot: 0, sy: 1.5 - 1.0 * tent};
    default: return flat;
  }
}
