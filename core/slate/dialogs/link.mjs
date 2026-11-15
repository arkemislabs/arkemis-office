// Link (Insert › Links › Link, Ctrl+K; submit: link.insert). OneNote's dialog: Text to display,
// Address, and "Or pick a location in OneNote": a search box over the notebook's sections and
// pages, plus "Create a new page with this title". Slate has no ArtCraft upstream. The location
// list is the notebook (sections in their groups, each with its pages); picking one links to it.
import {defineDialog} from '../../kernel/dialog.mjs';
import {isNotebook} from '../schema.mjs';
import {treeEntries} from '../model/notebook.mjs';
import {textRange, charRange} from '../lib/format-text.mjs';
import {linkExtent, parseInternalLink} from '../commands/insert.mjs';

/** The notebook as a flat list: [{value: 'section:<id>' | 'page:<id>', label, level}] (groups are headings). */
export function locationOptions(content) {
  const out = [];
  if (!isNotebook(content)) return out;
  for (const e of treeEntries(content)) {
    if (e.kind === 'group') { out.push({value: `group:${e.id}`, label: content.groups[e.id].name, level: e.depth, group: true}); continue; }
    const sec = content.sections[e.id];
    out.push({value: `section:${e.id}`, label: sec.name, level: e.depth});
    for (const pg of sec.pages) out.push({value: `page:${pg.id}`, label: content.pages[pg.id].title || 'Untitled page', level: e.depth + 1 + pg.level});
  }
  return out;
}

export default defineDialog({
  id: 'dialog.link',
  title: 'Link',
  command: 'link.insert',
  init(ctx) {
    let text = '', address = '', location = null;
    const range = textRange(ctx);
    if (range && range.kind === 'text') {
      const ext = range.from === range.to ? linkExtent(range.doc, range.from) : null;
      const sel = ext ?? (range.from !== range.to ? {from: range.from, to: range.to} : charRange(range));
      if (sel && range.doc.resolve(sel.from).parent === range.doc.resolve(sel.to).parent) text = range.doc.textBetween(sel.from, sel.to, undefined, '');
      if (ext) {
        const internal = parseInternalLink(ext.href);
        if (internal) location = `${internal.kind}:${internal.id}`; else address = ext.href;
      }
    }
    return {textToDisplay: text, address, search: '', location, createNewPage: false, locations: locationOptions(ctx.doc)};
  },
  derive(v, changed) {
    // Picking a location clears the address and the other way round; a new page needs no location.
    if (changed.includes('location') && v.location) return {address: '', createNewPage: false};
    if (changed.includes('address') && String(v.address ?? '').trim()) return {location: null, createNewPage: false};
    if (changed.includes('createNewPage') && v.createNewPage) return {location: null, address: ''};
    return {};
  },
  validate(v) {
    if (v.createNewPage) return String(v.textToDisplay ?? '').trim() ? [] : [{field: 'textToDisplay', message: 'Type the title of the new page in Text to display.'}];
    if (v.location) return [];
    return String(v.address ?? '').trim() ? [] : [{field: 'address', message: 'Type an address, or pick a location in the notebook.'}];
  },
  toCommand(v) {
    const params = {};
    const text = String(v.textToDisplay ?? '');
    if (text.trim()) params.text = text;
    if (v.createNewPage) params.createPage = true;
    else if (v.location) {
      const [kind, ...rest] = String(v.location).split(':');
      params[kind === 'section' ? 'section' : 'page'] = rest.join(':');
    } else params.address = String(v.address).trim();
    return {command: 'link.insert', params};
  },
});
