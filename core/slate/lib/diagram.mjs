// The diagram of a page (Insert > Files > Diagram; U:slate/rest).
//
// OneNote embeds a Visio drawing. The app has no Visio, so a diagram on the page is drawn by the app
// from an outline the person types, one line per box, and laid out for them: the way a text outline
// becomes a SmartArt graphic in Office, without a canvas to place boxes on by hand. Not checked
// against upstream (there is none).
//
//   flowchart   the lines in order, top to bottom, joined by arrows. (Start) is a rounded terminator,
//               <Is it done?> is a diamond, any other line is a box;
//   hierarchy   an outline: a line indented under another (two spaces or a tab) hangs below it;
//   process     the lines left to right, joined by arrows;
//   cycle       the lines round a circle, the last joined back to the first.
//
// The drawing is an SVG string made here from the outline alone (text is escaped; nothing from the
// outline is ever markup or script). No DOM, no Node built-ins.

export const DIAGRAM_KINDS = Object.freeze(['flowchart', 'hierarchy', 'process', 'cycle']);
export const DIAGRAM_LABELS = Object.freeze({flowchart: 'Flowchart', hierarchy: 'Hierarchy', process: 'Process', cycle: 'Cycle'});
export const MAX_DIAGRAM_NODES = 60;
export const MAX_DIAGRAM_TEXT = 4000;
const MAX_LABEL = 32;

export const SAMPLE = Object.freeze({
  flowchart: '(Start)\nGather notes\n<Is it clear?>\nShare the summary\n(Done)',
  hierarchy: 'Project\n  Research\n    Interviews\n    Survey\n  Design\n  Build',
  process: 'Plan\nDo\nCheck\nAct',
  cycle: 'Plan\nDo\nCheck\nAct',
});

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The boxes of an outline: [{text, shape, level}] (blank lines are skipped; text is cut to a label's length). */
export function parseOutline(text) {
  const nodes = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const lead = /^[ \t]*/.exec(raw)[0];
    const level = Math.floor(lead.replace(/\t/g, '  ').length / 2);
    let t = raw.trim();
    let shape = 'box';
    let m;
    if ((m = /^\((.*)\)$/.exec(t)) && m[1].trim()) { shape = 'terminator'; t = m[1].trim(); }
    else if ((m = /^<(.*)>$/.exec(t)) && m[1].trim()) { shape = 'decision'; t = m[1].trim(); }
    if (t.length > MAX_LABEL) t = `${t.slice(0, MAX_LABEL - 1)}…`;
    nodes.push({text: t, shape, level});
    if (nodes.length >= MAX_DIAGRAM_NODES) break;
  }
  return nodes;
}

const FONT = 13, PAD = 12, BOX_H = 34, GAP_Y = 30, GAP_X = 24;
const widthOf = n => Math.max(72, Math.min(240, Math.round(n.text.length * 7.2 + 2 * PAD + (n.shape === 'decision' ? 36 : 0))));
const heightOf = n => (n.shape === 'decision' ? 54 : BOX_H);

function boxSvg(n, x, y, w, h) {
  const label = `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-size="${FONT}">${esc(n.text)}</text>`;
  let shape;
  if (n.shape === 'decision') shape = `<polygon class="dg-node" points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"/>`;
  else if (n.shape === 'terminator') shape = `<rect class="dg-node" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
  else shape = `<rect class="dg-node" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>`;
  return `<g data-node="${esc(n.text)}">${shape}${label}</g>`;
}
const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1), s = 7;
  const hx = x2 - Math.cos(a) * s, hy = y2 - Math.sin(a) * s;
  const px = Math.sin(a) * 4, py = -Math.cos(a) * 4;
  return `<path class="dg-edge" d="M${x1} ${y1} L${hx.toFixed(1)} ${hy.toFixed(1)}"/><path class="dg-head" d="M${x2} ${y2} L${(hx + px).toFixed(1)} ${(hy + py).toFixed(1)} L${(hx - px).toFixed(1)} ${(hy - py).toFixed(1)} Z"/>`;
};

function chain(nodes, vertical) {
  const ws = nodes.map(widthOf), hs = nodes.map(heightOf);
  const out = [];
  let width, height;
  if (vertical) {
    width = Math.max(...ws) + 2 * 8;
    let y = 8;
    const ys = nodes.map((_, i) => { const at = y; y += hs[i] + GAP_Y; return at; });
    nodes.forEach((n, i) => {
      out.push(boxSvg(n, Math.round((width - ws[i]) / 2), ys[i], ws[i], hs[i]));
      if (i) out.push(arrow(width / 2, ys[i - 1] + hs[i - 1], width / 2, ys[i]));
    });
    height = y - GAP_Y + 8;
  } else {
    const h = Math.max(...hs);
    let x = 8;
    const xs = nodes.map((_, i) => { const at = x; x += ws[i] + GAP_X + 8; return at; });
    nodes.forEach((n, i) => {
      out.push(boxSvg(n, xs[i], 8 + Math.round((h - hs[i]) / 2), ws[i], hs[i]));
      if (i) out.push(arrow(xs[i - 1] + ws[i - 1], 8 + h / 2, xs[i], 8 + h / 2));
    });
    width = x - GAP_X - 8 + 8; height = h + 16;
  }
  return {body: out.join(''), width, height};
}

function tree(nodes) {
  // A level never jumps by more than one below its parent.
  const items = [];
  const stack = [];
  for (const n of nodes) {
    const level = Math.min(n.level, stack.length);
    stack.length = level;
    const item = {...n, level, children: []};
    if (level) stack[level - 1].children.push(item);
    items.push(item);
    stack[level] = item;
  }
  const roots = items.filter(i => i.level === 0);
  // Several top-level lines hang under an invisible root, so one tree holds them.
  const subtree = i => { i.w = widthOf(i); i.h = heightOf(i); i.span = Math.max(i.w, i.children.length ? i.children.reduce((s, c) => s + subtree(c) + GAP_X, -GAP_X) : 0); return i.span; };
  const out = [];
  let width = 0, height = 0;
  const place = (i, left, top) => {
    const x = left + (i.span - i.w) / 2;
    out.push(boxSvg(i, Math.round(x), top, i.w, i.h));
    width = Math.max(width, x + i.w); height = Math.max(height, top + i.h);
    let cx = left + (i.span - (i.children.reduce((s, c) => s + c.span + GAP_X, -GAP_X))) / 2;
    const tops = top + i.h + GAP_Y;
    for (const c of i.children) {
      out.push(`<path class="dg-edge" d="M${x + i.w / 2} ${top + i.h} V${top + i.h + GAP_Y / 2} H${cx + c.span / 2} V${tops}"/>`);
      place(c, cx, tops);
      cx += c.span + GAP_X;
    }
  };
  let left = 8;
  for (const r of roots) { subtree(r); place(r, left, 8); left += r.span + GAP_X; }
  return {body: out.join(''), width: width + 8, height: height + 8};
}

function cycle(nodes) {
  const n = nodes.length;
  if (n === 1) return chain(nodes, true);
  const ws = nodes.map(widthOf), hs = nodes.map(heightOf);
  const rx = Math.max(110, Math.max(...ws) * (n > 4 ? 0.9 : 0.7) + n * 10), ry = Math.max(80, n * 14 + 40);
  const cx = rx + Math.max(...ws) / 2 + 8, cy = ry + Math.max(...hs) / 2 + 8;
  const at = i => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return {x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a}; };
  const out = [];
  nodes.forEach((_, i) => {
    const p = at(i), q = at((i + 1) % n);
    const gap = 0.22 * Math.min(2 * Math.PI / n, 1.2);
    const a1 = p.a + gap, a2 = q.a - gap;
    out.push(arrow(cx + rx * Math.cos(a1), cy + ry * Math.sin(a1), cx + rx * Math.cos(a2), cy + ry * Math.sin(a2)));
  });
  nodes.forEach((nd, i) => { const p = at(i); out.push(boxSvg(nd, Math.round(p.x - ws[i] / 2), Math.round(p.y - hs[i] / 2), ws[i], hs[i])); });
  return {body: out.join(''), width: Math.round(2 * cx), height: Math.round(2 * cy)};
}

/** The drawing of a diagram: {svg, width, height, nodes}. An empty outline draws an empty frame. */
export function drawDiagram(kind, text) {
  const nodes = parseOutline(text);
  const k = DIAGRAM_KINDS.includes(kind) ? kind : 'flowchart';
  if (!nodes.length) return {svg: '', width: 0, height: 0, nodes: 0};
  const r = k === 'hierarchy' ? tree(nodes) : k === 'cycle' ? cycle(nodes) : chain(nodes, k === 'flowchart');
  const w = Math.ceil(r.width), h = Math.ceil(r.height);
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`${DIAGRAM_LABELS[k]} diagram of ${nodes.length} ${nodes.length === 1 ? 'box' : 'boxes'}`)}">${r.body}</svg>`,
    width: w, height: h, nodes: nodes.length,
  };
}

/** The outline text of a diagram, trimmed to what a page holds. */
export const cleanOutline = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').slice(0, 200).join('\n').slice(0, MAX_DIAGRAM_TEXT);
