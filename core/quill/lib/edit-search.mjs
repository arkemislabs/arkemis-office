// Find, Replace and Replace All over a story: the matches of the find state, read without text
// that Track Changes marks deleted, across paragraph marks when the pattern can match one.
//
// Translated from wordcraft crates/engine/src/cmd/edit.rs (Found, Seg, search, find_opts,
// search_full, read_opts, need_query) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {compile, toRegExp, parseReplace, resolveNames, expand, PARA_MARK, SECT_MARK} from './edit-find-pattern.mjs';
import {samePath, withLast, cmpPos} from './caret-session.mjs';

export const MAX_RESULTS = 100_000;

/** The find state as pattern options (find_opts). */
export const findOpts = f => ({matchCase: !!f.matchCase, wholeWord: !!f.wholeWord, prefix: !!f.matchPrefix, suffix: !!f.matchSuffix,
  ignorePunct: !!f.ignorePunct, ignoreSpace: !!f.ignoreSpace, wildcards: !!f.wildcards, regex: !!f.regex, literal: !!f.literal});

/** Copy the search options a command passes into the find state (read_opts). */
export function readOpts(find, p) {
  find.highlights = null;
  if (typeof p.text === 'string') find.query = p.text;
  if (typeof p.matchCase === 'boolean') find.matchCase = p.matchCase;
  if (typeof p.wholeWord === 'boolean') find.wholeWord = p.wholeWord;
  if (typeof p.regex === 'boolean') find.regex = p.regex;
  if (typeof p.wildcards === 'boolean') find.wildcards = p.wildcards;
  if (typeof p.special === 'boolean') find.literal = !p.special;
  if (typeof p.matchPrefix === 'boolean') find.matchPrefix = p.matchPrefix;
  if (typeof p.matchSuffix === 'boolean') find.matchSuffix = p.matchSuffix;
  if (typeof p.ignorePunct === 'boolean') find.ignorePunct = p.ignorePunct;
  if (typeof p.ignoreSpace === 'boolean') find.ignoreSpace = p.ignoreSpace;
  if (typeof p.with === 'string') find.replace = p.with;
}

/** Replace needs something to look for (need_query). */
export function needQuery(find, p) {
  if (typeof p.text !== 'string' && !find.query) throw new CommandError('invalid_params', '`text` (string) is required', {path: '/text'});
}

const parentKey = path => path.slice(0, -1).join('.');

/** All matches of the find state in `story`: [{a, b, rep}] (search_full); `withRep` fills in Replace with. */
export function searchFull(d, story, find, {withRep = false, clipboardText = ''} = {}) {
  if (!find.query) return [];
  const opts = findOpts(find);
  let c;
  try { c = compile(find.query, opts); } catch (e) { throw new CommandError('invalid_params', e.message); }
  let re;
  try { re = toRegExp(c); } catch (e) { throw new CommandError('invalid_params', e.message); }
  let pieces = null;
  if (withRep) {
    const names = groupNames(c.pattern);
    pieces = resolveNames(parseReplace(find.replace ?? '', opts), name => (names.has(name) ? name : null));
  }
  const paths = d.paraPaths(story);
  // Paragraphs read as one text: consecutive siblings when the pattern spans paragraphs.
  const chunks = [];
  for (let i = 0; i < paths.length; i++) {
    const joins = c.spansParas && i > 0 && parentKey(paths[i - 1]) === parentKey(paths[i]) && paths[i - 1][paths[i - 1].length - 1] + 1 === paths[i][paths[i].length - 1];
    if (joins) chunks[chunks.length - 1][1] = i + 1; else chunks.push([i, i + 1]);
  }
  const out = [];
  for (const [c0, c1] of chunks) {
    let hay = '';
    const segs = [];
    const cuts = [];
    const last = c1 - 1;
    for (let i = c0; i < c1; i++) {
      const p = d.para(story, paths[i]);
      if (!p) { cuts.push(hay.length); continue; }
      let expect = 0;
      for (const [s, e, props] of P.runRanges(p)) {
        if ((props?.del ?? null) !== null) continue;
        const t = p.text.slice(s, e);
        if (!t) continue;
        if (s !== expect) cuts.push(hay.length);
        const sg = segs[segs.length - 1];
        if (sg && !sg.mark && sg.para === i && sg.raw + sg.len === s) sg.len += t.length;
        else segs.push({hay: hay.length, para: i, raw: s, len: t.length, mark: false});
        hay += t;
        expect = e;
      }
      if (i < last) {
        if (expect !== p.text.length) cuts.push(hay.length);
        segs.push({hay: hay.length, para: i, raw: p.text.length, len: 1, mark: true});
        hay += p.section ? SECT_MARK : PARA_MARK;
      }
    }
    const posOf = (x, end) => {
      // partition_point over segments
      let lo = 0, hi = segs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const sg = segs[mid];
        if (end ? sg.hay + sg.len < x : sg.hay + sg.len <= x) lo = mid + 1; else hi = mid;
      }
      const sg = segs[lo];
      if (!sg) return null;
      if ((end && sg.hay >= x) || (!end && sg.hay > x)) return null;
      if (sg.mark && x > sg.hay) {
        const path = paths[sg.para];
        return {story, path: withLast(path, path[path.length - 1] + 1), off: 0};
      }
      return {story, path: [...paths[sg.para]], off: sg.raw + (x - sg.hay)};
    };
    cuts.push(hay.length);
    let from = 0;
    for (const cut of cuts) {
      if (cut <= from) continue;
      const piece = hay.slice(0, cut);
      re.lastIndex = from;
      from = cut;
      for (;;) {
        const m = re.exec(piece);
        if (!m) break;
        const ms = m.index, me = ms + m[0].length;
        if (ms === me) {
          // Step past an empty match so the search moves on.
          const cp = piece.codePointAt(me);
          re.lastIndex = me + (cp === undefined ? 1 : cp > 0xFFFF ? 2 : 1);
          if (re.lastIndex > piece.length) break;
          continue;
        }
        re.lastIndex = me;
        const a = posOf(ms, false), b = posOf(me, true);
        if (!a || !b) continue;
        let rep = null;
        if (pieces) {
          const group = n => (typeof n === 'string' ? m.groups?.[n] : m[n]) ?? null;
          rep = expand(pieces, m[0], group, clipboardText);
        }
        out.push({a, b, rep});
        if (out.length >= MAX_RESULTS) return out;
      }
    }
  }
  return out;
}

/** The named groups a pattern declares. */
function groupNames(pattern) {
  const out = new Set();
  for (const m of pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) out.add(m[1]);
  return out;
}

/** Matches as ranges (search). */
export const search = (d, story, find) => searchFull(d, story, find).map(f => [f.a, f.b]);

/** Index of the first match at or after `caret`, or 0 (edit.find / step forward). */
export const firstAtOrAfter = (results, caret) => { const i = results.findIndex(([a]) => cmpPos(a, caret) >= 0); return i < 0 ? 0 : i; };
/** Index of the last match ending at or before `caret`, or the last one (step back). */
export function lastAtOrBefore(results, caret) {
  for (let i = results.length - 1; i >= 0; i--) if (cmpPos(results[i][1], caret) <= 0) return i;
  return results.length - 1;
}

export {samePath};
