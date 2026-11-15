// Home › Editing: Find and Replace across slide text, table cells and speaker notes.
// Translated from deckcraft crates/engine/src/cmd/find.rs (`specs`, `Loc`, `bodies`, `Opts`,
// `para_chars`, `para_matches`, `splice`, `find`, `replace`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Offsets: deckcraft counts chars (Unicode scalars) in the paragraph; here they are UTF-16 code
// units, the unit every Prism position uses (core/prism/model/edit.mjs), and a match never splits
// a surrogate pair because it compares whole characters.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isTextRun, runContent, isBreakRun} from '../model/text.mjs';
import {isGroup} from '../model/presentation.mjs';
import {bad, hasDoc, UPSTREAM_COMMIT} from '../lib/text-session.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/find.rs']};

/** deckcraft `Opts::from`: the search options; errors without text. */
export function findOpts(p, cmd) {
  const pat = String(p?.text ?? '');
  if (!pat) throw bad(cmd, 'missing `text`', {path: '/text'});
  return {pat: [...pat], case: !!p.matchCase, whole: !!p.wholeWords};
}

const lower = c => c.toLowerCase();
const eqc = (o, a, b) => a === b || (!o.case && lower(a) === lower(b));
const wordChar = c => c !== undefined && (/[\p{L}\p{N}]/u.test(c) || c === '_');

/** deckcraft `Opts::matches`: non-overlapping matches in `chars` (an array of characters) as [start, end] char indices. */
export function matches(o, chars) {
  const n = o.pat.length, out = [];
  let i = 0;
  while (i + n <= chars.length) {
    let hit = true;
    for (let k = 0; k < n; k++) if (!eqc(o, chars[i + k], o.pat[k])) { hit = false; break; }
    if (hit && o.whole && (wordChar(chars[i - 1]) || wordChar(chars[i + n]))) hit = false;
    if (hit) { out.push([i, i + n]); i += n; } else i += 1;
  }
  return out;
}

/** Characters of a paragraph and the UTF-16 offset of each character boundary. */
function charsOf(p) {
  const chars = [...(p.runs ?? []).map(runContent).join('')];
  const offs = [0];
  for (const c of chars) offs.push(offs[offs.length - 1] + c.length);
  return {chars, offs};
}

/** deckcraft `para_matches`: matches wholly in plain text runs (never in a field, equation or break), as UTF-16 [start, end]. */
export function paraMatches(p, o) {
  const {chars, offs} = charsOf(p);
  const spans = [];
  let off = 0;
  for (const r of p.runs ?? []) {
    const n = runContent(r).length;
    spans.push([off, off + n, isTextRun(r)]);
    off += n;
  }
  return matches(o, chars).map(([a, b]) => [offs[a], offs[b]])
    .filter(([a, b]) => spans.every(([st, en, text]) => text || en <= a || st >= b || st === en));
}

/** deckcraft `splice`: replace UTF-16 [a, b) of the paragraph; the replacement takes the first run's formatting. */
export function splice(pIn, a, b, w) {
  const p = {...pIn, runs: (pIn.runs ?? []).map(r => ({...r}))};
  let off = 0, placed = false;
  for (const r of p.runs) {
    const t = runContent(r);
    const st = off, en = off + t.length;
    off = en;
    if (en <= a || st >= b) continue;
    const head = t.slice(0, Math.max(a - st, 0));
    const tail = t.slice(Math.min(Math.max(b - st, 0), t.length));
    if (isBreakRun(r)) continue; // matches never span a break (para_matches)
    r.text = placed ? tail : `${head}${w}${tail}`;
    placed = true;
  }
  if (p.runs.length > 1) p.runs = p.runs.filter(r => !(isTextRun(r) && !(r.text ?? '')));
  return p;
}

/**
 * deckcraft `bodies`: visit every text body on a slide: shapes depth-first (groups, table cells),
 * then the notes. `f(loc, body)` returns a new body or undefined (unchanged); returns the slide's
 * shapes and notes with the changes.
 */
export function mapBodies(sl, f) {
  const rec = (list, depth) => (depth > 64 ? list : (list ?? []).map(sh => {
    let n = sh;
    if (sh.text) { const b = f({shape: sh.id, cell: null}, sh.text); if (b) n = {...n, text: b}; }
    if (sh.kind?.type === 'table') {
      let rows = sh.kind.rows;
      sh.kind.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
        const b = f({shape: sh.id, cell: [r, c]}, cell.text ?? {body: {}, paragraphs: []});
        if (b) {
          if (rows === sh.kind.rows) rows = rows.map(x => ({...x, cells: [...x.cells]}));
          rows[r].cells[c] = {...rows[r].cells[c], text: b};
        }
      }));
      if (rows !== sh.kind.rows) n = {...n, kind: {...n.kind, rows}};
    } else if (isGroup(sh)) {
      const children = rec(sh.kind.children, depth + 1);
      if (children.some((x, i) => x !== sh.kind.children[i])) n = {...n, kind: {...n.kind, children}};
    }
    return n;
  }));
  const shapes = rec(sl.shapes, 0);
  const nb = f({shape: null, cell: null}, sl.notes ?? {body: {}, paragraphs: []});
  return {shapes, notes: nb ?? sl.notes};
}

/** deckcraft `find`: every match, slide by slide: {slide, shape (null = notes), cell, para, start, end}. */
export function findAll(c, o) {
  const out = [];
  (c.slides ?? []).forEach((sl, i) => {
    mapBodies(sl, (loc, t) => {
      (t.paragraphs ?? []).forEach((para, pi) => {
        for (const [a, b] of paraMatches(para, o)) out.push({slide: i, shape: loc.shape, cell: loc.cell, para: pi, start: a, end: b});
      });
      return undefined;
    });
  });
  return out;
}

const sameLoc = (at, loc) => (at.shape ?? null) === (loc.shape ?? null)
  && JSON.stringify(at.cell ?? null) === JSON.stringify(loc.cell ?? null);

/**
 * deckcraft `replace`: replace every match (or just the one `at`) in the presentation. Returns
 * {slides: Map(index → {shapes, notes}), count}.
 */
export function replaceAll(c, o, w, at) {
  const changed = new Map();
  let count = 0;
  (c.slides ?? []).forEach((sl, i) => {
    if (at && at.slide !== i) return;
    let n = 0;
    const r = mapBodies(sl, (loc, t) => {
      if (at && !sameLoc(at, loc)) return undefined;
      let hit = false;
      const paragraphs = (t.paragraphs ?? []).map((para, pi) => {
        if (at && at.para !== pi) return para;
        let q = para;
        for (const [a, b] of paraMatches(para, o).reverse()) {
          if (at && at.start !== a) continue;
          q = splice(q, a, b, w);
          n += 1;
          hit = true;
        }
        return q;
      });
      return hit ? {...t, paragraphs} : undefined;
    });
    if (n > 0) { changed.set(i, r); count += n; }
  });
  return {slides: changed, count};
}

const match = s.object({slide: s.integer({min: 0}), shape: s.optional(s.nullable(s.union([s.string({max: 64}), s.integer({min: 0})]))),
  cell: s.optional(s.nullable(s.array(s.integer({min: 0}), {min: 2, max: 2}))), para: s.integer({min: 0}), start: s.integer({min: 0}),
  end: s.optional(s.integer({min: 0}))}, {additional: true});

export default defineCommands({
  family: 'find',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'text.find', label: 'Find', risk: 'read', dialog: 'dialog.find',
      description: 'Find (Home › Editing): every match of `text` in slide text, table cells and speaker notes: [{slide, shape (null = notes), cell, para, start, end}] (offsets in the paragraph).',
      params: s.object({text: s.string({max: 10000}), matchCase: s.optional(s.boolean()), wholeWords: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => findAll(ctx.doc, findOpts(p, 'text.find')),
    },
    {
      id: 'text.replace', label: 'Replace', risk: 'edit', dialog: 'dialog.find',
      description: 'Replace (Home › Editing): replace every match of `text` with `with` (or just the match `at`, from text.find); the replacement takes the formatting of the text it replaces. Errors when nothing matches.',
      params: s.object({text: s.string({max: 10000}), with: s.optional(s.string({max: 100000})), matchCase: s.optional(s.boolean()),
        wholeWords: s.optional(s.boolean()), at: s.optional(match)}),
      state: hasDoc,
      run(ctx, p) {
        const o = findOpts(p, 'text.replace');
        const at = p.at ? {slide: p.at.slide, shape: p.at.shape == null ? null : String(p.at.shape), cell: p.at.cell ?? null, para: p.at.para, start: p.at.start} : null;
        const {slides, count} = replaceAll(ctx.doc, o, String(p.with ?? ''), at);
        if (!count) throw bad('text.replace', 'no matches');
        for (const [i, r] of slides) {
          const sl = ctx.doc.slides[i];
          if (r.shapes.some((x, k) => x !== sl.shapes[k])) ctx.change.set(['slides', i, 'shapes'], r.shapes);
          if (r.notes !== sl.notes) ctx.change.set(['slides', i, 'notes'], r.notes);
        }
        return {replaced: count};
      },
    },
  ],
});
