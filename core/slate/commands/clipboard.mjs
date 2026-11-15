// Home > Clipboard: Cut, Copy, Paste (with its modes) and Format Painter (U:slate/clipboard).
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `clipboard.*`; behaviour is
// OneNote's:
//   * Copy puts the selected text (or object) on the system clipboard as text and HTML, and keeps the
//     page slice itself in the session (the Office Clipboard ring), so pasting it back in the same
//     app keeps the structure, tags, lists and pictures; Cut also removes it;
//   * Paste replaces the selection (or goes at the caret). `mode`: default and keep-source keep the
//     formatting of what was copied (our own slice whole; another app's HTML with its emphasis,
//     links, colour and pictures), merge keeps its bold, italic, underline and strikethrough and takes
//     the rest from where it lands, text-only takes the text alone. With no caret on the page the text
//     becomes a new note container; copied pictures from the system clipboard are not offered (the
//     system clipboard here carries text and HTML only, docs/spec/patches/slate/home.json);
//   * Format Painter picks up the formatting (character marks and the paragraph's style and
//     alignment) of the selection; the next selection it is applied to takes it, and it is off again.
// The clipboard is the Host's (the bridge never touches the real one in tests).

import {Fragment, Slice} from '@tiptap/pm/model';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {insertContainer} from '../model/canvas.mjs';
import {posToPoint} from '../model/page.mjs';
import {charRange, editPage, newBlockId, needRange, textRange, textState, textblocksIn} from '../lib/format-text.mjs';
import {fragmentHtml, parseHtml, parseText} from '../lib/clipboard-html.mjs';
import {readClipboard, writeClipboard} from '../../common/lib/clipboard.mjs';
import {sheetText} from '../lib/sheet-text.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/clipboard.*']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
export const KIND = 'slate.slice';
export const PASTE_MODES = Object.freeze(['default', 'keep-source', 'merge', 'text-only']);
const FORMAT_MARKS = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript', 'highlight', 'textStyle', 'language'];
const MAX_SLICE = 2_000_000;

const leafText = n => (n.type.name === 'equation' ? n.attrs.linear : n.type.name === 'image' ? n.attrs.alt ?? '' : n.type.name === 'attachment' ? n.attrs.name ?? '' : n.type.name === 'spreadsheet' ? sheetText(n.attrs) : n.type.name === 'diagram' ? n.attrs.text ?? '' : '');

/** What is selected, as a clipboard entry; null for a caret (nothing selected copies nothing). */
function selectedEntry(ctx) {
  const range = textRange(ctx);
  if (!range || range.from === range.to) return null;
  const slice = range.doc.slice(range.from, range.to);
  const json = slice.toJSON();
  need(JSON.stringify(json).length <= MAX_SLICE, 'too_large', 'The selection is too large to copy');
  return {range, entry: {text: range.doc.textBetween(range.from, range.to, '\n', leafText), html: fragmentHtml(slice.content), kind: KIND, data: {slice: json}}};
}

async function copy(ctx) {
  const sel = selectedEntry(ctx);
  if (!sel) return {text: '', html: '', copied: false};
  await writeClipboard(ctx, sel.entry);
  return {text: sel.entry.text, html: sel.entry.html, copied: true};
}

// ---------------------------------------------------------------------------------------------
// Paste

const para = (ctx, p) => {
  const kids = [];
  for (const r of p.runs) {
    if (r.image) { kids.push(schema.nodes.image.create({id: newBlockId(ctx, 'image'), src: r.image.src, alt: r.image.alt ?? ''})); continue; }
    const parts = r.text.split('\n');
    parts.forEach((t, i) => {
      if (i > 0) kids.push(schema.nodes.hardBreak.create());
      if (t) kids.push(schema.text(t, (r.marks ?? []).filter(m => schema.marks[m.type]).map(m => schema.marks[m.type].create(m.attrs ?? undefined))));
    });
  }
  return schema.nodes.paragraph.create({id: newBlockId(ctx), style: p.style && /^(normal|h[1-6]|code|quote|citation)$/.test(p.style) ? p.style : 'normal'}, Fragment.from(kids));
};

/** Paragraphs of runs -> an open slice (the first and last paragraph join the text around them). */
const sliceOf = (ctx, paras) => new Slice(Fragment.from(paras.map(p => para(ctx, p))), paras.length ? 1 : 0, paras.length ? 1 : 0);

const plainOf = paras => paras.map(p => p.runs.map(r => (r.image ? '' : r.text)).join('')).join('\n');

/** What a paste reads: our own slice, another app's HTML, or text. */
async function source(ctx, p) {
  if (typeof p.text === 'string') return {source: 'external', text: p.text, html: typeof p.html === 'string' ? p.html : ''};
  const r = await readClipboard(ctx);
  if (r.source === 'internal' && r.kind === KIND && r.data?.slice) return r;
  return r.source === 'internal' ? {source: 'external', text: r.text, html: r.html} : r;
}

function pasteInto(ctx, src, mode) {
  const range = textRange(ctx);
  const text = String(src.text ?? '');
  const paras = mode === 'text-only' || !src.html
    ? parseText(text)
    : (() => { const x = parseHtml(src.html, {keep: mode === 'merge' ? 'emphasis' : 'all'}); return x.length ? x : parseText(text); })();
  const plain = src.source === 'internal' ? text : plainOf(paras);
  need(plain || paras.some(q => q.runs.some(r => r.image)), 'disabled', 'The clipboard is empty');
  if (!range) {
    // No caret on the page: the paste becomes a note container (OneNote puts it where the page was clicked).
    const loc = currentLocation(ctx.doc, ctx.selection);
    need(loc.pageId, 'disabled', 'No page is open');
    const made = insertContainer(ctx, loc.pageId, {x: 60, y: 140, width: null, text: ''});
    pasteAtContainer(ctx, loc.pageId, made.container, paras);
    return {container: made.container, pasted: 'text', chars: plain.length};
  }
  let slice;
  let kind;
  if (src.source === 'internal' && mode !== 'text-only' && mode !== 'merge') { slice = Slice.fromJSON(schema, src.data.slice); kind = 'slice'; }
  else { slice = sliceOf(ctx, paras); kind = mode === 'text-only' ? 'text' : src.html ? 'html' : 'text'; }
  let done = false;
  editPage(ctx, range.pageId, tr => {
    try { tr.replaceRange(range.from, range.to, slice); done = true; }
    catch { /* a slice that does not fit here: its text instead */ }
    if (!done && slice.size) { tr.replaceRange(range.from, range.to, sliceOf(ctx, parseText(plain))); done = true; kind = 'text'; }
  }, range.doc);
  return {pasted: kind, chars: plain.length};
}

function pasteAtContainer(ctx, pageId, containerId, paras) {
  // The new container holds one empty paragraph: replace it with the pasted paragraphs.
  const node = nodeOf(ctx.doc.pages[pageId].body);
  let pos = null, size = 0;
  node.descendants((n, p) => { if (n.type.name === 'container' && n.attrs.id === containerId) { pos = p; size = n.nodeSize; return false; } return true; });
  need(pos !== null, 'failed', 'The pasted note could not be placed');
  const blocks = paras.length ? paras.map(p => para(ctx, p)) : [schema.nodes.paragraph.create({id: newBlockId(ctx)})];
  editPage(ctx, pageId, tr => tr.replaceWith(pos + 1, pos + size - 1, Fragment.from(blocks)), node);
}

// ---------------------------------------------------------------------------------------------
// Type Text (text entry for automation and tests)

/** Put the caret at position `pos` (inside a paragraph) of the page. */
function caretAt(ctx, pageId, doc, pos) {
  const pt = posToPoint(doc, pos);
  const at = `/pg:${encodeURIComponent(pageId)}/b:${encodeURIComponent(pt.blockId)}/t:${pt.offset}`;
  ctx.setSelection({ranges: [{anchor: at, focus: at}], primary: 0});
}

/** The caret right after the end of paragraph `id` on the page. */
function caretAfter(ctx, pageId, id) {
  const doc = nodeOf(ctx.doc.pages[pageId].body);
  let end = null;
  doc.descendants((n, pos) => { if (end === null && n.attrs?.id === id && n.isTextblock) { end = pos + 1 + n.content.size; return false; } return end === null; });
  if (end !== null) caretAt(ctx, pageId, doc, end);
}

/**
 * Write text on the page: over the selection or at the caret; with no caret, after the last paragraph of the page's
 * last note container (a new container when the page has none), so repeated writes read down the page instead of
 * stacking on one spot. Lines become paragraphs; `html` keeps emphasis, lists and links. The caret ends after the text.
 */
function typeText(ctx, p) {
  const fromHtml = typeof p.html === 'string' && p.html ? parseHtml(p.html, {keep: 'all'}) : [];
  const paras = fromHtml.length ? fromHtml : parseText(String(p.text ?? ''));
  const plain = plainOf(paras);
  need(plain || paras.some(q => q.runs.some(r => r.image)), 'invalid_params', 'Give the text to write', {path: '/text'});
  const range = textRange(ctx);
  if (range) {
    let end = null;
    editPage(ctx, range.pageId, tr => {
      try { tr.replaceRange(range.from, range.to, sliceOf(ctx, paras)); }
      catch { tr.replaceRange(range.from, range.to, sliceOf(ctx, parseText(plain))); }
      end = tr.mapping.map(range.to);
    }, range.doc);
    const doc = nodeOf(ctx.doc.pages[range.pageId].body);
    const $end = doc.resolve(Math.min(end, doc.content.size));
    if ($end.parent.isTextblock) caretAt(ctx, range.pageId, doc, $end.pos);
    return {page: range.pageId, chars: plain.length, at: 'selection'};
  }
  const loc = currentLocation(ctx.doc, ctx.selection);
  need(loc.pageId, 'disabled', 'No page is open');
  const page = nodeOf(ctx.doc.pages[loc.pageId].body);
  let last = null;
  page.forEach((n, offset) => { if (n.type.name === 'container') last = {pos: offset, node: n}; });
  let container;
  if (!last) {
    container = insertContainer(ctx, loc.pageId, {x: 60, y: 140, width: null, text: ''}).container;
    pasteAtContainer(ctx, loc.pageId, container, paras);
  } else {
    container = last.node.attrs.id;
    const empty = last.node.childCount === 1 && last.node.firstChild.isTextblock && last.node.firstChild.content.size === 0;
    const to = last.pos + last.node.nodeSize - 1;
    editPage(ctx, loc.pageId, tr => tr.replaceWith(empty ? last.pos + 1 : to, to, Fragment.from(paras.map(q => para(ctx, q)))), page);
  }
  // The caret goes after the last block the container now ends with.
  const now = nodeOf(ctx.doc.pages[loc.pageId].body);
  let tail = null;
  now.descendants(n => { if (n.type.name === 'container' && n.attrs.id === container) { tail = n.lastChild; return false; } return true; });
  if (tail?.attrs?.id) caretAfter(ctx, loc.pageId, tail.attrs.id);
  return {page: loc.pageId, container, chars: plain.length, at: last ? 'end' : 'new'};
}

// ---------------------------------------------------------------------------------------------
// Format Painter

function pickFormat(ctx) {
  const range = needRange(ctx);
  const r = charRange(range) ?? {from: range.from, to: range.from};
  const $p = range.doc.resolve(r.from);
  let marks = $p.marks();
  if (r.from !== r.to) { let first = null; range.doc.nodesBetween(r.from, r.to, n => { if (!first && n.isInline) first = n; return !first; }); if (first) marks = first.marks; }
  const block = textblocksIn(range.doc, r.from, r.to).find(b => b.node.type === schema.nodes.paragraph);
  return {
    marks: marks.filter(m => FORMAT_MARKS.includes(m.type.name)).map(m => ({type: m.type.name, attrs: {...m.attrs}})),
    style: block?.node.attrs.style ?? 'normal', align: block?.node.attrs.align ?? null, source: {page: range.pageId, from: range.from, to: range.to},
  };
}

function applyFormat(ctx, f) {
  const range = needRange(ctx);
  const r = charRange(range);
  need(r, 'disabled', 'Select the text to format');
  editPage(ctx, range.pageId, tr => {
    for (const name of FORMAT_MARKS) tr.removeMark(r.from, r.to, schema.marks[name]);
    for (const m of f.marks) tr.addMark(r.from, r.to, schema.marks[m.type].create(m.attrs));
    for (const b of textblocksIn(tr.doc, r.from, r.to)) {
      if (b.node.type !== schema.nodes.paragraph) continue;
      if (b.node.attrs.style !== f.style) tr.setNodeAttribute(b.pos, 'style', f.style);
      if (b.node.attrs.align !== f.align) tr.setNodeAttribute(b.pos, 'align', f.align);
    }
  }, range.doc);
  return {changed: r.to - r.from};
}

export default defineCommands({
  family: 'clipboard',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'clipboard.copy', label: 'Copy', shortcut: 'Mod+C', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'Copy the selected text or object to the clipboard (text and HTML for other programs, the page slice for pasting back here); a caret alone copies nothing. Returns {text, html, copied}.',
      params: s.object({}),
      state: textState,
      run: ctx => copy(ctx),
    },
    {
      id: 'clipboard.cut', label: 'Cut', shortcut: 'Mod+X', risk: 'edit', repeatable: false,
      description: 'Cut the selected text or object: copy it, then remove it from the page; a caret alone cuts nothing.',
      params: s.object({}),
      state: textState,
      async run(ctx) {
        const sel = selectedEntry(ctx);
        if (!sel) return {text: '', html: '', copied: false};
        await writeClipboard(ctx, sel.entry);
        editPage(ctx, sel.range.pageId, tr => tr.delete(sel.range.from, sel.range.to), sel.range.doc);
        return {text: sel.entry.text, html: sel.entry.html, copied: true};
      },
    },
    {
      id: 'clipboard.paste', label: 'Paste', shortcut: 'Mod+V', risk: 'edit',
      description: `Paste the clipboard at the caret or over the selection. mode: ${PASTE_MODES.join(' (formatting as copied), ')} (see Home > Clipboard); text and html give the content instead of reading the clipboard.`,
      params: s.object({mode: s.optional(s.enum(PASTE_MODES)), text: s.optional(s.string({max: 10_000_000})), html: s.optional(s.string({max: 5_000_000}))}),
      state: ctx => (isNotebook(ctx.doc) ? (currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'}) : {enabled: false, reason: 'No notebook is open'}),
      async run(ctx, p) {
        const mode = p.mode ?? 'default';
        const src = await source(ctx, p);
        return {mode, ...pasteInto(ctx, src, mode)};
      },
    },
    {
      id: 'text.insert', label: 'Type Text', risk: 'edit', repeatable: false,
      description: 'Write text on the page: over the selection or at the caret, or (with no caret) after the last paragraph of the last note container on the page, a new container when there is none. Each line is a paragraph; html (optional) keeps emphasis, lists and links. Never touches the clipboard; the caret ends after the text.',
      params: s.object({text: s.string({max: 1_000_000}), html: s.optional(s.string({max: 5_000_000}))}),
      state: ctx => (isNotebook(ctx.doc) ? (currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'}) : {enabled: false, reason: 'No notebook is open'}),
      run: (ctx, p) => typeText(ctx, p),
    },
    {
      id: 'clipboard.formatPainter', label: 'Format Painter', risk: 'edit', effect: 'view', undo: 'auto', repeatable: false,
      description: 'Format Painter: with nothing picked up, take the formatting of the selection (marks, paragraph style and alignment); then apply it to the selected text and turn off. Called with value false it turns off.',
      params: s.object({value: s.optional(s.boolean())}),
      state: ctx => {
        const on = !!(ctx.view?.painter);
        return textRange(ctx) || on ? {enabled: true, checked: on} : textState(ctx);
      },
      run(ctx, p) {
        const active = ctx.view?.painter ?? null;
        if (p.value === false) { ctx.setView({painter: null}); return {active: false}; }
        if (!active) { ctx.setView({painter: pickFormat(ctx)}); return {active: true}; }
        const range = textRange(ctx);
        const r = range ? charRange(range) : null;
        // The same text again, or nothing selected: only turns it off.
        if (!r || (r.from === active.source.from && r.to === active.source.to && range.pageId === active.source.page)) { ctx.setView({painter: null}); return {active: false, applied: false}; }
        const out = applyFormat(ctx, active);
        ctx.setView({painter: null});
        return {active: false, applied: true, ...out};
      },
    },
  ],
});
