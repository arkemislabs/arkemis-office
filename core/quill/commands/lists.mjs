// List definitions (Home › Paragraph › Multilevel List, Bullets, Numbering), over the schema-2 model.
// Translated from wordcraft crates/engine/src/cmd/lists.rs (`list.define`, `list.get`,
// `list.multilevelPreset`, `define`, `get`, `preset`, `touch_*`) and the three list commands
// crates/engine/src/cmd/tools/specs.rs registers (`para.setNumberingValue`, `para.defineBullet`,
// `para.defineNumber`; this unit owns them with the Bullets / Numbering galleries and their Define
// New dialogs, see design note quill-format--quill-tools--list-commands) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {levelsFor, abstractOf, numOf} from '../model/numbering.mjs';
import {isNumFormat, NUM_FORMATS} from '../model/numfmt.mjs';
import {UPSTREAM_COMMIT, ready, need, ordered, selectedPaths, fmtParas, focusOf, selResult, peek} from '../lib/format-target.mjs';
import {LEVELS, levelJson, levelFrom, levelsOf, defaultLevel, caretList, presetLevels, addListLevels, linkLevelStyles, ensureHeadingStyle,
  setNumberingValue} from '../lib/para-lists.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/lists.rs', 'crates/engine/src/cmd/tools/specs.rs']};

export const PRESETS = Object.freeze(['headings', 'article', 'outlineHeadings', 'chapter']);

/** Number the selected paragraphs with list `num`, keeping their level (`define`'s apply). */
function numberSelection(ctx, d, num) {
  const [a] = ordered(ctx, d);
  fmtParas(d, a.story, selectedPaths(ctx, d), pp => {
    const level = pp.numbering && pp.numbering.num !== 0 ? pp.numbering.level : 0;
    pp.numbering = {num, level};
    delete pp.indentLeft; delete pp.indentFirst; delete pp.indentLeftChars; delete pp.indentFirstChars;
    if (!pp.style || pp.style === 'Normal') pp.style = 'ListParagraph';
  });
}

function define(ctx, p) {
  need(ctx);
  if (!Array.isArray(p.levels)) throw new CommandError('invalid_params', '`levels` (array) is required', {path: '/levels'});
  let num;
  ctx.model.edit(ctx, d => {
    const target = p.num ?? null;
    const base = target !== null ? levelsOf(d.numbering, target) : Array.from({length: LEVELS}, (_, i) => defaultLevel(i));
    if (!base) throw new CommandError('invalid_params', 'no such list', {path: '/num'});
    const levels = base.map((l, i) => (p.levels[i] && typeof p.levels[i] === 'object' ? levelFrom(l, i, p.levels[i]) : l));
    const name = typeof p.name === 'string' && p.name.trim() ? [...p.name].slice(0, 64).join('') : null;
    if (target !== null) {
      // Change the list in place: every list sharing its definition follows.
      const aid = numOf(d.numbering, target).abstractId;
      const n = d.numbering;
      d.setField('numbering', {
        ...n,
        abstracts: n.abstracts.map(a => (a.id === aid ? {...a, levels, ...(name ? {name} : {})} : a)),
        nums: n.nums.map(x => (x.id === target ? {...x, levelOverrides: []} : x)),
      });
      num = target;
    } else num = addListLevels(d, name, levels);
    // Levels linked to a paragraph style number every paragraph in that style.
    linkLevelStyles(d, num, levels);
    if (p.apply ?? true) numberSelection(ctx, d, num);
  });
  return {...selResult(ctx), num};
}

function preset(ctx, p) {
  need(ctx);
  const levels = presetLevels(p.preset);
  if (!levels) throw new CommandError('invalid_params', '`preset` must be headings, article, outlineHeadings or chapter', {path: '/preset'});
  let num;
  ctx.model.edit(ctx, d => {
    num = addListLevels(d, null, levels);
    const linked = [];
    for (let n = 1; n <= LEVELS; n++) linked.push(ensureHeadingStyle(d, n));
    linkLevelStyles(d, num, levels);
    const [a] = ordered(ctx, d);
    fmtParas(d, a.story, selectedPaths(ctx, d), pp => {
      // A heading keeps its style and level; any other paragraph becomes Heading 1. The number comes from the style.
      if (!linked.includes(pp.style)) pp.style = linked[0];
      delete pp.numbering;
      delete pp.indentLeft; delete pp.indentFirst; delete pp.indentLeftChars; delete pp.indentFirstChars;
    });
  });
  return {...selResult(ctx), num};
}

const LEVEL = s.object({
  format: s.optional(s.enum(NUM_FORMATS)), text: s.optional(s.string({max: 256})), start: s.optional(s.integer({min: 0})),
  restartAfter: s.optional(s.nullable(s.integer({min: 0}))), style: s.optional(s.nullable(s.string({max: 253}))),
  align: s.optional(s.enum(['left', 'center', 'right'])), alignedAt: s.optional(s.number()), indentAt: s.optional(s.number()),
  follow: s.optional(s.enum(['tab', 'space', 'nothing'])), tabAt: s.optional(s.nullable(s.number())), font: s.optional(s.nullable(s.string({max: 128}))),
  bold: s.optional(s.boolean()), italic: s.optional(s.boolean()), color: s.optional(s.nullable(s.string({max: 16}))), legal: s.optional(s.boolean()),
}, {additional: true});

export default defineCommands({
  family: 'lists',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'list.define', label: 'Define New Multilevel List', risk: 'edit', dialog: 'dialog.defineList',
      description: 'Define New Multilevel List: nine levels (number format, text with %n, start, restart, linked style, alignment, indents, follow, font); `num` changes a list in place; `apply` (default true) numbers the selection.',
      params: s.object({levels: s.array(s.nullable(LEVEL), {max: LEVELS}), num: s.optional(s.integer({min: 1})), apply: s.optional(s.boolean()),
        name: s.optional(s.string({max: 256}))}),
      state: ready,
      run: define,
    },
    {
      id: 'list.get', label: 'List Definition', risk: 'read',
      description: 'List Definition: the nine levels of a list (default: the caret\'s), as list.define takes them.',
      params: s.object({num: s.optional(s.integer({min: 1}))}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const d = peek(ctx);
        const num = p.num ?? caretList(d, focusOf(ctx, d));
        if (num === null || num === undefined) throw new CommandError('failed', 'not in a list');
        const levels = levelsOf(d.numbering, num);
        if (!levels) throw new CommandError('invalid_params', 'no such list', {path: '/num'});
        return {num, levels: levels.map(levelJson), name: abstractOf(d.numbering, num)?.name ?? null};
      },
    },
    {
      id: 'list.multilevelPreset', label: 'Multilevel List Library', risk: 'edit',
      description: 'Multilevel List Library: a new list linked to Heading 1–9 (headings 1/1.1/1.1.1, article, outlineHeadings I./A./1., chapter); selected headings keep their level, other paragraphs become Heading 1.',
      params: s.object({preset: s.enum(PRESETS)}),
      state: ready,
      run: preset,
    },
    {
      id: 'para.setNumberingValue', label: 'Set Numbering Value', risk: 'edit', dialog: 'dialog.setNumberingValue',
      description: 'Set Numbering Value (Home › Paragraph › Numbering): this paragraph starts a new list at `value`, the rest of its list follows.',
      params: s.object({value: s.integer({min: 0, max: 100_000})}),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        try { const d = peek(ctx); const n = d.paraAt(focusOf(ctx, d))?.props?.numbering; return n && n.num !== 0 ? st : {enabled: false, reason: 'not in a numbered list'}; }
        catch { return st; }
      },
      run(ctx, p) {
        need(ctx);
        ctx.model.edit(ctx, d => setNumberingValue(d, focusOf(ctx, d), p.value));
        return selResult(ctx);
      },
    },
    {
      id: 'para.defineBullet', label: 'Define New Bullet', risk: 'edit', dialog: 'dialog.defineBullet',
      description: 'Define New Bullet (Home › Paragraph › Bullets): a bulleted list with this character.',
      params: s.object({char: s.string({min: 1, max: 4})}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        if ([...p.char].length !== 1) throw new CommandError('invalid_params', 'char: one character', {path: '/char'});
        return ctx.run('para.bullets', {kind: p.char});
      },
    },
    {
      id: 'para.defineNumber', label: 'Define New Number Format', risk: 'edit', dialog: 'dialog.defineNumber',
      description: 'Define New Number Format (Home › Paragraph › Numbering): a numbered list whose first level uses `format`, `text` (%1 is the number) and `start`.',
      params: s.object({format: s.optional(s.enum(NUM_FORMATS)), text: s.optional(s.string({max: 64})), start: s.optional(s.integer({min: 0, max: 100_000}))}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const fmt = p.format && isNumFormat(p.format) ? p.format : 'decimal';
        let num;
        ctx.model.edit(ctx, d => {
          const levels = levelsFor('numbered');
          levels[0] = {...levels[0], format: fmt, text: p.text ?? '%1.', start: p.start ?? 1};
          num = addListLevels(d, null, levels);
          const [a] = ordered(ctx, d);
          fmtParas(d, a.story, selectedPaths(ctx, d), pp => { pp.numbering = {num, level: 0}; pp.style = 'ListParagraph'; });
        });
        return {...selResult(ctx), num};
      },
    },
  ],
});
