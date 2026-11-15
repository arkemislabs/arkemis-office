// Copy Link, Remove Link and Select All (right-click menus; U:slate/links). Slate has no ArtCraft
// upstream: ids and args are docs/spec/slate.json `link.copy`, `link.remove` and `edit.selectAll`;
// behaviour is OneNote's:
//   * Copy Link to Paragraph / Page / Section / Section Group / Notebook puts a link to it on the
//     clipboard (text and HTML); pasting it in a note makes a link that opens that place (the
//     `slate:` addresses of link.insert; a link to a group or a notebook is kept as its name);
//     scope `link` copies the address of the link at the caret;
//   * Remove Link takes the link off the word or selection it is on;
//   * Select All selects the text of the note container the caret is in.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, schema} from '../schema.mjs';
import {currentLocation, parentOf} from '../model/notebook.mjs';
import {blockIndex} from '../model/page.mjs';
import {charRange, editPage, needRange, textRange, textState} from '../lib/format-text.mjs';
import {pageLink, sectionLink} from './insert.mjs';
import {writeClipboard} from '../../common/lib/clipboard.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/link.*', 'docs/spec/slate.json#commands/edit.selectAll']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const SCOPES = ['paragraph', 'page', 'section', 'section-group', 'notebook', 'link'];
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const ready = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});

/** The block id the selection is in (a paragraph), or null. */
function blockOfSelection(ctx) {
  const r = ctx.selection?.ranges?.[ctx.selection.primary ?? 0];
  const m = /^\/pg:[^/]+\/(?:b|c):([^/]+)/.exec(r?.focus ?? r?.anchor ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

function linkOf(ctx, scope, id) {
  const c = ctx.doc;
  const loc = currentLocation(c, ctx.selection);
  switch (scope) {
    case 'paragraph': {
      const block = id ?? blockOfSelection(ctx);
      need(block && loc.pageId, 'disabled', 'Click in a paragraph first');
      return {href: pageLink(loc.pageId, block), label: c.pages[loc.pageId].title || 'Untitled page'};
    }
    case 'page': {
      const page = id ?? loc.pageId;
      need(c.pages[page], 'not_found', `No page ${page}`, {address: `/pg:${page}`});
      return {href: pageLink(page), label: c.pages[page].title || 'Untitled page'};
    }
    case 'section': {
      const sec = id ?? loc.sectionId;
      need(c.sections[sec], 'not_found', `No section ${sec}`, {address: `/sec:${sec}`});
      return {href: sectionLink(sec), label: c.sections[sec].name};
    }
    case 'section-group': {
      const g = id ?? parentOf(c, loc.sectionId)?.parent;
      need(g && c.groups[g], 'not_found', 'No section group');
      return {href: `slate:group/${encodeURIComponent(g)}`, label: c.groups[g].name};
    }
    case 'notebook': return {href: `slate:notebook/${encodeURIComponent(c.notebook.id)}`, label: c.notebook.name};
    default: {
      const range = needRange(ctx);
      const r = charRange(range) ?? range;
      let href = null;
      range.doc.nodesBetween(r.from, Math.max(r.to, r.from + 1), n => { const m = n.marks?.find(x => x.type === schema.marks.link); if (m && !href) href = m.attrs.href; return !href; });
      need(href, 'disabled', 'The caret is not in a link');
      return {href, label: href};
    }
  }
}

/** The whole run of text carrying the link that the word `r` is in. */
function linkExtent(doc, r) {
  const $p = doc.resolve(r.from);
  const spans = [];
  let at = $p.start();
  $p.parent.forEach(n => { spans.push({from: at, to: at + n.nodeSize, href: n.marks.find(m => m.type === schema.marks.link)?.attrs.href ?? null}); at += n.nodeSize; });
  const i = spans.findIndex(x => x.href && x.from <= r.from && r.to <= x.to);
  if (i < 0) return r;
  let a = i, b = i;
  while (a > 0 && spans[a - 1].href === spans[i].href) a--;
  while (b < spans.length - 1 && spans[b + 1].href === spans[i].href) b++;
  return {from: spans[a].from, to: spans[b].to};
}

export default defineCommands({
  family: 'links',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'link.copy', label: 'Copy Link', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: `Copy a link to the paragraph, page, section, section group or notebook (scope; id names one, default the current), or the address of the link at the caret (scope link), to the clipboard. Returns {href}.`,
      params: s.object({scope: s.optional(s.enum(SCOPES)), id: s.optional(s.string({min: 1, max: 200}))}),
      state: ready,
      async run(ctx, p) {
        const {href, label} = linkOf(ctx, p.scope ?? 'paragraph', p.id);
        await writeClipboard(ctx, {text: href, html: `<a href="${esc(href)}">${esc(label)}</a>`, label});
        return {href, label};
      },
    },
    {
      id: 'link.remove', label: 'Remove Link', risk: 'edit',
      description: 'Remove the link from the word at the caret or from the selected text (the text stays).',
      params: s.object({}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        let has = false;
        range.doc.nodesBetween(r.from, Math.max(r.to, r.from + 1), n => { if (n.marks?.some(m => m.type === schema.marks.link)) has = true; return !has; });
        return has ? {enabled: true} : {enabled: false, reason: 'The caret is not in a link'};
      },
      run(ctx) {
        const range = needRange(ctx);
        const r0 = charRange(range);
        need(r0, 'disabled', 'The caret is not in a link');
        // A caret takes the whole link off (all of its text), a selection only what it covers.
        const r = r0.word ? linkExtent(range.doc, r0) : r0;
        editPage(ctx, range.pageId, tr => tr.removeMark(r.from, r.to, schema.marks.link), range.doc);
        return {changed: r.to - r.from};
      },
    },
    {
      id: 'edit.selectAll', label: 'Select All', shortcut: 'Mod+A', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'Select all the text of the note container the caret is in.',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        const index = blockIndex(range.doc);
        const block = blockOfSelection(ctx);
        const hit = block ? index.get(block) : null;
        need(hit, 'disabled', 'Click in a note first');
        const container = hit.container ? index.get(hit.container) : null;
        need(container, 'disabled', 'Click in a note first');
        const blocks = [];
        container.node.descendants(n => { if (n.isTextblock) { blocks.push(n); return false; } return true; });
        need(blocks.length, 'disabled', 'There is no text here');
        const first = blocks[0], last = blocks[blocks.length - 1];
        const a = `/pg:${currentLocation(ctx.doc, ctx.selection).pageId}`;
        ctx.setSelection({ranges: [{anchor: `${a}/b:${first.attrs.id}/t:0`, focus: `${a}/b:${last.attrs.id}/t:${last.content.size}`}], primary: 0});
        return {blocks: blocks.length};
      },
    },
  ],
});
