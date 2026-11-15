// The paragraphs of a page as a reader sees them (what Export to Word, HTML, RTF and PowerPoint read): the page's text split into
// style runs, runs on one baseline into rows, rows into paragraphs.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/text_regions/grouping.rs   group_reading_blocks (rows of lines on one baseline; a dotted-leader entry stays on one
//                                              row), group_layout (runs join a row across a word space; rows join a block when they
//                                              are aligned, the leading holds and the style is the same), leader_entry,
//                                              opens_with_marker / starts_list_item (a list item opens its own paragraph), same_style
//   crates/edit/src/text/blocks.rs             TextBlock (text with a hyphen at a row's end joined to the next row, rect, size, bold,
//                                              italic, colour, rotation), reading_blocks
//   crates/engine/src/compare.rs               export_pages_checked: the block's face is bold or italic from its font name, its
//                                              box is turned to the page as shown with y up
// Differences (docs/spec/patches/folio/export.json): upstream builds its text lines from its own content interpreter (text objects,
// leading, horizontal scale); here a line is a run of glyphs of one style on one visual line of the page text the page view reads
// (model/extract.mjs), split where the gap passes 1.5 em as separate text objects would be. The checks that need the interpreter
// (the text object a run came from, a stated leading, the horizontal scale) are left out, and turned text stays one block per run.
// No DOM, no Node built-ins.

const SAME_SIZE = 0.05;

/** A face is bold or italic by its font name, as export_pages_checked reads it. */
const boldOf = style => !!style?.bold || /bold|black|heavy/.test(String(style?.font ?? '').toLowerCase());
const italicOf = style => !!style?.italic || /italic|oblique/.test(String(style?.font ?? '').toLowerCase());

/** The runs of a page's text: glyphs of one font and colour on one visual line, apart where the gap is wider than 1.5 em. */
export function textLines(text) {
  const lines = [];
  let cur = null;
  const g = text?.glyphs ?? [];
  for (let i = 0; i < g.length; i++) {
    const glyph = g[i];
    const style = glyph.style ?? {font: '', color: [0, 0, 0]};
    const size = glyph.size ?? Math.max(glyph.rect[3] - glyph.rect[1], 1);
    const rotation = Math.atan2(-glyph.direction[1], glyph.direction[0]) * 180 / Math.PI;
    const prev = cur ? g[cur.last] : null;
    const gap = prev ? glyph.rect[0] - prev.rect[2] : 0;
    const fresh = !cur || text.lineOf[i] !== text.lineOf[i - 1] || Math.abs(size - cur.size) > SAME_SIZE || Math.abs(rotation - cur.rotation) > 0.1
      || style.font !== cur.style.font || boldOf(style) !== boldOf(cur.style) || italicOf(style) !== italicOf(cur.style) || style.color.some((c, k) => c !== cur.style.color[k])
      || (Math.abs(cur.rotation) <= 0.1 && gap > cur.size * 1.5);
    if (fresh) {
      if (cur) lines.push(cur);
      cur = {text: '', rect: [...glyph.rect], size, rotation, style, last: i, first: i, spaceBefore: false};
    } else if (text.spaceBefore[i]) cur.text += ' ';
    cur.text += glyph.text;
    cur.last = i;
    cur.rect = [Math.min(cur.rect[0], glyph.rect[0]), Math.min(cur.rect[1], glyph.rect[1]), Math.max(cur.rect[2], glyph.rect[2]), Math.max(cur.rect[3], glyph.rect[3])];
  }
  if (cur) lines.push(cur);
  // The baseline: the em box starts 0.2 em below it.
  for (const l of lines) { l.baseline = l.rect[3] - 0.2 * l.size; l.bold = boldOf(l.style); l.italic = italicOf(l.style); l.color = l.style.color; }
  return lines;
}

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const paragraphSeparator = c => /\s/.test(c) && c !== '　';
const trimSeparators = s => { let a = 0, b = s.length; while (a < b && paragraphSeparator(s[a])) a++; while (b > a && paragraphSeparator(s[b - 1])) b--; return s.slice(a, b); };
const startsWhite = s => /^\s/.test(s);
const endsWhite = s => /\s$/.test(s);

const samePlane = (a, b) => Math.abs(a.rotation - b.rotation) < 0.06;
const sameStyle = (a, b) => a.style.font === b.style.font && a.bold === b.bold && a.italic === b.italic && a.color.every((c, i) => c === b.color[i])
  && Math.abs(a.rotation - b.rotation) < 0.01 && Math.abs(a.size - b.size) < SAME_SIZE;
const rowRect = (row, lines) => row.map(i => lines[i].rect).reduce(union);

/** Does a row open with a list marker: a bullet or a dash, or digits (or a single letter) followed by . or ) and a space or the end. */
export function opensWithMarker(text) {
  const first = [...text][0];
  if (!first) return false;
  if ('•◦▪‣⁃*-–—'.includes(first)) return true;
  if (!/[0-9A-Za-z]/.test(first)) return false;
  const digits = /^[0-9]*/.exec(text)[0].length;
  const letters = /^[A-Za-z]*/.exec(text)[0].length;
  let rest;
  if (digits > 0) rest = text.slice(digits);
  else if (letters === 1) rest = text.slice(1);
  else return false;
  return (rest[0] === '.' || rest[0] === ')') && (rest.length === 1 || /\s/.test(rest[1]));
}
const startsListItem = (row, lines) => {
  const t = row.map(i => lines[i].text.trimStart()).find(x => x);
  return t !== undefined && opensWithMarker(t);
};

/** Dotted leaders end in a page number, with a title before the dots (a dot in an article number or an ellipsis in prose is not a contents entry). */
export function leaderEntry(textIn) {
  const text = textIn.trimEnd();
  const prefix = text.replace(/[0-9ivxlcdmIVXLCDM]+$/, '');
  if (prefix.length === text.length) return false;
  const title = prefix.replace(/[\s.…]+$/, '');
  const dots = [...prefix.slice(title.length)].reduce((n, c) => n + (c === '.' ? 1 : c === '…' ? 3 : 0), 0);
  return dots >= 3 && /\p{L}/u.test(title);
}

/** group_layout: runs into rows, rows into blocks (`mixed` lets one block hold several styles; the reading blocks keep style boundaries). */
function groupLayout(lines, mixed) {
  const rows = [];
  lines.forEach((line, i) => {
    const prevIndex = rows.length ? rows.at(-1).at(-1) : null;
    const prev = prevIndex === null ? null : lines[prevIndex];
    let joins = false;
    if (prev) {
      const gap = line.rect[0] - prev.rect[2];
      const flat = Math.abs(prev.rotation) <= 0.1 && Math.abs(line.rotation) <= 0.1;
      joins = flat && (mixed || sameStyle(prev, line)) && samePlane(prev, line)
        && (Math.abs(prev.baseline - line.baseline) < Math.min(prev.size, line.size) * 0.2
          || (gap >= 0 && Math.min(prev.size, line.size) < Math.max(prev.size, line.size) * 0.9 && Math.abs(prev.baseline - line.baseline) < Math.max(prev.size, line.size) * 0.5))
        && gap >= -Math.min(prev.size, line.size) * 0.2
        && gap < Math.max(prev.size, line.size) * 1.5
        && (gap > Math.min(prev.size, line.size) * 0.01 || !sameStyle(prev, line) || endsWhite(prev.text) || startsWhite(line.text));
    }
    if (joins) rows.at(-1).push(i); else rows.push([i]);
  });
  const blocks = [];
  rows.forEach((row, rowAt) => {
    const first = lines[row[0]];
    const rect = rowRect(row, lines);
    const block = blocks.at(-1);
    let joins = false;
    if (block && !startsListItem(row, lines)) {
      const prevRow = block.rows.at(-1);
      const prev = lines[prevRow[0]];
      const pr = rowRect(prevRow, lines);
      const gap = first.baseline - prev.baseline;
      const tol = Math.max(prev.size, first.size, 1);
      const hanging = rect[0] > pr[0] && rect[0] - pr[0] <= tol * 3 && opensWithMarker(lines[block.lines[0]].text.trimStart());
      const aligned = Math.abs(pr[0] - rect[0]) < tol || Math.abs((pr[0] + pr[2] - rect[0] - rect[2]) / 2) < tol || Math.abs(pr[2] - rect[2]) < tol || hanging;
      let ownLeading = null;
      if (block.rows.length >= 2) {
        const above = lines[block.rows.at(-2)[0]];
        ownLeading = Math.abs(prev.baseline - above.baseline);
      }
      let repeated = null;
      const next = rows[rowAt + 1];
      if (next) {
        const nfirst = lines[next[0]];
        const nrect = rowRect(next, lines);
        const ngap = nfirst.baseline - first.baseline;
        const same = samePlane(first, nfirst) && (mixed || sameStyle(first, nfirst)) && Math.min(first.size, nfirst.size) >= Math.max(first.size, nfirst.size) * 0.4 && Math.abs(nrect[0] - rect[0]) < tol;
        const scale = Math.max(Math.abs(gap), Math.abs(ngap));
        if (same && ngap > tol * 0.8 && scale < tol * 4 && Math.abs(ngap - gap) <= scale * 0.08 + 0.5) repeated = gap;
      }
      const maxGap = ownLeading !== null && ownLeading > tol * 0.4 ? ownLeading * 1.5 : repeated !== null ? repeated * 1.5 : tol * 2.05;
      joins = Math.abs(first.rotation) <= 0.1 && Math.abs(prev.rotation) <= 0.1 && (mixed || sameStyle(prev, first)) && samePlane(prev, first) && aligned
        && Math.min(first.size, prev.size) >= Math.max(first.size, prev.size) * 0.4 && gap > Math.min(first.size, prev.size) * 0.8 && gap < maxGap;
    }
    if (!joins) {
      blocks.push({text: '', editorStart: false, editorEnd: false, rect, font: first.style.font, size: first.size, bold: first.bold, italic: first.italic, color: first.color, rotation: first.rotation, lines: [], rows: []});
    }
    const b = blocks.at(-1);
    let rowText = '';
    for (const index of row) {
      const line = lines[index];
      const prevInRow = b.lines.length && row.includes(b.lines.at(-1)) ? lines[b.lines.at(-1)] : null;
      if (prevInRow && !endsWhite(rowText) && !startsWhite(line.text) && line.rect[0] - prevInRow.rect[2] > line.size * 0.12) rowText += ' ';
      rowText += line.text;
      b.lines.push(index);
    }
    if (b.text) { if (b.text.endsWith('-')) b.text = b.text.slice(0, -1); else b.text += ' '; }
    b.text += trimSeparators(rowText);
    b.rect = union(b.rect, rect);
    b.rows.push(row);
  });
  for (const b of blocks) {
    b.editorStart = startsWhite(lines[b.lines[0]].text);
    b.editorEnd = endsWhite(lines[b.lines.at(-1)].text);
  }
  return blocks;
}

/** group_reading_blocks: a dotted-leader row stays one block of its own; everything else is group_layout of the text between. */
export function groupReadingBlocks(lines) {
  const blocks = [];
  let start = 0, offset = 0;
  // Rows of consecutive lines on one baseline.
  const chunks = [];
  for (const line of lines) {
    const last = chunks.at(-1)?.at(-1);
    if (last && samePlane(last, line) && Math.abs(last.baseline - line.baseline) < Math.min(last.size, line.size) * 0.2) chunks.at(-1).push(line); else chunks.push([line]);
  }
  for (const row of chunks) {
    let text = '';
    row.forEach((line, i) => {
      if (!endsWhite(text) && !startsWhite(line.text) && i > 0 && line.rect[0] - row[i - 1].rect[2] > line.size * 0.12) text += ' ';
      text += line.text;
    });
    if (leaderEntry(text) && row.length) {
      blocks.push(...groupLayout(lines.slice(start, offset), false));
      const merged = {...row[0], text, rect: row.map(l => l.rect).reduce(union)};
      blocks.push(...groupLayout([merged], false));
      start = offset + row.length;
    }
    offset += row.length;
  }
  blocks.push(...groupLayout(lines.slice(start), false));
  return blocks;
}

/**
 * The export `Block`s of a page (export_pages_checked): the paragraphs with their box turned to the page as shown with y up,
 * their size, weight, colour and angle. `height` is the displayed page height in points.
 */
export function exportBlocks(text, height) {
  const lines = textLines(text);
  return groupReadingBlocks(lines)
    .filter(b => b.text.trim())
    .map(b => ({
      text: b.text.trim(),
      rect: [b.rect[0], height - b.rect[3], b.rect[2], height - b.rect[1]],
      size: b.size, bold: b.bold, italic: b.italic, color: b.color, rotation: b.rotation,
      spaceAround: [b.editorStart, b.editorEnd],
    }));
}
