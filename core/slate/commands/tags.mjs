// Tags: Home › Tags gallery, To Do Tag, Find Tags (Tags Summary), Customize Tags (U:slate/tags).
//
// Slate has no ArtCraft upstream: ids and args are docs/spec/slate.json `tag.*`, `tags.*` and
// the Arkemis `note.tags` extension (sourceRef core/slate-tags.mjs); behaviour is OneNote's:
//   * a gallery tag (Ctrl+1..9 for the first nine) tags the selected paragraphs, or removes it
//     when every one already has it; a check box tag cycles unchecked → checked → removed, as
//     pressing Ctrl+1 repeatedly does; clicking the box checks or unchecks it (tag.check);
//   * Remove Tag (Ctrl+0) removes every tag from the selected paragraphs;
//   * Customize Tags lists the tags in gallery order (Move up / down, New Tag, Modify Tag,
//     Remove tag); the list is the person's, kept in prefs, and tagged notes keep their look;
//   * Find Tags opens the Tags Summary: tagged notes grouped by tag name, section, page title,
//     date or note text, searched in this section, section group, notebook, or by date
//     (today, yesterday, this week, last week, older), optionally unchecked items only;
//     Create Summary Page writes them to a new page at the end of the current section.
// The tag record a paragraph carries is core/slate/lib/tags-catalog.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {Fragment} from '@tiptap/pm/model';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {blockIndex, textOf} from '../model/page.mjs';
import {addPage, currentLocation, parentOf, sectionOrder, selectPage, setPageTitle} from '../model/notebook.mjs';
import {editPage, needRange, textRange, textState, textblocksIn} from '../lib/format-text.mjs';
import {MAX_TAGS, PREF, TAG_SYMBOLS, findTag, tagIcon, tagList, tagRecord} from '../lib/tags-catalog.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/tag.*', 'core/slate-tags.mjs']};
const iso = ctx => new Date(ctx.host.now()).toISOString();
const colorOrNull = s.optional(s.nullable(s.string({pattern: '^#[0-9a-fA-F]{6}$'})));

export const GROUP_BY = Object.freeze(['tag-name', 'section', 'title', 'date', 'note-text']);
export const SCOPES = Object.freeze(['section', 'section-group', 'notebook', 'today', 'yesterday', 'this-week', 'last-week', 'older']);
export const SUMMARY_TITLE = 'Tags Summary';

const paragraphsOf = ctx => {
  const range = needRange(ctx);
  const blocks = textblocksIn(range.doc, range.from, range.to).filter(b => b.node.type === schema.nodes.paragraph);
  if (!blocks.length) throw new CommandError('disabled', 'Click in a paragraph to tag it');
  return {range, blocks};
};

/** Write a paragraph's tags. */
const setTags = (tr, b, tags) => tr.setNodeAttribute(b.pos, 'tags', tags);

function saveTags(ctx, list) {
  ctx.updatePrefs({[PREF]: list.map(t => ({id: t.id, name: t.name, symbol: t.symbol, fontColor: t.fontColor ?? null, highlightColor: t.highlightColor ?? null}))});
}

function checkDefinition(p, list, own) {
  const name = p.displayName?.trim();
  if (name !== undefined) {
    if (!name) throw new CommandError('invalid_params', 'Type a display name for the tag', {path: '/displayName'});
    if (list.some(t => t.id !== own && t.name.toLowerCase() === name.toLowerCase())) throw new CommandError('invalid_params', `A tag named ${name} already exists`, {path: '/displayName'});
  }
  if (p.symbol !== undefined && !TAG_SYMBOLS.includes(p.symbol)) throw new CommandError('invalid_params', `Unknown symbol ${p.symbol}`, {path: '/symbol'});
}

// ---------------------------------------------------------------------------------------------
// Tags Summary

const DAY = 86400000;
function dateBucket(ms, now) {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const weekStart = today - d.getDay() * DAY;
  if (ms >= today) return 'today';
  if (ms >= today - DAY) return 'yesterday';
  if (ms >= weekStart) return 'this-week';
  if (ms >= weekStart - 7 * DAY) return 'last-week';
  return 'older';
}
const BUCKET_NAMES = {today: 'Today', yesterday: 'Yesterday', 'this-week': 'Earlier This Week', 'last-week': 'Last Week', older: 'Older'};

/** Every tagged paragraph in scope: [{pageId, blockId, text, tag, section, sectionName, page, when}]. */
export function collectTags(ctx, {scope = 'notebook', uncheckedOnly = false} = {}) {
  const c = ctx.doc;
  const here = currentLocation(c, ctx.selection);
  let sections = sectionOrder(c);
  if (scope === 'section') sections = here.sectionId ? [here.sectionId] : [];
  if (scope === 'section-group') {
    const where = here.sectionId ? parentOf(c, here.sectionId) : null;
    if (where?.parent) {
      const inGroup = new Set();
      const walk = gid => { for (const id of c.groups[gid].items) { if (c.sections[id]) inGroup.add(id); else if (c.groups[id]) walk(id); } };
      walk(where.parent);
      sections = sections.filter(id => inGroup.has(id));
    }
  }
  const now = ctx.host.now();
  const out = [];
  for (const sid of sections) {
    for (const entry of c.sections[sid].pages) {
      const page = c.pages[entry.id];
      const doc = nodeOf(page.body);
      for (const [blockId, hit] of blockIndex(doc)) {
        const tags = hit.node.type === schema.nodes.paragraph ? hit.node.attrs.tags : null;
        if (!tags?.length) continue;
        for (const tg of tags) {
          if (uncheckedOnly && tg.checkbox && tg.checked) continue;
          if (uncheckedOnly && !tg.checkbox) continue;
          const when = Date.parse(tg.created ?? page.modified) || Date.parse(page.modified);
          if (SCOPES.indexOf(scope) >= 3 && dateBucket(when, now) !== scope) continue;
          out.push({pageId: entry.id, blockId, text: textOf(hit.node), tag: tg, section: sid, sectionName: c.sections[sid].name, page: page.title, when: new Date(when).toISOString()});
        }
      }
    }
  }
  return out;
}

/** Group tagged notes as the Tags Summary pane does. */
export function groupTags(items, groupBy = 'tag-name', now = Date.now()) {
  const key = it => (groupBy === 'section' ? it.sectionName : groupBy === 'title' ? it.page || 'Untitled page'
    : groupBy === 'date' ? BUCKET_NAMES[dateBucket(Date.parse(it.when), now)] : groupBy === 'note-text' ? (it.text.trim()[0] ?? '').toUpperCase() || '#' : it.tag.name);
  const groups = new Map();
  for (const it of items) {
    const k = key(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const order = groupBy === 'date' ? Object.values(BUCKET_NAMES) : null;
  const names = [...groups.keys()];
  names.sort(order ? (a, b) => order.indexOf(a) - order.indexOf(b) : groupBy === 'tag-name' || groupBy === 'section' || groupBy === 'title' ? () => 0 : (a, b) => a.localeCompare(b));
  if (groupBy === 'note-text') for (const k of names) groups.get(k).sort((a, b) => a.text.localeCompare(b.text));
  return names.map(name => ({name, items: groups.get(name)}));
}

const summaryParams = s.object({
  groupBy: s.optional(s.enum(GROUP_BY)),
  scope: s.optional(s.enum(SCOPES)),
  uncheckedOnly: s.optional(s.boolean()),
});

function summary(ctx, p) {
  const items = collectTags(ctx, p);
  return {groupBy: p.groupBy ?? 'tag-name', scope: p.scope ?? 'notebook', uncheckedOnly: !!p.uncheckedOnly, count: items.length,
    groups: groupTags(items, p.groupBy ?? 'tag-name', ctx.host.now()).map(g => ({name: g.name, items: g.items.map(it => ({
      address: `/pg:${it.pageId}/b:${it.blockId}`, text: it.text, tag: it.tag.id, tagName: it.tag.name, symbol: it.tag.symbol,
      checkbox: it.tag.checkbox, checked: it.tag.checked, section: it.sectionName, page: it.page}))}))};
}

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'tags',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'tag.toggle', label: 'Tags', risk: 'edit',
      description: 'Tag the selected paragraphs (or remove the tag when all have it); a check box tag cycles unchecked, checked, removed.',
      params: s.object({tagId: s.optional(s.string({min: 1, max: 120, description: 'Tag id from the gallery, e.g. to-do, important'})), value: s.optional(s.string({min: 1, max: 120, description: 'A gallery tile: the tag id'}))}),
      // The gallery: one drawn tile per tag in the person's order (its icon and name), those the paragraph has selected.
      state(ctx, p) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        if (p?.tagId && !findTag(ctx.prefs, p.tagId)) return {enabled: false, reason: `There is no tag ${p.tagId}`};
        const para = textblocksIn(range.doc, range.from, range.to).find(b => b.node.type === schema.nodes.paragraph);
        const have = para?.node.attrs.tags ?? [];
        if (!p?.tagId) return {enabled: !!para, ...(para ? {} : {reason: 'Click in a paragraph to tag it'}), value: tagList(ctx.prefs).map(d => ({id: d.id, label: d.name, value: d.id, icon: tagIcon(d), selected: have.some(t => t.id === d.id)}))};
        const has = have.find(t => t.id === p.tagId);
        return {enabled: !!para, ...(para ? {} : {reason: 'Click in a paragraph to tag it'}), checked: !!has, value: has ? {checked: has.checked} : null};
      },
      run(ctx, p) {
        const tagId = p.tagId ?? p.value;
        const def = tagId ? findTag(ctx.prefs, tagId) : null;
        if (!def) throw new CommandError(tagId ? 'not_found' : 'invalid_params', tagId ? `There is no tag ${tagId}` : 'Give the tag', {path: '/tagId'});
        const {range, blocks} = paragraphsOf(ctx);
        const has = b => b.node.attrs.tags.find(t => t.id === def.id);
        const all = blocks.every(has);
        let action;
        editPage(ctx, range.pageId, tr => {
          for (const b of blocks) {
            const cur = has(b);
            if (!all) { if (!cur) setTags(tr, b, [...b.node.attrs.tags, tagRecord(def, iso(ctx))]); action = 'added'; continue; }
            if (cur.checkbox && !blocks.every(x => has(x).checked)) {
              setTags(tr, b, b.node.attrs.tags.map(t => (t.id === def.id ? {...t, checked: true} : t)));
              action = 'checked';
            } else {
              setTags(tr, b, b.node.attrs.tags.filter(t => t.id !== def.id));
              action = 'removed';
            }
          }
        }, range.doc);
        return {tag: def.id, action, paragraphs: blocks.length};
      },
    },
    {
      id: 'tag.removeAll', label: 'Remove Tag', shortcut: 'Mod+0', risk: 'edit',
      description: 'Remove every tag from the selected paragraphs.',
      params: s.object({}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        return textblocksIn(range.doc, range.from, range.to).some(b => b.node.attrs.tags?.length) ? {enabled: true} : {enabled: false, reason: 'The selection has no tags'};
      },
      run(ctx) {
        const {range, blocks} = paragraphsOf(ctx);
        const tagged = blocks.filter(b => b.node.attrs.tags.length);
        editPage(ctx, range.pageId, tr => { for (const b of tagged) setTags(tr, b, []); }, range.doc);
        return {paragraphs: tagged.length};
      },
    },
    {
      id: 'tag.check', label: 'Check Tag', risk: 'edit',
      description: 'Check or uncheck the check box tag of a paragraph (clicking the box).',
      params: s.object({
        paragraphId: s.string({min: 1, max: 80, description: 'Block id of the tagged paragraph'}),
        checked: s.boolean(),
        pageId: s.optional(s.string({min: 1, max: 80, description: 'Page of the paragraph (default: the current page)'})),
        tagId: s.optional(s.string({min: 1, max: 120, description: 'Which check box tag (default: the paragraph\'s first)'})),
      }),
      run(ctx, p) {
        if (!isNotebook(ctx.doc)) throw new CommandError('disabled', 'No notebook is open');
        const pageId = p.pageId ?? currentLocation(ctx.doc, ctx.selection).pageId;
        const page = ctx.doc.pages[pageId];
        if (!page) throw new CommandError('not_found', `No page ${pageId}`, {path: '/pageId'});
        const doc = nodeOf(page.body);
        const hit = blockIndex(doc).get(p.paragraphId);
        if (!hit || hit.node.type !== schema.nodes.paragraph) throw new CommandError('not_found', `No paragraph ${p.paragraphId} on this page`, {path: '/paragraphId'});
        const tags = hit.node.attrs.tags;
        const target = tags.find(t => t.checkbox && (p.tagId === undefined || t.id === p.tagId));
        if (!target) throw new CommandError('not_found', 'That paragraph has no check box tag', {path: '/paragraphId'});
        if (target.checked === p.checked) return {checked: p.checked, changed: false};
        editPage(ctx, pageId, tr => tr.setNodeAttribute(hit.pos, 'tags', tags.map(t => (t === target ? {...t, checked: p.checked} : t))), doc);
        return {checked: p.checked, changed: true};
      },
    },
    {
      id: 'tag.customize', label: 'Customize Tags...', risk: 'read', dialog: 'dialog.customize-tags',
      description: 'List the tags in gallery order (Customize Tags).',
      params: s.object({}),
      run: ctx => ({tags: tagList(ctx.prefs).map((t, i) => ({...t, shortcut: i < 9 ? `Ctrl+${i + 1}` : null}))}),
    },
    {
      id: 'tag.create', label: 'New Tag', risk: 'edit', effect: 'prefs', undo: 'none', dialog: 'dialog.tag-editor',
      description: 'Add a custom tag at the top of the tag list.',
      params: s.object({
        displayName: s.string({min: 1, max: 100, trim: true}),
        symbol: s.optional(s.string({max: 40})),
        fontColor: colorOrNull,
        highlightColor: colorOrNull,
      }),
      run(ctx, p) {
        const list = tagList(ctx.prefs);
        if (list.length >= MAX_TAGS) throw new CommandError('too_large', `You can have at most ${MAX_TAGS} tags`);
        checkDefinition(p, list, null);
        const def = {id: `custom-${ctx.host.uid()}`, name: p.displayName.trim(), symbol: p.symbol ?? 'none', fontColor: p.fontColor ?? null, highlightColor: p.highlightColor ?? null};
        // OneNote puts a new tag at the top of the list.
        saveTags(ctx, [def, ...list]);
        return {tag: def};
      },
    },
    {
      id: 'tag.modify', label: 'Modify Tag', risk: 'edit', effect: 'prefs', undo: 'none', dialog: 'dialog.tag-editor',
      description: 'Change a tag\'s name, symbol or colours (notes tagged before keep their look).',
      params: s.object({
        tagId: s.string({min: 1, max: 120}),
        displayName: s.optional(s.string({min: 1, max: 100, trim: true})),
        symbol: s.optional(s.string({max: 40})),
        fontColor: colorOrNull,
        highlightColor: colorOrNull,
      }),
      run(ctx, p) {
        const list = tagList(ctx.prefs);
        const at = list.findIndex(t => t.id === p.tagId);
        if (at < 0) throw new CommandError('not_found', `There is no tag ${p.tagId}`, {path: '/tagId'});
        checkDefinition(p, list, p.tagId);
        const cur = list[at];
        const next = {...cur, ...(p.displayName !== undefined ? {name: p.displayName.trim()} : {}), ...(p.symbol !== undefined ? {symbol: p.symbol} : {}),
          ...(p.fontColor !== undefined ? {fontColor: p.fontColor} : {}), ...(p.highlightColor !== undefined ? {highlightColor: p.highlightColor} : {})};
        saveTags(ctx, list.map((t, i) => (i === at ? next : t)));
        return {tag: next};
      },
    },
    {
      id: 'tag.delete', label: 'Remove tag', risk: 'edit', effect: 'prefs', undo: 'none',
      description: 'Remove a tag from the tag list (notes already tagged keep it).',
      params: s.object({tagId: s.string({min: 1, max: 120})}),
      run(ctx, p) {
        const list = tagList(ctx.prefs);
        if (!list.some(t => t.id === p.tagId)) throw new CommandError('not_found', `There is no tag ${p.tagId}`, {path: '/tagId'});
        saveTags(ctx, list.filter(t => t.id !== p.tagId));
        return {removed: p.tagId};
      },
    },
    {
      id: 'tag.reorder', label: 'Move Tag', risk: 'edit', effect: 'prefs', undo: 'none', dialog: 'dialog.customize-tags',
      description: 'Move a tag up or down the list (the first nine get Ctrl+1..Ctrl+9).',
      params: s.object({tagId: s.string({min: 1, max: 120}), direction: s.enum(['up', 'down'])}),
      run(ctx, p) {
        const list = [...tagList(ctx.prefs)];
        const at = list.findIndex(t => t.id === p.tagId);
        if (at < 0) throw new CommandError('not_found', `There is no tag ${p.tagId}`, {path: '/tagId'});
        const to = p.direction === 'up' ? at - 1 : at + 1;
        if (to < 0 || to >= list.length) return {index: at, moved: false};
        [list[at], list[to]] = [list[to], list[at]];
        saveTags(ctx, list);
        return {index: to, moved: true};
      },
    },
    {
      id: 'tags.find', label: 'Find Tags', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Open the Tags Summary: tagged notes grouped by tag name, section, title, date or note text.',
      params: summaryParams,
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx, p) {
        const result = summary(ctx, p);
        ctx.setView({tagsSummary: {groupBy: result.groupBy, scope: result.scope, uncheckedOnly: result.uncheckedOnly}});
        return result;
      },
    },
    {
      id: 'tags.refresh', label: 'Refresh Results', risk: 'read',
      description: 'Collect the Tags Summary again with its current options.',
      params: s.object({}),
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'}),
      run: ctx => summary(ctx, ctx.view?.tagsSummary ?? {}),
    },
    {
      id: 'tags.createSummaryPage', label: 'Create Summary Page', risk: 'edit',
      description: 'Add a page at the end of the current section listing the tagged notes, grouped as the Tags Summary shows them.',
      params: summaryParams,
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return currentLocation(ctx.doc, ctx.selection).sectionId ? {enabled: true} : {enabled: false, reason: 'Open a section first'};
      },
      run(ctx, p) {
        const opts = {...(ctx.view?.tagsSummary ?? {}), ...p};
        const items = collectTags(ctx, opts);
        if (!items.length) throw new CommandError('failed', 'No tagged notes were found');
        const groups = groupTags(items, opts.groupBy ?? 'tag-name', ctx.host.now());
        const here = currentLocation(ctx.doc, ctx.selection);
        const sid = here.sectionId;
        const pid = addPage(ctx, sid, {});
        setPageTitle(ctx, pid, SUMMARY_TITLE);
        const id = () => `b${ctx.host.uid()}`;
        const blocks = [];
        for (const g of groups) {
          blocks.push(schema.nodes.paragraph.create({id: id(), style: 'h2'}, g.name ? schema.text(g.name) : null));
          for (const it of g.items) {
            blocks.push(schema.nodes.paragraph.create({id: id(), tags: [{...it.tag}]}, it.text ? schema.text(it.text.replace(/￼/g, '')) || null : null));
          }
        }
        const container = schema.nodes.container.create({id: `c${ctx.host.uid()}`, x: 48, y: 96, width: null}, Fragment.fromArray(blocks));
        editPage(ctx, pid, tr => tr.insert(0, container));
        ctx.setSelection(selectPage(pid));
        return {page: pid, notes: items.length, groups: groups.length};
      },
    },
    {
      id: 'note.tags', label: 'Note tags', risk: 'edit',
      description: 'Add or remove page-level #tags (used by the library filters).',
      params: s.object({add: s.optional(s.string({min: 1, max: 60, trim: true})), remove: s.optional(s.string({min: 1, max: 60, trim: true}))}),
      state(ctx) {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        const {pageId} = currentLocation(ctx.doc, ctx.selection);
        return pageId ? {enabled: true, value: ctx.doc.pages[pageId].noteTags ?? []} : {enabled: false, reason: 'No page is open'};
      },
      run(ctx, p) {
        const {pageId} = currentLocation(ctx.doc, ctx.selection);
        if (!pageId) throw new CommandError('disabled', 'No page is open');
        if (p.add === undefined && p.remove === undefined) throw new CommandError('invalid_params', 'Give a tag to add or remove');
        const norm = t => t.replace(/^#/, '').trim().toLowerCase();
        let tags = [...(ctx.doc.pages[pageId].noteTags ?? [])];
        if (p.remove !== undefined) tags = tags.filter(t => t !== norm(p.remove));
        if (p.add !== undefined && norm(p.add) && !tags.includes(norm(p.add))) tags.push(norm(p.add));
        ctx.change.set(['pages', pageId, 'noteTags'], tags);
        return {tags};
      },
    },
  ],
});

