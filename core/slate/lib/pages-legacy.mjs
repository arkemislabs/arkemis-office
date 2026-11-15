// Schema-1 Slate pages (the legacy single-page editor) keep the interim notebook outline
// (core/slate/lib/pages-outline.mjs) until they are migrated to a notebook
// (core/slate/migrate.mjs turns the outline into sections and pages). New Page, New Page Below,
// New Subpage and New Section work there as they did before the notebook model (U:slate/pages).
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {SECTION_COLORS, findSection, newPage, outlineOf, saveOutline} from './pages-outline.mjs';

/** A schema-1 page (ProseMirror `content.doc`) is open. */
export const isLegacyPage = ctx => !!ctx.doc?.doc;

function insertPage(ctx, outline, si, after, page) {
  const sec = outline.sections[si];
  const pagesNext = [...sec.pages.slice(0, after + 1), page, ...sec.pages.slice(after + 1)];
  const sections = outline.sections.map((x, i) => (i === si ? {...sec, pages: pagesNext} : x));
  saveOutline(ctx, {...outline, sections, current: {sectionId: sec.id, pageId: page.id}});
  return {page: page.id, section: sec.id, index: after + 1, level: page.level};
}

function currentPage(outline) {
  const si = Math.max(0, findSection(outline, outline.current?.sectionId));
  const pi = outline.sections[si].pages.findIndex(p => p.id === outline.current?.pageId);
  return {si, pi};
}

function endOfFamily(pages, pi) {
  let end = pi;
  while (end + 1 < pages.length && pages[end + 1].level > pages[pi].level) end++;
  return end;
}

export function legacyNewPage(ctx, p) {
  if (p.templateId !== undefined) throw new CommandError('invalid_params', 'Templates need a notebook', {path: '/templateId'});
  const outline = outlineOf(ctx);
  const si = p.sectionId === undefined ? currentPage(outline).si : findSection(outline, p.sectionId);
  if (si < 0) throw new CommandError('not_found', `No section ${p.sectionId}`, {path: '/sectionId'});
  const pages = outline.sections[si].pages;
  let after = pages.length - 1;
  if (p.afterPageId !== undefined) {
    const at = pages.findIndex(pg => pg.id === p.afterPageId);
    if (at < 0) throw new CommandError('not_found', `No page ${p.afterPageId} in that section`, {path: '/afterPageId'});
    after = at;
  }
  return insertPage(ctx, outline, si, after, newPage(ctx, 0));
}

export function legacyNewBelow(ctx, sub) {
  const outline = outlineOf(ctx);
  const {si, pi} = currentPage(outline);
  const pages = outline.sections[si].pages;
  const level = pi < 0 ? 0 : pages[pi].level;
  if (sub && level >= 2) throw new CommandError('disabled', 'Subpages can only be two levels deep');
  return insertPage(ctx, outline, si, pi < 0 ? pages.length - 1 : endOfFamily(pages, pi), newPage(ctx, sub ? level + 1 : level));
}

export function legacySubpageLevel(ctx) {
  const outline = outlineOf(ctx);
  const {si, pi} = currentPage(outline);
  return pi < 0 ? 0 : outline.sections[si].pages[pi].level;
}

export function legacyNewSection(ctx, p) {
  const outline = outlineOf(ctx);
  if (p.notebookId !== undefined && p.notebookId !== outline.notebook.id) throw new CommandError('not_found', `No notebook ${p.notebookId} here`, {path: '/notebookId'});
  if (p.groupId !== undefined) throw new CommandError('invalid_params', 'Section groups need a notebook', {path: '/groupId'});
  const used = new Set(outline.sections.map(x => x.name.toLowerCase()));
  let name = p.name;
  if (name === undefined) for (let n = 1; ; n++) if (!used.has(`new section ${n}`)) { name = `New Section ${n}`; break; }
  if (used.has(name.toLowerCase())) throw new CommandError('invalid_params', `A section named ${name} already exists`, {path: '/name'});
  const page = newPage(ctx, 0);
  const section = {id: `sec-${ctx.host.uid()}`, name, color: SECTION_COLORS[outline.sections.length % SECTION_COLORS.length], pages: [page]};
  const at = Math.max(0, findSection(outline, outline.current?.sectionId)) + 1;
  const sections = [...outline.sections.slice(0, at), section, ...outline.sections.slice(at)];
  if (ctx.doc.outline && at < outline.sections.length) ctx.change.set(['outline', 'sections'], sections);
  saveOutline(ctx, {...outline, sections, current: {sectionId: section.id, pageId: page.id}});
  return {section: section.id, name, page: page.id, index: at};
}
