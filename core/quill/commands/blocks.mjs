// Insert › Text: Quick Parts and AutoText (building blocks), Document Property, Signature Line, Object and Text from File; and
// Header & Footer › Navigation and Position: Next and Previous Section, Link to Previous, Header from Top and Footer from Bottom.
//
// Translated from wordcraft crates/engine/src/cmd/tools/specs.rs (`insert.quickParts`, `insert.autoText`, `insert.docProperty`,
// `insert.signatureLine`, `insert.object`, `layout.linkToPrevious`, `hf.next`, `hf.previous`, `hf.position`), tools/actions.rs
// (`quick_parts`, `hf_nav`) and insert.rs (`insert.textFromFile`) at aadb077e072b7de05f724e359d8db82e151f125c; checked against
// wordcraft 0.13.1 (f2dfa0d). MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Building blocks: upstream keeps the ones saved "in the session" in memory and the ones saved `in: 'document'` in the document
// (`Document::glossary`); Quill keeps the first kind in the person's settings (preference `buildingBlocks`, per user profile) so they last.
// The document's own are kept in the model but not written to .docx yet (the glossary part is not translated).
// A file is read by its bytes (`data`, base64, with `path` naming its format), as the other file commands do.
// Not here (their controls stay hidden): the Alignment Tab (not upstream), Show Document Text, Online Pictures.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {open, finish, ordered, isCollapsed, UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {insertFragment, unlinkSections} from '../lib/paste-content.mjs';
import {BODY} from '../model/document.mjs';
import {read as readDocx} from '../formats/docx-read.mjs';
import {read as readTxt} from '../formats/txt-read.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/tools/specs.rs', 'crates/engine/src/cmd/tools/actions.rs', 'crates/engine/src/cmd/insert.rs']};
export const QUICK_PARTS_GALLERY = 'Quick Parts';
export const AUTO_TEXT_GALLERY = 'AutoText';
const MAX_BLOCK_BYTES = 2_000_000;
const MAX_BLOCKS = 500;

const bad = m => new CommandError('invalid_params', m);
const failed = m => new CommandError('failed', m);
const NAME = s.string({max: 256});
/** state(): ready, and the gallery's building blocks for a dynamic menu list: [{id, label, value}] (the Quick Parts menu). */
const galleryState = gallery => ctx => {
  const r = T.ready(ctx);
  if (!r.enabled) return r;
  return {enabled: true, value: blockNames(ctx, gallery).parts.map(n => ({id: n, label: n, value: n}))};
};

// ---- building blocks ---------------------------------------------------------------------------------------

export const sessionBlocks = ctx => (ctx?.prefs?.buildingBlocks && typeof ctx.prefs.buildingBlocks === 'object' && !Array.isArray(ctx.prefs.buildingBlocks) ? ctx.prefs.buildingBlocks : {});
const documentEntry = (glossary, name, gallery) => {
  const i = glossary.findIndex(e => e.name === name && e.gallery === gallery);
  return i >= 0 ? i : glossary.findIndex(e => e.name === name);
};

export const SETTINGS_TEMPLATE = 'Normal.dotm';
export const DOCUMENT_TEMPLATE = 'This document';
const galleryOf = frag => (frag?.gallery === AUTO_TEXT_GALLERY ? AUTO_TEXT_GALLERY : QUICK_PARTS_GALLERY);
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const previewText = blocks => (blocks ?? []).map(b => (typeof b?.text === 'string' ? P.plainText(b) : '')).filter(Boolean).join('\n').slice(0, 800);

/**
 * Every building block, the person's and then the document's, as the Building Blocks Organizer lists them:
 * {name, gallery, category, description, where: 'Settings' | 'Document', template, text}.
 */
export function blockRows(ctx) {
  const rows = [];
  const seen = new Set();
  for (const [name, frag] of Object.entries(sessionBlocks(ctx))) {
    rows.push({name, gallery: galleryOf(frag), category: frag.category || 'General', description: frag.description || '', where: 'Settings', template: SETTINGS_TEMPLATE, text: previewText(frag.blocks)});
    seen.add(name);
  }
  for (const e of ctx.doc?.glossary ?? []) {
    if (seen.has(e.name)) continue;
    rows.push({name: e.name, gallery: e.gallery === AUTO_TEXT_GALLERY ? AUTO_TEXT_GALLERY : QUICK_PARTS_GALLERY, category: e.category || 'General', description: e.description || '', where: 'Document', template: DOCUMENT_TEMPLATE, text: previewText(e.blocks)});
  }
  return rows;
}

/** The names the Quick Parts / AutoText galleries list: this session's, then the document's (quick_parts' answer). */
export function blockNames(ctx, gallery) {
  const document = (ctx.doc?.glossary ?? []).filter(e => e.gallery === gallery).map(e => e.name);
  const parts = Object.entries(sessionBlocks(ctx)).filter(([, f]) => galleryOf(f) === gallery).map(([n]) => n);
  for (const n of document) if (!parts.includes(n)) parts.push(n);
  return {parts, document};
}

function quickParts(ctx, p, gallery) {
  const S = open(ctx);
  const inDocument = p.in === 'document';
  let mine = {...sessionBlocks(ctx)};
  let changed = false;
  if (p.save !== undefined) {
    if (isCollapsed(S.sel)) throw bad('select the content to save');
    const [a, b] = ordered(S.sel);
    const frag = S.d.copyRange(a, b);
    if (inDocument) {
      if (!String(p.save).trim()) throw bad('a building block needs a name');
      S.d.updateField('glossary', g => {
        const list = [...(g ?? [])];
        const i = list.findIndex(e => e.name === p.save && e.gallery === gallery);
        const meta = {category: clean(p.category, 255) || list[i]?.category || 'General', description: clean(p.description, 1000) || (list[i]?.description ?? '')};
        if (i >= 0) list[i] = {...list[i], ...meta, blocks: frag.blocks}; else list.push({name: p.save, gallery, ...meta, blocks: frag.blocks});
        return list;
      });
    } else {
      if (Object.keys(mine).length >= MAX_BLOCKS && !mine[p.save]) throw failed(`at most ${MAX_BLOCKS} building blocks are kept`);
      if (JSON.stringify(frag).length > MAX_BLOCK_BYTES) throw failed('that is too much content for a building block');
      mine = {...mine, [p.save]: {...frag, gallery, category: clean(p.category, 255) || 'General', description: clean(p.description, 1000)}};
      changed = true;
    }
  }
  if (p.delete !== undefined) {
    if (inDocument || !mine[p.delete]) {
      const i = documentEntry(S.d.c.glossary ?? [], p.delete, gallery);
      if (i >= 0) S.d.updateField('glossary', g => g.filter((_, k) => k !== i));
    } else { mine = {...mine}; delete mine[p.delete]; changed = true; }
  }
  if (p.insert !== undefined) {
    let frag = mine[p.insert];
    if (!frag) {
      const e = (S.d.c.glossary ?? [])[documentEntry(S.d.c.glossary ?? [], p.insert, gallery)];
      if (!e) throw bad(`no Quick Part \`${p.insert}\``);
      frag = {blocks: structuredClone(e.blocks), parts: {}};
    }
    insertFragment(S, structuredClone({blocks: frag.blocks, parts: frag.parts}));
  }
  if (changed) ctx.updatePrefs({buildingBlocks: mine});
  const names = blockNames({doc: S.d.c, prefs: {buildingBlocks: mine}}, gallery);
  return finish(ctx, S, {edit: p.insert !== undefined || p.save !== undefined || p.delete !== undefined, result: names});
}

/**
 * Edit Properties of the Building Blocks Organizer: the block `name` (kept in the `from` place: settings or document, else wherever it
 * is) takes the name, gallery, category, description and place in `to`; what `to` leaves out stays.
 */
function blockProperties(ctx, p) {
  const S = open(ctx);
  let mine = {...sessionBlocks(ctx)};
  const glossary = S.d.c.glossary ?? [];
  const from = p.from ?? (mine[p.name] ? 'settings' : 'document');
  let cur;
  let at = -1;
  if (from === 'settings') {
    if (!mine[p.name]) throw bad(`no building block \`${p.name}\``);
    const f = mine[p.name];
    cur = {name: p.name, gallery: galleryOf(f), category: f.category || 'General', description: f.description || '', blocks: f.blocks, parts: f.parts ?? {}};
  } else {
    at = documentEntry(glossary, p.name, p.gallery ?? QUICK_PARTS_GALLERY);
    if (at < 0) throw bad(`no building block \`${p.name}\``);
    const e = glossary[at];
    cur = {name: e.name, gallery: e.gallery === AUTO_TEXT_GALLERY ? AUTO_TEXT_GALLERY : QUICK_PARTS_GALLERY, category: e.category || 'General', description: e.description || '', blocks: e.blocks, parts: e.parts ?? {}};
  }
  const to = p.to ?? {};
  const next = {
    name: to.name === undefined ? cur.name : clean(to.name, 256),
    gallery: to.gallery ?? cur.gallery,
    category: to.category === undefined ? cur.category : clean(to.category, 255) || 'General',
    description: to.description === undefined ? cur.description : clean(to.description, 1000),
  };
  if (!next.name) throw bad('a building block needs a name');
  const dest = to.in ?? from;
  // The same name in the same place is another block already.
  const taken = dest === 'settings'
    ? mine[next.name] && !(from === 'settings' && next.name === cur.name)
    : glossary.some((e, k) => e.name === next.name && e.gallery === next.gallery && !(from === 'document' && k === at));
  if (taken) throw failed(`there is a building block called \`${next.name}\` already`);
  let touchedDocument = false;
  if (from === 'settings') { mine = {...mine}; delete mine[cur.name]; }
  else { S.d.updateField('glossary', g => (g ?? []).filter((_, k) => k !== at)); touchedDocument = true; }
  if (dest === 'settings') mine = {...mine, [next.name]: {blocks: cur.blocks, parts: cur.parts, ...next}};
  else {
    S.d.updateField('glossary', g => [...(g ?? []), {name: next.name, gallery: next.gallery, category: next.category, description: next.description, blocks: cur.blocks}]);
    touchedDocument = true;
  }
  if (from === 'settings' || dest === 'settings') ctx.updatePrefs({buildingBlocks: mine});
  return finish(ctx, S, {edit: touchedDocument, result: {name: next.name, gallery: next.gallery, category: next.category, in: dest}});
}

// ---- document property, signature line, text from file -------------------------------------------------

const PROPS = {title: 'title', author: 'creator', creator: 'creator', subject: 'subject', keywords: 'keywords', comments: 'description', description: 'description', category: 'category'};

function docProperty(ctx, p) {
  const S = T.open(ctx);
  const name = String(p.name ?? 'Title');
  const key = PROPS[name.toLowerCase()];
  if (!key) throw bad('unknown property');
  const value = S.d.c.core?.[key] ?? '';
  const lower = name.toLowerCase();
  const instr = lower === 'author' || lower === 'creator' ? 'AUTHOR' : lower === 'title' ? 'TITLE' : `DOCPROPERTY ${lower}`;
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, {type: 'field', instr, result: value}, props);
  S.sel = T.caret(end);
  return T.finish(S);
}

function signatureLine(ctx, p) {
  const S = T.open(ctx);
  const lines = ['X ______________________________'];
  if (p.signer) lines.push(String(p.signer));
  if (p.title) lines.push(String(p.title));
  const at = T.deleteSelection(S);
  const frag = {blocks: lines.map(l => P.styled(P.paragraphWithText(l), 'NoSpacing')), parts: {}};
  const end = S.d.insertFragment(at, frag);
  S.sel = T.caret(end);
  return T.finish(S);
}

async function bytesOf(ctx, p) {
  if (typeof p.data === 'string') return Uint8Array.from(atob(p.data.replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0));
  if (typeof ctx.host?.readFile !== 'function') throw new CommandError('unavailable', 'reading a file by path is not available here; pass `data` (base64)');
  const got = await ctx.host.readFile(p.path);
  return got instanceof Uint8Array ? got : Uint8Array.from(atob(String(got)), c => c.charCodeAt(0));
}

/** Insert › Text › Object › Text from File: the body of another document, in place of the selection (insert.textFromFile). */
async function textFromFile(ctx, p) {
  const bin = await bytesOf(ctx, p);
  const isZip = bin[0] === 0x50 && bin[1] === 0x4b;
  let content;
  try { content = isZip || String(p.path ?? '').toLowerCase().endsWith('.docx') ? await readDocx(bin) : await readTxt(bin); } catch (e) { throw failed(String(e?.message ?? e)); }
  const {Document} = await import('../model/document.mjs');
  const frag = new Document(content).bodyFragment();
  frag.blocks = unlinkSections(frag.blocks);
  const S = open(ctx);
  insertFragment(S, frag);
  return finish(ctx, S, {edit: true});
}

// ---- header & footer navigation ---------------------------------------------------------------------------

/** The header and footer parts of every section, in order (hf_nav's ring). */
function hfParts(d) {
  const ids = [];
  for (const [, sect] of d.sections()) {
    for (const id of [sect.headers?.default, sect.headers?.first, sect.headers?.even, sect.footers?.default, sect.footers?.first, sect.footers?.even]) {
      if (id !== null && id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function hfNav(ctx, dir) {
  const S = T.open(ctx);
  const cur = S.sel.focus.story;
  if (cur === BODY || typeof cur !== 'number') throw new CommandError('disabled', 'edit a header or footer first');
  const ids = hfParts(S.d);
  const i = Math.max(0, ids.indexOf(cur));
  const n = Math.max(ids.length, 1);
  const next = ids[(((i + dir) % n) + n) % n] ?? cur;
  T.setCaret(S, S.d.startOf(next));
  return T.finish(S);
}

/** The section block the header/footer commands act on: the caret's, else the section that uses the part the caret is in (upstream: the caret's first path step). */
function sectionBlock(S) { return sectionBlockOf(S.d, S.sel.focus); }
function sectionBlockOf(d, f) {
  if (f.story === BODY) return f.path[0] ?? 0;
  for (const [end, sect] of d.sections()) {
    const ids = [sect.headers, sect.footers].flatMap(h => [h?.default, h?.first, h?.even]);
    if (ids.includes(f.story)) return end;
  }
  return f.path[0] ?? 0;
}

/** state() of the Header from Top / Footer from Bottom boxes: the distance of the caret's section, in points. */
const distanceState = key => ctx => {
  const r = T.ready(ctx);
  if (!r.enabled) return r;
  try {
    const d = ctx.model.open(ctx);
    const all = ctx.model.selection(ctx);
    const f = d.clamp((all[ctx.selection?.primary ?? 0] ?? all[0]).focus);
    return {enabled: true, value: Math.round((d.sectionOfBlock(sectionBlockOf(d, f))[key] ?? 36) * 100) / 100};
  } catch { return {enabled: true, value: null}; }
};

const inHf = ctx => { const r = T.ready(ctx); return r.enabled ? {enabled: true} : r; };

export default defineCommands({
  family: 'blocks',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'insert.quickParts', label: 'Quick Parts', risk: 'edit', state: galleryState(QUICK_PARTS_GALLERY),
      description: 'Quick Parts: `save` the selection as a building block (`in: "document"` keeps it in the document, else in the person\'s settings), `insert` or `delete` one by name; answers {parts: names (the session\'s, then the document\'s), document: the document\'s Quick Parts}.',
      params: s.object({save: s.optional(NAME), in: s.optional(s.enum(['document'])), category: s.optional(s.string({max: 255})), description: s.optional(s.string({max: 1000})), insert: s.optional(NAME), delete: s.optional(NAME)}), run: (ctx, p) => quickParts(ctx, p, QUICK_PARTS_GALLERY)},
    {id: 'insert.autoText', label: 'AutoText', risk: 'edit', state: galleryState(AUTO_TEXT_GALLERY),
      description: 'AutoText: the same as Quick Parts, for the AutoText gallery.',
      params: s.object({save: s.optional(NAME), in: s.optional(s.enum(['document'])), category: s.optional(s.string({max: 255})), description: s.optional(s.string({max: 1000})), insert: s.optional(NAME), delete: s.optional(NAME)}), run: (ctx, p) => quickParts(ctx, p, AUTO_TEXT_GALLERY)},
    {id: 'insert.buildingBlockProperties', label: 'Edit Building Block Properties', risk: 'edit', state: T.ready,
      description: 'Edit Properties (Building Blocks Organizer): the building block `name` (`from`: where it is kept, else wherever it is) takes the name, gallery, category, description and place (`in`: settings or document) in `to`.',
      params: s.object({name: NAME, from: s.optional(s.enum(['settings', 'document'])), gallery: s.optional(s.enum([QUICK_PARTS_GALLERY, AUTO_TEXT_GALLERY])),
        to: s.object({name: s.optional(NAME), gallery: s.optional(s.enum([QUICK_PARTS_GALLERY, AUTO_TEXT_GALLERY])), category: s.optional(s.string({max: 255})), description: s.optional(s.string({max: 1000})), in: s.optional(s.enum(['settings', 'document']))})}),
      run: blockProperties},
    {id: 'insert.docProperty', label: 'Document Property', risk: 'edit', state: T.ready,
      description: 'Document Property: a field for the Title, Author, Subject, Keywords, Comments or Category of the document, at the caret.',
      params: s.object({name: s.optional(s.string({max: 64}))}), run: docProperty},
    {id: 'insert.signatureLine', label: 'Signature Line', risk: 'edit', state: T.ready,
      description: 'Signature Line: a line to sign on ("X ____"), with the signer and title below it when given.',
      params: s.object({signer: s.optional(s.string({max: 256})), title: s.optional(s.string({max: 256}))}), run: signatureLine},
    {id: 'insert.textFromFile', label: 'Text from File', risk: 'edit', state: T.ready,
      description: 'Text from File: the body of another document (`data`: its bytes, base64, `path` naming its format; else the host reads `path`) in place of the selection.',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 60_000_000}))}), run: textFromFile},
    {id: 'insert.object', label: 'Object', risk: 'edit', state: T.ready,
      description: 'Object: inserts the text of a file (the same as Text from File).',
      params: s.object({path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 60_000_000}))}), run: (ctx, p) => ctx.run('insert.textFromFile', p)},
    {id: 'hf.next', label: 'Next Section', risk: 'read', effect: 'view', state: inHf, description: 'Next Section (Header & Footer › Navigation): the caret goes to the next header or footer.', params: s.object({}), run: ctx => hfNav(ctx, 1)},
    {id: 'hf.previous', label: 'Previous Section', risk: 'read', effect: 'view', state: inHf, description: 'Previous Section (Header & Footer › Navigation): the caret goes to the previous header or footer.', params: s.object({}), run: ctx => hfNav(ctx, -1)},
    {id: 'layout.linkToPrevious', label: 'Link to Previous', risk: 'edit', state: T.ready,
      description: 'Link to Previous: the section\'s headers (or footers with `footer`) are the previous section\'s again.', params: s.object({footer: s.optional(s.boolean())}),
      run(ctx, p) {
        const S = T.open(ctx);
        const header = p.footer === undefined ? true : !p.footer;
        S.d.updateSection(sectionBlock(S), sc => { sc[header ? 'headers' : 'footers'] = {default: null, first: null, even: null}; });
        return T.finish(S, {linked: true});
      }},
    {id: 'hf.headerFromTop', label: 'Header from Top', risk: 'edit', state: distanceState('header'),
      description: 'Header from Top: the distance in points of the section\'s header from the top of the page (hf.position with a box that shows it).', params: s.object({distance: s.number()}),
      run: (ctx, p) => ctx.run('hf.position', {header: p.distance})},
    {id: 'hf.footerFromBottom', label: 'Footer from Bottom', risk: 'edit', state: distanceState('footer'),
      description: 'Footer from Bottom: the distance in points of the section\'s footer from the bottom of the page (hf.position with a box that shows it).', params: s.object({distance: s.number()}),
      run: (ctx, p) => ctx.run('hf.position', {footer: p.distance})},
    {id: 'hf.position', label: 'Header/Footer Position', risk: 'edit', state: T.ready,
      description: 'Header from Top / Footer from Bottom: the distance in points (0 to 300) of the section\'s header from the top and footer from the bottom of the page.',
      params: s.object({header: s.optional(s.number()), footer: s.optional(s.number())}),
      run(ctx, p) {
        const S = T.open(ctx);
        const block = sectionBlock(S);
        const clamp = v => Math.min(300, Math.max(0, v));
        S.d.updateSection(block, sc => { if (Number.isFinite(p.header)) sc.header = clamp(p.header); if (Number.isFinite(p.footer)) sc.footer = clamp(p.footer); });
        const sect = S.d.sectionOfBlock(block);
        return T.finish(S, {header: sect.header, footer: sect.footer});
      }},
  ],
});
