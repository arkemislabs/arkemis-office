// The Outlining tab (Outline view): outline levels (Heading 1–9 or body text), Promote / Demote,
// Move Up / Move Down with what is under a heading, Expand / Collapse, Show Level, Show Text
// Formatting, Show First Line Only, and Close Outline View.
//
// Translated from wordcraft crates/engine/src/cmd/outline.rs (`specs`, `set_levels`, `expand`,
// `collapse`, `show_level`, `select_subtree`, outline.state) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// What's collapsed and shown is the document view (core/quill/lib/outline-view.mjs), never saved
// and never on the undo list; level changes and moves are ordinary edits, one undo step each (the
// joined para.* command runs inside this one, as upstream's `run_joined`).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {ready, need, ordered, selResult, peek, UPSTREAM_COMMIT} from '../lib/format-target.mjs';
import {ensureHeadingStyle} from '../lib/para-lists.mjs';
import {BODY, outlineOf, collapsedIdx, levelsOf, targets, expand, collapse, withCollapsed, subtreeSelection, selectedBlocks, moveSection} from '../lib/outline-view.mjs';
import {hidden as hiddenOf} from '../layout/outline.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/outline.rs', 'crates/engine/src/cmd/para/outline.rs']};
const NONE = s.object({});
const BLOCK = s.object({block: s.optional(s.integer({min: 0, description: 'Body paragraph index (default: the selection)'}))});

/** Enabled only in Outline view (in_outline). */
function inOutline(ctx) {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return ctx.view?.mode === 'outline' && !ctx.view?.readMode ? {enabled: true} : {enabled: false, reason: 'only in Outline view'};
}

const sel = (ctx, d) => ordered(ctx, d);

/** A level as the Outlining tab's boxes give it: 1–9, "Level 3", "body" / "Body Text", "all" / "All Levels". */
export function parseLevel(v, extra) {
  if (Number.isInteger(v) && v >= 1 && v <= 9) return v;
  const t = String(v ?? '').trim().toLowerCase();
  if (t === extra || (extra === 'body' && t === 'body text') || (extra === 'all' && t === 'all levels')) return extra;
  const m = /^(?:level\s*)?([1-9])$/.exec(t);
  if (m) return Number(m[1]);
  throw new CommandError('invalid_params', `\`level\` must be 1–9 or "${extra}"`, {path: '/level'});
}
const LEVEL_PARAM = s.union([s.integer({min: 1, max: 9}), s.string({min: 1, max: 32})]);

/** Apply Heading `level` (or body text: null) to the selected paragraphs (set_levels → set_heading). */
function setLevels(ctx, level) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    const paths = d.pathsBetween(a, b);
    if (!paths.length) throw new CommandError('failed', 'select paragraphs to change their level');
    for (const path of paths) {
      const style = level === null ? null : ensureHeadingStyle(d, Math.min(9, Math.max(1, level)));
      const m = d.paraMut(a.story, path);
      const props = {...(m.props ?? {})};
      if (style) props.style = style; else delete props.style;
      delete props.outlineLevel;
      m.props = props;
    }
  });
  return selResult(ctx);
}

/** The view's outline state after a change. */
function setOutline(ctx, o) { ctx.setView({outline: o}); }

function expandOrCollapse(ctx, p, kind, all) {
  const d = peek(ctx);
  const o = outlineOf(ctx.view, d);
  const lv = levelsOf(d);
  const tg = targets(lv, sel(ctx, d), p.block);
  const r = (kind === 'expand' ? expand : collapse)(lv, o, tg, all);
  setOutline(ctx, withCollapsed(d, o, r.set, r.showLevel));
  return selResult(ctx);
}

function showLevel(ctx, level) {
  setOutline(ctx, {...outlineOf(ctx.view), showLevel: level, collapsed: []});
  return {showLevel: level};
}

const showLevelCommands = Array.from({length: 9}, (_, i) => ({
  id: `outline.showLevel${i + 1}`, label: `Show Level ${i + 1}`, shortcut: `Alt+Shift+${i + 1}`, risk: 'read', effect: 'view',
  description: `Show Level ${i + 1}: headings down to level ${i + 1}, no body text.`, params: NONE, state: inOutline, run: ctx => showLevel(ctx, i + 1),
}));

export default defineCommands({
  family: 'outline',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {id: 'outline.promoteToHeading1', label: 'Promote to Heading 1', risk: 'edit',
      description: 'Promote to Heading 1: the selected paragraphs become Heading 1.', params: NONE, state: ready, run: ctx => setLevels(ctx, 1)},
    {id: 'outline.promote', label: 'Promote', risk: 'edit',
      description: 'Promote: a heading up one level (what a collapsed heading hides comes along); body text becomes a heading.', params: NONE, state: ready,
      run: ctx => ctx.run('para.promote', {})},
    {id: 'outline.demote', label: 'Demote', risk: 'edit',
      description: 'Demote: a heading down one level (what a collapsed heading hides comes along).', params: NONE, state: ready,
      run: ctx => ctx.run('para.demote', {})},
    {id: 'outline.demoteToBody', label: 'Demote to Body Text', risk: 'edit',
      description: 'Demote to Body Text: the selected paragraphs become body text (the Normal style).', params: NONE, state: ready, run: ctx => setLevels(ctx, null)},
    {id: 'outline.level', label: 'Outline Level', risk: 'edit',
      description: 'Outline Level: the selected paragraphs become Heading `level` (1–9), or body text ("body").',
      params: s.object({level: LEVEL_PARAM}),
      state(ctx) {
        const r = ready(ctx);
        if (!r.enabled) return r;
        try {
          const d = peek(ctx);
          const [a] = ordered(ctx, d);
          const lv = a.story === 'body' && a.path.length === 1 ? levelsOf(d)[a.path[0]] : BODY;
          return {enabled: true, value: lv >= BODY ? 'Body Text' : `Level ${lv}`};
        } catch { return {enabled: true}; }
      },
      run(ctx, p) { const l = parseLevel(p.level, 'body'); return setLevels(ctx, l === 'body' ? null : l); }},
    {id: 'outline.moveUp', label: 'Move Up', risk: 'edit',
      description: 'Move Up: the selected paragraphs (and what a collapsed heading hides) pass the shown paragraph above.', params: NONE, state: ready,
      run: ctx => ctx.run('para.moveUp', {})},
    {id: 'outline.moveDown', label: 'Move Down', risk: 'edit',
      description: 'Move Down: the selected paragraphs (and what a collapsed heading hides) pass the shown paragraph below.', params: NONE, state: ready,
      run: ctx => ctx.run('para.moveDown', {})},
    {id: 'outline.expand', label: 'Expand', shortcut: 'Alt+Shift+=', risk: 'read', effect: 'view',
      description: 'Expand: a collapsed heading opens; an open one shows the next collapsed level under it.', params: BLOCK, state: inOutline,
      run: (ctx, p) => expandOrCollapse(ctx, p, 'expand', false)},
    {id: 'outline.collapse', label: 'Collapse', shortcut: 'Alt+Shift+-', risk: 'read', effect: 'view',
      description: 'Collapse: the deepest open level under a heading closes; then the heading itself.', params: BLOCK, state: inOutline,
      run: (ctx, p) => expandOrCollapse(ctx, p, 'collapse', false)},
    {id: 'outline.toggle', label: 'Expand or Collapse Heading', risk: 'read', effect: 'view',
      description: 'Double-clicking a heading\'s symbol: all of it collapsed, or all of it expanded.', params: BLOCK, state: inOutline,
      run(ctx, p) {
        const d = peek(ctx);
        const lv = levelsOf(d);
        const tg = targets(lv, sel(ctx, d), p.block);
        const o = outlineOf(ctx.view, d);
        const isCollapsed = tg.length && o.collapsed.some(([i]) => i === tg[0]);
        return expandOrCollapse(ctx, p, isCollapsed ? 'expand' : 'collapse', true);
      }},
    {id: 'outline.selectSubtree', label: 'Select Heading and Content', risk: 'read', effect: 'view',
      description: 'Clicking a symbol: the paragraph and everything under it.', params: BLOCK, state: inOutline,
      run(ctx, p) {
        const d = peek(ctx);
        let start = p.block;
        if (start === undefined) {
          const r = selectedBlocks(...sel(ctx, d));
          if (!r) throw new CommandError('failed', 'put the caret in the body text');
          start = r[0];
        }
        const {anchor, focus} = subtreeSelection(d, start);
        ctx.model.setSelection(ctx, [{anchor, focus}]);
        return selResult(ctx);
      }},
    {id: 'outline.showLevel', label: 'Show Level', risk: 'read', effect: 'view',
      description: 'Show Level: headings down to `level` (1–9) without body text, or "all".',
      params: s.object({level: LEVEL_PARAM}),
      state(ctx) {
        const r = inOutline(ctx);
        if (!r.enabled) return r;
        const n = outlineOf(ctx.view).showLevel;
        return {enabled: true, value: n >= 1 && n <= 9 ? `Level ${n}` : 'All Levels'};
      },
      run(ctx, p) { const l = parseLevel(p.level, 'all'); return showLevel(ctx, l === 'all' ? 0 : l); }},
    ...showLevelCommands,
    {id: 'outline.showAll', label: 'Show All Levels', shortcut: 'Alt+Shift+A', risk: 'read', effect: 'view',
      description: 'Show All Levels.', params: NONE, state: inOutline, run: ctx => showLevel(ctx, 0)},
    {id: 'outline.firstLineOnly', label: 'Show First Line Only', shortcut: 'Alt+Shift+L', risk: 'read', effect: 'view',
      description: 'Show First Line Only: body paragraphs show their first line.', params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = inOutline(ctx); return r.enabled ? {enabled: true, checked: outlineOf(ctx.view).firstLineOnly} : r; },
      run(ctx, p) {
        const o = outlineOf(ctx.view);
        const on = p.value ?? !o.firstLineOnly;
        setOutline(ctx, {...o, firstLineOnly: on});
        return {value: on};
      }},
    {id: 'outline.showFormatting', label: 'Show Text Formatting', risk: 'read', effect: 'view',
      description: 'Show Text Formatting: off draws every paragraph in the Normal style.', params: s.object({value: s.optional(s.boolean())}),
      state: ctx => { const r = inOutline(ctx); return r.enabled ? {enabled: true, checked: !outlineOf(ctx.view).hideFormatting} : r; },
      run(ctx, p) {
        const o = outlineOf(ctx.view);
        const on = p.value ?? o.hideFormatting;
        setOutline(ctx, {...o, hideFormatting: !on});
        return {value: on};
      }},
    {id: 'outline.moveSection', label: 'Move Heading', risk: 'edit',
      description: 'The Navigation pane\'s drag of a heading (Word): the heading at body paragraph `from` and everything under it move before body block `to` (the end: the number of body blocks). One undo step.',
      params: s.object({from: s.integer({min: 0}), to: s.integer({min: 0})}), state: ready,
      run(ctx, p) {
        need(ctx);
        let sel;
        ctx.model.edit(ctx, d => {
          const r = moveSection(d, p.from, p.to);
          sel = r;
        });
        ctx.model.setSelection(ctx, [{anchor: sel, focus: sel}]);
        return selResult(ctx);
      }},
    {id: 'outline.close', label: 'Close Outline View', risk: 'read', effect: 'view',
      description: 'Close Outline View: back to Print Layout.', params: NONE, state: inOutline,
      run: ctx => ctx.run('view.printLayout', {})},
    {id: 'outline.state', label: 'Outline State', risk: 'read', effect: 'view',
      description: 'The outline: each body block\'s level (10 = body text), the blocks shown, the collapsed headings, Show Level, First Line Only, Show Text Formatting.',
      params: NONE, state: ready,
      run(ctx) {
        const d = peek(ctx);
        const o = outlineOf(ctx.view, d);
        const lv = levelsOf(d);
        const hid = hiddenOf(lv, collapsedIdx(o));
        return {levels: lv, shown: hid.map((h, i) => (h ? -1 : i)).filter(i => i >= 0), collapsed: o.collapsed.map(([i]) => i),
          showLevel: o.showLevel, firstLineOnly: o.firstLineOnly, showFormatting: !o.hideFormatting};
      }},
  ],
});
