// Schema 1 -> schema 2 for Slate (docs/architecture.md 16.1 pattern; F:slate foundation).
//
// A schema-1 Slate file is one page from the legacy TipTap editor: `content.doc` (ProseMirror
// JSON with TipTap node names), page-level `tags`, and the notebook and section it was filed under
// as strings. The interim page commands may have added `content.outline` (sections and pages of
// the notebook, kept inside the page). Migration builds a schema-2 notebook from that:
//
//   * the notebook is `content.notebook` (or "My Notebook"); sections come from the outline, else
//     one section named `content.section` (or "Quick Notes");
//   * the file itself becomes the page whose id is the file id (title = file title, created =
//     file createdAt), its body one note container holding the converted blocks;
//   * other outline pages become empty pages with their titles, levels and dates;
//   * TipTap nodes map to OneNote's: headings become Heading 1–6 paragraphs, blockquotes Quote,
//     code blocks Code paragraphs, table headers cells of a header-row table; page breaks,
//     horizontal rules and Word fields (not OneNote concepts) are dropped; marks keep bold,
//     italic, underline, strike, sub/superscript, highlight, font (textStyle) and links.
//
// No DOM, no Node built-ins.

import {CONTENT_VERSION, NOTEBOOK_FORMAT, NOTEBOOK_COLORS, SECTION_COLORS, newPageRecord, schema, validateContent, LIMITS} from './schema.mjs';

const ALIGN = new Set(['left', 'center', 'right', 'justify']);

/** Marks in the schema's order, one textStyle (merged), sub- and superscript exclusive. */
function normalizeMarks(list) {
  const style = list.filter(m => m.type === 'textStyle');
  const merged = style.length ? [{type: 'textStyle', attrs: style.reduce((a, m) => ({color: m.attrs.color ?? a.color, fontFamily: m.attrs.fontFamily ?? a.fontFamily, fontSize: m.attrs.fontSize ?? a.fontSize}), {color: null, fontFamily: null, fontSize: null})}] : [];
  const seen = new Set();
  const out = [];
  for (const m of [...list.filter(x => x.type !== 'textStyle'), ...merged]) {
    if (seen.has(m.type) || (m.type === 'subscript' && seen.has('superscript')) || (m.type === 'superscript' && seen.has('subscript'))) continue;
    seen.add(m.type);
    out.push(m);
  }
  const rank = t => { const i = Object.keys(schema.marks).indexOf(t); return i < 0 ? 99 : i; };
  return out.sort((a, b) => rank(a.type) - rank(b.type));
}

function convertMarks(marks) {
  return normalizeMarks(rawMarks(marks));
}

function rawMarks(marks) {
  const out = [];
  for (const m of marks ?? []) {
    switch (m?.type) {
      case 'bold': case 'italic': case 'underline': case 'strike': case 'subscript': case 'superscript':
        out.push({type: m.type}); break;
      case 'highlight': out.push({type: 'highlight', attrs: {color: typeof m.attrs?.color === 'string' ? m.attrs.color : '#ffff00'}}); break;
      case 'link': if (typeof m.attrs?.href === 'string') out.push({type: 'link', attrs: {href: m.attrs.href, title: m.attrs.title ?? null}}); break;
      case 'code': out.push({type: 'textStyle', attrs: {color: null, fontFamily: 'Consolas', fontSize: null}}); break;
      case 'textStyle': {
        const a = m.attrs ?? {};
        const size = typeof a.fontSize === 'number' ? a.fontSize : typeof a.fontSize === 'string' ? Number.parseFloat(a.fontSize) : null;
        const v = {color: typeof a.color === 'string' ? a.color : null, fontFamily: typeof a.fontFamily === 'string' ? a.fontFamily : null,
          fontSize: Number.isFinite(size) && size > 0 ? size : null};
        if (v.color || v.fontFamily || v.fontSize) out.push({type: 'textStyle', attrs: v});
        break;
      }
      default: break;
    }
  }
  return out;
}

function convertInline(nodes, newId) {
  const out = [];
  for (const n of nodes ?? []) {
    if (n?.type === 'text' && typeof n.text === 'string' && n.text) {
      const marks = convertMarks(n.marks);
      out.push(marks.length ? {type: 'text', text: n.text, marks} : {type: 'text', text: n.text});
    } else if (n?.type === 'hardBreak') out.push({type: 'hardBreak'});
    else if (n?.type === 'image' && typeof n.attrs?.src === 'string') {
      out.push({type: 'image', attrs: {id: newId(), src: n.attrs.src, alt: n.attrs.alt ?? '', title: n.attrs.title ?? null,
        width: Number.isFinite(n.attrs.width) ? n.attrs.width : null, height: Number.isFinite(n.attrs.height) ? n.attrs.height : null}});
    }
  }
  return out;
}

const para = (newId, inline, attrs = {}) => ({type: 'paragraph', attrs: {id: newId(), style: 'normal', align: null, indent: 0, dir: null, tags: [], spacing: null, audio: null, ...attrs},
  ...(inline.length ? {content: inline} : {})});

function convertBlocks(nodes, newId, style) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!n || typeof n !== 'object') continue;
    const align = ALIGN.has(n.attrs?.textAlign) ? n.attrs.textAlign : null;
    switch (n.type) {
      case 'paragraph': out.push(para(newId, convertInline(n.content, newId), {style: style ?? 'normal', align})); break;
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
        out.push(para(newId, convertInline(n.content, newId), {style: `h${level}`, align}));
        break;
      }
      case 'blockquote': out.push(...convertBlocks(n.content, newId, 'quote')); break;
      case 'codeBlock': {
        const text = (n.content ?? []).map(t => t.text ?? '').join('');
        for (const line of text.split('\n')) out.push(para(newId, line ? [{type: 'text', text: line}] : [], {style: 'code'}));
        break;
      }
      case 'bulletList': case 'orderedList': {
        const items = (n.content ?? []).filter(i => i?.type === 'listItem').map(i => {
          const inner = convertBlocks(i.content, newId, style);
          if (!inner.length || inner[0].type !== 'paragraph') inner.unshift(para(newId, []));
          return {type: 'listItem', attrs: {id: newId()}, content: inner};
        });
        if (items.length) out.push(n.type === 'bulletList' ? {type: 'bulletList', attrs: {id: newId(), symbol: null}, content: items}
          : {type: 'orderedList', attrs: {id: newId(), start: Number.isInteger(n.attrs?.start) ? n.attrs.start : 1, format: 'decimal'}, content: items});
        break;
      }
      case 'table': {
        let header = false;
        const rows = (n.content ?? []).filter(r => r?.type === 'tableRow').map((r, ri) => {
          const cells = (r.content ?? []).filter(c => c?.type === 'tableCell' || c?.type === 'tableHeader').map(c => {
            if (ri === 0 && c.type === 'tableHeader') header = true;
            const inner = convertBlocks(c.content, newId, style);
            return {type: 'tableCell', attrs: {id: newId(), shading: null}, content: inner.length ? inner : [para(newId, [])]};
          });
          return cells.length ? {type: 'tableRow', attrs: {id: newId()}, content: cells} : null;
        }).filter(Boolean);
        if (rows.length) out.push({type: 'table', attrs: {id: newId(), hideBorders: false, headerRow: header, widths: null}, content: rows});
        break;
      }
      case 'image': out.push(para(newId, convertInline([n], newId))); break;
      default: break;   // horizontalRule, pageBreak, wordField: not OneNote concepts
    }
  }
  return out;
}

const randomId = () => {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};
const cut = (s, n) => String(s ?? '').slice(0, n);
const validTime = s => typeof s === 'string' && !Number.isNaN(Date.parse(s));

/** The body of the migrated page: one note container with the converted blocks (none when empty). */
export function migrateBody(doc, newId) {
  const blocks = convertBlocks(doc?.content, newId);
  const meaningful = blocks.some(b => b.type !== 'paragraph' || b.content?.length);
  if (!meaningful) return {type: 'doc'};
  return {type: 'doc', content: [{type: 'container', attrs: {id: newId(), x: 48, y: 128, width: 624}, content: blocks}]};
}

/**
 * Schema-1 Slate content -> schema-2 notebook content.
 * @param {object} c schema-1 content
 * @param {{id: string, title?: string, created?: string, uid?: () => string, now?: string}} file
 */
export function migrateContent(c, file) {
  const make = file.uid ?? randomId;
  const newId = () => `b${make()}`;
  const now = file.now ?? new Date().toISOString();
  const created = validTime(file.created) ? file.created : now;
  const pageId = file.id;
  const notebookName = cut(typeof c?.notebook === 'string' && c.notebook.trim() ? c.notebook.trim() : 'My Notebook', LIMITS.nameLength);
  const page = {...newPageRecord({id: pageId, title: cut(file.title ?? '', LIMITS.titleLength), created}), body: migrateBody(c?.doc, newId)};
  if (Array.isArray(c?.tags) && c.tags.length) page.tags = c.tags.filter(t => typeof t === 'string').slice(0, 100);
  const pages = {[pageId]: page};
  const sections = {};
  const tree = [];
  const outline = c?.outline && Array.isArray(c.outline.sections) ? c.outline : null;
  if (outline) {
    for (const [i, s] of outline.sections.entries()) {
      if (!s || typeof s.id !== 'string' || sections[s.id]) continue;
      const entries = [];
      for (const p of s.pages ?? []) {
        if (!p || typeof p.id !== 'string') continue;
        if (!pages[p.id]) pages[p.id] = newPageRecord({id: p.id, title: cut(p.title ?? '', LIMITS.titleLength), created: validTime(p.created) ? p.created : now});
        else if (p.id !== pageId) continue;
        if (entries.some(e => e.id === p.id) || Object.values(sections).some(x => x.pages.some(e => e.id === p.id))) continue;
        entries.push({id: p.id, level: Math.min(2, Math.max(0, Number(p.level) || 0))});
      }
      sections[s.id] = {id: s.id, name: cut(s.name || `New Section ${i + 1}`, LIMITS.nameLength), color: /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color : SECTION_COLORS[i % SECTION_COLORS.length],
        created, pages: entries};
      tree.push(s.id);
    }
  }
  const placed = Object.values(sections).some(s => s.pages.some(e => e.id === pageId));
  if (!placed) {
    const sid = tree[0] ?? `s${make()}`;
    if (!sections[sid]) {
      sections[sid] = {id: sid, name: cut(typeof c?.section === 'string' && c.section.trim() ? c.section.trim() : 'Quick Notes', LIMITS.nameLength), color: SECTION_COLORS[0], created, pages: []};
      tree.push(sid);
    }
    sections[sid].pages.unshift({id: pageId, level: 0});
  }
  const content = {
    format: NOTEBOOK_FORMAT, version: CONTENT_VERSION,
    notebook: {id: outline?.notebook?.id && /^[A-Za-z0-9_-]{1,80}$/.test(outline.notebook.id) ? outline.notebook.id : `nb${make()}`, name: notebookName,
      color: NOTEBOOK_COLORS[0], created, path: null},
    tree, groups: {}, sections, pages,
  };
  // Every page body must be valid in the Slate schema before the notebook is used.
  for (const p of Object.values(pages)) schema.nodeFromJSON(p.body).check();
  return validateContent(content);
}

/** A schema-1 Slate file -> a schema-2 file (same id, title and dates). Schema-2 files pass through. */
export function migrateFile(file, opts = {}) {
  if (file?.schema === 2) return file;
  if (file?.schema !== 1 || file.kind !== 'slate') throw new Error('migrateFile takes a schema-1 Slate file');
  return {...file, schema: 2, content: migrateContent(file.content, {id: file.id, title: file.title, created: file.createdAt, ...opts})};
}
