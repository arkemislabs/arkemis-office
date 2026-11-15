// Tracked moves (Review › Track Changes, ECMA-376 §17.13.5.21–28): with Track Changes on, a
// paragraph or sentence cut and pasted elsewhere is recorded as a move: its source (moveFrom, a
// deletion revision) and destination (moveTo, an insertion revision) are linked by a move name, and
// accepting or rejecting either end resolves both.
//
// Translated from wordcraft crates/engine/src/cmd/moves.rs (PendingMove, move_sized, stories,
// in_use, cut_tracked, take_paste, names_in, resolve, has_moves) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `names_in`, `resolve` and `has_moves` are what Review › Accept/Reject (U:quill/review) calls.

import * as P from '../model/para.mjs';
import {caret, ordered, samePos, samePath} from './caret-session.mjs';
import {trackDeleteAs, joinNextPara, setMark} from './text-edit.mjs';

/** Is cut text big enough to be moved: a whole paragraph or at least a sentence? (move_sized) */
export function moveSized(text) {
  let t = text.replace(/[  ]+$/u, '');
  if (t.includes('\n')) return true;
  t = t.replace(/["'”’)]+$/u, '');
  return /[.!?…]$/u.test(t) && t.split(/\s+/u).filter(Boolean).length >= 2;
}

/** Every story: the body, then the parts. */
const stories = d => ['body', ...Object.keys(d.c.parts ?? {}).map(Number).sort((a, b) => a - b)];

/** Does some text or paragraph mark carry revision `rev`? (in_use) */
export function inUse(d, rev) {
  for (const st of stories(d)) {
    for (const path of d.paraPaths(st)) {
      const p = d.para(st, path);
      if (!p) continue;
      if (p.mark?.ins === rev || p.mark?.del === rev) return true;
      if (p.runs.some(r => r.props?.ins === rev || r.props?.del === rev)) return true;
    }
  }
  return false;
}

/**
 * Cut's deletion under Track Changes: a move-sized cut gets a revision of its own and is
 * remembered, so the paste right after it can make it a move. False when it isn't such a cut (cut_tracked).
 */
export function cutTracked(S, clipboardText) {
  const [a, b] = ordered(S.sel);
  const st = S.d.c.settings ?? {};
  const trackMoves = st.trackMoves ?? true;
  if (!(st.trackChanges || S.ctx?.view?.trackMine) || !trackMoves || samePos(a, b) || a.story !== b.story || !moveSized(clipboardText)) return false;
  S.d.updateField('revisions', rs => [...(rs ?? []), {kind: 'delete', author: S.author, date: S.now()}]);
  const rid = S.d.c.revisions.length - 1;
  const r = trackDeleteAs(S, a, b, rid);
  S.sel = caret(r.at);
  // Only the author's own insertions were cut: they are gone, not moved.
  if (inUse(S.d, rid)) S.view.pendingMove = {rev: rid, text: clipboardText, author: S.author};
  return true;
}

/** A tracked paste of what the last command cut: the destination's revision, or null (take_paste). */
export function takePaste(S, fragmentText) {
  const m = S.view.pendingMove;
  S.view.pendingMove = null;
  if (!m) return null;
  const trackMoves = S.d.c.settings?.trackMoves ?? true;
  if (!trackMoves || m.author !== S.author || fragmentText !== m.text || !inUse(S.d, m.rev)) return null;
  const src = S.d.c.revisions?.[m.rev];
  if (!src || src.kind !== 'delete' || src.moveName) return null;
  const taken = new Set((S.d.c.revisions ?? []).map(r => r.moveName).filter(Boolean));
  let n = 1;
  while (taken.has(`move${n}`)) n++;
  const name = `move${n}`;
  S.d.updateField('revisions', rs => {
    const out = [...rs];
    out[m.rev] = {...out[m.rev], moveName: name};
    out.push({kind: 'insert', author: S.author, date: src.date, moveName: name});
    return out;
  });
  return S.d.c.revisions.length - 1;
}

/** The move name of revision index `i`, or null. */
const moveName = (d, i) => (i === undefined || i === null ? null : d.c.revisions?.[i]?.moveName ?? null);

/** Move names of the insertions and deletions in a..b (and the marks it covers) (names_in). */
export function namesIn(d, a, b, caretMark = null) {
  const out = new Set();
  const add = r => { const n = moveName(d, r); if (n) out.add(n); };
  for (const path of d.pathsBetween(a, b)) {
    const p = d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : p.text.length;
    for (const [s, e, c] of P.runRanges(p)) {
      if ((e > from && s < to) || (from === to && s <= from && from <= e)) { add(c?.ins); add(c?.del); }
    }
    if (!samePath(path, b.path) || (caretMark && samePath(caretMark, path))) { add(p.mark?.ins); add(p.mark?.del); }
  }
  return out;
}

/** Accept or reject every end of the moves named `names` (resolve). */
export function resolve(S, names, accept) {
  if (!names.size) return;
  const named = r => { const n = moveName(S.d, r); return !!n && names.has(n); };
  for (const st of stories(S.d)) {
    for (const path of [...S.d.paraPaths(st)].reverse()) {
      const p = S.d.para(st, path);
      if (!p) continue;
      const ranges = P.runRanges(p).map(([s, e, c]) => [s, e, named(c?.ins), named(c?.del)]).filter(([, , i, dl]) => i || dl);
      const markIns = named(p.mark?.ins), markDel = named(p.mark?.del);
      if (!ranges.length && !markIns && !markDel) continue;
      for (const [x, y, ins, del] of ranges.reverse()) {
        const A = {story: st, path, off: x}, B = {story: st, path, off: y};
        if ((del && accept) || (ins && !accept)) S.d.deleteRange(A, B);
        else S.d.formatRange(A, B, c => { if (ins) delete c.ins; if (del) delete c.del; return c; });
      }
      if (!markIns && !markDel) continue;
      if (((markDel && accept) || (markIns && !accept)) && joinNextPara(S, st, path)) continue;
      setMark(S, st, path, mk => { if (markIns) delete mk.ins; if (markDel) delete mk.del; return mk; });
    }
  }
}

/** Does the body have moved text? (has_moves) */
export function hasMoves(d) {
  if (!(d.c.revisions ?? []).some(r => r.moveName)) return false;
  return d.paraPaths('body').some(path => {
    const p = d.para('body', path);
    return !!p && (moveName(d, p.mark?.ins) || moveName(d, p.mark?.del) || p.runs.some(r => moveName(d, r.props?.ins) || moveName(d, r.props?.del)));
  });
}
