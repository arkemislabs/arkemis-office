// The Comments panel's model: threads (replies, statuses and check marks under the comment they
// belong to), search, the filter (type, author, status, colour, check mark), sorting and the
// header counts.
//
// Translated from printcraft crates/ui-egui/src/panels/comments_panel.rs (subtype_label,
// kind_label, subtype_icon, initials, color_key, check_label, is_marked, count, reply_count,
// matches, the thread building and filtering of `show`, SortBy order and group headings) and
// crates/render (Annotation::is_comment/is_reply/is_mark, thread_tops) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {summaries} from '../model/annots.mjs';
import {foldCase} from '../model/text.mjs';
import {pageLabel} from '../model/index.mjs';

export const SORTS = Object.freeze(['Page', 'Author', 'Date', 'Type', 'Color']);
export const STATUSES = Object.freeze(['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']);

/** comments_panel.rs `subtype_label`. */
export function subtypeLabel(s) {
  return {Text: 'Note', FreeText: 'Text box', StrikeOut: 'Strikethrough', Square: 'Rectangle', Circle: 'Oval', Ink: 'Drawing', PolyLine: 'Polyline',
    FileAttachment: 'Attachment', Caret: 'Insert text'}[s] ?? s;
}
/** comments_panel.rs `kind_label`. */
export function kindLabel(a) {
  return {StrikeOutTextEdit: 'Replace text', FreeTextCallout: 'Callout', PolygonCloud: 'Cloud', FreeTextTypeWriter: 'Typewriter'}[a.intent] ?? subtypeLabel(a.subtype);
}
/** comments_panel.rs `subtype_icon` (glyph names in the Arkemis icon set). */
export function subtypeIcon(s) {
  return {Text: 'message-square-text', Highlight: 'highlighter', Underline: 'underline', StrikeOut: 'strikethrough', Squiggly: 'spline', FreeText: 'type',
    Ink: 'pencil', Square: 'square', Circle: 'circle', Line: 'move-right', Polygon: 'pen-tool', PolyLine: 'pen-tool', Stamp: 'stamp',
    FileAttachment: 'paperclip', Caret: 'text-select', Redact: 'rectangle-horizontal'}[s] ?? 'message-square-text';
}
/** comments_panel.rs `initials`. */
export function initials(name) {
  const s = String(name ?? '').split(/\s+/).filter(Boolean).map(w => Array.from(w)[0]).slice(0, 2).join('');
  return s ? s.toUpperCase() : '?';
}
/** comments_panel.rs `color_key`: RRGGBB, '' for none. */
export const colorKey = a => (Array.isArray(a.color) ? a.color.map(c => Math.trunc(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase() : '');
const isMark = a => a.state === 'Marked' || a.state === 'Unmarked';
/** comments_panel.rs `is_marked`: the latest check-mark reply says Marked. */
export const isMarked = thread => [...thread].reverse().find(isMark)?.state === 'Marked';
const checkLabel = marked => (marked ? 'Checked' : 'Unchecked');
/** render Annotation::is_comment: a listed comment (not a reply, status, pop-up). */
export const isComment = a => !a.inReplyTo && a.subtype !== 'Popup' && !(a.state && a.inReplyTo);

function anyContains(fields, q) {
  const f = foldCase(q);
  return fields.some(s => s != null && foldCase(String(s)).includes(f));
}
const matches = (a, q) => anyContains([a.author, a.contents, kindLabel(a)], q);

/**
 * Every listed comment with its thread: {roots: [{comment, replies, status, marked}], count,
 * replyCount, authors, types, colors} after `search`, `filter` ({types, authors, statuses,
 * colors, checks}: values to hide) and `sort`.
 */
export function commentThreads(content, {search = '', filter = {}, sort = 'Page'} = {}) {
  const all = summaries(content);
  const byId = new Map(all.map(a => [a.id, a]));
  // thread_tops: the root a reply at any depth starts from.
  const topOf = a => { let cur = a, guard = 0; while (cur.inReplyTo && byId.has(cur.inReplyTo) && guard++ < 64) cur = byId.get(cur.inReplyTo); return cur; };
  const replies = new Map();
  for (const a of all) {
    if (!a.inReplyTo) continue;
    const key = a.state ? a.inReplyTo : topOf(a).id;
    if (!replies.has(key)) replies.set(key, []);
    replies.get(key).push(a);
  }
  const repliesOf = a => replies.get(a.id) ?? [];
  const statusOf = a => [...repliesOf(a)].reverse().filter(r => !isMark(r)).find(r => r.state)?.state ?? 'None';
  const hide = k => new Set(filter[k] ?? []);
  const [ht, ha, hs, hc, hk] = ['types', 'authors', 'statuses', 'colors', 'checks'].map(hide);
  const q = String(search ?? '').trim();
  const top = all.filter(a => !a.inReplyTo && a.subtype !== 'Popup');
  let roots = top
    .filter(a => !q || matches(a, q) || repliesOf(a).some(r => matches(r, q)))
    .filter(a => !ht.has(kindLabel(a)))
    .filter(a => !ha.has(a.author ?? ''))
    .filter(a => !hs.has(statusOf(a)))
    .filter(a => !hc.has(colorKey(a)))
    .filter(a => !hk.has(checkLabel(isMarked(repliesOf(a)))));
  const key = {
    Author: a => (a.author ?? '').toLowerCase(), Type: a => kindLabel(a), Color: a => colorKey(a),
  }[sort];
  if (key) roots = roots.map((a, i) => [a, i]).sort((x, y) => (key(x[0]) < key(y[0]) ? -1 : key(x[0]) > key(y[0]) ? 1 : x[1] - y[1])).map(x => x[0]);
  else if (sort === 'Date') roots = roots.map((a, i) => [a, i]).sort((x, y) => ((y[0].modified ?? '') < (x[0].modified ?? '') ? -1 : (y[0].modified ?? '') > (x[0].modified ?? '') ? 1 : x[1] - y[1])).map(x => x[0]);
  const heading = a => (sort === 'Page' ? `Page ${pageLabel(content, a.page)}` : sort === 'Author' ? (a.author || 'Unknown author')
    : sort === 'Type' ? kindLabel(a) : sort === 'Color' ? (a.color ? `#${colorKey(a)}` : 'No colour') : null);
  return {
    roots: roots.map(a => {
      const rs = repliesOf(a);
      return {comment: a, kind: kindLabel(a), icon: subtypeIcon(a.subtype), heading: heading(a),
        replies: rs.filter(r => !r.state && !r.grouped), grouped: rs.filter(r => r.grouped), status: statusOf(a), marked: isMarked(rs),
        history: rs.filter(r => r.state && !isMark(r)).map(r => ({state: r.state, author: r.author, modified: r.modified}))};
    }),
    count: top.length,
    replyCount: all.filter(a => a.inReplyTo && !a.state && !a.grouped).length,
    authors: [...new Set(top.map(a => a.author ?? ''))].sort(),
    types: [...new Set(top.map(kindLabel))].sort(),
    colors: [...new Set(top.map(colorKey))].sort(),
  };
}
