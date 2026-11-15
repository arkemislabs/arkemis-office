// Compare and Combine Documents (U:quill/review): the differences between an original and a
// revised document as tracked insertions, deletions and formatting changes by one author.
//
// Translated from wordcraft crates/engine/src/cmd/tools/compare.rs (`COMPARE_PARAMS`,
// `CompareOptions`, `MAX_CHAR_DIFF`, `compare`, `block_text`, `mark_block`, `Op`, `MAX_LCS`,
// `MAX_COMPARE_CELLS`, `lcs_ops`, `NOISE_MATCH_LEN`, `collapse_noise_matches`, `flatten_region`,
// `tokens`, `word_diff`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Characters are code points (upstream: Rust chars); the result is plain block data the
// review.compare command puts into the document as one undo step.

import * as P from '../model/para.mjs';
import {compareFormatting} from './review-fmt.mjs';

export const SAME = 0, DEL = 1, INS = 2;
/** Longest sequence the comparison table is built for. */
export const MAX_LCS = 4000;
/** Comparison table cells one compare may fill over all its tables. */
export const MAX_COMPARE_CELLS = 50_000_000;
/** Changed paragraphs longer than this are compared word by word even at character level. */
export const MAX_CHAR_DIFF = 2000;
const NOISE_MATCH_LEN = 1;
const MAX_DEPTH = 16;

/** What Compare / Combine compares (CompareOptions); `key(t)` is the text a comparison sees. */
export function compareOptions(p = {}) {
  const o = {case: p.caseChanges ?? true, whiteSpace: p.whiteSpace ?? true, formatting: p.formatting ?? true, characters: p.level === 'character' || p.level === 'char'};
  o.key = t => {
    let s = o.whiteSpace ? t : t.split(/\s+/u).filter(Boolean).join(' ');
    if (!o.case) s = s.toLowerCase();
    return s;
  };
  return o;
}

/** LCS edit script: common start and end first, then the bounded middle (lcs_ops). `budget` is {left}. */
export function lcsOps(a, b, budget) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  const ra = a.slice(pre), rb = b.slice(pre);
  let suf = 0;
  while (suf < ra.length && suf < rb.length && ra[ra.length - 1 - suf] === rb[rb.length - 1 - suf]) suf++;
  const ma = ra.slice(0, ra.length - suf), mb = rb.slice(0, rb.length - suf);
  const ops = new Array(pre).fill(SAME);
  let n = Math.min(ma.length, MAX_LCS), m = Math.min(mb.length, MAX_LCS);
  const cells = n * m;
  if (cells > budget.left) { n = 0; m = 0; } else budget.left -= cells;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { ops.push(SAME); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push(DEL); i++; } else { ops.push(INS); j++; }
  }
  for (let k = i; k < ma.length; k++) ops.push(DEL);
  for (let k = j; k < mb.length; k++) ops.push(INS);
  for (let k = 0; k < suf; k++) ops.push(SAME);
  return ops;
}

/** Fold single-token matches inside a run of edits into one clean delete and insert (collapse_noise_matches). */
export function collapseNoiseMatches(ops) {
  const runs = [];
  for (let k = 0; k < ops.length;) {
    const op = ops[k];
    let len = 0;
    while (k + len < ops.length && ops[k + len] === op) len++;
    const fold = op === SAME && k !== 0 && k + len !== ops.length && len <= NOISE_MATCH_LEN;
    runs.push([op, len, fold]);
    k += len;
  }
  if (!runs.some(r => r[2])) return ops.slice();
  const out = [];
  for (let i = 0; i < runs.length;) {
    if (runs[i][0] === SAME && !runs[i][2]) { for (let x = 0; x < runs[i][1]; x++) out.push(SAME); i++; continue; }
    const start = i;
    while (i < runs.length && !(runs[i][0] === SAME && !runs[i][2])) i++;
    const region = runs.slice(start, i);
    if (region.some(r => r[2])) {
      const dels = region.reduce((s, [op, len, fold]) => s + (fold || op === DEL ? len : 0), 0);
      const inss = region.reduce((s, [op, len, fold]) => s + (fold || op === INS ? len : 0), 0);
      for (let x = 0; x < dels; x++) out.push(DEL);
      for (let x = 0; x < inss; x++) out.push(INS);
    } else for (const [op, len] of region) for (let x = 0; x < len; x++) out.push(op);
  }
  return out;
}

/** Words with the spaces after them ("The ", "cat "), or single characters (tokens). */
export function tokens(s, characters) {
  if (characters) return [...s];
  const v = [];
  let cur = '';
  for (const c of s) { cur += c; if (c === ' ') { v.push(cur); cur = ''; } }
  if (cur) v.push(cur);
  return v;
}

/** A block's text (a table's cells in order), for matching blocks (block_text). */
function blockText(b, depth = 0) {
  if (b.kind === 'para') return P.plainText(b);
  if (depth >= MAX_DEPTH) return '';
  return b.rows.flatMap(r => r.cells).flatMap(c => c.blocks).map(x => blockText(x, depth + 1)).join('\t');
}

/** A copy of the block with every run (in tables, every cell's) changed by `f` (mark_block). */
function markBlock(b, f, depth = 0) {
  if (b.kind === 'para') {
    const p = structuredClone(b);
    if (p.text.length) P.formatRange(p, 0, p.text.length, f);
    return p;
  }
  const t = structuredClone(b);
  if (depth < MAX_DEPTH) for (const r of t.rows) for (const c of r.cells) c.blocks = c.blocks.map(x => markBlock(x, f, depth + 1));
  return t;
}

/** The changed paragraph pair as one paragraph with tracked insertions and deletions (word_diff). */
function wordDiff(a, b, ins, del, opts, budget, newId) {
  const at = P.plainText(a), bt = P.plainText(b);
  const chars = opts.characters && Math.max([...at].length, [...bt].length) <= MAX_CHAR_DIFF;
  const ta = tokens(at, chars), tb = tokens(bt, chars);
  let ops = lcsOps(ta.map(opts.key), tb.map(opts.key), budget);
  if (chars) ops = collapseNoiseMatches(ops);
  const p = P.newParagraph(newId());
  if (b.props) p.props = structuredClone(b.props);
  const base = {...(a.runs[0]?.props ?? {})};
  let i = 0, j = 0;
  for (const op of ops) {
    const off = p.text.length;
    if (op === SAME) { P.insertText(p, off, tb[j] ?? '', base); i++; j++; }
    else if (op === DEL) { P.insertText(p, off, ta[i] ?? '', {...base, del}); i++; }
    else { P.insertText(p, off, tb[j] ?? '', {...base, ins}); j++; }
  }
  return p;
}

/**
 * Compare `old` blocks (the original) with `nw` (the revised), returning the result blocks, the
 * revisions to append (insert at `revBase`, delete at `revBase + 1`, then formatting ones) and how
 * many changes were found (compare). `newId()` gives fresh block ids.
 */
export function compareBlocks(old, nw, {author, date, opts, revBase, newId}) {
  // The insert and delete revisions, then the formatting ones the recorder adds (indices relative
  // to `revBase`).
  const revisions = [{kind: 'insert', author, date}, {kind: 'delete', author, date}];
  const ins = revBase, del = revBase + 1;
  const key = b => (b.kind === 'para' ? opts.key(P.plainText(b)) : `\u0000table\u0000${opts.key(blockText(b))}`);
  const budget = {left: MAX_COMPARE_CELLS};
  const ops = lcsOps(old.map(key), nw.map(key), budget);
  const out = [];
  let i = 0, j = 0, changes = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k] === SAME) {
      const a = old[i], b = nw[j];
      if (a?.kind === 'para' && b?.kind === 'para') {
        const p = structuredClone(b);
        if (opts.formatting && a.text === b.text) {
          const before = revisions.length;
          const changed = compareFormatting(a, p, revisions, author, date);
          if (changed || revisions.length > before) {
            changes++;
            remapFormat(p, revBase);
          }
        }
        out.push(p);
      } else out.push(structuredClone(b ?? a));
      i++; j++; k++;
      continue;
    }
    let run = 0;
    while (k + run < ops.length && ops[k + run] !== SAME) run++;
    const dels = ops.slice(k, k + run).filter(o => o === DEL).length;
    const inss = run - dels;
    for (let x = 0; x < Math.max(dels, inss); x++) {
      const a = x < dels ? old[i + x] : null, b = x < inss ? nw[j + x] : null;
      if (a?.kind === 'para' && b?.kind === 'para') out.push(wordDiff(a, b, ins, del, opts, budget, newId));
      else {
        if (a) out.push(markBlock(a, c => { c.del = del; }));
        if (b) out.push(markBlock(b, c => { c.ins = ins; }));
      }
      changes++;
    }
    i += dels; j += inss; k += Math.max(run, 1);
  }
  return {blocks: out, revisions, changes};
}

/** The recorder numbered formatting revisions within this compare's list; shift them to the document's. */
function remapFormat(p, revBase) {
  const fix = c => { if (c?.fmtChange) c.fmtChange = {...c.fmtChange, rev: c.fmtChange.rev + revBase}; };
  for (const r of p.runs) if (r.props?.fmtChange) { r.props = {...r.props}; fix(r.props); }
  if (p.mark?.fmtChange) { p.mark = {...p.mark}; fix(p.mark); }
  if (p.props?.fmtChange) { p.props = {...p.props}; fix(p.props); }
}
