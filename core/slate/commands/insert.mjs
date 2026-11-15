// Insert tab: Insert Space, Files, Images, Links, Time Stamp and Symbols (U:slate/insert).
// Tables are core/slate/commands/table.mjs, Page Templates core/slate/commands/pages.mjs.
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `insert.*` and
// `link.insert` (OneNote for Microsoft 365, Insert tab); behaviour is OneNote's:
//   * Insert Space turns on a tool: drag down (or right) on the page and every note and stroke below
//     (to the right of) the click moves by the drag; dragging up (left) takes the space back, no
//     further than the nearest note. The drag is `insert.spaceBy`; the tool turns off after one use;
//   * File Attachment puts a file on the page as an icon with its name (the file is stored in the
//     notebook); File Printout adds the attachment and a picture of each page of the file (PDF and
//     pictures: the files the app can draw);
//   * Pictures inserts a picture at the caret (the system Open dialog when no file is given), sized
//     to the page; Screen Clipping inserts a clip of this window;
//   * Link (Ctrl+K) makes the selected text (or the text typed in the dialog) a link to a web
//     address or to a page or section of the notebook; Create a new page with this title adds the
//     page and links to it; Ctrl+K on a link edits it;
//   * Date, Time, Date & Time stamp the current date and time (Alt+Shift+D / T / F) as typed text;
//   * Symbol inserts a character, remembering the 20 last used; Equation inserts Office's built-in
//     equations or an empty one to type into (UnicodeMath linear format, typeset on the page).
// Online Pictures, Scanned Image, Record Audio / Video, Online Video, Loop Components, Forms,
// Spreadsheet and Diagram need services or programs the app does not have and are not offered.

import {Fragment} from '@tiptap/pm/model';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {addPage, currentLocation} from '../model/notebook.mjs';
import {applySteps, normalizeStroke, pageDoc} from '../model/canvas.mjs';
import {blockIndex} from '../model/page.mjs';
import {editPage, textRange, charRange} from '../lib/format-text.mjs';
import {bid, caretSelection, insertBlock, insertInline, needPage, pageReady} from '../lib/insert-point.mjs';
import {PRESETS, MAX_LINEAR} from '../lib/equation.mjs';
import {latexToLinear} from '../lib/equation-latex.mjs';
import {presetTiles} from '../lib/equation-catalog.mjs';
import {stampEdit} from '../lib/history.mjs';
import {base64Encode, bytesOf, imageExt, probe} from '../../quill/lib/insert-objects.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/insert.*', 'docs/spec/slate.json#commands/link.insert']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

export const RECENT_SYMBOLS_PREF = 'slate.recentSymbols';
export const RECENT_SYMBOLS = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A picture is shown at its own size up to this width (px), as OneNote fits a picture to the page. */
export const MAX_PICTURE_WIDTH = 640;

const MIME = {pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json', html: 'text/html', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint'};
export const mimeOf = name => MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream';

/** Decoded size in bytes of base64 text (data URL prefix allowed). */
function base64Size(text) {
  const b = String(text).replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  const pad = b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0;
  return Math.floor(b.length * 3 / 4) - pad;
}
const plainBase64 = text => String(text).replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');

const selectObject = (ctx, pageId, id) => ctx.setSelection({ranges: [{anchor: `/pg:${pageId}/media:${id}`, focus: `/pg:${pageId}/media:${id}`}], primary: 0});

// ---------------------------------------------------------------------------------------------
// Pictures

export function pictureNode(ctx, p, bytes) {
  const info = probe(bytes);
  need(!info.notPicture, 'invalid_params', 'That file is not a picture the app can show', {path: '/data'});
  need(!info.refused, 'invalid_params', info.refused, {path: '/data'});
  const ext = imageExt(bytes);
  const natural = {width: info.width || 1, height: info.height || 1};
  let width = p.width ?? Math.min(natural.width, MAX_PICTURE_WIDTH);
  width = Math.max(8, Math.min(4000, Math.round(width)));
  const height = Math.max(1, Math.round(width * natural.height / natural.width));
  const src = `data:image/${ext};base64,${base64Encode(bytes)}`;
  return schema.nodes.image.create({id: bid(ctx), src, alt: p.alt ?? p.name ?? '', title: null, width, height});
}

export function placeObject(ctx, node) {
  const {pageId} = insertInline(ctx, () => [node]);
  selectObject(ctx, pageId, node.attrs.id);
  return {pageId, object: `/pg:${pageId}/media:${node.attrs.id}`};
}

export async function readFile(ctx, p, {image = false} = {}) {
  if (typeof p.data === 'string') return {name: p.name ?? (image ? 'Picture' : 'File'), data: p.data};
  if (image) {
    need(typeof ctx.host?.pickImage === 'function', 'unavailable', 'The system Open dialog is not available here; pass `data` (base64)');
    const url = await ctx.host.pickImage();
    return url ? {name: p.name ?? 'Picture', data: url} : null;
  }
  need(typeof ctx.host?.pickDocument === 'function', 'unavailable', 'The system Open dialog is not available here; pass `name` and `data` (base64)');
  const f = await ctx.host.pickDocument({all: true});
  return f ? {name: p.name ?? f.name, data: f.data} : null;
}

function attachmentNode(ctx, name, data) {
  const b64 = plainBase64(data);
  need(/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64.slice(0, 4096)), 'invalid_params', 'data is not base64', {path: '/data'});
  const size = base64Size(b64);
  need(size <= MAX_FILE_BYTES, 'too_large', `A file on a page is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`, {path: '/data'});
  need(String(name).trim(), 'invalid_params', 'A file needs a name', {path: '/name'});
  return schema.nodes.attachment.create({id: bid(ctx), name: String(name).slice(0, 255), mime: mimeOf(name), size, data: b64, path: null});
}

const fileParams = {
  name: s.optional(s.string({min: 1, max: 255, description: 'File name (with extension)'})),
  data: s.optional(s.string({max: 40_000_000, description: 'The file, base64 (omit to choose one in the system Open dialog)'})),
};

// ---------------------------------------------------------------------------------------------
// Links

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp', 'file', 'slate', 'onenote', 'tel']);
/** The address a link points at: a web address gets https:// when it has no scheme; scripts and data are refused. */
export function linkAddress(text) {
  const t = String(text ?? '').trim();
  need(t, 'invalid_params', 'Type the address of the link', {path: '/address'});
  const m = SCHEME.exec(t);
  if (m) {
    need(SAFE_SCHEMES.has(m[1].toLowerCase()), 'invalid_params', `Links to ${m[1]}: addresses are not allowed`, {path: '/address'});
    return t;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
  need(!/\s/.test(t), 'invalid_params', 'An address has no spaces', {path: '/address'});
  return `https://${t}`;
}
/** Internal link addresses: slate:page/<id>[#<block>], slate:section/<id>. */
export const pageLink = (pageId, block) => `slate:page/${encodeURIComponent(pageId)}${block ? `#${encodeURIComponent(block)}` : ''}`;
export const sectionLink = sectionId => `slate:section/${encodeURIComponent(sectionId)}`;
export function parseInternalLink(href) {
  const m = /^slate:(page|section)\/([^#]+)(?:#(.+))?$/.exec(String(href ?? ''));
  return m ? {kind: m[1], id: decodeURIComponent(m[2]), block: m[3] ? decodeURIComponent(m[3]) : null} : null;
}

/** The extent [from, to] of the link mark around a position (the whole link text), or null. */
export function linkExtent(doc, pos) {
  const $p = doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const type = schema.marks.link;
  const parent = $p.parent, base = $p.start();
  let at = 0, hit = null;
  parent.forEach((child, off) => {
    const m = type.isInSet(child.marks);
    const from = base + off, to = from + child.nodeSize;
    if (m && pos >= from && pos <= to && !hit) hit = {from, to, mark: m};
    at = off;
  });
  void at;
  if (!hit) return null;
  let {from, to} = hit;
  const same = n => { const m = type.isInSet(n.marks); return !!m && m.attrs.href === hit.mark.attrs.href; };
  parent.forEach((child, off) => {
    const f = base + off, t = f + child.nodeSize;
    if (same(child) && t === from) from = f;
    if (same(child) && f === to) to = t;
  });
  return {from, to, href: hit.mark.attrs.href};
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'insert',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Insert Space ---------------------------------------------------------------------------
    {
      id: 'insert.space', label: 'Insert Space', risk: 'read', effect: 'view',
      description: 'Turn the Insert Space tool on or off: click on the page and drag down (or right) to push everything below (to the right of) the click away; Esc or one drag turns it off.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        const r = pageReady(ctx);
        return r.enabled ? {enabled: true, checked: ctx.view?.insertSpace === true} : r;
      },
      run(ctx, p) {
        const on = p.value ?? ctx.view?.insertSpace !== true;
        ctx.setView({insertSpace: on, ...(on ? {ink: null} : {})});
        return {value: on};
      },
    },
    {
      id: 'insert.spaceBy', label: 'Insert Space', risk: 'edit',
      description: 'Move every note container and stroke at or below y (axis down) or at or right of x (axis right) by an amount in px; a negative amount takes space back, no further than the nearest of them.',
      params: s.object({
        axis: s.enum(['down', 'right']),
        at: s.number({min: 0, max: 500000, description: 'The page coordinate of the click (y for down, x for right), px'}),
        amount: s.number({min: -500000, max: 500000, description: 'px to add (negative removes)'}),
        page: s.optional(s.string({min: 1, max: 80})),
      }),
      state: pageReady,
      run(ctx, p) {
        const pageId = p.page ?? needPage(ctx);
        need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`, {path: '/page'});
        const vertical = p.axis === 'down';
        const doc = pageDoc(ctx, pageId);
        const moved = [];
        doc.forEach((node, pos) => { const c = vertical ? node.attrs.y : node.attrs.x; if (c >= p.at) moved.push({node, pos, c}); });
        const strokes = ctx.doc.pages[pageId].ink.map((st, i) => {
          let min = Infinity;
          for (let k = vertical ? 1 : 0; k < st.points.length; k += 2) min = Math.min(min, st.points[k]);
          return {st, i, min: min - st.width / 2};
        }).filter(x => x.min >= p.at);
        let amount = Math.round(p.amount);
        if (amount < 0) {
          const nearest = Math.min(...moved.map(m => m.c), ...strokes.map(x => x.min));
          amount = Math.max(amount, -Math.max(0, Math.floor(nearest - p.at)));
        }
        for (const m of moved) amount = Math.max(amount, -m.c);
        if (!amount || (!moved.length && !strokes.length)) return {moved: 0, strokes: 0, amount: 0};
        const steps = moved.map(m => ({pos: m.pos, c: m.c})).map(({pos, c}) => {
          const attr = vertical ? 'y' : 'x';
          return {stepType: 'attr', pos, attr, value: Math.min(vertical ? 500000 : 50000, c + amount)};
        });
        applySteps(ctx, pageId, steps);
        const iso = new Date(ctx.host.now()).toISOString();
        for (const x of strokes) {
          const pts = x.st.points.slice();
          for (let k = vertical ? 1 : 0; k < pts.length; k += 2) pts[k] = Math.round((pts[k] + amount) * 10) / 10;
          ctx.change.splice(['pages', pageId, 'ink'], x.i, 1, normalizeStroke({...x.st, points: pts}, x.st.id));
        }
        if (strokes.length) stampEdit(ctx, pageId);
        return {moved: moved.length, strokes: strokes.length, amount};
      },
    },

    // --- Files ----------------------------------------------------------------------------------
    {
      id: 'insert.fileAttachment', label: 'File Attachment', risk: 'edit',
      description: 'Attach a file to the page as an icon with its name (the file is stored in the notebook, up to 25 MB); without a file the system Open dialog asks for one.',
      params: s.object(fileParams),
      state: pageReady,
      async run(ctx, p) {
        const file = await readFile(ctx, p);
        if (!file) return {cancelled: true};
        const node = attachmentNode(ctx, file.name, file.data);
        return {...placeObject(ctx, node), name: node.attrs.name, size: node.attrs.size};
      },
    },
    {
      id: 'insert.filePrintout', label: 'File Printout', risk: 'edit',
      description: 'Insert a file as a printout: the file attached as an icon, then a picture of each of its pages (a PDF, or a picture). `pages` are the page pictures (PNG data URLs) when the caller has them.',
      params: s.object({...fileParams, pages: s.optional(s.array(s.string({max: 20_000_000}), {min: 1, max: 200}))}),
      state: pageReady,
      async run(ctx, p) {
        const file = await readFile(ctx, p);
        if (!file) return {cancelled: true};
        const att = attachmentNode(ctx, file.name, file.data);
        let pages = p.pages;
        if (!pages) {
          const mime = att.attrs.mime;
          if (mime.startsWith('image/') && mime !== 'image/svg+xml') pages = [file.data];
          else if (mime === 'application/pdf') {
            need(typeof ctx.host?.printoutPages === 'function', 'unavailable', 'Drawing the pages of a PDF is not available here; pass `pages`');
            pages = await ctx.host.printoutPages({name: att.attrs.name, data: plainBase64(file.data), mime});
          } else throw new CommandError('unavailable', `A printout of ${att.attrs.name} needs the program that opens it; only PDF files and pictures can be printed to a page. Use File Attachment instead.`);
        }
        const para = (...inline) => schema.nodes.paragraph.create({id: bid(ctx)}, Fragment.from(inline));
        const blocks = [para(att)];
        for (const url of pages) {
          const bytes = bytesOf(String(url));
          need(bytes, 'invalid_params', 'A page picture is not base64', {path: '/pages'});
          blocks.push(para(pictureNode(ctx, {name: `${att.attrs.name} page ${blocks.length}`}, bytes)));
        }
        const {pageId, pos} = insertBlock(ctx, blocks);
        ctx.setSelection(caretSelection(pageId, pageDoc(ctx, pageId), pos + blocks.reduce((n, b) => n + b.nodeSize, 0) + 1));
        return {attachment: `/pg:${pageId}/media:${att.attrs.id}`, pages: pages.length, name: att.attrs.name};
      },
    },

    // --- Images ---------------------------------------------------------------------------------
    {
      id: 'insert.picture', label: 'Pictures', risk: 'edit',
      description: 'Insert a picture (PNG, JPEG, GIF, WebP, BMP) at the caret, shown at its own size up to 640 px wide; without a file the system Open dialog asks for one.',
      params: s.object({
        data: s.optional(s.string({max: 40_000_000, description: 'The picture, base64 or a data URL'})),
        name: s.optional(s.string({min: 1, max: 255})), alt: s.optional(s.string({max: 1000})),
        width: s.optional(s.number({min: 8, max: 4000, description: 'Width in px (default: its own, up to 640)'})),
      }),
      state: pageReady,
      async run(ctx, p) {
        const file = await readFile(ctx, p, {image: true});
        if (!file) return {cancelled: true};
        const bytes = bytesOf(file.data);
        need(bytes && bytes.length, 'invalid_params', 'data is not base64', {path: '/data'});
        const node = pictureNode(ctx, p, bytes);
        return {...placeObject(ctx, node), width: node.attrs.width, height: node.attrs.height};
      },
    },
    {
      id: 'insert.screenClipping', label: 'Screen Clipping', risk: 'edit',
      description: 'Insert a clip of this window as a picture: drag a rectangle over the window (Esc cancels). `data` is the clip when the caller has it.',
      params: s.object({data: s.optional(s.string({max: 40_000_000})), alt: s.optional(s.string({max: 1000}))}),
      state(ctx) {
        const r = pageReady(ctx);
        if (!r.enabled) return r;
        return {enabled: true};
      },
      async run(ctx, p) {
        let data = p.data;
        if (typeof data !== 'string') {
          need(typeof ctx.host?.captureClip === 'function', 'unavailable', 'Clipping the window is not available here; pass `data`');
          data = await ctx.host.captureClip();
          if (!data) return {cancelled: true};
        }
        const bytes = bytesOf(data);
        need(bytes && bytes.length, 'invalid_params', 'data is not base64', {path: '/data'});
        const node = pictureNode(ctx, {name: 'Screen clipping', alt: p.alt ?? 'Screen clipping'}, bytes);
        return {...placeObject(ctx, node), width: node.attrs.width, height: node.attrs.height};
      },
    },

    // --- Links ----------------------------------------------------------------------------------
    {
      id: 'link.insert', label: 'Link', shortcut: 'Mod+K', risk: 'edit', dialog: 'dialog.link',
      description: 'Make the selected text a link to a web address (`address`), a page (`page`, with `block` to land on a paragraph) or a section (`section`) of the notebook; `text` is what the link shows; `createPage` adds a new page titled `text` and links to it. At a caret the link text is inserted; on a link, it is edited.',
      params: s.object({
        text: s.optional(s.string({max: 500, description: 'Text to display'})),
        address: s.optional(s.string({max: 2048, description: 'Web address, mail address or file'})),
        page: s.optional(s.string({min: 1, max: 80, description: 'Page id to link to'})),
        section: s.optional(s.string({min: 1, max: 80, description: 'Section id to link to'})),
        block: s.optional(s.string({min: 1, max: 80, description: 'Paragraph id on that page'})),
        createPage: s.optional(s.boolean({description: 'Create a new page titled with the text and link to it'})),
      }),
      state: pageReady,
      run(ctx, p) {
        const pageId = needPage(ctx);
        const given = [p.address !== undefined && p.address !== '', p.page !== undefined, p.section !== undefined, p.createPage === true].filter(Boolean).length;
        need(given === 1, 'invalid_params', 'Give one of address, page, section or createPage');
        let href, shown = null;
        if (p.createPage) {
          need(String(p.text ?? '').trim(), 'invalid_params', 'Type the title of the new page in Text to display', {path: '/text'});
          const {sectionId} = currentLocation(ctx.doc, ctx.selection);
          need(sectionId, 'disabled', 'Open a section first');
          const id = addPage(ctx, sectionId, {title: String(p.text).trim().slice(0, 255)});
          href = pageLink(id);
          shown = String(p.text).trim();
        } else if (p.page !== undefined) {
          const page = ctx.doc.pages[p.page];
          need(page, 'not_found', `No page ${p.page}`, {path: '/page'});
          if (p.block) need(blockIndex(nodeOf(page.body)).has(p.block), 'not_found', `No paragraph ${p.block} on that page`, {path: '/block'});
          href = pageLink(p.page, p.block);
          shown = page.title || 'Untitled page';
        } else if (p.section !== undefined) {
          const sec = ctx.doc.sections[p.section];
          need(sec, 'not_found', `No section ${p.section}`, {path: '/section'});
          href = sectionLink(p.section);
          shown = sec.name;
        } else href = linkAddress(p.address);
        const text = p.text !== undefined && p.text !== '' ? p.text : null;
        const range = textRange(ctx);
        const mark = schema.marks.link.create({href});
        const doc = range?.doc ?? nodeOf(ctx.doc.pages[pageId].body);
        let caretAt;
        if (range && range.kind === 'text') {
          const ext = range.from === range.to ? linkExtent(doc, range.from) : null;
          const sel = ext ?? (range.from !== range.to && doc.resolve(range.from).parent === doc.resolve(range.to).parent ? {from: range.from, to: range.to}
            : (charRange(range) ?? null));
          if (sel) {
            const current = doc.textBetween(sel.from, sel.to, undefined, '￼');
            const label = text ?? (ext || current ? current : shown ?? href);
            editPage(ctx, pageId, tr => {
              const marks = doc.resolve(sel.from).marksAcross(doc.resolve(sel.to)) ?? [];
              const keep = marks.filter(m => m.type !== schema.marks.link);
              if (label === current) { tr.removeMark(sel.from, sel.to, schema.marks.link); tr.addMark(sel.from, sel.to, mark); }
              else { tr.replaceWith(sel.from, sel.to, schema.text(label, [...keep, mark])); caretAt = sel.from + label.length; }
            }, doc);
            const out = {link: href, text: label};
            if (caretAt !== undefined) ctx.setSelection(caretSelection(pageId, pageDoc(ctx, pageId), caretAt));
            return out;
          }
        }
        const label = text ?? shown ?? href;
        const r = insertInline(ctx, marks => [schema.text(label, [...marks.filter(m => m.type !== schema.marks.link), mark])], {replace: true});
        ctx.setSelection(caretSelection(pageId, pageDoc(ctx, r.pageId), r.pos + label.length));
        return {link: href, text: label};
      },
    },

    // --- Time Stamp -----------------------------------------------------------------------------
    {
      id: 'insert.dateTime', label: 'Date & Time', risk: 'edit',
      description: 'Insert the current date, time or both as text at the caret (the date as the page header writes it, the time as 9:30 AM).',
      params: s.object({kind: s.enum(['date', 'time', 'date-time']), at: s.optional(s.string({max: 40, description: 'ISO time to stamp instead of now'}))}),
      state: pageReady,
      run(ctx, p) {
        const when = p.at ? new Date(p.at) : new Date(ctx.host.now());
        need(!Number.isNaN(when.getTime()), 'invalid_params', 'at is not a date', {path: '/at'});
        const d = stampDate(when), t = stampTime(when);
        const text = p.kind === 'date' ? d : p.kind === 'time' ? t : `${d} ${t}`;
        const r = insertInline(ctx, marks => [schema.text(text, marks)], {replace: true});
        ctx.setSelection(caretSelection(r.pageId, pageDoc(ctx, r.pageId), r.pos + text.length));
        return {text};
      },
    },

    // --- Symbols --------------------------------------------------------------------------------
    {
      id: 'insert.symbol', label: 'Symbol', risk: 'edit', dialog: 'dialog.symbol',
      description: 'Insert a character (in a font of its own when `font` is given) at the caret, replacing the selected text; the last 20 are remembered.',
      params: s.object({char: s.string({min: 1, max: 64, description: 'The character(s)'}), font: s.optional(s.string({min: 1, max: 120}))}),
      state: pageReady,
      run(ctx, p) {
        const chars = p.char;
        const r = insertInline(ctx, marks => {
          const keep = marks.filter(m => m.type !== schema.marks.link);
          const withFont = p.font ? [...keep.filter(m => m.type !== schema.marks.textStyle), schema.marks.textStyle.create({...(schema.marks.textStyle.isInSet(keep)?.attrs ?? {}), fontFamily: p.font})] : keep;
          return [schema.text(chars, withFont)];
        }, {replace: true});
        ctx.setSelection(caretSelection(r.pageId, pageDoc(ctx, r.pageId), r.pos + chars.length));
        const prior = Array.isArray(ctx.prefs?.[RECENT_SYMBOLS_PREF]) ? ctx.prefs[RECENT_SYMBOLS_PREF] : [];
        const entry = {ch: [...chars][0], font: p.font ?? ''};
        ctx.updatePrefs({[RECENT_SYMBOLS_PREF]: [entry, ...prior.filter(x => !(x.ch === entry.ch && x.font === entry.font))].slice(0, RECENT_SYMBOLS)});
        return {char: chars};
      },
    },

    // --- Equations ------------------------------------------------------------------------------
    {
      id: 'insert.equation', label: 'Equation', shortcut: 'Alt+=', risk: 'edit',
      description: 'Insert an equation at the caret: one of Office\'s built-in equations (`preset`), the linear-format text given (`linear`), or an empty one to type into.',
      params: s.object({
        preset: s.optional(s.nullable(s.enum(Object.keys(PRESETS)))),
        linear: s.optional(s.string({max: MAX_LINEAR, description: 'UnicodeMath linear format, e.g. x=(-b±√(b^2-4ac))/2a (LaTeX when the input syntax is LaTeX)'})),
        value: s.optional(s.string({max: 80, description: 'A gallery tile: the preset id'})),
      }),
      // The Equation tab's gallery: the built-in equations, drawn as tiles.
      state(ctx, p) {
        const st = pageReady(ctx);
        return st.enabled && !p?.preset && p?.linear === undefined && p?.value === undefined ? {...st, value: presetTiles()} : st;
      },
      run(ctx, p) {
        const preset = p.preset ?? (p.value && PRESETS[p.value] ? p.value : null);
        need(!(preset && p.linear), 'invalid_params', 'Give a preset or linear text, not both');
        need(!p.value || preset, 'invalid_params', `${p.value} is not a built-in equation`, {path: '/value'});
        const linear = preset ? PRESETS[preset].linear : equationInput(ctx, p.linear ?? '');
        const node = schema.nodes.equation.create({id: bid(ctx), linear, display: false});
        return {...placeObject(ctx, node), linear};
      },
    },
    {
      id: 'equation.edit', label: 'Edit Equation', risk: 'edit',
      description: 'Set the linear-format text of an equation on the page (typing in it).',
      params: s.object({id: s.string({min: 1, max: 80, description: 'Equation id (the /pg:<page>/media:<id> of it)'}), linear: s.string({max: MAX_LINEAR}), page: s.optional(s.string({min: 1, max: 80}))}),
      state: pageReady,
      run(ctx, p) {
        const pageId = p.page ?? needPage(ctx);
        need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`);
        const hit = blockIndex(pageDoc(ctx, pageId)).get(p.id);
        need(hit && hit.node.type.name === 'equation', 'not_found', `No equation ${p.id} on this page`, {address: `/pg:${pageId}/media:${p.id}`});
        const linear = equationInput(ctx, p.linear);
        if (hit.node.attrs.linear === linear) return {changed: false};
        editPage(ctx, pageId, tr => tr.setNodeAttribute(hit.pos, 'linear', linear), pageDoc(ctx, pageId));
        return {changed: true, linear};
      },
    },
  ],
});

/** What is typed in an equation, as the linear format: LaTeX is converted when it is the Equation tab's input syntax. */
export const equationInput = (ctx, text) => (ctx.prefs?.['slate.equationInput'] === 'latex' ? latexToLinear(text) : text);

/** The date as the page header writes it ("Friday, October 30, 2026"), in the person's locale. */
export const stampDate = d => d.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
/** The time as the page header writes it ("9:30 AM"). */
export const stampTime = d => d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});

void isNotebook;
