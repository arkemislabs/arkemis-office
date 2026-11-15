// Home, Layout and Design leftovers (U:quill/word-core): Show/Hide ¶, Select Text with Similar Formatting, Phonetic Guide, Format Page
// Numbers, Hyphenation (options and None).
//
// Translated from wordcraft crates/engine/src/cmd/view.rs (`view.marks`), tools/actions.rs (`select_similar`), phonetic.rs
// (`format.phonetic`, `ruby_at`, `base_size`, `default_size`, `state`), page.rs (`layout.pageNumberFormat`, `layout.hyphenation`) at aadb077e072b7de05f724e359d8db82e151f125c, checked against wordcraft 0.13.1 (f2dfa0d).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Hyphenation: the settings (automatic, zone, caps, consecutive limit) are kept and written to the .docx; the layout hyphenates with
// wordcraft's dictionary and Liang patterns (core/quill/lib/hyphen.mjs) when Automatic is on, and Manual hyphenation (layout.manualHyphenation)
// walks the words that start a wrapped line and could end the line above.
// Not here: Phonetic Guide's Font and preview (not upstream).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {Document} from '../model/document.mjs';
import {selectionPositions} from '../address.mjs';
import {resolveChar} from '../model/styles.mjs';
import {NUM_FORMATS} from '../model/numfmt.mjs';
import {ready, ordered, cmpPos, posParam, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {withSect, sectEdit} from './page.mjs';
import {layoutFor} from '../lib/caret-session.mjs';
import {hyphenPoints, defaultLimits} from '../lib/hyphen.mjs';
import {END} from '../layout/para/model.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/view.rs', 'crates/engine/src/cmd/tools/actions.rs', 'crates/engine/src/cmd/phonetic.rs',
  'crates/engine/src/cmd/page.rs', 'crates/engine/src/cmd/design.rs']};
const MAX_CHARS = 255;
const fin = Number.isFinite;
const disabled = m => new CommandError('disabled', m);
const failed = m => new CommandError('failed', m);
const bad = m => new CommandError('invalid_params', m);
const round1 = v => Math.round(v * 10) / 10 + 0;

// ---- Phonetic Guide ----------------------------------------------------------------------------------------

/** The phonetic guide the selection is (exactly one ruby object) or the caret is next to: its position, or null. */
function rubyAt(d, a, b) {
  const para = d.para(a.story, a.path);
  if (!para) return null;
  const ruby = off => (P.objectAt(para, off)?.type === 'ruby' ? {story: a.story, path: [...a.path], off} : null);
  if (cmpPos(a, b) === 0) return ruby(a.off) ?? (a.off >= 1 ? ruby(a.off - 1) : null);
  return a.story === b.story && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]) && b.off === a.off + 1 ? ruby(a.off) : null;
}

/** The resolved font size of the character at `at`, points. */
function baseSize(d, at) {
  const para = d.para(at.story, at.path);
  if (!para) return 10.5;
  const size = resolveChar(d.c.styles, para.props?.style ?? null, P.propsOfChar(para, at.off)).size;
  return fin(size) ? Math.min(1584, Math.max(1, size)) : 10.5;
}

/** Ruby half the base size, rounded down to a half point (10.5 pt text gets 5 pt ruby). */
const defaultSize = base => Math.max(1, Math.floor(base) / 2);

/** What the Phonetic Guide shows for a selection: its ruby, or the selected text with defaults. */
export function phoneticState(d, a, b) {
  const at = rubyAt(d, a, b);
  const obj = at ? P.objectAt(d.para(at.story, at.path), at.off) : null;
  if (obj) {
    const bs = obj.base_size > 0 ? obj.base_size : baseSize(d, at);
    return {base: obj.base ?? '', ruby: obj.ruby ?? '', align: obj.align ?? 'center', size: obj.size, offset: round1(P.rubyOffset(obj.raise, bs, obj.size)), existing: true};
  }
  const same = a.story === b.story && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);
  const para = same ? d.para(a.story, a.path) : null;
  const raw = para && cmpPos(a, b) !== 0 ? para.text.slice(a.off, b.off) : '';
  const base = [...raw].filter(c => !/\p{Cc}/u.test(c) && c !== P.OBJ).slice(0, MAX_CHARS).join('');
  return {base, ruby: '', align: 'center', size: defaultSize(baseSize(d, a)), offset: 0, existing: false};
}

/** The phonetic state of the document and selection of a command context (dialog init). */
export function phoneticOf(ctx) {
  const d = new Document(ctx.doc);
  const ranges = selectionPositions(ctx.doc, ctx.selection);
  const r = ranges[ctx.selection?.primary ?? 0] ?? ranges[0];
  const [a, b] = ordered({anchor: r.anchor, focus: r.focus});
  return phoneticState(d, a, b);
}

function phonetic(ctx, p) {
  const S = T.open(ctx);
  const [a, b] = T.ordered(S.sel);
  if (p.ruby === undefined) return {...phoneticState(S.d, a, b), ui: {open: 'phonetic'}};
  const text = String(p.ruby ?? '').split('').filter(c => !/\p{Cc}/u.test(c) && c !== P.OBJ).slice(0, MAX_CHARS).join('').trim();
  const align = p.align === undefined ? null : P.RUBY_ALIGNS.includes(p.align) ? p.align : (() => { throw bad(`unknown alignment \`${p.align}\``); })();
  const size = p.size === undefined ? null : Math.min(1584, Math.max(1, p.size));
  const offset = p.offset === undefined ? null : Math.min(1584, Math.max(-1584, p.offset));
  const at = rubyAt(S.d, a, b);
  if (at) {
    const end = {...at, path: [...at.path], off: at.off + 1};
    const bsz = baseSize(S.d, at);
    const para = S.d.paraMut(at.story, at.path);
    const props = P.propsOfChar(para, at.off);
    const cur = P.objectAt(para, at.off);
    if (!cur || cur.type !== 'ruby') throw failed('no phonetic guide at the selection');
    if (!text) {
      // Remove: the base text stays, in the ruby's formatting.
      S.d.deleteRange(at, end);
      const stop = S.d.insertText(at, cur.base ?? '', props);
      S.sel = {anchor: at, focus: stop};
      return T.finish(S, phoneticState(S.d, ...T.ordered(S.sel)));
    }
    const base = cur.base_size > 0 ? cur.base_size : bsz;
    const nextSize = size ?? cur.size;
    const keep = P.rubyOffset(cur.raise, base, cur.size);
    const raise = Math.min(1584, Math.max(0, P.rubyRaise(offset ?? keep, base, nextSize)));
    P.setObjectAt(para, at.off, {...cur, ruby: text, align: align ?? cur.align, size: nextSize, raise, base_size: base});
    S.sel = {anchor: at, focus: end};
    return T.finish(S, phoneticState(S.d, ...T.ordered(S.sel)));
  }
  if (!text) throw failed('no phonetic guide at the selection');
  const same = a.story === b.story && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);
  if (cmpPos(a, b) === 0 || !same) throw failed('select the text, within one paragraph, to set a phonetic guide over');
  const para = S.d.para(a.story, a.path);
  const base = para.text.slice(a.off, b.off);
  if (!base || [...base].some(c => c === P.OBJ || /\p{Cc}/u.test(c))) throw failed('a phonetic guide goes over plain text (no objects, tabs or breaks)');
  if ([...base].length > MAX_CHARS) throw failed(`a phonetic guide covers at most ${MAX_CHARS} characters`);
  // One set of formatting draws the whole guide: a symbol font only when every base character has it.
  const first = P.propsOfChar(para, a.off);
  let allSymbols = true;
  for (let i = 0; i < base.length; i++) if (P.propsOfChar(para, a.off + i).symFont !== first.symFont) { allSymbols = false; break; }
  const props = allSymbols ? first : (({symFont: _s, ...rest}) => rest)(first);
  const bsz = baseSize(S.d, a);
  const sz = size ?? defaultSize(bsz);
  const raise = Math.min(1584, Math.max(0, P.rubyRaise(offset ?? 0, bsz, sz)));
  const obj = {type: 'ruby', base, ruby: text, align: align ?? 'center', size: sz, raise, base_size: bsz};
  S.d.deleteRange(a, b);
  const end = S.d.insertObject(a, obj, props);
  S.sel = {anchor: a, focus: end};
  return T.finish(S, phoneticState(S.d, ...T.ordered(S.sel)));
}

// ---- Page numbers and hyphenation ------------------------------------------------------------------------------

/** Format Page Numbers: the section's number format and start (`start` left out keeps it; null numbers on from the section before). */
function pageNumberFormat(ctx, p) {
  const format = p.format === undefined ? null : NUM_FORMATS.includes(p.format) ? p.format : 'decimal';
  return sectEdit(ctx, S => {
    withSect(S, x => {
      if (format) x.pageNumFormat = format;
      if (p.start !== undefined) x.pageNumStart = p.start === null ? null : Math.min(100_000, Math.max(0, Math.trunc(p.start)));
    });
  });
}

/** Hyphenation: the document's settings (automatic, zone in points, hyphenate capitals, consecutive hyphen limit). */
function hyphenation(ctx, p) {
  const S = T.open(ctx);
  const options = ['zone', 'caps', 'limit'].some(k => p[k] !== undefined && p[k] !== null);
  S.d.updateField('settings', st => {
    if (typeof p.value === 'boolean') st.autoHyphenation = p.value;
    else if (!options) st.autoHyphenation = !st.autoHyphenation;
    if (fin(p.zone)) st.hyphenationZone = Math.min(1584, Math.max(0, p.zone));
    if (typeof p.caps === 'boolean') st.hyphenateCaps = p.caps;
    if (fin(p.limit)) st.consecutiveHyphenLimit = Math.min(32_767, Math.max(0, Math.trunc(p.limit)));
  });
  const st = S.d.settings;
  return T.finish(S, {value: !!st.autoHyphenation, zone: st.hyphenationZone ?? null, caps: st.hyphenateCaps !== false, limit: st.consecutiveHyphenLimit ?? 0});
}

// ---- Manual hyphenation ------------------------------------------------------------------------------------------

const WORD = /^[\p{Alphabetic}'\u2019]*/u;
const isAllUpper = w => [...w].every(c => c === c.toUpperCase() && c !== c.toLowerCase());

/**
 * Manual hyphenation: the next word after `from` that starts a line after a line wrapped at a space and could end the line before it if
 * hyphenated. `points` are where a hyphen may go (char indices into `word`); `suggest` is the last one whose first part fits on that
 * line. `ctx` is a command context (its document and view); `from` a position (default: the start of the selection). Null when done.
 */
export function nextManualHyphen(ctx, from = null) {
  const content = ctx.doc;
  const d = new Document(content);
  if (!from) {
    // The start of the selection, or of the document when there is none yet.
    try {
      const r = selectionPositions(content, ctx.selection);
      const at = r[ctx.selection?.primary ?? 0] ?? r[0];
      from = ordered({anchor: at.anchor, focus: at.focus})[0];
    } catch { from = null; }
    from ??= {story: 'body', path: [0], off: 0};
  }
  const lim = defaultLimits();
  const caps = content.settings?.hyphenateCaps !== false;
  const lay = layoutFor(ctx, content);
  let best = null;
  for (const page of lay.pages) {
    for (const it of page.items) {
      if (it.kind !== 'lines' || it.story !== 'body') continue;
      const para = d.para('body', it.path);
      if (!para) continue;
      for (let li = Math.max(it.l0, 1); li < it.l1; li++) {
        const prev = it.para.lines[li - 1], line = it.para.lines[li];
        if (!prev || !line || prev.end !== END.WRAP || prev.hyphen) continue;
        const at = {story: 'body', path: [...it.path], off: line.start};
        if (cmpPos(at, from) < 0 || (best && cmpPos(best.at, at) <= 0)) continue;
        const rest = para.text.slice(line.start);
        const word = WORD.exec(rest)[0];
        // A word with an optional hyphen already breaks where its author said.
        if (rest[word.length] === '\u00ad' || [...word].length < lim.minWord || (!caps && isAllUpper(word))) continue;
        const points = hyphenPoints(word, lim);
        const room = prev.right - prev.endX();
        const first = word ? (word.codePointAt(0) > 0xFFFF ? 2 : 1) : 0;
        const xa = it.para.xOf(li, line.start), xb = it.para.xOf(li, line.start + first);
        const hyphenW = xa !== null && xb !== null ? (xb - xa) * 0.6 : 6;
        const units = word.length ? [...word].reduce((acc, c) => { acc.push(acc[acc.length - 1] + c.length); return acc; }, [0]) : [0];
        const fits = pt => {
          const a = it.para.xOf(li, line.start), b = it.para.xOf(li, line.start + (units[pt] ?? word.length));
          return a !== null && b !== null && b - a + hyphenW <= room;
        };
        const ok = points.filter(fits);
        if (!ok.length) continue;
        best = {at, found: {word, pos: at, points, suggest: Math.max(...ok), offsets: units}};
      }
    }
  }
  return best ? best.found : null;
}

// ---- Select similar, marks, design default ---------------------------------------------------------------------

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const sameProps = (x, y) => JSON.stringify(sortKeys(x ?? {})) === JSON.stringify(sortKeys(y ?? {}));

/** Select Text with Similar Formatting: from the first run formatted as the one at the caret to the last, in this story. */
function selectSimilar(ctx) {
  const S = T.open(ctx);
  const f = T.ordered(S.sel)[0];
  const target = P.propsOfChar(S.d.para(f.story, f.path) ?? P.newParagraph(), f.off);
  let first = null, last = null, count = 0;
  for (const path of S.d.paraPaths(f.story)) {
    const para = S.d.para(f.story, path);
    if (!para) continue;
    for (const [from, to, props] of P.runRanges(para)) {
      if (!sameProps(props, target)) continue;
      count++;
      if (!first) first = {story: f.story, path: [...path], off: from};
      last = {story: f.story, path: [...path], off: to};
    }
  }
  if (first && last) S.sel = {anchor: first, focus: last};
  return T.finish(S, {runs: count});
}

export default defineCommands({
  family: 'word-core',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'layout.manualHyphenation', label: 'Manual Hyphenation', risk: 'read', effect: 'view', state: T.ready, dialog: 'dialog.manualHyphenation',
      description: 'Manual Hyphenation (Layout › Page Setup › Hyphenation): the next word after `from` (default the caret) that starts a wrapped line and could end the line above if hyphenated: {word, pos, points, suggest}, or {done: true}. Accepting is caret.set to pos plus the point, then text.optionalHyphen.',
      params: s.object({from: s.optional(s.any())}),
      run: (ctx, p) => {
        const from = p?.from ? posParam(ctx, p.from, 'from') : null;
        const hit = nextManualHyphen(ctx, from);
        return hit ? {word: hit.word, pos: hit.pos, points: hit.points, suggest: hit.suggest} : {done: true};
      }},
    {id: 'view.marks', label: 'Show/Hide ¶', shortcut: 'Mod+Shift+8', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!ctx.view?.marks} : r; },
      description: 'Show/Hide ¶ (Home › Paragraph): the formatting marks (paragraph marks, spaces, tabs) are drawn or not; `value` sets it, otherwise it toggles.',
      params: s.object({value: s.optional(s.boolean())}),
      run: (ctx, p) => { const on = p?.value ?? !ctx.view?.marks; ctx.setView({marks: on}); return {value: on}; }},
    {id: 'select.similar', label: 'Select Text with Similar Formatting', risk: 'read', effect: 'view', state: T.ready,
      description: 'Select Text with Similar Formatting (Home › Editing › Select): the selection runs from the first run formatted like the text at the caret to the last one; answers {runs}.',
      params: s.object({}), run: selectSimilar},
    {id: 'format.phonetic', label: 'Phonetic Guide', risk: 'edit', state: T.ready, dialog: 'dialog.phonetic',
      description: 'Phonetic Guide (Home › Font): ruby text over the selected text (or edit the guide the selection is or the caret touches); `ruby` null or "" removes it. Without `ruby` it answers {base, ruby, align, size, offset, existing}.',
      params: s.object({ruby: s.optional(s.nullable(s.string({max: 1024}))), align: s.optional(s.string({max: 32})), size: s.optional(s.number()), offset: s.optional(s.number())}),
      run: phonetic},
    {id: 'layout.pageNumberFormat', label: 'Format Page Numbers', risk: 'edit', state: T.ready, dialog: 'dialog.pageNumbers',
      description: 'Format Page Numbers (Insert › Header & Footer › Page Number): the section\'s number `format` (decimal, numberInDash, lowerLetter, upperLetter, lowerRoman, upperRoman...) and `start` (left out: the numbering keeps its start; null: the pages number on from the section before; a number: numbering starts there).',
      params: s.object({format: s.optional(s.string({max: 32})), start: s.optional(s.nullable(s.number({min: 0})))}),
      run: pageNumberFormat},
    {id: 'layout.hyphenation', label: 'Hyphenation', risk: 'edit', state: T.ready, dialog: 'dialog.hyphenation',
      description: 'Hyphenation (Layout › Page Setup): `value` automatic (the layout does not hyphenate by itself yet; the setting is kept), `zone` in points, `caps` hyphenate words in capitals, `limit` consecutive hyphens (0 = no limit); with nothing given, the automatic setting toggles.',
      params: s.object({value: s.optional(s.boolean()), zone: s.optional(s.number()), caps: s.optional(s.boolean()), limit: s.optional(s.number())}),
      run: hyphenation},
  ],
});

