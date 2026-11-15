// Shared helpers for the caret, text, edit and paste tests (U:quill/text and friends): upstream's
// typing test harness (wordcraft crates/engine/src/tests/typing.rs `s`, `run`, `typ`, `paras`,
// `para`, `typed`) over a kernel test session with the generated Quill registry.

import {createTestSession} from '../../core/kernel/testing.mjs';
import {createContent} from '../../core/quill/model/content.mjs';
import {Document} from '../../core/quill/model/document.mjs';
import {levelOf} from '../../core/quill/model/numbering.mjs';
import {addressOf, positionOf} from '../../core/quill/address.mjs';
import {resetLayouts} from '../../core/quill/lib/caret-session.mjs';

const generated = await import('../../core/generated/quill.commands.mjs');
const apps = await import('../../core/generated/apps.mjs');

export const BACKSPACE = String.fromCharCode(8);

/** A session over `content` (default: an empty document); prefs as File › Options would set them. */
export async function s(content = createContent(), opts = {}) {
  resetLayouts();
  return createTestSession('quill', {modules: generated.modules, foundation: apps.apps.quill, content, ...opts});
}

/** Run a command and report its id on failure (upstream `run`). */
export async function run(t, id, params = {}, origin = 'test') {
  try {
    return (await t.session.execute(t.docId, id, params, {origin})).result;
  } catch (e) {
    e.message = `${id}: ${e.message}`;
    throw e;
  }
}

/** Type like a person: \n Enter, \t Tab, BACKSPACE Backspace, else one character at a time. */
export async function typ(t, keys) {
  for (const c of keys) {
    if (c === '\n') await run(t, 'text.newParagraph');
    else if (c === '\t') await run(t, 'text.tab');
    else if (c === BACKSPACE) await run(t, 'text.backspace');
    else await run(t, 'text.insert', {text: c});
  }
}

export async function typed(keys, opts = {}) {
  const t = await s(opts.content, opts);
  await typ(t, keys);
  return t;
}

export const doc = t => new Document(t.content);
export const blocks = t => t.content.body.chunks.flat();
export const bodyParas = t => blocks(t).filter(b => b.kind === 'para');
/** The body as plain text, paragraphs separated by \n (Document::plain_text). */
export const plain = t => doc(t).plainText('body');
/** Body paragraphs as [text, list level or null, in List Paragraph] (upstream `paras`). */
export const paras = t => bodyParas(t).map(p => [p.text, p.props?.numbering && p.props.numbering.num !== 0 ? p.props.numbering.level : null,
  p.props?.style === 'ListParagraph']);
/** Expected paragraph (upstream `para`). */
export const para = (text, level = null) => [text, level, level !== null];
/** Body texts lowercased (upstream typing.rs `texts`). */
export const texts = t => paras(t).map(p => p[0].toLowerCase());
/** The list label text of body paragraph i (upstream `label_at`). */
export function labelAt(t, i) {
  const n = bodyParas(t)[i]?.props?.numbering;
  return levelOf(t.content.numbering, n.num, n.level)?.text ?? '';
}
/** The primary selection as model positions. */
export function sel(t) {
  const r = t.doc.selection.ranges[t.doc.selection.primary];
  return {anchor: positionOf(t.content, r.anchor), focus: positionOf(t.content, r.focus)};
}
/** A body position {story, path, off} (Pos::body). */
export const pos = (block, off) => ({story: 'body', path: [block], off});
/** Address of a position in the current content. */
export const addr = (t, p) => addressOf(t.content, p);
/** Put the caret (or a range) at positions. */
export async function setSel(t, anchor, focus = anchor) {
  await run(t, 'select.range', {anchor: addr(t, anchor), focus: addr(t, focus)});
}
export const undoDepth = t => t.doc.undo.size;
export async function undo(t) { await run(t, 'edit.undo'); }
export async function redo(t) { await run(t, 'edit.redo'); }
/** Character props at offset `off` of body paragraph i. */
export async function charAt(t, i, off) {
  const P = await import('../../core/quill/model/para.mjs');
  return P.propsOfChar(bodyParas(t)[i], off) ?? {};
}
