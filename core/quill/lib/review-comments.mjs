// Comments (U:quill/review): where they are anchored, the comment at the caret, reply threads,
// removing anchors from every story, the list in reading order and Next/Previous Comment.
//
// Translated from wordcraft crates/engine/src/cmd/review/comments.rs (`new_comment`,
// `validate_comment_id`, `reply`, `comment_id`, `comments_change`, `edit_comment`,
// `comment_range_at_caret`, `comment_at_caret`, `remove_anchors`, `thread_of`, `delete_comment`,
// `comment_list`, `list_comments`, `nav_comment`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A comment is `content.comments[id] = {author, initials, date, parent, resolved, part}`; its text
// is the comment part `part`; its range is the commentStart … commentEnd objects in a story.

import * as P from '../model/para.mjs';
import {BODY, cmpPath} from '../model/document.mjs';

const OBJ = P.OBJ;

/** Comments can't be written or edited in a document protected as read only or for forms (comments_change). */
export function commentsLocked(d) {
  const m = d.c.settings?.protection;
  return m === 'readOnly' || m === 'forms' ? 'the document is protected' : null;
}

/** An id no comment has: one past the largest, or the lowest free one (comment_id). */
export function freeCommentId(d) {
  const ids = Object.keys(d.c.comments ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const last = ids.length ? ids[ids.length - 1] : -1;
  if (last < 0xffff_ffff) return last + 1;
  const set = new Set(ids);
  for (let i = 0; i < 0xffff_ffff; i++) if (!set.has(i)) return i;
  return null;
}

/** The user's initials (Session::user_initials): the first letter of each word of the name. */
export function initialsOf(name) {
  const w = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return w.map(x => [...x][0].toUpperCase()).join('').slice(0, 9) || 'A';
}

/** Ids of the comments whose range is open at `f` in its paragraph, innermost last (comment_range_at_caret). */
function openAt(d, f) {
  const p = d.paraAt(f);
  if (!p) return [];
  const open = [];
  for (const [off, o] of P.objectsWithOffsets(p)) {
    if (off > f.off) break;
    if (o.type === 'commentStart') open.push(o.id);
    else if (o.type === 'commentEnd') { const i = open.lastIndexOf(o.id); if (i >= 0) open.splice(i, 1); }
  }
  return open;
}

/** The innermost comment whose range holds the caret (comment_range_at_caret). */
export function commentRangeAtCaret(d, f) {
  const open = openAt(d, f);
  return open.length ? open[open.length - 1] : null;
}

/** The comment anchored around the caret, else the first one in its paragraph (comment_at_caret). */
export function commentAtCaret(d, f) {
  const r = commentRangeAtCaret(d, f);
  if (r !== null) return r;
  const p = d.paraAt(f);
  if (!p) return null;
  for (const [, o] of P.objectsWithOffsets(p)) if (o.type === 'commentStart' || o.type === 'commentEnd') return o.id;
  return null;
}

/** Remove the comments' anchors from every story (remove_anchors). */
export function removeAnchors(d, ids) {
  const stories = [BODY, ...Object.keys(d.c.parts ?? {}).map(Number)];
  for (const story of stories) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      const offs = P.objectsWithOffsets(p).filter(([, o]) => (o.type === 'commentStart' || o.type === 'commentEnd') && ids.has(o.id)).map(([off]) => off);
      for (let k = offs.length - 1; k >= 0; k--) d._pDelete(story, path, offs[k], offs[k] + 1);
    }
  }
}

/** The comment and every reply below it, replies to replies included; a parent cycle ends the walk (thread_of). */
export function threadOf(d, id) {
  const children = new Map();
  for (const [k, c] of Object.entries(d.c.comments ?? {})) {
    if (c.parent === null || c.parent === undefined) continue;
    if (!children.has(c.parent)) children.set(c.parent, []);
    children.get(c.parent).push(Number(k));
  }
  const seen = new Set([id]);
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const k of children.get(ids[i]) ?? []) if (!seen.has(k)) { seen.add(k); ids.push(k); }
  return ids;
}

/** Comments in reading order with their anchors, in every story the reader sees (comment_list): [[id, pos|null]]. */
export function commentList(d) {
  const found = [];
  const comments = d.c.comments ?? {};
  if (!Object.keys(comments).length) return found;
  for (const story of d.shownStories()) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      for (const [off, o] of P.objectsWithOffsets(p)) if (o.type === 'commentStart') found.push([o.id, {story, path, off}]);
    }
  }
  const seen = new Set(found.map(([id]) => id));
  for (const k of Object.keys(comments).map(Number).sort((a, b) => a - b)) if (!seen.has(k)) found.push([k, null]);
  return found;
}

/** A part's plain text, paragraphs on new lines, objects left out. */
export function partText(d, part) {
  const blocks = d.c.parts?.[part]?.blocks ?? [];
  return blocks.filter(b => b.kind === 'para').map(b => b.text.split(OBJ).join('')).join('\n');
}

/** The Show Comments list (list_comments); `addr(pos)` names an anchor. */
export function listComments(d, addr) {
  return commentList(d).map(([id, at]) => {
    const c = d.c.comments?.[id];
    if (!c) return null;
    return {id, author: c.author ?? '', initials: c.initials ?? '', date: c.date ?? '', resolved: !!c.resolved, parent: c.parent ?? null,
      text: partText(d, c.part), anchor: at ? addr(at) : null};
  }).filter(Boolean);
}

/** Next (dir > 0) or Previous Comment: the caret goes to its anchor (nav_comment). */
export function navComment(d, focus, dir) {
  const list = commentList(d).map(([, p]) => p).filter(Boolean);
  const rank = new Map(d.shownStories().map((s, i) => [s, i]));
  const key = p => (rank.has(p.story) ? [rank.get(p.story), p.path, p.off] : null);
  const cmp = (x, y) => (x[0] - y[0]) || cmpPath(x[1], y[1]) || (x[2] - y[2]);
  const caret = key(focus);
  let t;
  if (dir > 0) t = list.find(p => caret && cmp(key(p), caret) > 0) ?? list[0];
  else t = [...list].reverse().find(p => caret && cmp(key(p), caret) < 0) ?? list[list.length - 1];
  return t ?? null;
}

/** Where a comment is anchored: [start, end] positions (start after the start marker), or null. */
export function commentRange(d, id) {
  let start = null;
  for (const story of [BODY, ...Object.keys(d.c.parts ?? {}).map(Number)]) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      for (const [off, o] of P.objectsWithOffsets(p)) {
        if (o.id !== id) continue;
        if (o.type === 'commentStart') start = {story, path, off};
        else if (o.type === 'commentEnd' && start) return [start, {story, path, off: off + 1}];
      }
    }
  }
  return start ? [start, start] : null;
}
