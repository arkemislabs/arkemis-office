// Export a PDF to Word, PowerPoint, HTML and RTF: each page is reduced to paragraphs (text, box, size, weight, colour) and images; the
// writers turn that into a flowing document: headings are the paragraphs set larger than the body text, a block that continues
// another on its line (an italic word, a link) is a run of that block's paragraph, tables are detected from the text layout.
// Word keeps pages with rotated text, or text overlapped by artwork or watermark-sized text, as positioned, editable shapes.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/export/src/layout.rs     Block, Image, Page, Table, Cell, body_size, level, continued_from, paragraphs, para_level, tables,
//                                   items (a page's paragraphs, tables and images from the top down)
//   crates/export/src/as_docx.rs    rgb8, hex, run_xml, docx_table, positioned (pages kept as shapes), positioned_page, section, docx
//   crates/export/src/as_html.rs    allowed, esc, base64, html
//   crates/export/src/as_rtf.rs     rtf_text, rtf (colour table, runs as groups, real table rows)
//   crates/export/src/pptx.rs       emu, height_emu, run_drawingml, pptx_table, pptx (a slide per page, the largest text as its title)
// Blocks come from lib/reading-blocks.mjs. A page here has `images: []` unless the caller gives some ({ext, bytes, rect, size,
// rotation}; export.mjs says why none are read yet): the writers handle them as upstream does.
// A rectangle is [x0, y0, x1, y1] on the displayed page in points with y up. No DOM, no Node built-ins (JSZip writes the packages).

import JSZip from 'jszip';

const total = (a, b) => (Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : a - b);

// ── layout.rs ─────────────────────────────────────────────────────────────────────────────────

export const COL_TOL = 4;
export const MAX_COLS = 63;
const INLINE_GAP = 0.5;
const CONTINUATION_PROBE = 64;
const WORD_GAP = 0.12;

/** The body text size: the size most of the document's characters are set in (11 with no text). */
export function bodySize(pages) {
  const by = [];
  const slot = new Map();
  for (const p of pages) for (const b of p.blocks) {
    const k = Math.round(b.size * 2);
    let i = slot.get(k);
    if (i === undefined) { i = by.length; slot.set(k, i); by.push([k, 0]); }
    by[i][1] += new TextEncoder().encode(b.text).length;
  }
  let best = null;
  for (const e of by) if (!best || e[1] >= best[1]) best = e;
  return best ? best[0] / 2 : 11;
}

/** Heading level for a block: 1 for 1.6x the body size or more, 2 for 1.25x or more, 0 for body text. */
function level(b, body) {
  const bytes = new TextEncoder().encode(b.text).length;
  const short = bytes < 200;
  if (short && b.size >= body * 1.6) return 1;
  if (short && (b.size >= body * 1.25 || (b.bold && b.size >= body && bytes < 80 && !b.text.endsWith('.')))) return 2;
  return 0;
}

/** Per block, the block it continues on the same line: of those it could continue, the one that ends nearest to where it starts. */
export function continuedFrom(blocks) {
  const byEnd = blocks.map((b, i) => [b.rect[2], i]).sort((a, b) => total(a[0], b[0]));
  return blocks.map((b, bi) => {
    const limit = b.rect[0] - INLINE_GAP * b.size;
    let lo = 0, hi = byEnd.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (byEnd[mid][0] < limit) lo = mid + 1; else hi = mid; }
    let best = null;
    let taken = 0;
    for (let k = lo; k < byEnd.length && byEnd[k][0] <= b.rect[0] + 1 && taken < CONTINUATION_PROBE; k++, taken++) {
      const ai = byEnd[k][1];
      if (ai === bi) continue;
      const a = blocks[ai];
      if (!(Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]) > 0.5 * Math.min(a.rect[3] - a.rect[1], b.rect[3] - b.rect[1]))) continue;
      const d = Math.abs(a.rect[2] - b.rect[0]);
      if (!best || d < best[1]) best = [ai, d];
    }
    return best ? best[0] : null;
  });
}

/** A page's paragraphs, each a list of runs ({block, text}) from left to right along its line. Blocks marked in `skip` are left out. */
export function paragraphs(blocks, skip = []) {
  const skipped = i => !!skip[i];
  const from = continuedFrom(blocks);
  const order = blocks.map((b, i) => [b.rect[0], i]).filter(([, i]) => !skipped(i)).sort((a, b) => total(a[0], b[0]) || a[1] - b[1]);
  const head = blocks.map((_, i) => i);
  const members = blocks.map(() => []);
  for (const [x0, bi] of order) {
    const b = blocks[bi];
    const ai = from[bi];
    const joined = ai !== null && !skipped(ai) && total(blocks[ai].rect[0], x0) < 0 && Math.abs(blocks[ai].rotation - b.rotation) <= 0.1 ? head[ai] : null;
    const h = joined ?? bi;
    head[bi] = h;
    members[h].push(bi);
  }
  return members.filter(m => m.length).map(m => {
    const runs = [];
    for (const bi of m) {
      const b = blocks[bi];
      const prev = runs.at(-1);
      if (prev && !/\s$/.test(prev.text) && !/^\s/.test(b.text) && (prev.block.spaceAround[1] || b.spaceAround[0] || b.rect[0] - prev.block.rect[2] > b.size * WORD_GAP)) prev.text += ' ';
      runs.push({block: b, text: b.text});
    }
    return runs;
  });
}

/** A paragraph's heading level: the lowest of its runs', a marker smaller than the first run (a footnote number) not counting. */
function paraLevel(runs, body) {
  const first = runs[0];
  if (!first) return 0;
  const marker = r => r.block.size < first.block.size * 0.9 && [...r.block.text.trim()].length <= 3;
  const levels = runs.filter(r => !marker(r)).map(r => level(r.block, body));
  return levels.length ? Math.min(...levels) : 0;
}

const isCellLike = b => b.rect[3] - b.rect[1] <= b.size * 5 && b.text.trim() !== '';

/** Tables detected from a page's text layout: [{rect, cols, rows: [[{text, size, bold, italic, color, span}]]}] and, per block, whether a table consumed it. */
export function tables(blocks) {
  const consumed = blocks.map(() => false);
  const xs = blocks.map((b, i) => [b.rect[0], i]).filter(([, i]) => isCellLike(blocks[i])).sort((a, b) => total(a[0], b[0]));
  let cols = [];
  for (const [x, i] of xs) {
    const last = cols.at(-1);
    if (last && Math.abs(x - last[0]) <= COL_TOL) { last[0] = (last[0] * last[1].length + x) / (last[1].length + 1); last[1].push(i); } else cols.push([x, [i]]);
  }
  cols = cols.filter(([, m]) => m.length >= 2);
  if (cols.length < 2) return [[], consumed];
  const colOf = blocks.map(() => null);
  cols.forEach(([, members], ci) => { for (const i of members) colOf[i] = ci; });
  const columnAt = x => {
    let lo = 0, hi = cols.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cols[mid][0] < x - COL_TOL) lo = mid + 1; else hi = mid; }
    return lo < cols.length && Math.abs(cols[lo][0] - x) <= COL_TOL ? lo : null;
  };
  const rows = [];
  const order = blocks.map((_, i) => i).sort((a, b) => total(blocks[b].rect[3], blocks[a].rect[3]) || total(blocks[a].rect[0], blocks[b].rect[0]));
  for (const bi of order) {
    const b = blocks[bi];
    if (!isCellLike(b)) continue;
    const ci = columnAt(b.rect[0]);
    if (ci === null) continue;
    const row = rows.at(-1);
    let joins = false;
    if (row) {
      const rb = blocks[row[0][1]];
      const overlap = Math.min(rb.rect[3], b.rect[3]) - Math.max(rb.rect[1], b.rect[1]);
      joins = overlap > 0.5 * Math.min(rb.rect[3] - rb.rect[1], b.rect[3] - b.rect[1]);
    }
    if (joins) row.push([ci, bi]); else rows.push([[ci, bi]]);
  }
  const out = [];
  const edgesOf = used => {
    const edges = used.map(i => colOf[i]).filter(ci => ci !== null).map(ci => cols[ci][0]).sort(total);
    const dedup = [];
    for (const e of edges) if (!dedup.length || Math.abs(dedup.at(-1) - e) > COL_TOL) dedup.push(e);
    return dedup;
  };
  const flush = run => {
    if (run.length < 2) return;
    const used = [...new Set(run.flat().map(([, i]) => i))].sort((a, b) => a - b);
    const edges = edgesOf(used);
    const ncols = edges.length;
    if (!((ncols >= 3 || (ncols === 2 && run.length >= 3)) && ncols <= MAX_COLS)) return;
    const right = Math.max(...used.map(i => blocks[i].rect[2])) + COL_TOL;
    const rowsOut = [];
    for (const row of run) {
      const slots = new Array(ncols).fill(null);
      for (const [, bi] of row) {
        const b = blocks[bi];
        const slot = edges.findIndex(e => Math.abs(e - b.rect[0]) <= COL_TOL);
        if (slot < 0) continue;
        const span = edges.slice(slot + 1).filter(e => e > b.rect[0] + COL_TOL && e < b.rect[2] - COL_TOL).length + 1;
        const cell = {text: b.text.trim(), size: b.size, bold: b.bold, italic: b.italic, color: b.color, span};
        if (slots[slot]) { slots[slot][0].text += ` ${cell.text}`; slots[slot][1].push(bi); } else slots[slot] = [cell, [bi]];
      }
      const materialized = [];
      let column = 0;
      while (column < ncols) {
        const taken = slots[column];
        if (taken) {
          slots[column] = null;
          const [cell, sources] = taken;
          // A spanning cell can skip later slots: source blocks are consumed only when their text is emitted.
          for (const bi of sources) consumed[bi] = true;
          cell.span = Math.max(1, Math.min(cell.span, ncols - column));
          column += cell.span;
          materialized.push(cell);
        } else { column += 1; materialized.push({text: '', size: 11, bold: false, italic: false, color: [0, 0, 0], span: 1}); }
      }
      while (materialized.length && materialized.at(-1).text === '' && materialized.some(c => c.span > 1)) materialized.pop();
      rowsOut.push(materialized);
    }
    const rect = [edges[0], Math.min(...used.map(i => blocks[i].rect[1])), right, Math.max(...used.map(i => blocks[i].rect[3]))];
    out.push({rect, cols: edges, rows: rowsOut});
  };
  const spansRun = (edges, bi) => {
    const b = blocks[bi];
    return edges.some(e => Math.abs(e - b.rect[0]) <= COL_TOL) && edges.some(e => e > b.rect[0] + COL_TOL && e < b.rect[2] - COL_TOL);
  };
  const runEdges = run => edgesOf([...new Set(run.flat().map(([, i]) => i))]);
  const cont = continuedFrom(blocks).map(f => f !== null);
  const qual = rows.map(row => {
    const cells = row.filter(([, bi]) => !cont[bi]);
    const spans = cells.map(([, bi]) => [blocks[bi].rect[0], blocks[bi].rect[2]]).sort((a, b) => total(a[0], b[0]));
    const apart = spans.every((s, k) => k === 0 || s[0] >= spans[k - 1][1] - COL_TOL);
    return apart && new Set(cells.map(([c]) => c)).size >= 2;
  });
  let i = 0;
  while (i < rows.length) {
    if (!qual[i]) { i++; continue; }
    const start = i;
    while (i < rows.length && qual[i]) i++;
    const end = i;
    const pieces = [];
    if (start > 0 && rows[start - 1].length === 1 && spansRun(runEdges(rows.slice(start, end)), rows[start - 1][0][1])) pieces.push(rows[start - 1]);
    pieces.push(...rows.slice(start, end));
    if (end < rows.length && rows[end].length === 1 && spansRun(runEdges(rows.slice(start, end)), rows[end][0][1])) pieces.push(rows[end]);
    flush(pieces);
  }
  return [out, consumed];
}

/** What goes into the output, in order: {kind: 'para', runs, level} | {kind: 'table', table} | {kind: 'img', image} | {kind: 'break'}. */
export function items(pages) {
  const body = bodySize(pages);
  const out = [];
  pages.forEach((p, i) => {
    if (i > 0) out.push({kind: 'break'});
    const [tabs, consumed] = tables(p.blocks);
    const parts = [];
    for (const runs of paragraphs(p.blocks, consumed)) {
      const first = runs[0].block;
      parts.push([first.rect[3], first.rect[0], {kind: 'para', runs, level: paraLevel(runs, body)}]);
    }
    for (const t of tabs) parts.push([t.rect[3], t.rect[0], {kind: 'table', table: t}]);
    for (const im of p.images ?? []) parts.push([im.rect[3], im.rect[0], {kind: 'img', image: im}]);
    parts.sort((a, b) => total(b[0], a[0]) || total(a[1], b[1]));
    out.push(...parts.map(x => x[2]));
  });
  return out;
}

// ── as_html.rs and as_docx.rs helpers ─────────────────────────────────────────────────────────

/** Whether a character may appear in the output: XML 1.0 forbids the C0 controls other than tab, line feed and carriage return, and U+FFFE and U+FFFF. */
export const allowed = c => { const n = c.codePointAt(0); return c === '\t' || c === '\n' || c === '\r' || !(n < 0x20 || n === 0x7f || n === 0xfffe || n === 0xffff); };

export function esc(s) {
  let o = '';
  for (const c of s) {
    if (!allowed(c)) continue;
    o += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c;
  }
  return o;
}

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return globalThis.btoa(s); };

/** A colour's 8-bit sRGB components (NaN and out-of-range values clamp; NaN reads as 0). */
export const rgb8 = c => c.map(v => (Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 255) : 0));
/** The colour as RRGGBB, or null for black (the default every format already uses). */
export function hex(c) {
  const [r, g, b] = rgb8(c);
  return r | g | b ? [r, g, b].map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('') : null;
}

/** One HTML file: headings and paragraphs, tables as real tables, images inline, a rule between pages. */
export function html(pages, title) {
  let s = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>body{max-width:46em;margin:2em auto;font-family:sans-serif;line-height:1.45}img{max-width:100%}hr{border:0;border-top:1px solid #ccc;margin:2em 0}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #999;padding:2px 6px;vertical-align:top}</style>\n</head>\n<body>\n`;
  for (const it of items(pages)) {
    if (it.kind === 'para') {
      const first = it.runs[0].block;
      let t = '';
      for (const r of it.runs) {
        let run = esc(r.text);
        if (r.block.italic) run = `<em>${run}</em>`;
        if (r.block.bold && it.level === 0) run = `<strong>${run}</strong>`;
        const colour = rgb8(r.block.color);
        if (colour.some((v, k) => v !== rgb8(first.color)[k])) run = `<span style="color:#${colour.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}">${run}</span>`;
        t += run;
      }
      const h = hex(first.color);
      const style = h ? ` style="color:#${h}"` : '';
      s += it.level === 0 ? `<p${style}>${t}</p>\n` : `<h${it.level}${style}>${t}</h${it.level}>\n`;
    } else if (it.kind === 'table') {
      s += '<table>\n';
      for (const row of it.table.rows) {
        s += '<tr>';
        for (const c of row) {
          let body = esc(c.text);
          if (c.italic) body = `<em>${body}</em>`;
          if (c.bold) body = `<strong>${body}</strong>`;
          const h = hex(c.color);
          s += `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${h ? ` style="color:#${h}"` : ''}>${body}</td>`;
        }
        s += '</tr>\n';
      }
      s += '</table>\n';
    } else if (it.kind === 'img') s += `<p><img alt="" src="data:${it.image.ext === 'jpg' ? 'image/jpeg' : 'image/png'};base64,${b64(it.image.bytes)}"></p>\n`;
    else s += '<hr>\n';
  }
  return `${s}</body>\n</html>\n`;
}

// ── as_rtf.rs ─────────────────────────────────────────────────────────────────────────────────

function rtfText(s) {
  let o = '';
  for (const c of s) {
    if (!allowed(c)) continue;
    if (c === '\\' || c === '{' || c === '}') o += `\\${c}`;
    else if (c.codePointAt(0) < 128) o += c;
    else {
      // \uN with a ? fallback; UTF-16 units as signed 16-bit numbers.
      for (let i = 0; i < c.length; i++) { const u = c.charCodeAt(i); o += `\\u${u > 32767 ? u - 65536 : u}?`; }
    }
  }
  return o;
}

/** Rich Text Format: paragraphs with their sizes and bold/italic, real table rows, page breaks between pages (images are left out). */
export function rtf(pages) {
  const list = items(pages);
  const colors = [];
  const slot = new Map();
  const note = c => {
    const k = rgb8(c).join(',');
    if (k !== '0,0,0' && !slot.has(k)) { slot.set(k, colors.length); colors.push(rgb8(c)); }
  };
  for (const it of list) {
    if (it.kind === 'para') it.runs.forEach(r => note(r.block.color));
    else if (it.kind === 'table') it.table.rows.flat().forEach(c => note(c.color));
  }
  const cf = c => { const i = slot.get(rgb8(c).join(',')); return i === undefined ? '' : `\\cf${i + 1}`; };
  let s = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\n';
  if (colors.length) s += `{\\colortbl;${colors.map(([r, g, b]) => `\\red${r}\\green${g}\\blue${b};`).join('')}}\n`;
  for (const it of list) {
    if (it.kind === 'para') {
      const fmt = (b, later) => {
        let f = `\\fs${Math.round(b.size * 2)}`;
        if (b.bold) f += '\\b'; else if (later) f += '\\b0';
        if (b.italic) f += '\\i'; else if (later) f += '\\i0';
        const colour = cf(b.color);
        return f + (colour === '' && later ? '\\cf0' : colour);
      };
      const [first, ...rest] = it.runs;
      s += `{\\pard${fmt(first.block, false)} ${rtfText(first.text)}`;
      for (const r of rest) s += `{${fmt(r.block, true)} ${rtfText(r.text)}}`;
      s += '\\par}\n';
    } else if (it.kind === 'table') {
      const t = it.table;
      const edges = [...t.cols, t.rect[2]];
      const cellx = edges.slice(1).map(e => Math.round(e * 20));
      for (const row of t.rows) {
        s += '\\trowd\\trgaph108';
        let column = 0;
        for (const c of row) {
          column += Math.max(c.span, 1);
          const x = cellx[Math.max(Math.min(column, cellx.length) - 1, 0)];
          if (x !== undefined) s += `\\cellx${x}`;
        }
        for (const c of row) {
          let f = `\\intbl\\fs${Math.round(c.size * 2)}`;
          if (c.bold) f += '\\b';
          if (c.italic) f += '\\i';
          s += `{${f}${cf(c.color)} ${rtfText(c.text)}}\\cell`;
        }
        s += '\\row\n';
      }
    } else if (it.kind === 'break') s += '\\page\n';
  }
  return `${s}}`;
}

// ── as_docx.rs ────────────────────────────────────────────────────────────────────────────────

function runXml(text, size, bold, italic, color) {
  let rpr = '';
  if (bold) rpr += '<w:b/>';
  if (italic) rpr += '<w:i/>';
  const h = hex(color);
  if (h) rpr += `<w:color w:val="${h}"/>`;
  const half = Number.isFinite(size) ? Math.round(Math.min(3276, Math.max(2, size * 2))) : 24;
  rpr += `<w:sz w:val="${half}"/>`;
  return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** One Word table: absent borders, a grid sized from the detected column edges, gridSpan for spanning cells, empty cells for holes. */
export function docxTable(t) {
  const edges = [...t.cols, t.rect[2]];
  const widths = edges.slice(0, -1).map((e, i) => Math.round(Math.min(31680, Math.max(60, Math.max(edges[i + 1] - e, 20) * 20))));
  let s = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>';
  for (const edge of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) s += `<w:${edge} w:val="nil"/>`;
  s += '</w:tblBorders></w:tblPr><w:tblGrid>';
  for (const w of widths) s += `<w:gridCol w:w="${w}"/>`;
  s += '</w:tblGrid>';
  for (const row of t.rows) {
    s += '<w:tr>';
    let column = 0;
    for (const c of row) {
      const span = c.span > 1 ? `<w:gridSpan w:val="${c.span}"/>` : '';
      const w = widths.slice(column, column + c.span).reduce((a, b) => a + b, 0);
      s += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span}</w:tcPr><w:p>${runXml(c.text, c.size, c.bold, c.italic, c.color)}</w:p></w:tc>`;
      column += c.span;
    }
    for (let k = column; k < t.cols.length; k++) s += '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p/></w:tc>';
    s += '</w:tr>';
  }
  return `${s}</w:tbl>`;
}

const overlaps = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0.5 && h > 0.5;
};

/** Pages with rotated text, or text that overlaps an image or an oversized (watermark-like) text block, stay as positioned text boxes. */
export function positioned(page) {
  if (page.blocks.some(b => Math.abs(b.rotation) > 0.1)) return true;
  const body = Math.max(bodySize([page]), 1);
  const overlays = [...(page.images ?? []).map(im => [im.rect, null]), ...page.blocks.map((b, i) => [b, i]).filter(([b]) => b.size >= 2 * body).map(([b, i]) => [b.rect, i])];
  let budget = 1_000_000;
  for (const [r, own] of overlays) {
    for (let i = 0; i < page.blocks.length; i++) {
      if (budget === 0) return false;
      budget--;
      if (own !== i && overlaps(r, page.blocks[i].rect)) return true;
    }
  }
  return false;
}

const layoutNumber = n => (Number.isFinite(n) ? Math.min(1584, Math.max(-1584, n)) : 0);
export const MAX_MEDIA = 1000;
const MAX_MEDIA_BYTES = 512 << 20;
const roomFor = (media, im) => im.bytes.length > 0 && media.length < MAX_MEDIA && media.reduce((a, [, m]) => a + m.bytes.length, im.bytes.length) <= MAX_MEDIA_BYTES;
const emu = pt => (Number.isFinite(pt) ? Math.round(pt * 12700) : 0);

function pictureXml(n, name, [cx, cy], rotation) {
  const rot = rotation === null ? '' : ` rot="${Math.round(rotation * 60000)}"`;
  return `<wp:docPr id="${n}" name="Picture ${n}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm${rot}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
}

const fixed = (n, d) => n.toFixed(d);

function positionedPage(page, media, shapeId) {
  let s = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>';
  const body = Math.max(bodySize([page]), 1);
  for (const b of page.blocks) {
    shapeId.n += 1;
    const rotation = ((layoutNumber(-b.rotation) % 360) + 360) % 360;
    const sin = Math.sin(rotation * Math.PI / 180), cos = Math.cos(rotation * Math.PI / 180);
    const bw = Math.max(layoutNumber(b.rect[2] - b.rect[0]), 1), bh = Math.max(layoutNumber(b.rect[3] - b.rect[1]), 1);
    const h = Math.abs(b.rotation) > 0.1 ? Math.max(layoutNumber(b.size), 1) : bh;
    let w = Math.abs(b.rotation) <= 0.1 ? bw : Math.abs(cos) >= Math.abs(sin) ? (bw - h * Math.abs(sin)) / Math.abs(cos) : (bh - h * Math.abs(cos)) / Math.abs(sin);
    w = Math.max(layoutNumber(w), 1);
    const x = layoutNumber(b.rect[0] + (bw - w) / 2), y = layoutNumber(page.height - b.rect[3] + (bh - h) / 2);
    const z = b.size >= 2 * body ? -2 : 1;
    const style = `position:absolute;margin-left:${fixed(x, 3)}pt;margin-top:${fixed(y, 3)}pt;width:${fixed(w, 3)}pt;height:${fixed(h, 3)}pt;rotation:${fixed(rotation, 3)};z-index:${z};mso-position-horizontal-relative:page;mso-position-vertical-relative:page`;
    s += `<w:r><w:pict><v:rect id="Text${shapeId.n}" style="${style}" filled="f" stroked="f"><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:t"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runXml(b.text, b.size, b.bold, b.italic, b.color)}</w:p></w:txbxContent></v:textbox><w10:wrap type="none"/></v:rect></w:pict></w:r>`;
  }
  for (const im of page.images ?? []) {
    if (!roomFor(media, im)) continue;
    shapeId.n += 1;
    const n = media.length + 1;
    const w = Math.max(layoutNumber(im.size[0]), 1), h = Math.max(layoutNumber(im.size[1]), 1);
    const x = layoutNumber((im.rect[0] + im.rect[2] - w) / 2), y = layoutNumber(page.height - (im.rect[1] + im.rect[3] + h) / 2);
    const rotation = ((layoutNumber(-im.rotation) % 360) + 360) % 360;
    const name = `image${n}.${im.ext}`;
    s += `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${n + 1}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(y)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`;
    s += pictureXml(n, name, [emu(w), emu(h)], rotation);
    s += '</wp:anchor></w:drawing></w:r>';
    media.push([name, im]);
  }
  return `${s}</w:p>`;
}

const wordPageSize = page => {
  const twips = pt => (Number.isFinite(pt) ? Math.round(Math.min(31680, Math.max(144, pt * 20))) : 12240);
  return [twips(page.width), twips(page.height)];
};
function section(page) {
  const [pw, ph] = wordPageSize(page);
  const mx = Math.min(Math.trunc(pw / 8), 1440), my = Math.min(Math.trunc(ph / 8), 1440);
  return `<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="${pw}" w:h="${ph}"/><w:pgMar w:top="${my}" w:right="${mx}" w:bottom="${my}" w:left="${mx}" w:header="${Math.trunc(my / 2)}" w:footer="${Math.trunc(my / 2)}" w:gutter="0"/></w:sectPr>`;
}
/** Word has one background for the whole document: written only when every page has the same, non-white one. */
function wordBackground(pages) {
  const first = pages[0]?.background ? rgb8(pages[0].background) : null;
  if (!first) return null;
  const same = pages.every(p => p.background && rgb8(p.background).every((v, i) => v === first[i]));
  return same && !(first[0] === 255 && first[1] === 255 && first[2] === 255) ? first.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('') : null;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const enc = new TextEncoder();

/** A Word document (.docx): ordinary pages flow as paragraphs and tables; pages with rotated text, or text over artwork, keep floating shapes. Resolves to the file's bytes. */
export async function docx(pages, title) {
  let body = '';
  const media = [];
  let afterTable = false;
  const shapeId = {n: 0};
  pages.forEach((page, pageIndex) => {
    const [pw] = wordPageSize(page);
    const textW = (pw - 2 * Math.min(Math.trunc(pw / 8), 1440)) / 20;
    if (positioned(page)) { body += positionedPage(page, media, shapeId); afterTable = false; }
    else {
      for (const it of items([page])) {
        if (it.kind === 'para') {
          const style = it.level === 1 ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : it.level === 2 ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' : '';
          body += `<w:p>${style}${it.runs.map(r => runXml(r.text, r.block.size, r.block.bold, r.block.italic, r.block.color)).join('')}</w:p>`;
        } else if (it.kind === 'table') {
          if (afterTable) body += '<w:p/>';
          body += docxTable(it.table);
        } else if (it.kind === 'img') {
          const im = it.image;
          if (roomFor(media, im)) {
            const n = media.length + 1;
            const name = `image${n}.${im.ext}`;
            const w = Math.max(im.rect[2] - im.rect[0], 1), h = Math.max(im.rect[3] - im.rect[1], 1);
            const k = Math.min(textW / w, 1);
            const cx = emu(w * k), cy = emu(h * k);
            body += `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/>${pictureXml(n, name, [cx, cy], null)}</wp:inline></w:drawing></w:r></w:p>`;
            media.push([name, im]);
          }
        } else body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
        afterTable = it.kind === 'table';
      }
    }
    if (pageIndex + 1 < pages.length) body += `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${section(page)}</w:pPr></w:p>`;
    else {
      if (afterTable || (!page.blocks.length && !(page.images ?? []).length)) body += '<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>';
      body += section(page);
    }
    afterTable = false;
  });
  const pageColour = wordBackground(pages);
  const background = pageColour ? `<w:background w:color="${pageColour}"/>` : '';
  const doc = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word">${background}<w:body>${body}</w:body></w:document>`;
  let types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`;
  if (pageColour) types += '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>';
  types += '</Types>';
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  let docRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  media.forEach(([name], i) => { docRels += `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`; });
  if (pageColour) docRels += '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>';
  docRels += '</Relationships>';
  const styles = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>`;
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`;
  const z = new JSZip();
  z.file('[Content_Types].xml', enc.encode(types));
  z.file('_rels/.rels', enc.encode(rels));
  z.file('docProps/core.xml', enc.encode(core));
  z.file('word/document.xml', enc.encode(doc));
  z.file('word/styles.xml', enc.encode(styles));
  z.file('word/_rels/document.xml.rels', enc.encode(docRels));
  if (pageColour) z.file('word/settings.xml', enc.encode(`${XML}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:displayBackgroundShape/></w:settings>`));
  for (const [name, im] of media) z.file(`word/media/${name}`, im.bytes, {compression: 'STORE'});
  return z.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

// ── pptx.rs ───────────────────────────────────────────────────────────────────────────────────

const MAX_ITEM_EMU = 1_000_000_000;
const slideEmu = (pt, fallback) => (Number.isFinite(pt) && pt > 0 ? Math.round(Math.min(51206400, Math.max(914400, pt * 12700))) : Math.round(fallback * 12700));
const heightEmu = pt => { const v = pt * 12700; return Number.isFinite(v) ? Math.round(Math.min(MAX_ITEM_EMU, Math.max(0, v))) : v > 0 ? MAX_ITEM_EMU : 0; };

function runDrawingml(text, size, bold, italic, color) {
  const sz = Number.isFinite(size) ? Math.round(Math.min(400000, Math.max(100, size * 100))) : 1200;
  let rpr = ` sz="${sz}"`;
  if (bold) rpr += ' b="1"';
  if (italic) rpr += ' i="1"';
  const h = hex(color);
  return `<a:r><a:rPr${rpr}>${h ? `<a:solidFill><a:srgbClr val="${h}"/></a:solidFill>` : ''}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

const TC_PR = '<a:tcPr><a:lnL w="12700" cmpd="s"><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:lnL><a:lnR w="12700" cmpd="s"><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:lnR><a:lnT w="12700" cmpd="s"><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:lnT><a:lnB w="12700" cmpd="s"><a:solidFill><a:srgbClr val="999999"/></a:solidFill></a:lnB></a:tcPr>';

function pptxTable(shapeId, t, x, y, contentW) {
  const edges = [...t.cols, t.rect[2]];
  const widthsPt = edges.slice(0, -1).map((e, i) => Math.max(edges[i + 1] - e, 20));
  const totalPt = widthsPt.reduce((a, b) => a + b, 0);
  const scale = totalPt > 0 ? Math.min(contentW / (totalPt * 12700), 1) : 1;
  const widths = widthsPt.map(w => Math.max(Math.round(w * scale * 12700), 127000));
  const tableW = widths.reduce((a, b) => a + b, 0);
  const rowH = heightEmu(24);
  const tableH = Math.min(t.rows.length * rowH, MAX_ITEM_EMU);
  const gridCols = widths.map(w => `<a:gridCol w="${w}"/>`).join('');
  let rowsXml = '';
  for (const row of t.rows) {
    rowsXml += `<a:tr h="${rowH}">`;
    for (const c of row) {
      const span = Math.max(c.span, 1);
      const run = runDrawingml(c.text, c.size, c.bold, c.italic, c.color);
      if (span > 1) {
        rowsXml += `<a:tc gridSpan="${span}"><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run}</a:p></a:txBody>${TC_PR}</a:tc>`;
        for (let k = 1; k < span; k++) rowsXml += `<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>${TC_PR}</a:tc>`;
      } else rowsXml += `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run}</a:p></a:txBody>${TC_PR}</a:tc>`;
    }
    const used = row.reduce((a, c) => a + c.span, 0);
    for (let k = used; k < t.cols.length; k++) rowsXml += `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>${TC_PR}</a:tc>`;
    rowsXml += '</a:tr>';
  }
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${shapeId}" name="Table ${shapeId}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${tableW}" cy="${tableH}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${gridCols}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  return [frame, tableH];
}

/** A PowerPoint presentation (.pptx): each page a slide, the largest text its title, the rest body text with images and tables between. Resolves to the file's bytes. */
export async function pptx(pagesIn, title) {
  const pages = pagesIn.length ? pagesIn : [{width: 0, height: 0, blocks: [], images: []}];
  const [sw, sh] = [slideEmu(pages[0].width, 720), slideEmu(pages[0].height, 540)];
  const mx = Math.min(Math.max(Math.trunc(sw / 16), 360000), 914400);
  const my = Math.min(Math.max(Math.trunc(sh / 16), 360000), 914400);
  const contentW = sw - 2 * mx;
  const globalMedia = [];
  const slides = [];
  for (const p of pages) {
    const [tabs, consumed] = tables(p.blocks);
    let titleIdx = null;
    p.blocks.forEach((b, i) => { if (!consumed[i] && b.text.trim() && (titleIdx === null || total(b.size, p.blocks[titleIdx].size) >= 0)) titleIdx = i; });
    const parts = [];
    const skip = p.blocks.map((_, bi) => bi === titleIdx || consumed[bi]);
    for (const runs of paragraphs(p.blocks, skip)) parts.push([runs[0].block.rect[3], runs[0].block.rect[0], {kind: 'para', runs}]);
    for (const t of tabs) parts.push([t.rect[3], t.rect[0], {kind: 'table', table: t}]);
    for (const im of p.images ?? []) parts.push([im.rect[3], im.rect[0], {kind: 'img', image: im}]);
    parts.sort((a, b) => total(b[0], a[0]) || total(a[1], b[1]));
    let currentY = my, shapes = '', shapeId = 2;
    const slideRels = [];
    if (titleIdx !== null) {
      const tb = p.blocks[titleIdx];
      const titleH = heightEmu(Math.max(tb.size * 1.5, 36));
      shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="Title ${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${mx}" y="${currentY}"/><a:ext cx="${contentW}" cy="${titleH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p>${runDrawingml(tb.text, tb.size, tb.bold, tb.italic, tb.color)}</a:p></p:txBody></p:sp>`;
      shapeId++;
      currentY += titleH + heightEmu(18);
    }
    let i = 0;
    while (i < parts.length) {
      const item = parts[i][2];
      if (item.kind === 'para') {
        let parasXml = '', estH = 0;
        while (i < parts.length && parts[i][2].kind === 'para') {
          const runs = parts[i][2].runs;
          parasXml += `<a:p>${runs.map(r => runDrawingml(r.text, r.block.size, r.block.bold, r.block.italic, r.block.color)).join('')}</a:p>`;
          const len = runs.reduce((a, r) => a + enc.encode(r.text).length, 0);
          const size = runs.reduce((a, r) => Math.max(a, r.block.size), 10);
          estH += size * 1.3 * Math.max(Math.ceil(len / 60), 1) + 6;
          i++;
        }
        const boxH = heightEmu(estH);
        shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="TextBox ${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${mx}" y="${currentY}"/><a:ext cx="${contentW}" cy="${boxH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${parasXml}</p:txBody></p:sp>`;
        shapeId++;
        currentY += boxH + heightEmu(12);
      } else if (item.kind === 'img') {
        const im = item.image;
        const idx = globalMedia.length + 1;
        const name = `image${idx}.${im.ext}`;
        globalMedia.push([name, im]);
        const rId = `rIdImg${slideRels.length + 1}`;
        slideRels.push([rId, idx]);
        const w = Math.max(im.rect[2] - im.rect[0], 1), h = Math.max(im.rect[3] - im.rect[1], 1);
        const k = Math.min(contentW / 12700 / w, 1);
        const cx = Math.min(heightEmu(w * k), contentW), cy = heightEmu(h * k);
        const x = mx + Math.trunc((contentW - cx) / 2);
        shapes += `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId}" name="Picture ${shapeId}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${currentY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
        shapeId++;
        currentY += cy + heightEmu(12);
        i++;
      } else {
        const [xml, tableH] = pptxTable(shapeId, item.table, mx, currentY, contentW);
        shapes += xml;
        shapeId++;
        currentY += tableH + heightEmu(12);
        i++;
      }
    }
    const slideXml = `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    let rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    for (const [rId, g] of slideRels) rels += `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${globalMedia[g - 1][0]}"/>`;
    rels += '</Relationships>';
    slides.push([slideXml, rels]);
  }
  let types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`;
  slides.forEach((_, k) => { types += `<Override PartName="/ppt/slides/slide${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`; });
  types += '</Types>';
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`;
  let sldIdLst = '';
  let presRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`;
  slides.forEach((_, k) => {
    sldIdLst += `<p:sldId id="${256 + k}" r:id="rIdSld${k + 1}"/>`;
    presRels += `<Relationship Id="rIdSld${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${k + 1}.xml"/>`;
  });
  presRels += '</Relationships>';
  const pres = `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst><p:sldIdLst>${sldIdLst}</p:sldIdLst><p:sldSz cx="${sw}" cy="${sh}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const master = `${XML}<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const masterRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
  const layout = `${XML}<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sldLayout>`;
  const layoutRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  const theme = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const z = new JSZip();
  z.file('[Content_Types].xml', enc.encode(types));
  z.file('_rels/.rels', enc.encode(rels));
  z.file('docProps/core.xml', enc.encode(core));
  z.file('ppt/presentation.xml', enc.encode(pres));
  z.file('ppt/_rels/presentation.xml.rels', enc.encode(presRels));
  z.file('ppt/slideMasters/slideMaster1.xml', enc.encode(master));
  z.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', enc.encode(masterRels));
  z.file('ppt/slideLayouts/slideLayout1.xml', enc.encode(layout));
  z.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', enc.encode(layoutRels));
  z.file('ppt/theme/theme1.xml', enc.encode(theme));
  slides.forEach(([x, r], k) => { z.file(`ppt/slides/slide${k + 1}.xml`, enc.encode(x)); z.file(`ppt/slides/_rels/slide${k + 1}.xml.rels`, enc.encode(r)); });
  for (const [name, im] of globalMedia) z.file(`ppt/media/${name}`, im.bytes, {compression: 'STORE'});
  return z.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
