// Spelling in Word (U:quill/spelling): the misspelt words of a paragraph, the issue under a position, the next issue after the
// caret, and the key Ignore Once remembers a place by. The words and the dictionary are the shared service's
// (core/common/lib/spelling.mjs); what is Word's own is which text is checked.
//
// Translated from wordcraft crates/layout/src/para/proof.rs (`proof_runs`, `paragraph_issues`, `proof_text`: inline objects and
// tracked deletions are not words; runs marked "Do not check spelling", hidden text and hyperlinks are left out; each run is
// checked in its own language) and crates/engine/src/cmd/review/proofing.rs (`para_issues`, `issue_at`, `next_issue`,
// `all_issues`, `suggestions`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Differences from upstream, said once: only US English ships (core/common/lib/spelling.mjs), so text in another language is not
// checked rather than checked wrongly; there is no grammar checking (no engine), so every issue here is a spelling issue.

import {spellingFor, wordsOf, isCheckedLanguage, sessionKey} from '../../common/lib/spelling.mjs';
import * as P from '../model/para.mjs';

/** Paragraph text for proofing, offsets unchanged: inline objects and tracked deletions become spaces (neither words nor part of one). */
export function proofText(p) {
  const text = p.text;
  if (!text) return '';
  const dropped = P.deletedRanges(p);
  if (!dropped.length && !p.objects?.length && !text.includes(P.OBJ)) return text;
  let out = '';
  let r = 0;
  const sorted = dropped.slice().sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < text.length; i++) {
    while (r < sorted.length && sorted[r][1] <= i) r++;
    const gone = r < sorted.length && sorted[r][0] <= i;
    out += gone || text[i] === P.OBJ ? ' ' : text[i];
  }
  return out;
}

/** Ranges [start, end] left unchecked: "Do not check spelling" runs, hidden text, hyperlinks, and text in a language no dictionary ships for. */
export function unchecked(p, defaultLang) {
  const out = [];
  for (const [a, b, c] of P.runRanges(p)) {
    if (c.noProof || c.hidden || c.link || !isCheckedLanguage(c.lang ?? defaultLang)) out.push([a, b]);
  }
  return out;
}

/** The language a document's text is in unless a run says otherwise. */
export const defaultLanguage = content => content?.styles?.defaultChr?.lang ?? 'en-US';

/** Ignore Once's key for the occurrence of `word` that is the `n`-th misspelling of that word in the paragraph. */
export const onceKey = (p, word, n) => `${p.id ?? ''}:${String(word).toLowerCase()}:${n}`;

/**
 * The misspelt words of one paragraph (as the squiggles show them): [{start, end, text, key}]. Words not looked up yet
 * count as correct (the service queues them; `sp.version` goes up when they are in). `o`: {session, defaultLang, ignored: false
 * to include words skipped with Ignore Once}.
 */
export function paraIssues(p, sp, o = {}) {
  if (!p || !p.text || !p.text.trim() || p.text.length > 100_000) return [];
  const skips = unchecked(p, o.defaultLang ?? 'en-US');
  const skip = skips.length ? (a, b) => skips.some(([x, y]) => x < b && a < y) : undefined;
  const counts = new Map();
  const out = [];
  for (const t of sp.misspellings(proofText(p), {session: o.session, skip})) {
    const w = t.text.toLowerCase();
    const n = counts.get(w) ?? 0;
    counts.set(w, n + 1);
    const key = onceKey(p, t.text, n);
    if (o.ignored !== false && o.session !== undefined && sp.isIgnoredOnce(o.session, key)) continue;
    out.push({...t, key});
  }
  return out;
}

/** Every word of the paragraphs in `list` is looked up (one batch) before they are read with `paraIssues`. */
export async function prepare(d, story, paths, sp, o = {}) {
  const words = [];
  for (const path of paths) {
    const p = d.para(story, path);
    if (!p || !p.text.trim() || p.text.length > 100_000) continue;
    const skips = unchecked(p, o.defaultLang ?? 'en-US');
    const text = proofText(p);
    for (const t of wordsOf(text)) if (!skips.some(([x, y]) => x < t.end && t.start < y)) words.push(t.text);
  }
  await sp.prepare(words);
}

/** The service for a command's prefs. */
export const serviceFor = ctx => spellingFor(ctx?.prefs);

/** The session key Ignore All and Ignore Once are kept under: the document. */
export const sessionOf = ctx => sessionKey(ctx?.host, ctx?.docId);

const BATCH = 40;

/**
 * The issues after position `from` (the caret, or the start of the story) in reading order, wrapping once, as
 * [{story, path, start, end, text, key}]: at most `limit`. The paragraphs are looked up in batches, so a long document
 * is read only as far as the answer needs (the Spelling & Grammar check stops at the first one).
 */
export async function issuesFrom(d, from, sp, o = {}) {
  const story = from.story;
  const paths = d.paraPaths(story);
  if (!paths.length) return [];
  const here = Math.max(0, paths.findIndex(p => p.length === from.path.length && p.every((v, i) => v === from.path[i])));
  const limit = o.limit ?? 1;
  const out = [];
  let looked = 0;
  while (looked < paths.length && out.length < limit) {
    const batch = [];
    for (let k = looked; k < Math.min(looked + BATCH, paths.length); k++) batch.push(paths[(here + k) % paths.length]);
    await prepare(d, story, batch, sp, o);
    for (let k = 0; k < batch.length && out.length < limit; k++) {
      const path = batch[k];
      const index = looked + k;
      const p = d.para(story, path);
      for (const t of paraIssues(p, sp, o)) {
        // In the caret's own paragraph, words before the caret come last (after the wrap), as upstream skips them first.
        if (index === 0 && t.start < from.off && paths.length > 1) continue;
        out.push({story, path, ...t});
        if (out.length >= limit) break;
      }
    }
    looked += batch.length;
  }
  // The words before the caret in the caret's paragraph, after the wrap.
  if (out.length < limit && paths.length > 1) {
    const p = d.para(story, paths[here]);
    for (const t of paraIssues(p, sp, o)) {
      if (t.start < from.off && out.length < limit) out.push({story, path: paths[here], ...t});
    }
  }
  return out;
}

/** The issue touching offset `off` of a paragraph (`issue_at`), or null. */
export function issueAt(p, off, sp, o = {}) {
  return paraIssues(p, sp, o).find(t => t.start <= off && off <= t.end) ?? null;
}
