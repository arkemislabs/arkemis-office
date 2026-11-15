// Paste: what a paste brings in (our own copy, another program's HTML or RTF, the system
// clipboard's text), Merge Formatting, inserting a fragment with Track Changes and tracked moves,
// adopting another document's lists, styles, pictures and revisions, and Paste Special's formats.
//
// Translated from wordcraft crates/engine/src/cmd/paste.rs (MAX_PASTE_BYTES, MAX_PICTURE_BYTES,
// FORMATS, clip_text, looks_like_rtf, looks_like_html, source, available, formats_json,
// BLOCKQUOTE_INDENT, import_html, blockquote_margins, html_fragment, has_content, rich_fragment,
// Pasted, paste_content, paste_fragment, insert_text, merge_formatting, insert, each_para,
// remap_change, remap_table_changes, unlink_sections, adopt), crates/doc/src/edit.rs
// (Fragment::clipboard_text = shown text) and crates/engine/src/io.rs (text_width,
// fit_block_pictures) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// HTML and RTF are read by the Quill format modules (core/quill/formats/html-read.mjs and
// rtf-read.mjs, owned by U:quill/formats-html and formats-rtf). Until they exist, `importers()`
// finds none: HTML and RTF are not offered by Paste Special and Paste falls back to the text,
// which is what upstream does when a payload holds nothing it can read.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {Document, fragmentPlainText, fragmentToDocument} from '../model/document.mjs';
import {fragmentFromText} from '../model/edit.mjs';
import {symbolChar} from '../model/symbol-fonts.mjs';
import {shownFont} from '../model/props.mjs';
import {textWidth as sectionTextWidth} from '../model/section.mjs';
import {getStyle} from '../model/styles.mjs';
import {caret, samePath, ordered} from './caret-session.mjs';
import {typingProps, trackChanges, newRevision, deleteSelection, prepareEdit, pasteText} from './text-edit.mjs';
import {takePaste} from './edit-moves.mjs';

/** Largest clipboard payload Paste Special accepts, in bytes (UTF-16 units here). */
export const MAX_PASTE_BYTES = 16 << 20;
/** Largest clipboard picture Paste Special accepts (base64). */
export const MAX_PICTURE_BYTES = 96 << 20;
const MAX_DEPTH = 64;
const BLOCKQUOTE_INDENT = 36;

/** The formats, in the order the dialog lists them: [id, label] (FORMATS). */
export const FORMATS = Object.freeze([['formatted', 'Formatted Text'], ['rtf', 'Rich Text Format (RTF)'], ['html', 'HTML Format'], ['picture', 'Picture'],
  ['text', 'Unformatted Text']]);

// ---- fragments ---------------------------------------------------------------------------------------

/** Every paragraph in a block, tables included (each_para); `f` gets a mutable copy and returns it. */
export function mapEachPara(b, f, depth = 0) {
  if (depth > MAX_DEPTH) return b;
  if (b.kind === 'para') return f({...b});
  return {...b, rows: b.rows.map(r => ({...r, cells: r.cells.map(c => ({...c, blocks: c.blocks.map(x => mapEachPara(x, f, depth + 1))}))}))};
}
export function eachPara(b, f, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (b.kind === 'para') { f(b); return; }
  for (const r of b.rows) for (const c of r.cells) for (const x of c.blocks) eachPara(x, f, depth + 1);
}

/** A paragraph's text as shown: objects as their text, symbol fonts mapped (Paragraph::shown_text). */
function shownText(p) {
  let out = '', k = 0;
  const runs = P.runRanges(p);
  let r = 0;
  for (let i = 0; i < p.text.length;) {
    const cp = p.text.codePointAt(i);
    const c = String.fromCodePoint(cp);
    while (r < runs.length && runs[r][1] <= i) r++;
    if (c === P.OBJ) { out += P.objectPlainText(p.objects?.[k]); k++; i += c.length; continue; }
    const font = runs[r] && runs[r][0] <= i ? shownFont(runs[r][2] ?? {}) : null;
    out += (font ? symbolChar(font, c) : null) ?? c;
    i += c.length;
  }
  return out;
}

/** Fragment::clipboard_text: the shown text, paragraphs separated by \n, cells by \t. */
export function clipboardText(frag) {
  const out = [];
  const walk = (blocks, depth) => {
    if (depth > 16) return;
    for (const b of blocks) {
      if (b.kind === 'para') out.push(shownText(b) + '\n');
      else for (const row of b.rows) {
        out.push(row.cells.map(c => { const s = []; const save = out.length; walk(c.blocks, depth + 1); s.push(...out.splice(save)); return s.join('').replace(/\n+$/, '').replace(/\n/g, ' '); }).join('\t') + '\n');
      }
    }
  };
  walk(frag.blocks ?? [], 0);
  const t = out.join('');
  return t.endsWith('\n') ? t.slice(0, -1) : t;
}

export const plainText = frag => fragmentPlainText(frag);

// ---- the clipboard ----------------------------------------------------------------------------------

/** Our own copy on the kernel clipboard, or null. */
export function ownClip(ctx) {
  const c = ctx.clipboard;
  return c && c.app === 'quill' && c.fragment ? c : null;
}

const looksLikeRtf = t => t.trimStart().startsWith('{\\rtf');
function looksLikeHtml(t) { const s = t.trimStart(); return s.startsWith('<') && (s.includes('</') || s.includes('/>')); }

/** Clipboard text from the params (system clipboard), else our own copy (clip_text). */
function clipText(ctx, p) {
  if (typeof p.text === 'string') return p.text.replace(/\r\n/g, '\n');
  const own = ownClip(ctx);
  return own ? plainText(own.fragment) : null;
}

/** The source for a format, if the clipboard has it (source). */
function source(ctx, p, fmt, importers) {
  const nonEmpty = t => (t ? t : null);
  switch (fmt) {
    case 'formatted': {
      const own = ownClip(ctx);
      if (!own) return null;
      // System clipboard text that isn't our own copy means someone else copied since.
      if (typeof p.text === 'string' && own.text !== p.text.replace(/\r\n/g, '\n')) return null;
      return '';
    }
    case 'rtf': {
      if (!importers.rtf) return null;
      const t = typeof p.rtf === 'string' ? p.rtf : (() => { const c = clipText(ctx, p); return c && looksLikeRtf(c) ? c : null; })();
      return nonEmpty(t);
    }
    case 'html': {
      if (!importers.html) return null;
      const t = typeof p.html === 'string' ? p.html : (() => { const c = clipText(ctx, p); return c && looksLikeHtml(c) ? c : null; })();
      return nonEmpty(t);
    }
    case 'picture': return typeof p.picture === 'string' && p.picture ? p.picture : null;
    case 'text': return nonEmpty(clipText(ctx, p));
    default: return null;
  }
}

/** Formats the clipboard can be pasted as, best first (available). */
export function available(ctx, p, importers) {
  return FORMATS.map(([id]) => id).filter(id => source(ctx, p, id, importers) !== null);
}
export const formatsJson = ids => ids.map(id => ({id, label: FORMATS.find(([f]) => f === id)?.[1] ?? id}));
export const sourceOf = source;

// ---- other programs' formats ----------------------------------------------------------------------------

/** The HTML and RTF readers the Quill format modules provide: {html?: fn(text) -> content, rtf?: fn(text) -> content}. */
let readersSeen = {html: false, rtf: false};
/** Which readers the last importers() call found (for the Paste Special dialog, which is synchronous). */
export const readersKnown = () => ({...readersSeen});

export async function importers() {
  let formats = null;
  try { formats = (await import('../../generated/quill.formats.mjs')).formats; } catch { formats = null; }
  // A reader takes the clipboard's text: the module's text entry (html-read importHtml, rtf-read
  // importRtf / readText), else its file entry fed the text's UTF-8 bytes.
  const reader = (ext, textEntry) => {
    const m = formats?.[ext]?.read;
    if (!m) return null;
    const fn = m[textEntry] ?? m.readText;
    if (typeof fn === 'function') return async text => fn(text);
    if (typeof m.read === 'function') return async text => m.read(new TextEncoder().encode(text), {paste: true});
    return null;
  };
  const out = {html: reader('html', 'importHtml'), rtf: reader('rtf', 'importRtf')};
  readersSeen = {html: !!out.html, rtf: !!out.rtf};
  return out;
}

/** HTML for a copied fragment, when the HTML writer exists (copy_result's export_fragment). */
export async function fragmentHtml(frag) {
  try {
    const w = (await import('../../generated/quill.formats.mjs')).formats?.html?.write;
    if (typeof w?.exportFragment !== 'function') return '';
    return String(w.exportFragment(fragmentToDocument(frag).c));
  } catch { return ''; }
}

/** The HTML itself from a Windows "HTML Format" (CF_HTML) payload (html_fragment). */
export function htmlFragment(html) {
  if (!html.startsWith('Version:')) return html;
  const offset = key => {
    const at = html.indexOf(key);
    if (at < 0) return null;
    const digits = html.slice(at + key.length).split(/[\r\n]/)[0].trim();
    return /^\d+$/.test(digits) ? Number(digits) : null;
  };
  const a = offset('StartFragment:'), b = offset('EndFragment:');
  // The offsets count UTF-8 bytes.
  if (a !== null && b !== null && a <= b) {
    const bytes = new TextEncoder().encode(html);
    if (b <= bytes.length) return new TextDecoder().decode(bytes.slice(a, b));
  }
  const i = html.indexOf('<');
  return i >= 0 ? html.slice(i) : '';
}

/** The CSS length in points (wordcraft_formats::html::css_len_pt). */
function cssLenPt(v) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(pt|px|cm|mm|in|pc|em)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const k = {pt: 1, px: 0.75, cm: 72 / 2.54, mm: 72 / 25.4, in: 72, pc: 12, em: 12}[(m[2] ?? 'px').toLowerCase()];
  return n * k;
}

/** The left and right margins (points) the payload's <style> gives blockquote (blockquote_margins). */
export function blockquoteMargins(html) {
  const len = v => { const x = cssLenPt(v); return x === null ? null : Math.min(Math.max(x, 0), 1584); };
  let left = BLOCKQUOTE_INDENT, right = BLOCKQUOTE_INDENT;
  let rest = html.toLowerCase();
  for (;;) {
    const at = rest.indexOf('<style');
    if (at < 0) break;
    const tag = rest.slice(at);
    const j = tag.indexOf('>');
    const sheet = j >= 0 ? tag.slice(j + 1) : '';
    const end = sheet.indexOf('</style') >= 0 ? sheet.indexOf('</style') : sheet.length;
    for (const rule of sheet.slice(0, end).split('}')) {
      const k = rule.indexOf('{');
      if (k < 0) continue;
      const sel = rule.slice(0, k), decls = rule.slice(k + 1);
      if (!sel.split(',').some(s => s.trim().replace(/^<!--/, '').trim() === 'blockquote')) continue;
      for (const d of decls.split(';')) {
        const c = d.indexOf(':');
        if (c < 0) continue;
        const name = d.slice(0, c).trim(), v = d.slice(c + 1);
        if (name === 'margin-left') left = len(v) ?? left;
        else if (name === 'margin-right') right = len(v) ?? right;
        else if (name === 'margin') {
          const vals = v.trim().split(/\s+/).slice(0, 4);
          let r, l;
          if (vals.length === 1) [r, l] = [vals[0], vals[0]];
          else if (vals.length === 2 || vals.length === 3) [r, l] = [vals[1], vals[1]];
          else if (vals.length === 4) [r, l] = [vals[1], vals[3]];
          else continue;
          right = len(r) ?? right;
          left = len(l) ?? left;
        }
      }
    }
    rest = sheet.slice(end);
  }
  return [left, right];
}

/** Another program's HTML as content; a <blockquote> pastes as an indented Normal paragraph (import_html). */
export async function importHtml(importers0, html) {
  const content = await importers0.html(htmlFragment(html));
  const [left, right] = blockquoteMargins(html);
  const d = new Document(content);
  const blocks = d.story('body').toArray().map(b => mapEachPara(b, p => {
    if (p.props?.style === 'Quote') {
      const pr = {...p.props};
      delete pr.style;
      if (pr.indentLeft === undefined) pr.indentLeft = left;
      if (pr.indentRight === undefined) pr.indentRight = right;
      p.props = pr;
    }
    return p;
  }));
  return {...content, body: {chunks: [blocks]}};
}

/** Whether imported content has anything to paste (has_content). */
function hasContent(content) {
  const blocks = (content.body?.chunks ?? []).flat();
  const media = Object.keys(content.media ?? {}).length > 0;
  return blocks.some(b => (b.kind === 'para' ? b.text.trim() !== '' || (!!b.objects?.length && media) : true));
}

/** Another program's formatted copy, HTML else RTF, as a fragment of this document (rich_fragment). */
export async function richFragment(S, p, importers0) {
  const fits = k => (typeof p[k] === 'string' && p[k].trim() && p[k].length <= MAX_PASTE_BYTES ? p[k] : null);
  let content = null;
  if (fits('html') && importers0.html) {
    try { content = await importHtml(importers0, fits('html')); } catch { content = null; }
    if (content && !hasContent(content)) content = null;
  }
  if (!content) {
    const rtf = fits('rtf');
    if (!rtf || !looksLikeRtf(rtf) || !importers0.rtf) return null;
    try { content = await importers0.rtf(rtf); } catch { return null; }
    if (!content || !hasContent(content)) return null;
  }
  return adopt(S, content);
}

/**
 * What Paste inserts: our own copy while the system clipboard still holds it, else another
 * program's formatted copy, else the system clipboard's text (paste_content).
 */
export async function pasteContent(S, p, importers0) {
  const text = typeof p.text === 'string' ? p.text.replace(/\r\n/g, '\n') : null;
  const own = ownClip(S.ctx);
  if (own && (text === null || own.text === text) && (text !== null || (p.html === undefined && p.rtf === undefined))) {
    return {fragment: own.fragment};
  }
  const rich = await richFragment(S, p, importers0);
  if (rich) return {fragment: rich};
  if (text) return {text};
  throw new CommandError('failed', 'the clipboard is empty');
}

/** paste_content as a fragment: text becomes paragraphs with no formatting of their own (paste_fragment). */
export async function pasteFragment(S, p, importers0) {
  const got = await pasteContent(S, p, importers0);
  return got.fragment ?? fragmentFromText(got.text);
}

/** Plain text as Keep Text Only pastes it (insert_text). */
export function insertPlainText(S, text) {
  S.view.pendingMove = null;
  pasteText(S, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
}

/** Merge Formatting: the destination's formatting, keeping only emphasis, links and tracked changes (merge_formatting). */
export function mergeFormatting(S, frag) {
  const base = typingProps(S);
  delete base.ins; delete base.del; delete base.fmtChange;
  const [start] = ordered(S.sel);
  const para = S.d.paraAt(start)?.props ?? null;
  return {...frag, blocks: frag.blocks.map(b => mapEachPara(b, p => {
    if (para && Object.keys(para).length) p.props = {...para}; else delete p.props;
    p.runs = p.runs.map(run => {
      const src = run.props ?? {};
      const props = {...base};
      if (src.bold === true) props.bold = true;
      if (src.italic === true) props.italic = true;
      if (src.underline && src.underline !== 'none') props.underline = src.underline;
      if (src.strike === true) props.strike = true;
      if (src.link !== undefined) props.link = src.link; else delete props.link;
      if (src.ins !== undefined) props.ins = src.ins;
      if (src.del !== undefined) props.del = src.del;
      return Object.keys(props).length ? {len: run.len, props} : {len: run.len};
    });
    return p;
  }))};
}

/** Replace the selection with `frag`, marked as an insertion (or a move) under Track Changes (insert). */
export function insertFragment(S, frag0) {
  prepareEdit(S);
  const at0 = deleteSelection(S);
  let frag = frag0;
  let rid = null;
  if (trackChanges(S)) {
    const r = takePaste(S, plainText(frag));
    rid = r ?? newRevision(S, 'insert');
    frag = {...frag, blocks: frag.blocks.map(b => mapEachPara(b, p => {
      p.runs = p.runs.map(run => { const props = {...(run.props ?? {}), ins: rid}; delete props.fmtChange; return {len: run.len, props}; });
      if (p.mark) { const m = {...p.mark}; delete m.ins; delete m.del; if (Object.keys(m).length) p.mark = m; else delete p.mark; }
      return p;
    }))};
  } else S.view.pendingMove = null;
  const end = S.d.insertFragment(at0, frag);
  // The paragraph marks the paste added are inserted too; the last ends with the original mark.
  if (rid !== null && at0.story === end.story && samePath(at0.path.slice(0, -1), end.path.slice(0, -1))) {
    const first = at0.path[at0.path.length - 1], lastI = end.path[end.path.length - 1];
    for (let i = first; i < lastI; i++) {
      const path = [...at0.path.slice(0, -1), i];
      if (!S.d.para(at0.story, path)) continue;
      const q = S.d.paraMut(at0.story, path);
      q.mark = {...(q.mark ?? {}), ins: rid};
      delete q.mark.del;
    }
  }
  S.sel = caret(end);
  return end;
}

/** Section breaks from another document link to the previous section's headers (unlink_sections). */
export function unlinkSections(blocks) {
  return blocks.map(b => mapEachPara(b, p => {
    if (p.section) p.section = {...p.section, headers: {default: null, first: null, even: null}, footers: {default: null, first: null, even: null}, titlePage: false};
    return p;
  }));
}

/** The narrowest section's text width (io::text_width). */
function docTextWidth(d) {
  const ws = d.sections().map(([, s]) => sectionTextWidth(s));
  return Math.min(Math.max(Math.min(...ws, Infinity), 36), 4000);
}

/** Shrink inline pictures wider than `maxW` (fit_block_pictures). */
function fitPictures(b, maxW) {
  return mapEachPara(b, p => {
    if (!p.objects?.length) return p;
    p.objects = p.objects.map(o => {
      if (o.type === 'image' && (o.float?.wrap ?? 'inline') === 'inline' && Number.isFinite(o.w) && o.w > maxW) {
        const k = maxW / o.w;
        return {...o, w: maxW, h: Math.max(o.h * k, 1)};
      }
      return o;
    });
    return p;
  });
}

/** Imported content as a fragment of the session's document: media, lists, styles and revisions renumbered (adopt). */
export function adopt(S, src) {
  const d = S.d;
  const media = {};
  for (const [key, data] of Object.entries(src.media ?? {})) {
    const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : 'png';
    media[key] = d.addMedia(data, ext);
  }
  const ours = d.c.numbering;
  const nextAbs = ours.abstracts.reduce((m, a) => Math.max(m, a.id + 1), 0);
  const absMap = new Map();
  const abstracts = [...ours.abstracts];
  (src.numbering?.abstracts ?? []).forEach((a, i) => { const id = nextAbs + i; absMap.set(a.id, id); abstracts.push({...a, id}); });
  const nextNum = Math.max(ours.nums.reduce((m, n) => Math.max(m, n.id + 1), 1), 1);
  const numMap = new Map();
  const nums = [...ours.nums];
  (src.numbering?.nums ?? []).forEach((n, i) => { const id = nextNum + i; numMap.set(n.id, id); nums.push({...n, id, abstractId: absMap.get(n.abstractId) ?? n.abstractId}); });
  if (absMap.size || numMap.size) d.setField('numbering', {...ours, abstracts, nums});
  const missing = (src.styles?.styles ?? []).filter(st => !getStyle(d.c.styles, st.id));
  if (missing.length) d.updateField('styles', sh => ({...sh, styles: [...sh.styles, ...missing]}));
  // Tracked changes the source carries point at its own revisions: add them after ours.
  const revBase = (d.c.revisions ?? []).length;
  const srcRevs = (src.revisions ?? []).length;
  if (srcRevs) d.updateField('revisions', rs => [...(rs ?? []), ...src.revisions]);
  const rev = i => (Number.isInteger(i) && i < srcRevs ? revBase + i : undefined);
  const remapChange = c => { if (!c) return c; const r = rev(c.rev); return r === undefined ? undefined : {...c, rev: r}; };
  const maxW = docTextWidth(d);
  let blocks = (src.body?.chunks ?? []).flat().map(b => fitPictures(b, maxW));
  blocks = blocks.map(b => mapEachPara(b, p => {
    if (p.props?.numbering && p.props.numbering.num !== 0) p.props = {...p.props, numbering: {...p.props.numbering, num: numMap.get(p.props.numbering.num) ?? 0}};
    p.runs = p.runs.map(r => {
      if (!r.props) return r;
      const props = {...r.props};
      for (const k of ['ins', 'del']) { if (props[k] !== undefined) { const v = rev(props[k]); if (v === undefined) delete props[k]; else props[k] = v; } }
      if (props.fmtChange) { const c = remapChange(props.fmtChange); if (c) props.fmtChange = c; else delete props.fmtChange; }
      return {...r, props};
    });
    if (p.mark) {
      const m = {...p.mark};
      for (const k of ['ins', 'del']) { if (m[k] !== undefined) { const v = rev(m[k]); if (v === undefined) delete m[k]; else m[k] = v; } }
      if (m.fmtChange) { const c = remapChange(m.fmtChange); if (c) m.fmtChange = c; else delete m.fmtChange; }
      p.mark = m;
    }
    if (p.props?.fmtChange || p.props?.numChange) {
      const pr = {...p.props};
      if (pr.fmtChange) { const c = remapChange(pr.fmtChange); if (c) pr.fmtChange = c; else delete pr.fmtChange; }
      if (pr.numChange) { const c = remapChange(pr.numChange); if (c) pr.numChange = c; else delete pr.numChange; }
      p.props = pr;
    }
    if (p.objects?.length) p.objects = p.objects.map(o => (o.type === 'image' && media[o.media] ? {...o, media: media[o.media]} : o));
    return p;
  }));
  blocks = blocks.map(b => remapTableChanges(b, remapChange));
  blocks = unlinkSections(blocks);
  const parts = {};
  for (const [id, part] of Object.entries(src.parts ?? {})) if (part.kind === 'textBox') parts[id] = part;
  return {blocks, parts};
}

/** remap_table_changes: table, row and cell formatting changes renumbered. */
function remapTableChanges(b, remap, depth = 0) {
  if (b.kind !== 'table' || depth > MAX_DEPTH) return b;
  const fix = props => { if (!props?.fmtChange) return props; const c = remap(props.fmtChange); const o = {...props}; if (c) o.fmtChange = c; else delete o.fmtChange; return o; };
  return {...b, props: fix(b.props), rows: b.rows.map(r => ({...r, props: fix(r.props), cells: r.cells.map(c => ({...c, props: fix(c.props), blocks: c.blocks.map(x => remapTableChanges(x, remap, depth + 1))}))}))};
}

export {pasteText};
