// Painting chart drawing primitives (core/grid/lib/chart-render.mjs `Prim`: rect, line, poly, wedge, circle, text) on a 2D canvas.
// A thin copy of Grid's paintPrims (src/apps/grid/surface/objects.ts, left as it is) with the font family as a parameter, for Quill's page
// view, which draws charts and typeset equations with the same primitives.

const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;

/** Draws chart primitives with their origin at (ox, oy) and one unit as `s` pixels. */
export function paintPrims(ctx: CanvasRenderingContext2D, prims: any[], ox: number, oy: number, s: number, family = '"Segoe UI", Carlito, Arial, sans-serif') {
  for (const p of prims) {
    switch (p.t) {
      case 'rect': {
        const x = ox + p.x * s, y = oy + p.y * s, w = p.w * s, h = p.h * s;
        ctx.beginPath();
        if (p.radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, p.radius * s); else ctx.rect(x, y, w, h);
        if (p.fill) { ctx.fillStyle = rgba(p.fill); ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      }
      case 'line':
        ctx.beginPath();
        p.pts.forEach((q: number[], i: number) => (i ? ctx.lineTo(ox + q[0] * s, oy + q[1] * s) : ctx.moveTo(ox + q[0] * s, oy + q[1] * s)));
        ctx.strokeStyle = rgba(p.color); ctx.lineWidth = p.width * s; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(p.dash ? [4 * s, 3 * s] : []);
        ctx.stroke(); ctx.setLineDash([]);
        break;
      case 'poly':
        ctx.beginPath();
        p.pts.forEach((q: number[], i: number) => (i ? ctx.lineTo(ox + q[0] * s, oy + q[1] * s) : ctx.moveTo(ox + q[0] * s, oy + q[1] * s)));
        ctx.closePath(); ctx.fillStyle = rgba(p.fill); ctx.fill();
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      case 'wedge': {
        // Angles run clockwise from 12 o'clock.
        const a0 = p.a0 - Math.PI / 2, a1 = p.a1 - Math.PI / 2, cx = ox + p.cx * s, cy = oy + p.cy * s;
        ctx.beginPath();
        ctx.arc(cx, cy, p.ro * s, a0, a1);
        if (p.ri > 0) ctx.arc(cx, cy, p.ri * s, a1, a0, true); else ctx.lineTo(cx, cy);
        ctx.closePath(); ctx.fillStyle = rgba(p.fill); ctx.fill();
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      }
      case 'circle':
        ctx.beginPath(); ctx.arc(ox + p.cx * s, oy + p.cy * s, p.r * s, 0, Math.PI * 2);
        if (p.fill) { ctx.fillStyle = rgba(p.fill); ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = rgba(p.stroke[0]); ctx.lineWidth = p.stroke[1] * s; ctx.stroke(); }
        break;
      case 'text': {
        ctx.save();
        ctx.translate(ox + p.x * s, oy + p.y * s);
        if (p.rotation) ctx.rotate(p.rotation);
        ctx.font = `${p.italic ? 'italic ' : ''}${p.bold ? '700 ' : '400 '}${p.size * s}px ${family}`;
        ctx.fillStyle = rgba(p.color);
        ctx.textAlign = p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : 'left';
        ctx.textBaseline = p.valign === 'middle' ? 'middle' : p.valign === 'bottom' ? 'bottom' : p.valign === 'baseline' ? 'alphabetic' : 'top';
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
        break;
      }
      default: break;
    }
  }
}
