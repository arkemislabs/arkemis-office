// The paragraphs of a page for editing: the lines (text-interp.mjs) into rows on one baseline, rows into blocks, each block with the text an
// editor shows (a newline between rows) and the text a width change reflows (a wrapped row rejoins, a typed break stays).
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/text_regions/grouping.rs   same_plane, row_rect, frame_row_rect, neighbour_left, alignment_frame, is_centred, group_blocks,
//                                              opens_with_marker, starts_list_item, group_layout (mixed = true), same_style, reflow_text, break_gap
//   crates/edit/src/text/blocks.rs             TextBlock, BlockKey (of, find), block_overlapping, paragraph_separator, wrap
// Not translated: BlockKey/edited_spans' run-level diff (the styled path keeps each run's style; here a rewritten paragraph is set in its first
// run's style), Chinese/Japanese word pieces in wrap (a word is one piece), invisible-text OCR paragraphs' cover colour (docs/spec/patches/folio/edit.json).
// No DOM, no Node built-ins.

import {mul} from './redact-content.mjs';
import {sameBaseFont, stripSubsetTag} from './text-font.mjs';
import {union, frameOrigin, lineRotation, lineWrapLeading} from './text-interp.mjs';

export const paragraphSeparator = c => /\s/.test(c) && c !== '　';
const trimSeparators = s => { let a = 0, b = s.length; while (a < b && paragraphSeparator(s[a])) a++; while (b > a && paragraphSeparator(s[b - 1])) b--; return s.slice(a, b); };
const startsWhite = s => /^\s/.test(s);
const endsWhite = s => /\s$/.test(s);

function samePlane(a, b) {
  const at = mul(a.origin.tm, a.origin.ctm), bt = mul(b.origin.tm, b.origin.ctm);
  return a.scope === b.scope && a.paint === b.paint && [0, 2].every(axis => {
    const [ax, ay, bx, by] = [at[axis], at[axis + 1], bt[axis], bt[axis + 1]];
    const [al, bl] = [Math.hypot(ax, ay), Math.hypot(bx, by)];
    return al > 0 && bl > 0 && Math.abs(ax / al - bx / bl) < 0.001 && Math.abs(ay / al - by / bl) < 0.001;
  });
}

export const rowRect = (row, lines) => row.map(i => lines[i].rect).reduce(union);
const frameRowRect = (row, lines) => row.map(i => lines[i].frame).reduce(union);
const invisible = l => l.origin.state.renderMode === 3;

function sameStyle(a, b) {
  const sameFont = a.font === b.font || sameBaseFont(a.baseFont, b.baseFont) || false;
  return sameFont && (sameBaseFont(a.baseFont, b.baseFont) || (stripSubsetTag(a.baseFont) === '' && stripSubsetTag(b.baseFont) === ''))
    && a.bold === b.bold && a.italic === b.italic && a.color.every((c, i) => c === b.color[i])
    && Math.abs(lineRotation(a) - lineRotation(b)) < 0.01 && Math.abs(a.size - b.size) < 0.01;
}

/** opens_with_marker: a bullet or a dash, or an ordered marker (digits or one letter, then . or ) and a space or the end). */
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

/** group_layout with mixed styles: runs into rows, rows into blocks. */
function groupLayout(lines) {
  const rows = [];
  lines.forEach((line, i) => {
    const prev = rows.length ? lines[rows.at(-1).at(-1)] : null;
    let joins = false;
    if (prev) {
      const gap = line.frame[0] - prev.frame[2];
      const scanned = invisible(prev) === invisible(line) && (!invisible(line) || gap < Math.max(prev.size, line.size) * 0.6);
      const [pa, la] = [frameOrigin(prev)[1], frameOrigin(line)[1]];
      const small = Math.min(prev.size, line.size), big = Math.max(prev.size, line.size);
      joins = scanned && samePlane(prev, line)
        && (Math.abs(pa - la) < small * 0.2 || (gap >= 0 && small < big * 0.9 && Math.abs(pa - la) < big * 0.5))
        && gap >= -small * 0.2 && gap < big * 1.5
        && (prev.origin.btOp === line.origin.btOp || gap > small * 0.01 || !sameStyle(prev, line) || endsWhite(prev.text) || startsWhite(line.text));
    }
    if (joins) rows.at(-1).push(i); else rows.push([i]);
  });
  const blocks = [];
  rows.forEach((row, rowAt) => {
    const first = lines[row[0]];
    const rect = rowRect(row, lines), frame = frameRowRect(row, lines);
    const block = blocks.at(-1);
    let joins = false;
    if (block && !startsListItem(row, lines)) {
      const prevRow = block.rows.at(-1);
      const prev = lines[prevRow[0]];
      const pr = frameRowRect(prevRow, lines);
      const gap = frameOrigin(prev)[1] - frameOrigin(first)[1];
      const tol = Math.max(prev.size, first.size, 1);
      const hanging = frame[0] > pr[0] && frame[0] - pr[0] <= tol * 3 && opensWithMarker(lines[block.lines[0]].text.trimStart());
      const aligned = Math.abs(pr[0] - frame[0]) < tol || Math.abs((pr[0] + pr[2] - frame[0] - frame[2]) / 2) < tol || Math.abs(pr[2] - frame[2]) < tol || hanging;
      let ownLeading = null;
      if (block.rows.length >= 2) {
        const above = lines[block.rows.at(-2)[0]];
        ownLeading = Math.abs(frameOrigin(above)[1] - frameOrigin(prev)[1]);
      }
      const stated = prev.origin.state.leading > 0 ? lineWrapLeading(prev) : null;
      const statedOk = stated !== null && Number.isFinite(stated) && stated > tol * 0.4 ? stated : null;
      let repeated = null;
      const next = rows[rowAt + 1];
      if (next) {
        const nfirst = lines[next[0]];
        const nframe = frameRowRect(next, lines);
        const ngap = frameOrigin(first)[1] - frameOrigin(nfirst)[1];
        const same = samePlane(first, nfirst) && Math.min(first.size, nfirst.size) >= Math.max(first.size, nfirst.size) * 0.4 && Math.abs(nframe[0] - frame[0]) < tol;
        const scale = Math.max(Math.abs(gap), Math.abs(ngap));
        if (same && ngap > tol * 0.8 && scale < tol * 4 && Math.abs(ngap - gap) <= scale * 0.08 + 0.5) repeated = gap;
      }
      const lead = ownLeading !== null && ownLeading > tol * 0.4 ? ownLeading : statedOk ?? repeated;
      const maxGap = lead !== null && lead !== undefined ? lead * 1.5 : tol * 2.05;
      joins = !(invisible(prev) || invisible(first)) && samePlane(prev, first) && Math.abs(prev.origin.state.scale - first.origin.state.scale) < 1e-6 && aligned
        && Math.min(first.size, prev.size) >= Math.max(first.size, prev.size) * 0.4 && gap > Math.min(first.size, prev.size) * 0.8 && gap < maxGap;
    }
    if (!joins) {
      blocks.push({text: '', editorText: '', reflowText: '', spans: [], rect, baseFont: first.baseFont, size: first.size, bold: first.bold, italic: first.italic,
        color: first.color, rotation: lineRotation(first), lines: [], rows: [], invisible: true});
    }
    const b = blocks.at(-1);
    let rowText = '';
    if (b.rows.length) b.editorText += '\n';
    for (const index of row) {
      const line = lines[index];
      const prevInRow = b.lines.length && row.includes(b.lines.at(-1)) ? lines[b.lines.at(-1)] : null;
      if (prevInRow && !endsWhite(rowText) && !startsWhite(line.text) && line.frame[0] - prevInRow.frame[2] > line.size * 0.12) { rowText += ' '; b.editorText += ' '; }
      const start = b.editorText.length;
      b.editorText += line.text;
      b.spans.push([start, b.editorText.length, index]);
      rowText += line.text;
      b.invisible &&= line.origin.state.renderMode === 3;
      b.lines.push(index);
    }
    if (b.text) { if (b.text.endsWith('-')) b.text = b.text.slice(0, -1); else b.text += ' '; }
    b.text += trimSeparators(rowText);
    b.rect = union(b.rect, rect);
    b.rows.push(row);
  });
  for (const b of blocks) b.reflowText = reflowText(b, lines);
  return blocks;
}

/** break_gap: null = a hard break (kept as a newline); a number = a soft wrap, rejoined with that many spaces. */
function breakGap(block, lines, rowIndex) {
  const line = lines[block.rows[rowIndex][0]];
  if (line.hardBreak) return null;
  if (line.softBreak) return line.softGap;
  // A line nothing marked is a wrap of the paragraph's flow, whatever its length: opening a paragraph for editing joins its rows
  // (the grouping above has already split paragraphs on gaps, indents and list markers), so only a marked hard break stays a newline.
  // Differs from upstream, which keeps an unmarked short row as a break when the next word would have fitted; Acrobat joins them.
  return 1;
}

/** reflow_text: the text a width change should reflow. */
function reflowText(block, lines) {
  const parts = block.editorText.split('\n');
  if (parts.length !== block.rows.length) return block.editorText;
  let out = '';
  parts.forEach((part, index) => {
    if (index > 0) {
      const gap = breakGap(block, lines, index);
      if (gap !== null && out.endsWith('-')) out = out.slice(0, -1);
      else if (gap !== null && !endsWhite(out)) out += ' '.repeat(gap);
      else if (gap === null) out += '\n';
    }
    out += part;
  });
  return out;
}

/** group_blocks: the page's paragraphs. */
export const groupBlocks = lines => groupLayout(lines);

/** neighbour_left: the left edge the rest of the page's text sits on, ignoring the rows of `block`. */
function neighbourLeft(lines, block) {
  const edges = new Map();
  lines.forEach((line, i) => { if (!block.lines.includes(i)) { const k = Math.round(line.rect[0] * 4); edges.set(k, (edges.get(k) ?? 0) + 1); } });
  let best = null, count = -1;
  for (const [k, c] of edges) if (c > count) { best = k; count = c; }
  return best === null ? null : best / 4;
}

/** is_centred: whether a block reads as centred and so keeps its centre as it grows or wraps. */
export function isCentred(block, lines, pageCentre, size) {
  const centre = (block.rect[0] + block.rect[2]) / 2;
  const lefts = block.rows.map(r => rowRect(r, lines)[0]);
  if (block.rows.length > 1) {
    const span = Math.max(...lefts) - Math.min(...lefts);
    return span > size * 0.5 && block.rows.every(row => { const r = rowRect(row, lines); return Math.abs((r[0] + r[2]) / 2 - centre) < size; });
  }
  const left = lefts[0];
  if (left === undefined || Math.abs(centre - pageCentre) >= size) return false;
  const edge = neighbourLeft(lines, block);
  return edge === null || Math.abs(left - edge) > size * 0.5;
}

/** alignment_frame: where an alignment picked for a one-row paragraph is measured, as [left, right], or null. */
export function alignmentFrame(lines, blocks, block, style, draft) {
  const rowsInDraft = draft.split('\n').length;
  const asked = rowsInDraft > 0 && style.align !== undefined && style.align !== null;
  if (!asked || style.width !== undefined || style.offset !== undefined || block.rows.length !== 1 || Math.abs(block.rotation) > 0.01) return null;
  const own = [block.rect[0], block.rect[2]];
  const tolerance = Math.max(block.size, 1) * 0.5;
  const gap = other => Math.max(Math.max(other.rect[1] - block.rect[3], block.rect[1] - other.rect[3]), 0);
  const column = other => {
    const left = other.rect[0];
    const right = other.rows.map(row => rowRect(row, lines)).filter(r => Math.abs(r[0] - left) < tolerance).map(r => r[2]).reduce((a, b) => Math.max(a, b), -Infinity);
    return Number.isFinite(right) && right - left > own[1] - own[0] && own[0] >= left - tolerance && own[1] <= right + tolerance ? [left, right] : null;
  };
  let best = null;
  for (const other of blocks) {
    if (!other.lines.every(i => !block.lines.includes(i)) || !(other.rect[2] > own[0] && other.rect[0] < own[1])) continue;
    const frame = column(other);
    if (!frame) continue;
    const entry = {frame, near: gap(other)};
    if (!best || (frame[1] - frame[0]) < (best.frame[1] - best.frame[0]) || ((frame[1] - frame[0]) === (best.frame[1] - best.frame[0]) && entry.near < best.near)) best = entry;
  }
  if (best) return best.frame;
  return draft !== block.editorText ? null : own;
}

/**
 * wrap: greedy word wrapping to `width` with `advance` giving a string's width. Each \n starts a new line; every typed space stays, only the spaces
 * where a row wraps are dropped (recorded as the third value so a rejoin restores the count). The bool: the line continues the previous one because
 * the next word did not fit.
 */
export function wrap(text, width, advance) {
  const out = [];
  for (const row of text.split('\n')) {
    let line = '', soft = false, wrapGap = 0, gap = 0;
    const start = out.length;
    const words = row.split(/(?!　)\s/u);
    words.forEach((word, k) => {
      if (k > 0) gap++;
      if (word === '') return;
      const gapHere = gap;
      gap = 0;
      const spaces = ' '.repeat(gapHere);
      const candidate = `${line}${spaces}${word}`;
      if ([...line].some(c => c !== ' ') && advance(candidate) > width) {
        out.push([line, soft, wrapGap]);
        soft = true;
        wrapGap = gapHere;
        line = word;
      } else line = candidate;
    });
    line += ' '.repeat(gap);
    if (line !== '' || out.length === start) out.push([line, soft, wrapGap]);
  }
  return out;
}

/** BlockKey: names a paragraph by what it says and where it is, so a paragraph that no longer exists has no match. */
export const blockKey = block => ({text: block.text, rect: block.rect.slice()});
export function findBlock(blocks, key, hint = 0) {
  const matches = b => b.text === key.text && b.rect.every((v, i) => Math.abs(v - key.rect[i]) <= 0.01);
  if (blocks[hint] && matches(blocks[hint])) return hint;
  const i = blocks.findIndex(matches);
  return i < 0 ? null : i;
}
/** block_overlapping: the block whose box overlaps `rect` the most, if any overlaps it. */
export function blockOverlapping(blocks, rect) {
  let best = null, area = 0;
  blocks.forEach((b, i) => {
    if (![...rect, ...b.rect].every(Number.isFinite)) return;
    const w = Math.min(b.rect[2], rect[2]) - Math.max(b.rect[0], rect[0]);
    const h = Math.min(b.rect[3], rect[3]) - Math.max(b.rect[1], rect[1]);
    if (w > 0 && h > 0 && w * h > area) { best = i; area = w * h; }
  });
  return best;
}
