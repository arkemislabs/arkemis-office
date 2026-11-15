// Threaded comments in an Excel workbook: `xl/threadedComments/threadedCommentN.xml` (a thread's
// comment, then its replies by `parentId`), `xl/persons/person.xml` (who wrote them) and the legacy
// note each thread carries, authored `tc=<thread id>`, for readers without threaded comments.
// Translated from gridcraft crates/xlsx/src/sheet_write/parts.rs (`thread_ids`, `threaded_xml`) and
// sheet_read/parts.rs (the threaded comment reader) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:grid/formats-xlsx. No DOM, no Node built-ins.

import {parseCell} from './addr.mjs';

const NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const NS_X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escAttr = s => esc(s).replaceAll('"', '&quot;');

let counter = 0;
const guid = () => { counter += 1; return `{${(0x10000000 + counter).toString(16).toUpperCase().padStart(8, '0')}-0000-4000-8000-${Date.now().toString(16).toUpperCase().padStart(12, '0').slice(-12)}}`; };

/** The text a reader without threaded comments shows (Excel's own placeholder with the thread under it). */
export function placeholderNote(c) {
  let s = '[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\n';
  s += `Comment:\n    ${String(c.text ?? '').replaceAll('\n', '\n    ')}`;
  for (const [, text] of c.replies ?? []) s += `\nReply:\n    ${String(text ?? '').replaceAll('\n', '\n    ')}`;
  return s;
}

/** The thread part for `[ref, comment][]`; `persons` (name to id) collects the authors. Returns {xml, ids: ref to the thread's id}. */
export function threadedXml(threads, persons) {
  const personId = name => { const n = String(name || 'Unknown'); if (!persons.has(n)) persons.set(n, guid()); return persons.get(n); };
  const ids = new Map();
  const when = new Date().toISOString().slice(0, 19) + '.00';
  let s = `${XML_DECL}<ThreadedComments xmlns="${NS}" xmlns:x="${NS_X}">`;
  const sorted = [...threads].filter(([ref]) => parseCell(ref)).sort(([a], [b]) => { const x = parseCell(a), y = parseCell(b); return x.row - y.row || x.col - y.col; });
  for (const [ref, c] of sorted) {
    const id = guid();
    ids.set(ref, id);
    s += `<threadedComment ref="${escAttr(ref)}" dT="${when}" personId="${personId(c.author)}" id="${id}"${c.resolved ? ' done="1"' : ''}><text>${esc(c.text ?? '')}</text></threadedComment>`;
    for (const [author, text] of c.replies ?? []) s += `<threadedComment ref="${escAttr(ref)}" dT="${when}" personId="${personId(author)}" id="${guid()}" parentId="${id}"><text>${esc(text ?? '')}</text></threadedComment>`;
  }
  return {xml: `${s}</ThreadedComments>`, ids};
}

export function personsXml(persons) {
  let s = `${XML_DECL}<personList xmlns="${NS}" xmlns:x="${NS_X}">`;
  for (const [name, id] of persons) s += `<person displayName="${escAttr(name)}" id="${id}" userId="${escAttr(name)}" providerId="None"/>`;
  return `${s}</personList>`;
}

/** Person id to display name from a persons part. */
export function readPersons(x) {
  const out = new Map();
  for (const p of x?.kids('person') ?? []) if (p.attr('id')) out.set(p.attr('id'), p.attr('displayName') ?? p.attr('userId') ?? '');
  return out;
}

/** Reads a thread part into `sheet.comments`: {author, text, replies: [[author, text]], threaded: true, resolved, visible}. */
export function readThreaded(x, persons, sheet) {
  const byId = new Map();
  const comments = sheet.comments ?? {};
  for (const t of x.kids('threadedComment')) {
    const ref = String(t.attr('ref') ?? '').replace(/\$/g, '');
    const cell = parseCell(ref);
    if (!cell) continue;
    const text = t.child('text')?.text ?? '';
    const author = persons.get(t.attr('personId')) ?? '';
    const parent = t.attr('parentId');
    if (parent && byId.has(parent)) { byId.get(parent).replies.push([author, text]); continue; }
    const c = {author, text, replies: [], threaded: true, resolved: t.flag('done', false), visible: false};
    byId.set(t.attr('id'), c);
    comments[ref] = c;
  }
  if (Object.keys(comments).length) sheet.comments = comments;
}
