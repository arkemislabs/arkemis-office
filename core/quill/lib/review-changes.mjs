// Tracked changes (U:quill/review): the list of changes (Reviewing Pane, Next/Previous Change),
// accepting and rejecting them at the selection or all at once, moves, the deletion balloons and
// the formatting balloons the page view draws.
//
// Translated from wordcraft crates/engine/src/cmd/review/changes.rs (`resolve_runs`,
// `resolve_para`, `resolve_cell`, `Change`, `mark_change`, `run_kind`, `move_changes`,
// `resolve_loose_blocks`, `resolve_all`, `resolve_all_then`, `resolve_sel_then`, `revision_span`,
// `resolve_sel`, `changes`, `format_changes`, `has_format_changes`, `deletion_balloons`,
// `push_deletion`, `plain_deletion`, `has_deletions`, `nav_change`, `select_next_unresolved`,
// `list_changes`) and crates/engine/src/cmd/moves.rs (`names_in`, `resolve`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// `S` is the Session from caret-session.mjs. Text a revision deletes or a rejected insertion
// leaves goes through the Document's recorded deletes, so anchors and the selection map through.

import * as P from '../model/para.mjs';
import {BODY} from '../model/document.mjs';
import {caret, ordered, cmpPos, samePos, samePath, withLast, cellOf} from './caret-session.mjs';
import {hasNextPara, joinNextPara, removeEmptyPara} from './text-edit.mjs';
import {resolveChar, resolvePara as resolveParaProps, resolveSection, resolveContainers, resolveTableProps, resolveRowProps, resolveCellProps,
  charDiff, paraDiff, sectionDiff, tableDiff, rowDiff, cellDiff, describe} from './review-fmt.mjs';

const OBJ = P.OBJ;
const has = v => v !== undefined && v !== null;
const pos = (story, path, off) => ({story, path: [...path], off});

/** The kind of an insertion / deletion change: insert, delete, moveTo, moveFrom; '' when neither (run_kind). */
export function runKind(d, ins, del) {
  if (has(ins)) return d.moveName(ins) !== null ? 'moveTo' : 'insert';
  if (has(del)) return d.moveName(del) !== null ? 'moveFrom' : 'delete';
  return '';
}

/** The tracked paragraph mark at the end of the paragraph at `path`, as a change (mark_change). */
function markChange(S, story, path) {
  const p = S.d.para(story, path);
  if (!p) return null;
  const m = p.mark ?? {};
  const kind = runKind(S.d, m.ins, m.del);
  if (!kind) return null;
  const a = pos(story, path, p.text.length);
  const b = hasNextPara(S, story, path) ? pos(story, withLast(path, path[path.length - 1] + 1), 0) : a;
  return {a, b, kind, rev: has(m.ins) ? m.ins : m.del, props: []};
}

/** Every tracked change in the body, in document order (changes). */
export function changes(S) {
  const d = S.d;
  const out = [];
  const mk = (path, off) => pos(BODY, path, off);
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    // A table's, row's and cell's changes sit at the start of the cell's first paragraph.
    const cell = cellOf(path);
    if (path[path.length - 1] === 0 && cell) {
      const [tp, r, c] = cell;
      const t = d.table(BODY, tp);
      if (t) {
        const row = t.rows[r], cl = row?.cells[c];
        const found = [
          r === 0 && c === 0 && t.props?.fmtChange ? [t.props.fmtChange.rev, tableDiff(t.props)] : null,
          c === 0 && row?.props?.fmtChange ? [row.props.fmtChange.rev, rowDiff(row.props)] : null,
          cl?.props?.fmtChange ? [cl.props.fmtChange.rev, cellDiff(cl.props)] : null,
        ];
        for (const f of found) if (f) out.push({a: mk(path, 0), b: mk(path, 0), kind: 'format', rev: f[0], props: f[1]});
      }
    }
    if (p.props?.fmtChange) out.push({a: mk(path, 0), b: mk(path, p.text.length), kind: 'format', rev: p.props.fmtChange.rev, props: paraDiff(p.props)});
    for (const [s, e, c] of P.runRanges(p)) {
      const kind = runKind(d, c.ins, c.del);
      if (kind) out.push({a: mk(path, s), b: mk(path, e), kind, rev: has(c.ins) ? c.ins : c.del, props: []});
      if (!c.fmtChange) continue;
      const props = charDiff(c);
      const last = out[out.length - 1];
      // Neighbouring runs changed the same way by the same revision are one change.
      if (last && last.kind === 'format' && last.rev === c.fmtChange.rev && samePos(last.b, mk(path, s)) && JSON.stringify(last.props) === JSON.stringify(props)) last.b = mk(path, e);
      else out.push({a: mk(path, s), b: mk(path, e), kind: 'format', rev: c.fmtChange.rev, props});
    }
    if (p.mark?.fmtChange) { const end = mk(path, p.text.length); out.push({a: end, b: end, kind: 'format', rev: p.mark.fmtChange.rev, props: charDiff(p.mark)}); }
    const m = markChange(S, BODY, path);
    if (m) out.push(m);
    if (p.section?.fmtChange) { const end = mk(path, p.text.length); out.push({a: end, b: end, kind: 'format', rev: p.section.fmtChange.rev, props: sectionDiff(p.section)}); }
  }
  if (d.c.lastSection?.fmtChange) { const end = d.endOf(BODY); out.push({a: end, b: end, kind: 'format', rev: d.c.lastSection.fmtChange.rev, props: sectionDiff(d.c.lastSection)}); }
  return out;
}

/** The changes for the Reviewing Pane and the bridge (list_changes); `addr(pos)` names a position. */
export function listChanges(S, addr) {
  const d = S.d;
  return changes(S).map(c => {
    const rev = has(c.rev) ? d.c.revisions[c.rev] : null;
    const v = {kind: c.kind, start: addr(c.a), end: addr(c.b), text: rangeText(d, c.a, c.b), author: rev?.author ?? null, date: rev?.date ?? null};
    if (c.kind === 'format') { v.description = describe(c.props); v.props = c.props; }
    if (rev?.moveName && c.kind.startsWith('move')) { v.move = rev.moveName; v.description = c.kind === 'moveFrom' ? 'Moved from' : 'Moved to'; }
    return v;
  });
}

/** The plain text between two positions of one story (objects left out, paragraphs on new lines). */
export function rangeText(d, a, b) {
  if (a.story !== b.story) return '';
  const out = [];
  for (const path of d.pathsBetween(a, b)) {
    const p = d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0, to = samePath(path, b.path) ? b.off : p.text.length;
    out.push(p.text.slice(from, to).split(OBJ).join(''));
  }
  return out.join('\n');
}

/** The formatting changes in the body, for balloons: [{at, author, rev, props, description}] (format_changes). */
export function formatChanges(S) {
  return changes(S).filter(c => c.kind === 'format').map(c => ({at: c.a, author: S.d.c.revisions[c.rev]?.author ?? '', rev: c.rev, props: c.props, description: describe(c.props)}));
}

/** The moves in the body, for balloons: [{at, author, from}] (move_changes). */
export function moveChanges(S) {
  const seen = new Set();
  const out = [];
  for (const c of changes(S)) {
    if (c.kind !== 'moveFrom' && c.kind !== 'moveTo') continue;
    const rev = S.d.c.revisions[c.rev];
    const key = `${rev?.moveName ?? ''}\u0000${c.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({at: c.a, author: rev?.author ?? '', from: c.kind === 'moveFrom'});
  }
  return out;
}

/** At most this many characters of deleted text show in a balloon. */
export const DELETION_TEXT_CHARS = 200;
const MAX_DELETION_BALLOONS = 500;
const plainDeletion = (d, del) => (has(del) && d.moveName(del) === null ? del : null);

/** The tracked deletions in the body, for balloons, in document order: [{at, author, text}] (deletion_balloons). */
export function deletionBalloons(S) {
  const d = S.d;
  const author = r => d.c.revisions[r]?.author ?? '';
  const out = [];
  const push = (at, end, who, text) => {
    const last = out[out.length - 1];
    const joins = last && samePos(last.end, at) && last.d.author === who;
    if (!joins) {
      if (out.length >= MAX_DELETION_BALLOONS) return;
      out.push({d: {at, author: who, text: ''}, end, chars: 0});
    }
    const e = out[out.length - 1];
    e.end = end;
    for (const ch of text) {
      if (e.chars > DELETION_TEXT_CHARS) break;
      let c = ch;
      if (c === OBJ) continue;
      if (c === '\t' || c === P.LINE_BREAK || c === P.PAGE_BREAK || c === P.COLUMN_BREAK) c = ' ';
      else if (/\p{Cc}/u.test(c)) continue;
      e.chars++;
      e.d.text += e.chars > DELETION_TEXT_CHARS ? '…' : c;
    }
  };
  for (const path of d.paraPaths(BODY)) {
    const p = d.para(BODY, path);
    if (!p) continue;
    for (const [s, e, c] of P.runRanges(p)) {
      const rev = plainDeletion(d, c.del);
      if (rev === null) continue;
      push(pos(BODY, path, s), pos(BODY, path, e), author(rev), p.text.slice(s, e));
    }
    const mrev = plainDeletion(d, p.mark?.del);
    if (mrev !== null) {
      const at = pos(BODY, path, p.text.length);
      const end = hasNextPara(S, BODY, path) ? pos(BODY, withLast(path, path[path.length - 1] + 1), 0) : at;
      push(at, end, author(mrev), '¶');
    }
  }
  return out.map(x => x.d);
}

/** Whether the body has any tracked deletion other than a move's source (has_deletions). */
export function hasDeletions(d) {
  return d.paraPaths(BODY).some(path => {
    const p = d.para(BODY, path);
    return !!p && (plainDeletion(d, p.mark?.del) !== null || p.runs.some(r => plainDeletion(d, r.props?.del) !== null));
  });
}

/** Whether the document has any tracked change at all (Accept/Reject All enabled). */
export function hasAnyChange(d) {
  if (d.c.revisions?.length) return true;
  return false;
}

// ---- resolving ---------------------------------------------------------------------------------

/** Accept or reject the tracked formatting and text of from..to in one paragraph, not its mark (resolve_runs). */
function resolveRuns(S, story, path, from, to, props, accept) {
  const d = S.d;
  const cur = d.para(story, path);
  if (props && (cur.props?.fmtChange || cur.props?.numChange)) {
    const pm = d.paraMut(story, path);
    const np = resolveParaProps(pm.props, accept);
    if (Object.keys(np).length) pm.props = np; else delete pm.props;
  }
  const ranges = P.runRanges(d.para(story, path)).filter(([s, e]) => e > from && s < to)
    .map(([s, e, c]) => [Math.max(s, from), Math.min(e, to), has(c.ins), has(c.del), !!c.fmtChange]);
  for (let k = ranges.length - 1; k >= 0; k--) {
    const [a, b, ins, del, fmt] = ranges[k];
    if ((del && accept) || (ins && !accept)) d._pDelete(story, path, a, b);
    else if (ins || del || fmt) {
      const pm = d.paraMut(story, path);
      P.formatRange(pm, a, b, c => { const r = resolveChar(c, accept); delete r.ins; delete r.del; return r; });
    }
  }
}

/** Accept or reject a revision range in one paragraph; `mark` includes its paragraph mark, `props` its own formatting change (resolve_para). */
function resolveParaRange(S, story, path, from, to, mark, props, accept) {
  resolveRuns(S, story, path, from, to, props, accept);
  if (!mark) return;
  const d = S.d;
  let para = d.para(story, path);
  if (para.mark?.fmtChange || para.section?.fmtChange) {
    const pm = d.paraMut(story, path);
    if (pm.mark?.fmtChange) { const m = resolveChar(pm.mark, accept); if (Object.keys(m).length) pm.mark = m; else delete pm.mark; }
    if (pm.section?.fmtChange) pm.section = resolveSection(pm.section, accept);
    para = pm;
  }
  const ins = para.mark?.ins, del = para.mark?.del;
  if (!has(ins) && !has(del)) return;
  // An inserted paragraph mark that is rejected, or a deleted one that is accepted, goes away: the
  // next paragraph joins this one. A paragraph left empty goes away whole. The mark at the end of
  // a story or cell can't go, so it just stops being a revision.
  if (((has(del) && accept) || (has(ins) && !accept)) && (removeEmptyPara(S, story, path) || joinNextPara(S, story, path))) return;
  const pm = d.paraMut(story, path);
  const m = {...(pm.mark ?? {})};
  delete m.ins; delete m.del;
  if (Object.keys(m).length) pm.mark = m; else delete pm.mark;
}

/** Accept or reject the changes of the table cell `path` is in (resolve_cell); whether there were any. */
function resolveCell(S, story, path, accept) {
  const cell = cellOf(path);
  if (!cell) return false;
  const [tp, r, c] = cell;
  const t = S.d.table(story, tp);
  const row = t?.rows[r];
  if (!t || !(t.props?.fmtChange || row?.props?.fmtChange || row?.cells[c]?.props?.fmtChange)) return false;
  S.d.updateTable(story, tp, tb => ({...tb, props: resolveTableProps(tb.props, accept), rows: tb.rows.map((rw, i) => (i !== r ? rw
    : {...rw, props: resolveRowProps(rw.props, accept), cells: rw.cells.map((cl, j) => (j !== c ? cl : {...cl, props: resolveCellProps(cl.props, accept)}))}))}));
  return true;
}

/** The stories accepting and rejecting go through: the body, then every part. */
const allStories = d => [BODY, ...Object.keys(d.c.parts ?? {}).map(Number).sort((a, b) => a - b)];

/** Accept or reject every change of a block list that is not a story (a note separator) (resolve_loose_blocks). */
function resolveLooseBlocks(blocks, accept) {
  const out = blocks.map(b => {
    if (b.kind !== 'para') return b;
    const p = structuredClone(b);
    const ranges = P.runRanges(p).map(([s, e, c]) => [s, e, has(c.ins), has(c.del), !!c.fmtChange]);
    for (let k = ranges.length - 1; k >= 0; k--) {
      const [a, z, ins, del, fmt] = ranges[k];
      if ((del && accept) || (ins && !accept)) P.deleteRange(p, a, z);
      else if (ins || del || fmt) P.formatRange(p, a, z, c => { const r = resolveChar(c, accept); delete r.ins; delete r.del; return r; });
    }
    if (p.props?.fmtChange || p.props?.numChange) { const np = resolveParaProps(p.props, accept); if (Object.keys(np).length) p.props = np; else delete p.props; }
    if (p.mark) { let m = resolveChar(p.mark, accept); m = {...m}; delete m.ins; delete m.del; if (Object.keys(m).length) p.mark = m; else delete p.mark; }
    if (p.section?.fmtChange) p.section = resolveSection(p.section, accept);
    return p;
  });
  return resolveContainers(out, accept, 0);
}

/** Accept or Reject All (resolve_all). */
export function resolveAll(S, accept) {
  const d = S.d;
  for (const st of allStories(d)) {
    for (const path of d.paraPaths(st).reverse()) {
      const p = d.para(st, path);
      if (!p) continue;
      resolveParaRange(S, st, path, 0, p.text.length, true, true, accept);
    }
  }
  // Tables, rows, cells and sections.
  for (const st of allStories(d)) {
    const list = d.story(st);
    if (!list) continue;
    const blocks = list.toArray();
    const next = resolveContainers(blocks, accept, 0);
    if (next !== blocks) next.forEach((b, i) => { if (b !== blocks[i]) d.setBlock(st, [i], b); });
  }
  if (d.c.lastSection?.fmtChange) d.setField('lastSection', resolveSection(d.c.lastSection, accept));
  for (const key of ['footnoteSeparators', 'endnoteSeparators']) {
    const sep = d.c[key];
    if (!sep || typeof sep !== 'object') continue;
    let changed = false;
    const next = {...sep};
    for (const slot of ['separator', 'continuationSeparator', 'continuationNotice']) {
      if (!Array.isArray(sep[slot])) continue;
      next[slot] = resolveLooseBlocks(sep[slot], accept);
      changed = true;
    }
    if (changed) d.setField(key, next);
  }
  d.setField('revisions', []);
}

/** The span of the tracked change around `off`: its run, joined across comment anchors (revision_span). */
function revisionSpan(p, off) {
  const runs = P.runRanges(p);
  const i = runs.findIndex(([s, e, c]) => s <= off && off <= e && (has(c.ins) || has(c.del) || !!c.fmtChange));
  if (i < 0) return null;
  let [start, end] = runs[i];
  const key = c => `${c.ins ?? ''}|${c.del ?? ''}`;
  const k0 = key(runs[i][2]);
  if (k0 === '|') return [start, end];
  const isAnchor = k => { const o = P.objectAt(p, runs[k][0]); return o?.type === 'commentStart' || o?.type === 'commentEnd'; };
  const same = k => key(runs[k][2]) === k0;
  let k = i;
  while (k > 0) {
    if (same(k - 1)) k -= 1;
    else if (isAnchor(k - 1) && k > 1 && same(k - 2)) k -= 2;
    else break;
    start = runs[k][0];
  }
  k = i;
  while (k + 1 < runs.length) {
    if (same(k + 1)) k += 1;
    else if (isAnchor(k + 1) && k + 2 < runs.length && same(k + 2)) k += 2;
    else break;
    end = runs[k][1];
  }
  return [start, end];
}

/** Move names with an end in a..b (moves.rs names_in). */
function moveNamesIn(S, a, b, caretMark) {
  const d = S.d;
  const out = new Set();
  const add = r => { const n = d.moveName(r); if (n !== null) out.add(n); };
  for (const path of d.pathsBetween(a, b)) {
    const p = d.para(a.story, path);
    if (!p) continue;
    const from = samePath(path, a.path) ? a.off : 0, to = samePath(path, b.path) ? b.off : p.text.length;
    for (const [s, e, c] of P.runRanges(p)) {
      if ((e > from && s < to) || (from === to && s <= from && from <= e)) { add(c.ins); add(c.del); }
    }
    if (!samePath(path, b.path) || (caretMark && samePath(caretMark, path))) { add(p.mark?.ins); add(p.mark?.del); }
  }
  return out;
}

/** Accept or reject every end of the moves named (moves.rs resolve). */
function resolveMoves(S, names, accept) {
  if (!names.size) return;
  const d = S.d;
  const named = r => { const n = d.moveName(r); return n !== null && names.has(n); };
  for (const st of allStories(d)) {
    for (const path of d.paraPaths(st).reverse()) {
      const p = d.para(st, path);
      if (!p) continue;
      const ranges = P.runRanges(p).map(([s, e, c]) => [s, e, named(c.ins), named(c.del)]).filter(([, , i, x]) => i || x);
      const mi = named(p.mark?.ins), md = named(p.mark?.del);
      if (!ranges.length && !mi && !md) continue;
      for (let k = ranges.length - 1; k >= 0; k--) {
        const [a, b, ins, del] = ranges[k];
        if ((del && accept) || (ins && !accept)) d._pDelete(st, path, a, b);
        else { const pm = d.paraMut(st, path); P.formatRange(pm, a, b, c => { if (ins) delete c.ins; if (del) delete c.del; }); }
      }
      if (!mi && !md) continue;
      if (((md && accept) || (mi && !accept)) && joinNextPara(S, st, path)) continue;
      const pm = d.paraMut(st, path);
      const m = {...(pm.mark ?? {})};
      if (mi) delete m.ins;
      if (md) delete m.del;
      if (Object.keys(m).length) pm.mark = m; else delete pm.mark;
    }
  }
}

/** Accept or Reject at the selection; with `next`, the next change is selected afterwards (resolve_sel). */
export function resolveSelection(S, accept, next) {
  let [a, b] = ordered(S.sel);
  const d = S.d;
  let caretMark = null, caretProps = null;
  const ranged = !samePos(a, b);
  if (!ranged) {
    const p = d.paraAt(a);
    const found = p ? revisionSpan(p, a.off) : null;
    const paraFmt = !!p && !!(p.props?.fmtChange || p.props?.numChange);
    const markFmt = !!p && a.off === p.text.length && !!p.mark?.fmtChange;
    if (found) { b = {...a, path: [...a.path], off: found[1]}; a = {...a, path: [...a.path], off: found[0]}; }
    else if (markFmt || (markChange(S, a.story, a.path) && samePos(markChange(S, a.story, a.path).a, a))) caretMark = [...a.path];
    else if (paraFmt) caretProps = [...a.path];
    else {
      if (resolveCell(S, a.story, a.path, accept)) { if (next) selectNextUnresolved(S); return true; }
      navChange(S, 1);
      return false;
    }
  }
  const moves = moveNamesIn(S, a, b, caretMark);
  for (const path of d.pathsBetween(a, b).reverse()) {
    const len = d.para(a.story, path)?.text.length ?? 0;
    const from = samePath(path, a.path) ? a.off : 0;
    const to = samePath(path, b.path) ? b.off : len;
    const mark = !samePath(path, b.path) || (caretMark && samePath(caretMark, path));
    const props = (ranged && (!samePath(path, b.path) || to > from)) || (caretProps && samePath(caretProps, path));
    resolveParaRange(S, a.story, path, from, to, !!mark, !!props, accept);
    if (ranged) resolveCell(S, a.story, path, accept);
  }
  resolveMoves(S, moves, accept);
  S.sel = caret(d.clamp(a));
  if (next) selectNextUnresolved(S);
  return true;
}

/** Next (dir > 0) or Previous Change: selects it (nav_change). */
export function navChange(S, dir) {
  const list = changes(S);
  const [c0, c1] = ordered(S.sel);
  let t;
  if (dir > 0) t = list.find(c => cmpPos(c.a, c1) >= 0 && (cmpPos(c.a, c0) > 0 || cmpPos(c.b, c1) > 0)) ?? list[0];
  else t = [...list].reverse().find(c => cmpPos(c.b, c0) <= 0 && (cmpPos(c.b, c1) < 0 || cmpPos(c.a, c0) < 0)) ?? list[list.length - 1];
  if (t) S.sel = {anchor: t.a, focus: t.b};
  return t ?? null;
}

/** After a change at the caret is resolved: select the first change from the caret on, else the first (select_next_unresolved). */
export function selectNextUnresolved(S) {
  const list = changes(S);
  const at = ordered(S.sel)[0];
  const c = list.find(x => cmpPos(x.a, at) >= 0) ?? list[0];
  if (c) S.sel = {anchor: c.a, focus: c.b};
}

/** The tracked change at `p` (for the right-click menu): its kind or null. */
export function changeAt(d, p) {
  const para = d.paraAt(p);
  if (!para) return null;
  for (const [s, e, c] of P.runRanges(para)) {
    if (s <= p.off && p.off < e || (s < p.off && p.off === e)) {
      const k = runKind(d, c.ins, c.del);
      if (k) return k;
      if (c.fmtChange) return 'format';
    }
  }
  return null;
}
