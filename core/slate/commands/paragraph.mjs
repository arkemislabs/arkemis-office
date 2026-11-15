// Paragraph, lists and styles: Home › Basic Text (bullets, numbering, indent, alignment, spacing),
// Home › Styles, and the outline keys (U:slate/paragraph).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `list.*`,
// `paragraph.*` and `style.apply` (sourceRef core/slate-paragraph.mjs); behaviour is OneNote's:
//   * Bullets (Ctrl+.) and Numbering (Ctrl+/) toggle a list on the selected paragraphs; a gallery
//     style changes the list's bullet or number format; None removes the list; adjacent lists of
//     the same kind join, so numbering continues;
//   * Increase/Decrease Indent Position (Alt+Shift+Right/Left, Tab/Shift+Tab) nest and un-nest
//     list items and move other paragraphs one outline level;
//   * Paragraph Alignment (Ctrl+L, Ctrl+R; Center from the menu), Paragraph Spacing Options
//     (Before, After, Line Spacing At Least, in points), Ctrl+Left/Right Shift text direction;
//   * Alt+Shift+Up/Down move the paragraph with its subordinate paragraphs past its neighbour;
//     Ctrl+Shift+- selects a paragraph with its subordinates; Shift+Enter breaks the line;
//   * Styles: Heading 1–6, Page Title, Citation, Quote, Code, Normal (Ctrl+Alt+1..6, Ctrl+Shift+N
//     is Clear All Formatting in format.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {EditorState, TextSelection} from '@tiptap/pm/state';
import {Fragment} from '@tiptap/pm/model';
import {liftListItem, sinkListItem, wrapRangeInList} from '@tiptap/pm/schema-list';
import {schema} from '../schema.mjs';
import {posToPoint} from '../model/page.mjs';
import {applySteps} from '../model/canvas.mjs';
import {editPage, ensureIds, needRange, textRange, textState, textblocksIn} from '../lib/format-text.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/paragraph.*', 'docs/spec/slate.json#commands/list.*', 'core/slate-paragraph.mjs']};

export const BULLET_STYLES = Object.freeze(['disc', 'circle', 'square', 'hollow-square', 'diamond', 'four-diamonds', 'arrow', 'check', 'dash', 'star',
  'triangle', 'hand', 'asterisk', 'equals']);
export const NUMBER_FORMATS = Object.freeze(['decimal-period', 'decimal-paren', 'decimal-both-paren', 'upper-roman', 'lower-roman', 'upper-alpha',
  'lower-alpha', 'upper-alpha-paren', 'lower-alpha-paren', 'lower-alpha-both-paren', 'ordinal-text', 'ordinal', 'cardinal-text']);
/** Spec style ids -> the page schema's paragraph styles. */
export const STYLE_IDS = Object.freeze({'heading-1': 'h1', 'heading-2': 'h2', 'heading-3': 'h3', 'heading-4': 'h4', 'heading-5': 'h5', 'heading-6': 'h6',
  'page-title': 'pageTitle', citation: 'citation', quote: 'quote', code: 'code', normal: 'normal'});
const STYLE_OF = Object.fromEntries(Object.entries(STYLE_IDS).map(([k, v]) => [v, k]));
/** The Styles gallery's tiles: id, name and the icon each is drawn with (assets/icons/ribbon/style-*.svg). */
export const STYLE_TILES = Object.freeze([['heading-1', 'Heading 1', 'style-h1'], ['heading-2', 'Heading 2', 'style-h2'], ['heading-3', 'Heading 3', 'style-h3'], ['heading-4', 'Heading 4', 'style-h4'],
  ['heading-5', 'Heading 5', 'style-h5'], ['heading-6', 'Heading 6', 'style-h6'], ['page-title', 'Page Title', 'style-title'], ['citation', 'Citation', 'style-citation'], ['quote', 'Quote', 'style-quote'],
  ['code', 'Code', 'style-code'], ['normal', 'Normal', 'style-normal']].map(([id, label, icon]) => Object.freeze({id, label, value: id, icon})));
export const MAX_INDENT = 20;

/** Customize Numbering's Sequence choices -> number formats (text after "." by default). */
export const SEQUENCES = Object.freeze({'1, 2, 3': 'decimal', 'I, II, III': 'upper-roman', 'i, ii, iii': 'lower-roman', 'A, B, C': 'upper-alpha',
  'a, b, c': 'lower-alpha', 'First, Second, Third': 'ordinal-text', '1st, 2nd, 3rd': 'ordinal', 'One, Two, Three': 'cardinal-text'});

// ---------------------------------------------------------------------------------------------
// Helpers

/** The list item and list a textblock sits in (innermost), or null. */
function listOf(doc, blockPos) {
  const $p = doc.resolve(blockPos + 1);
  for (let d = $p.depth - 1; d > 0; d--) {
    const n = $p.node(d);
    if (n.type === schema.nodes.listItem && d > 1) {
      const list = $p.node(d - 1);
      return {item: n, itemPos: $p.before(d), list, listPos: $p.before(d - 1), depth: d};
    }
    if (n.type === schema.nodes.container) break;
  }
  return null;
}

const isList = n => n.type === schema.nodes.bulletList || n.type === schema.nodes.orderedList;

/** Run ProseMirror commands repeatedly on a moving selection, collecting all steps into one edit. */
function pmLoop(ctx, range, fn) {
  let state = EditorState.create({schema, doc: range.doc, selection: TextSelection.create(range.doc, range.from, range.to)});
  const steps = [];
  const dispatch = tr => { ensureIds(ctx, tr); steps.push(...tr.steps); state = state.apply(tr); };
  fn(() => state, dispatch);
  if (!steps.length) return false;
  applySteps(ctx, range.pageId, steps.map(st => st.toJSON()));
  return true;
}

/** OneNote's look for a nested list: bullets go disc, circle, square; numbers 1., a., i. */
const NEXT_BULLET = {disc: 'circle', circle: 'square', square: 'disc'};
const NEXT_NUMBER = {'decimal-period': 'lower-alpha', 'lower-alpha': 'lower-roman', 'lower-roman': 'decimal-period'};
function fixNestedLooks(ctx, pageId) {
  editPage(ctx, pageId, tr => {
    tr.doc.descendants((node, pos) => {
      if (!isList(node)) return true;
      const bullet = node.type === schema.nodes.bulletList;
      if (bullet ? node.attrs.symbol : node.attrs.format && node.attrs.format !== 'decimal') return true;
      const $p = tr.doc.resolve(pos);
      const outer = $p.depth >= 2 ? $p.node($p.depth - 1) : null;
      const look = outer && isList(outer) && outer.type === node.type ? listLook(outer) : null;
      if (bullet) tr.setNodeAttribute(pos, 'symbol', look ? NEXT_BULLET[look] ?? 'disc' : 'disc');
      else tr.setNodeAttribute(pos, 'format', look ? NEXT_NUMBER[look] ?? 'decimal-period' : 'decimal-period');
      return true;
    });
  });
}

/** Join adjacent lists of the same kind and format inside every container (numbering continues across them). */
function joinAdjacentLists(tr) {
  for (let again = true, guard = 0; again && guard < 200; guard++) {
    again = false;
    tr.doc.descendants((node, pos) => {
      if (again || node.isTextblock) return false;
      let prev = null;
      node.forEach((child, off) => {
        if (again) return;
        const at = pos + 1 + off;
        if (prev && isList(prev.node) && prev.node.type === child.type && JSON.stringify(listLook(prev.node)) === JSON.stringify(listLook(child))) {
          tr.join(at);
          again = true;
        }
        prev = {node: child, at};
      });
      return !again;
    });
  }
}
const listLook = n => (n.type === schema.nodes.bulletList ? n.attrs.symbol : n.attrs.format);

/** Apply a bullet or number look to the selected paragraphs (wrapping those not yet in a list). */
function applyList(ctx, range, type, attrs) {
  const blocks = textblocksIn(range.doc, range.from, range.to);
  if (!blocks.length) throw new CommandError('disabled', 'Click in a paragraph to make a list');
  return editPage(ctx, range.pageId, tr => {
    // Paragraphs already in a list: change that list's kind and look.
    const lists = new Map();
    const loose = [];
    for (const b of blocks) {
      const l = listOf(tr.doc, b.pos);
      if (l) lists.set(l.listPos, l.list); else loose.push(b);
    }
    for (const [pos, list] of lists) tr.setNodeMarkup(pos, type, {...attrs, id: list.attrs.id});
    // Loose paragraphs: wrap each run of sibling paragraphs in a new list, last run first.
    const runs = [];
    for (const b of loose) {
      const $b = tr.doc.resolve(b.pos);
      const last = runs[runs.length - 1];
      if (last && last.parentPos === $b.before() && last.end === b.pos) { last.end = b.pos + b.node.nodeSize; continue; }
      runs.push({parentPos: $b.before(), start: b.pos, end: b.pos + b.node.nodeSize});
    }
    for (const run of runs.reverse()) {
      const $s = tr.doc.resolve(run.start + 1), $e = tr.doc.resolve(run.end - 1);
      const blockRange = $s.blockRange($e);
      if (blockRange) wrapRangeInList(tr, blockRange, type, attrs);
    }
    joinAdjacentLists(tr);
  }, range.doc);
}

/** Lift every selected paragraph out of its lists. */
function removeLists(ctx, range) {
  return pmLoop(ctx, range, (state, dispatch) => {
    for (let guard = 0; guard < 12; guard++) {
      const st = state();
      const inList = textblocksIn(st.doc, st.selection.from, st.selection.to).some(b => listOf(st.doc, b.pos));
      if (!inList || !liftListItem(schema.nodes.listItem)(st, dispatch)) break;
    }
  });
}

/** Are all selected paragraphs in lists of this kind (and look, when given)? */
function allInList(range, type, look) {
  const blocks = textblocksIn(range.doc, range.from, range.to);
  return blocks.length > 0 && blocks.every(b => {
    const l = listOf(range.doc, b.pos);
    return l && l.list.type === type && (look === undefined || listLook(l.list) === look);
  });
}

/** The list look at the caret, for the gallery's checked state. */
function lookAt(range, type) {
  const b = textblocksIn(range.doc, range.from, range.to)[0];
  const l = b && listOf(range.doc, b.pos);
  return l && l.list.type === type ? listLook(l.list) : null;
}

/** Sibling groups for moving a paragraph: a list item, or a paragraph with the following paragraphs indented under it. */
function moveUnit(doc, blockPos) {
  const l = listOf(doc, blockPos);
  if (l) {
    const $i = doc.resolve(l.itemPos);
    const parent = $i.parent, index = $i.index();
    const groups = [];
    parent.forEach((child, off) => groups.push({from: $i.start() + off, to: $i.start() + off + child.nodeSize, nodes: [child]}));
    return {groups, index};
  }
  const $b = doc.resolve(blockPos);
  const parent = $b.parent, at = $b.index();
  const kids = [];
  parent.forEach((child, off) => kids.push({node: child, from: $b.start() + off, to: $b.start() + off + child.nodeSize}));
  const level = k => (k.node.type === schema.nodes.paragraph ? k.node.attrs.indent : 0);
  // Groups: a paragraph with the following ones indented deeper than it.
  const groups = [];
  let i = 0;
  while (i < kids.length) {
    let j = i + 1;
    while (j < kids.length && level(kids[j]) > level(kids[i])) j++;
    groups.push({from: kids[i].from, to: kids[j - 1].to, nodes: kids.slice(i, j).map(k => k.node), level: level(kids[i]), first: i});
    i = j;
  }
  // The group holding the paragraph (a subordinate paragraph moves within its parent's group).
  let index = groups.findIndex(g => kids[g.first].from <= blockPos && blockPos < g.to);
  const own = groups[index];
  if (own && kids[own.first].from !== blockPos) {
    // Re-group the subordinate level only.
    const sub = kids.filter(k => k.from >= kids[own.first].to && k.to <= own.to);
    const lvl = level(kids.find(k => k.from === blockPos));
    const sg = [];
    let a = 0;
    while (a < sub.length) {
      let b = a + 1;
      while (b < sub.length && level(sub[b]) > lvl) b++;
      sg.push({from: sub[a].from, to: sub[b - 1].to, nodes: sub.slice(a, b).map(k => k.node), level: level(sub[a])});
      a = b;
    }
    return {groups: sg, index: sg.findIndex(g => g.from <= blockPos && blockPos < g.to)};
  }
  return {groups, index};
}

function moveParagraph(ctx, dir) {
  const range = needRange(ctx);
  const blocks = textblocksIn(range.doc, range.from, range.to);
  if (!blocks.length) throw new CommandError('disabled', 'Click in a paragraph to move it');
  const {groups, index} = moveUnit(range.doc, blocks[0].pos);
  const other = groups[index + dir];
  const own = groups[index];
  if (!own || !other || (own.level !== undefined && other.level !== undefined && other.level < own.level)) return {moved: false};
  const sel = ctx.selection;
  const [first, second] = dir < 0 ? [other, own] : [own, other];
  editPage(ctx, range.pageId, tr => {
    tr.replaceWith(first.from, second.to, Fragment.fromArray([...second.nodes, ...first.nodes]));
  }, range.doc);
  // Block ids are kept, so the selection's addresses still name the moved text.
  ctx.setSelection(sel);
  return {moved: true};
}

const blocksOrThrow = range => {
  const blocks = textblocksIn(range.doc, range.from, range.to);
  if (!blocks.length) throw new CommandError('disabled', 'Click in a paragraph');
  return blocks;
};

/** Set an attribute on every selected paragraph. */
function setParagraphAttr(ctx, attr, value) {
  const range = needRange(ctx);
  let blocks = blocksOrThrow(range).filter(b => b.node.type === schema.nodes.paragraph);
  // Several selected cells (Table Layout › Select Columns / Rows) are one range each: every one is aligned.
  const ranges = ctx.selection?.ranges ?? [];
  if (ranges.length > 1) {
    const seen = new Set(blocks.map(b => b.pos));
    for (const r of ranges) {
      const more = textRange({doc: ctx.doc, selection: {ranges: [r], primary: 0}});
      if (!more || more.pageId !== range.pageId) continue;
      for (const b of textblocksIn(more.doc, more.from, more.to)) if (b.node.type === schema.nodes.paragraph && !seen.has(b.pos)) { seen.add(b.pos); blocks.push(b); }
    }
  }
  editPage(ctx, range.pageId, tr => {
    for (const b of blocks) if (JSON.stringify(b.node.attrs[attr]) !== JSON.stringify(value)) tr.setNodeAttribute(b.pos, attr, value);
  }, range.doc);
  return {paragraphs: blocks.length};
}

const firstParagraph = ctx => {
  const range = textRange(ctx);
  if (!range) return null;
  return textblocksIn(range.doc, range.from, range.to).find(b => b.node.type === schema.nodes.paragraph)?.node ?? null;
};

// ---------------------------------------------------------------------------------------------

export default defineCommands({
  family: 'paragraph',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'list.bullets', label: 'Bullets', shortcut: 'Mod+.', risk: 'edit',
      description: 'Toggle bullets on the selected paragraphs, or change their bullet style (none removes the list).',
      params: s.object({style: s.optional(s.enum([...BULLET_STYLES, 'none'], {description: 'Bullet style (default: toggle filled circle bullets)'}))}),
      state(ctx, p) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const look = lookAt(range, schema.nodes.bulletList);
        return {enabled: true, checked: p?.style ? (p.style === 'none' ? look === null : look === p.style) : look !== null, value: look};
      },
      run(ctx, p) {
        const range = needRange(ctx);
        const style = p.style ?? 'disc';
        if (style === 'none' || (p.style === undefined && allInList(range, schema.nodes.bulletList))) {
          return {list: null, changed: removeLists(ctx, range)};
        }
        applyList(ctx, range, schema.nodes.bulletList, {symbol: style});
        return {list: 'bullet', style};
      },
    },
    {
      id: 'list.numbering', label: 'Numbering', shortcut: 'Mod+/', risk: 'edit',
      description: 'Toggle numbering on the selected paragraphs, or change the number format (none removes the list).',
      params: s.object({format: s.optional(s.enum([...NUMBER_FORMATS, 'none'], {description: 'Number format (default: toggle 1. 2. 3.)'}))}),
      state(ctx, p) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const look = lookAt(range, schema.nodes.orderedList);
        return {enabled: true, checked: p?.format ? (p.format === 'none' ? look === null : look === p.format) : look !== null, value: look};
      },
      run(ctx, p) {
        const range = needRange(ctx);
        const format = p.format ?? 'decimal-period';
        if (format === 'none' || (p.format === undefined && allInList(range, schema.nodes.orderedList))) {
          return {list: null, changed: removeLists(ctx, range)};
        }
        applyList(ctx, range, schema.nodes.orderedList, {format, start: 1});
        return {list: 'number', format};
      },
    },
    {
      id: 'list.customizeNumbering', label: 'Customize Numbering...', risk: 'edit', dialog: 'dialog.customize-numbering',
      description: 'Number the selected paragraphs with a custom sequence, start value and restart setting.',
      params: s.object({
        sequence: s.optional(s.enum(Object.keys(SEQUENCES), {description: 'Number sequence'})),
        textBefore: s.optional(s.string({max: 20})),
        textAfter: s.optional(s.string({max: 20})),
        startAt: s.optional(s.integer({min: 1, max: 32767})),
        restart: s.optional(s.boolean({description: 'Restart numbering at startAt (true) or continue the list (false)'})),
        listAlignment: s.optional(s.enum(['left', 'center', 'right'])),
        alignmentDistance: s.optional(s.number({min: 0, max: 22})),
        textDistance: s.optional(s.number({min: 0, max: 22})),
      }),
      state: textState,
      run(ctx, p) {
        const range = needRange(ctx);
        // The page schema stores the list's format and start value; text around the number and
        // the list's alignment and distances need list attributes the schema does not have yet
        // (design note U-slate-paragraph--F-slate--list-number-attrs).
        const unsupported = ['textBefore', 'listAlignment', 'alignmentDistance', 'textDistance'].filter(k => p[k] !== undefined && p[k] !== '' && !(k === 'listAlignment' && p[k] === 'left'));
        if (p.textAfter !== undefined && !['.', ')', ''].includes(p.textAfter)) unsupported.push('textAfter');
        if (unsupported.length) throw new CommandError('invalid_params', `${unsupported.join(', ')} cannot be stored in this notebook yet`, {path: `/${unsupported[0]}`});
        const base = SEQUENCES[p.sequence ?? '1, 2, 3'];
        const format = base === 'decimal' ? (p.textAfter === ')' ? 'decimal-paren' : 'decimal-period')
          : base === 'upper-alpha' && p.textAfter === ')' ? 'upper-alpha-paren' : base === 'lower-alpha' && p.textAfter === ')' ? 'lower-alpha-paren' : base;
        const blocks = textblocksIn(range.doc, range.from, range.to);
        const inList = blocks.length && blocks.every(b => listOf(range.doc, b.pos)?.list.type === schema.nodes.orderedList);
        if (!inList) applyList(ctx, range, schema.nodes.orderedList, {format, start: p.startAt ?? 1});
        else {
          const r2 = textRange(ctx);
          editPage(ctx, r2.pageId, tr => {
            const seen = new Set();
            for (const b of textblocksIn(r2.doc, r2.from, r2.to)) {
              const l = listOf(r2.doc, b.pos);
              if (!l || seen.has(l.listPos)) continue;
              seen.add(l.listPos);
              const start = p.restart === false ? l.list.attrs.start : p.startAt ?? l.list.attrs.start;
              tr.setNodeMarkup(l.listPos, schema.nodes.orderedList, {...l.list.attrs, format, start});
            }
          }, r2.doc);
        }
        return {format, start: p.startAt ?? 1};
      },
    },
    {
      id: 'paragraph.indent', label: 'Increase Indent Position', shortcut: 'Alt+Shift+Right', risk: 'edit',
      description: 'Increase the outline indent of the selected paragraphs (nests list items).',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        const blocks = blocksOrThrow(range);
        if (blocks.every(b => listOf(range.doc, b.pos))) {
          const ok = pmLoop(ctx, range, (state, dispatch) => sinkListItem(schema.nodes.listItem)(state(), dispatch));
          if (ok) fixNestedLooks(ctx, range.pageId);
          return {indented: ok ? blocks.length : 0};
        }
        let n = 0;
        editPage(ctx, range.pageId, tr => {
          for (const b of blocks) {
            if (b.node.type !== schema.nodes.paragraph || listOf(range.doc, b.pos) || b.node.attrs.indent >= MAX_INDENT) continue;
            tr.setNodeAttribute(b.pos, 'indent', b.node.attrs.indent + 1);
            n++;
          }
        }, range.doc);
        return {indented: n};
      },
    },
    {
      id: 'paragraph.outdent', label: 'Decrease Indent Position', shortcut: 'Alt+Shift+Left', risk: 'edit',
      description: 'Decrease the outline indent of the selected paragraphs (un-nests list items).',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        const blocks = blocksOrThrow(range);
        const nested = blocks.filter(b => { const l = listOf(range.doc, b.pos); return l && l.depth > 2 && range.doc.resolve(l.listPos).parent.type === schema.nodes.listItem; });
        if (nested.length) {
          const ok = pmLoop(ctx, range, (state, dispatch) => liftListItem(schema.nodes.listItem)(state(), dispatch));
          return {outdented: ok ? nested.length : 0};
        }
        let n = 0;
        editPage(ctx, range.pageId, tr => {
          for (const b of blocks) {
            if (b.node.type !== schema.nodes.paragraph || b.node.attrs.indent <= 0) continue;
            tr.setNodeAttribute(b.pos, 'indent', b.node.attrs.indent - 1);
            n++;
          }
        }, range.doc);
        return {outdented: n};
      },
    },
    {
      id: 'paragraph.align', label: 'Paragraph Alignment', risk: 'edit',
      description: 'Align the selected paragraphs left, center or right.',
      params: s.object({alignment: s.enum(['left', 'center', 'right'])}),
      state(ctx, p) {
        const para = firstParagraph(ctx);
        if (!para) return textState(ctx);
        const value = para.attrs.align ?? 'left';
        return {enabled: true, value, ...(p?.alignment ? {checked: value === p.alignment} : {})};
      },
      run(ctx, p) {
        return {...setParagraphAttr(ctx, 'align', p.alignment === 'left' ? null : p.alignment), alignment: p.alignment};
      },
    },
    {
      id: 'paragraph.spacing', label: 'Paragraph Spacing Options...', risk: 'edit', dialog: 'dialog.paragraph-spacing',
      description: 'Set space before and after the selected paragraphs and their minimum line spacing, in points.',
      params: s.object({
        spaceBefore: s.optional(s.number({min: 0, max: 999})),
        spaceAfter: s.optional(s.number({min: 0, max: 999})),
        lineSpacingAtLeast: s.optional(s.number({min: 0, max: 999})),
      }),
      state(ctx) {
        const para = firstParagraph(ctx);
        if (!para) return textState(ctx);
        return {enabled: true, value: {spaceBefore: 0, spaceAfter: 0, lineSpacingAtLeast: 0, ...(para.attrs.spacing ?? {})}};
      },
      run(ctx, p) {
        const range = needRange(ctx);
        const blocks = blocksOrThrow(range).filter(b => b.node.type === schema.nodes.paragraph);
        editPage(ctx, range.pageId, tr => {
          for (const b of blocks) {
            const cur = {spaceBefore: 0, spaceAfter: 0, lineSpacingAtLeast: 0, ...(b.node.attrs.spacing ?? {})};
            const next = {...cur};
            for (const k of ['spaceBefore', 'spaceAfter', 'lineSpacingAtLeast']) if (p[k] !== undefined) next[k] = Math.round(p[k] * 10) / 10;
            const value = next.spaceBefore || next.spaceAfter || next.lineSpacingAtLeast ? next : null;
            if (JSON.stringify(value) !== JSON.stringify(b.node.attrs.spacing)) tr.setNodeAttribute(b.pos, 'spacing', value);
          }
        }, range.doc);
        return {paragraphs: blocks.length};
      },
    },
    {
      id: 'paragraph.moveUp', label: 'Move Paragraph Up', shortcut: 'Alt+Shift+Up', risk: 'edit',
      description: 'Move the selected paragraph (with its subordinate paragraphs) above the one before it.',
      params: s.object({}),
      state: textState,
      run: ctx => moveParagraph(ctx, -1),
    },
    {
      id: 'paragraph.moveDown', label: 'Move Paragraph Down', shortcut: 'Alt+Shift+Down', risk: 'edit',
      description: 'Move the selected paragraph (with its subordinate paragraphs) below the one after it.',
      params: s.object({}),
      state: textState,
      run: ctx => moveParagraph(ctx, 1),
    },
    {
      id: 'paragraph.selectWithChildren', label: 'Select Paragraph and Subordinates', shortcut: 'Mod+Shift+-', risk: 'edit', effect: 'view', undo: 'none',
      description: 'Select the current paragraph and the paragraphs indented under it.',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        const b = blocksOrThrow(range)[0];
        const l = listOf(range.doc, b.pos);
        let end;
        if (l) end = l.itemPos + l.item.nodeSize - 1;
        else {
          const {groups, index} = moveUnit(range.doc, b.pos);
          end = groups[index]?.to ?? b.pos + b.node.nodeSize;
        }
        const a = posToPoint(range.doc, b.pos + 1), f = posToPoint(range.doc, end - 1);
        const sel = {ranges: [{anchor: `/pg:${range.pageId}/b:${a.blockId}/t:${a.offset}`, focus: `/pg:${range.pageId}/b:${f.blockId}/t:${f.offset}`}], primary: 0};
        ctx.setSelection(sel);
        return {selection: sel};
      },
    },
    {
      id: 'paragraph.textDirection', label: 'Text Direction', risk: 'edit',
      description: 'Write the selected paragraphs left to right or right to left.',
      params: s.object({direction: s.enum(['ltr', 'rtl'])}),
      state(ctx, p) {
        const para = firstParagraph(ctx);
        if (!para) return textState(ctx);
        const value = para.attrs.dir ?? 'ltr';
        return {enabled: true, value, ...(p?.direction ? {checked: value === p.direction} : {})};
      },
      run: (ctx, p) => ({...setParagraphAttr(ctx, 'dir', p.direction === 'ltr' ? null : 'rtl'), direction: p.direction}),
    },
    {
      id: 'paragraph.lineBreak', label: 'Line Break', shortcut: 'Shift+Enter', risk: 'edit',
      description: 'Start a new line without starting a new paragraph (replaces selected text).',
      params: s.object({}),
      state: textState,
      run(ctx) {
        const range = needRange(ctx);
        if (!range.doc.resolve(range.from).parent.isTextblock || range.kind !== 'text') throw new CommandError('disabled', 'Click in a paragraph to break the line');
        const tr = editPage(ctx, range.pageId, t => t.replaceWith(range.from, range.to, schema.nodes.hardBreak.create()), range.doc);
        const p = posToPoint(tr.doc, range.from + 1);
        ctx.setSelection({ranges: [{anchor: `/pg:${range.pageId}/b:${p.blockId}/t:${p.offset}`, focus: `/pg:${range.pageId}/b:${p.blockId}/t:${p.offset}`}], primary: 0});
        return {block: p.blockId, offset: p.offset};
      },
    },
    {
      id: 'style.apply', label: 'Styles', risk: 'edit',
      description: 'Apply a paragraph style (Heading 1–6, Page Title, Citation, Quote, Code, Normal) to the selected paragraphs.',
      params: s.object({style: s.optional(s.enum(Object.keys(STYLE_IDS))), value: s.optional(s.enum(Object.keys(STYLE_IDS)))}),
      // The gallery: one drawn tile per style (its own icon and name), the paragraph's current style selected.
      state(ctx, p) {
        const para = firstParagraph(ctx);
        if (!para) return textState(ctx);
        const value = STYLE_OF[para.attrs.style] ?? 'normal';
        if (p?.style) return {enabled: true, value, checked: value === p.style};
        return {enabled: true, value: STYLE_TILES.map(t => ({...t, selected: t.value === value}))};
      },
      run(ctx, p) {
        const style = p.style ?? p.value;
        if (!style) throw new CommandError('invalid_params', 'Give the style', {path: '/style'});
        return {...setParagraphAttr(ctx, 'style', STYLE_IDS[style]), style};
      },
    },
  ],
});
