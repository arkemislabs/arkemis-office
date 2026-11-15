// The master views (View › Master Views): Slide Master (the master and its layouts: Insert Layout,
// Rename, Delete, Preserve, Master Layout's Title and Footers, Insert Placeholder), Handout Master
// and Notes Master (their header, date, footer, page number, slide image and body placeholders), and
// Close Master View.
//
// Translated from deckcraft crates/engine/src/cmd/design/master_view.rs (`master_view`, `handout_view`,
// `handout_placeholders`, `notes_view`, `notes_placeholders`, `close_master`, `insert_layout`,
// `rename_layout`, `delete_layout`, `insert_placeholder`, `preserve`, `placeholders`,
// `handout_placeholder`, `notes_placeholder`, `retarget_placeholder`, `synthesized_placeholder`) and
// crates/ui-egui/src/ribbon/masters.rs at 4ce2944 / f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The open master is the view key `master`: {kind: 'slide' | 'handout' | 'notes', master, layout}
// (deckcraft's Selection.target). The master canvas is drawn read-only: the placeholders and graphics
// of a layout are changed with the tab's commands, not dragged.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2, allocIds} from '../model/doc.mjs';
import {defaultTheme} from '../model/theme.mjs';
import {isTitlePh, shape as newShape, virtualSlideId} from '../model/presentation.mjs';
import {currentSlideId} from '../model/doc.mjs';
import {selectSlideList} from '../lib/text-session.mjs';
import {bad, hasDoc, selectionOf, UPSTREAM_COMMIT} from '../lib/text-session.mjs';
import {masterIndexOf, dateKind, dateNow, fieldRun} from './design.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/design/master_view.rs', 'crates/ui-egui/src/ribbon/masters.rs']};
const v2 = (cmd, ctx) => { if (!isSchema2(ctx.doc)) throw bad(cmd, 'needs a presentation (schema 2)'); };
const isFooterKind = k => k === 'date' || k === 'footer' || k === 'slideNum';
const ph = (kind, idx, extra = {}) => ({kind, idx, vertical: false, size: null, hasCustomPrompt: false, ...extra});

/**
 * Open (or move within) a master view: the master, layout, handout or notes master is edited as a
 * virtual slide (model/presentation.mjs), so the selection goes to it; the slide the person came from
 * is kept to go back to.
 */
function openView(ctx, master) {
  const was = ctx.view?.master;
  const from = was?.from ?? currentSlideId(ctx.doc, ctx.selection) ?? null;
  const vid = virtualSlideId(master.kind, master.master, master.layout);
  ctx.setView({master: {...master, from}, mode: 'normal', show: null});
  ctx.setSelection({ranges: [{anchor: `/sl:${vid}`, focus: `/sl:${vid}`}], primary: 0});
}
const virtualId = open => virtualSlideId(open.kind, open.master, open.layout);

/** The open master view, or null. */
export const openMaster = ctx => ctx.view?.master ?? null;
export {virtualId};

/** The shapes the open slide master or layout holds (path and list), or null. */
function slideTarget(ctx, cmd) {
  const m = openMaster(ctx);
  if (!m || m.kind !== 'slide') throw bad(cmd, 'open View › Slide Master first');
  const master = ctx.doc.masters?.[m.master];
  if (!master) throw bad(cmd, 'no such master');
  if (m.layout === null || m.layout === undefined) return {m, master, layout: null, path: ['masters', m.master, 'shapes'], shapes: master.shapes ?? []};
  const layout = master.layouts?.[m.layout];
  if (!layout) throw bad(cmd, 'no such layout');
  return {m, master, layout, path: ['masters', m.master, 'layouts', m.layout, 'shapes'], shapes: layout.shapes ?? []};
}

// ---------------------------------------------------------------------------------------------
// Handout and notes masters

const HANDOUT_KINDS = [['header', 'header'], ['date', 'date'], ['footer', 'footer'], ['pageNumber', 'slideNum']];
const NOTES_KINDS = [['header', 'header'], ['date', 'date'], ['slideImage', 'slideImage'], ['body', 'body'], ['footer', 'footer'], ['pageNumber', 'slideNum']];

/** The four handout-master placeholders PowerPoint offers, in a page of `size`. */
export function handoutPlaceholder(kind, size, id) {
  const [w, h] = [size.width, size.height];
  const [name, idx, x, y] = kind === 'header' ? ['Header Placeholder', 0, 0, 0] : kind === 'date' ? ['Date Placeholder', 1, w * 0.57, 0]
    : kind === 'footer' ? ['Footer Placeholder', 2, 0, h * 0.95] : ['Slide Number Placeholder', 3, w * 0.57, h * 0.95];
  const right = kind === 'date' || kind === 'slideNum';
  return newShape({id, name: `${name} ${idx + 1}`, xfrm: {x, y, w: w * 0.43, h: h * 0.05}, ph: ph(kind, idx, {size: 'quarter'}),
    text: {body: {}, paragraphs: [{level: 0, runs: [], ...(right ? {props: {align: 'right'}} : {})}]}});
}

/** A notes-master placeholder in a page of `size`, laid out as PowerPoint's default notes master. */
export function notesPlaceholder(kind, size, id) {
  const [w, h] = [size.width, size.height];
  if (kind === 'slideImage') {
    return newShape({id, name: 'Slide Image Placeholder 3', xfrm: {x: w * 0.125, y: h * 0.125, w: w * 0.75, h: h * 0.375}, ph: ph('slideImage', 2),
      fill: {kind: 'none'}, line: {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 0, g: 0, b: 0, a: 255}}}}, width: 1}});
  }
  if (kind === 'body') {
    return newShape({id, name: 'Notes Placeholder 4', xfrm: {x: w * 0.1, y: h * 0.53, w: w * 0.8, h: h * 0.36}, ph: ph('body', 3, {size: 'quarter'}),
      text: {body: {}, paragraphs: [{level: 0, runs: [{text: 'Click to edit Master text styles'}]}]}});
  }
  const sh = handoutPlaceholder(kind, size, id);
  return {...sh, ph: {...sh.ph, idx: kind === 'header' ? 0 : kind === 'date' ? 1 : kind === 'footer' ? 4 : 5}};
}

const auxMaster = (ctx, name) => {
  const first = ctx.doc.masters?.[0];
  return {id: '0', name, theme: structuredClone(first?.theme ?? defaultTheme()), shapes: [], background: null, titleStyle: {levels: []}, bodyStyle: {levels: []}, otherStyle: {levels: []},
    layouts: [], colorMap: structuredClone(first?.colorMap ?? []), preserve: false};
};
const shown = (m, kind) => !!m && (m.shapes ?? []).some(x => x.ph?.kind === kind);

/** The Notes and Handouts page of Header and Footer: the date, header, page number and footer of the notes master and the handout master, as PowerPoint sets both together. */
const NH_KINDS = [['header', 'header'], ['date', 'date'], ['footer', 'footer'], ['pageNumber', 'slideNum']];
export function notesHandoutsState(doc) {
  const read = m => {
    const find = k => (m?.shapes ?? []).find(x => x.ph?.kind === k);
    const text = k => (find(k)?.text?.paragraphs ?? []).flatMap(p => p.runs ?? []).map(r => r.text ?? '').join('');
    const dateRun = (find('date')?.text?.paragraphs ?? []).flatMap(p => p.runs ?? []).find(r => r.kind?.kind === 'field');
    return {header: !!find('header'), headerText: text('header'), date: !!find('date'), dateFixed: !!find('date') && !dateRun && text('date') !== '', dateText: dateRun ? '' : text('date'),
      dateFormat: dateRun?.kind.field ?? 'datetime1', footer: !!find('footer'), footerText: text('footer'), pageNumber: !!find('slideNum')};
  };
  return read((doc.notesMaster?.shapes ?? []).length ? doc.notesMaster : doc.handoutMaster);
}
function notesHandoutsRun(ctx, p) {
  const cmd = 'design.notesHeaderFooter';
  v2(cmd, ctx);
  const dateOn = typeof p.date === 'boolean' ? p.date : undefined;
  for (const [field, title, kinds, make] of [['notesMaster', 'Notes Master', NOTES_KINDS, notesPlaceholder], ['handoutMaster', 'Handout Master', HANDOUT_KINDS, handoutPlaceholder]]) {
    let m = ctx.doc[field] ? structuredClone(ctx.doc[field]) : null;
    if (!m || !(m.shapes ?? []).length) {
      const ids0 = allocIds(ctx, kinds.length);
      m = m ?? auxMaster(ctx, title);
      m.shapes = [...(m.shapes ?? []), ...kinds.map(([, kind], i) => make(kind, ctx.doc.notesSize, ids0[i]))];
    }
    const given = NH_KINDS.filter(([k]) => typeof p[k] === 'boolean');
    const ids = given.length ? allocIds(ctx, given.length) : [];
    let shapes = [...m.shapes];
    given.forEach(([k, kind], i) => {
      const has = shapes.some(x => x.ph?.kind === kind);
      if (p[k] && !has) shapes.push(make(kind, ctx.doc.notesSize, ids[i]));
      else if (!p[k]) shapes = shapes.filter(x => x.ph?.kind !== kind);
    });
    const setText = (kind, run) => { shapes = shapes.map(x => (x.ph?.kind === kind ? {...x, text: {...(x.text ?? {body: {}}), paragraphs: [{...(x.text?.paragraphs?.[0] ?? {level: 0}), runs: run ? [run] : []}]}} : x)); };
    if (typeof p.headerText === 'string') setText('header', p.headerText ? {text: p.headerText} : null);
    if (typeof p.footerText === 'string') setText('footer', p.footerText ? {text: p.footerText} : null);
    if (typeof p.dateText === 'string' || typeof p.dateFormat === 'string' || dateOn === true) {
      const fixed = typeof p.dateText === 'string' ? p.dateText : '';
      const format = dateKind(p.dateFormat);
      setText('date', fixed ? {text: fixed} : fieldRun(dateNow(ctx, format), format));
    }
    setText('slideNum', fieldRun('‹#›', 'slidenum'));
    if (JSON.stringify(shapes) !== JSON.stringify(ctx.doc[field]?.shapes) || !ctx.doc[field]) ctx.change.set([field], {...m, shapes});
  }
  return {};
}

function placeholdersCommand(cmd, field, key, kinds, make) {
  return (ctx, p) => {
    v2(cmd, ctx);
    const open = openMaster(ctx);
    if (!open || open.kind !== (field === 'handoutMaster' ? 'handout' : 'notes')) throw bad(cmd, `open View › ${field === 'handoutMaster' ? 'Handout' : 'Notes'} Master first`);
    const master = ctx.doc[field];
    if (!master) throw bad(cmd, `no ${field === 'handoutMaster' ? 'handout' : 'notes'} master`);
    const given = kinds.filter(([k]) => typeof p[k] === 'boolean');
    const ids = given.length ? allocIds(ctx, given.length) : [];
    let shapes = [...(master.shapes ?? [])];
    given.forEach(([k, kind], i) => {
      const has = shapes.some(x => x.ph?.kind === kind);
      if (p[k] && !has) shapes.push(make(kind, ctx.doc.notesSize, ids[i]));
      else if (!p[k]) shapes = shapes.filter(x => x.ph?.kind !== kind);
    });
    if (JSON.stringify(shapes) !== JSON.stringify(master.shapes)) ctx.change.set([field, 'shapes'], shapes);
    return Object.fromEntries(kinds.map(([k, kind]) => [k, shapes.some(x => x.ph?.kind === kind)]));
  };
}

const checkState = (field, kind) => ctx => (!isSchema2(ctx.doc) ? hasDoc(ctx) : {enabled: !!openMaster(ctx) && openMaster(ctx).kind === (field === 'handoutMaster' ? 'handout' : 'notes'),
  reason: 'open the master view first', checked: shown(ctx.doc[field], kind)});

// ---------------------------------------------------------------------------------------------
// Placeholders on a master or layout

const PREFERRED_IDX = {title: 0, ctrTitle: 0, date: 10, footer: 11, slideNum: 12};
function freeIdx(shapes, preferred) {
  const taken = i => shapes.some(x => x.ph?.idx === i);
  return !taken(preferred) ? preferred : Math.max(0, ...shapes.map(x => x.ph?.idx ?? 0)) + 1;
}
const slideNumberParagraph = () => ({level: 0, runs: [{text: '‹#›', kind: {kind: 'field', field: 'slidenum'}}]});
/** A copy of a master placeholder, with a new id and index. Prompt text is cleared; a slide number keeps its field. */
function retarget(sh, id, idx) {
  const out = {...structuredClone(sh), id, ph: {...sh.ph, idx}};
  if (sh.ph?.kind === 'slideNum') out.text = {...(out.text ?? {body: {}}), paragraphs: [slideNumberParagraph()]};
  else if (out.text) out.text = {...out.text, paragraphs: []};
  return out;
}
/** Standard placeholder boxes at 960x540, scaled to the slide size. */
function placeholderRect(kind, size) {
  const [sx, sy] = [size.width / 960, size.height / 540];
  const [x, y, w, h] = kind === 'date' ? [60, 500, 216, 28] : kind === 'footer' ? [318, 500, 324, 28] : kind === 'slideNum' ? [684, 500, 216, 28] : [60, 29, 840, 104];
  return {x: x * sx, y: y * sy, w: w * sx, h: h * sy};
}
function synthesized(kind, id, idx, size) {
  const name = kind === 'date' ? 'Date Placeholder' : kind === 'footer' ? 'Footer Placeholder' : kind === 'slideNum' ? 'Slide Number Placeholder' : 'Title';
  return newShape({id, name, xfrm: placeholderRect(kind, size), ph: ph(kind, idx),
    text: {body: {}, paragraphs: kind === 'slideNum' ? [slideNumberParagraph()] : []}});
}

const layoutKey = (p, ctx, cmd) => {
  const m = openMaster(ctx);
  const mi = p.master ?? (m?.kind === 'slide' ? m.master : masterIndexOf(ctx.doc, selectionOf(ctx).slide));
  const li = p.layout ?? (m?.kind === 'slide' && m.layout !== null && m.layout !== undefined ? m.layout : 0);
  if (!ctx.doc.masters?.[mi]?.layouts?.[li]) throw bad(cmd, 'no such layout');
  return [mi, li];
};
const inSlideMaster = ctx => (isSchema2(ctx.doc) ? (openMaster(ctx)?.kind === 'slide' ? {enabled: true} : {enabled: false, reason: 'open View › Slide Master first'}) : hasDoc(ctx));
const inLayout = ctx => (inSlideMaster(ctx).enabled ? (openMaster(ctx).layout !== null && openMaster(ctx).layout !== undefined ? {enabled: true} : {enabled: false, reason: 'select a layout in Slide Master view'}) : inSlideMaster(ctx));

export default defineCommands({
  family: 'master',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'view.slideMaster', label: 'Slide Master', risk: 'read', effect: 'view',
      description: 'Slide Master (View › Master Views): open the slide master view on {master?, layout?} (a master thumbnail sends only `master` and means the master itself; with neither, the layout of the current slide).',
      params: s.object({master: s.optional(s.integer({min: 0, max: 1000})), layout: s.optional(s.integer({min: 0, max: 1000}))}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: openMaster(ctx)?.kind === 'slide'} : hasDoc(ctx)),
      run(ctx, p) {
        v2('view.slideMaster', ctx);
        const sl = selectionOf(ctx).slide;
        const mi = p.master ?? masterIndexOf(ctx.doc, sl);
        if (!ctx.doc.masters?.[mi]) throw bad('view.slideMaster', 'no such master', {path: '/master'});
        const layout = p.master !== undefined && p.layout === undefined ? null : p.layout ?? (() => { const i = (ctx.doc.masters[mi].layouts ?? []).findIndex(l => l.id === sl?.layout); return i < 0 ? null : i; })();
        if (layout !== null && !ctx.doc.masters[mi].layouts?.[layout]) throw bad('view.slideMaster', 'no such layout', {path: '/layout'});
        openView(ctx, {kind: 'slide', master: mi, layout});
        return {master: mi, layout};
      },
    },
    {
      id: 'view.handoutMaster', label: 'Handout Master', risk: 'edit',
      description: 'Handout Master (View › Master Views): open the handout master view; a deck without one gets it, with a header, date, footer and page number.',
      params: s.object({}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: openMaster(ctx)?.kind === 'handout'} : hasDoc(ctx)),
      run(ctx) {
        v2('view.handoutMaster', ctx);
        const created = !ctx.doc.handoutMaster;
        if (created) {
          const ids = allocIds(ctx, HANDOUT_KINDS.length);
          const m = auxMaster(ctx, 'Handout Master');
          m.shapes = HANDOUT_KINDS.map(([, kind], i) => handoutPlaceholder(kind, ctx.doc.notesSize, ids[i]));
          ctx.change.set(['handoutMaster'], m);
        }
        openView(ctx, {kind: 'handout', master: 0, layout: null});
        return {created};
      },
    },
    {
      id: 'view.notesMaster', label: 'Notes Master', risk: 'edit',
      description: 'Notes Master (View › Master Views): open the notes master view; a deck without one gets it, with a header, date, slide image, notes body, footer and page number.',
      params: s.object({}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: openMaster(ctx)?.kind === 'notes'} : hasDoc(ctx)),
      run(ctx) {
        v2('view.notesMaster', ctx);
        const created = !ctx.doc.notesMaster || !(ctx.doc.notesMaster.shapes ?? []).length;
        if (created) {
          const ids = allocIds(ctx, NOTES_KINDS.length);
          const m = ctx.doc.notesMaster ? structuredClone(ctx.doc.notesMaster) : auxMaster(ctx, 'Notes Master');
          m.shapes = [...(m.shapes ?? []), ...NOTES_KINDS.map(([, kind], i) => notesPlaceholder(kind, ctx.doc.notesSize, ids[i]))];
          ctx.change.set(['notesMaster'], m);
        }
        openView(ctx, {kind: 'notes', master: 0, layout: null});
        return {created};
      },
    },
    {
      id: 'view.closeMaster', label: 'Close Master View', risk: 'read', effect: 'view',
      description: 'Close Master View: back to the slides.',
      params: s.object({}),
      state: ctx => (isSchema2(ctx.doc) ? (openMaster(ctx) ? {enabled: true} : {enabled: false, reason: 'no master view is open'}) : hasDoc(ctx)),
      run(ctx) {
        v2('view.closeMaster', ctx);
        const from = openMaster(ctx)?.from;
        const sl = (ctx.doc.slides ?? []).find(x => x.id === from) ?? ctx.doc.slides?.[0];
        ctx.setView({master: null});
        if (sl) selectSlideList(ctx, [sl.id], sl.id);
        return {};
      },
    },
    {
      id: 'master.insertLayout', label: 'Insert Layout', risk: 'edit',
      description: 'Insert Layout (Slide Master › Edit Master): a new custom layout after the open one, with a title placeholder copied from the master; `name` (default Custom Layout). It becomes the open layout.',
      params: s.object({name: s.optional(s.string({min: 1, max: 255}))}),
      state: inSlideMaster,
      run(ctx, p) {
        v2('master.insertLayout', ctx);
        const open = openMaster(ctx);
        if (open?.kind !== 'slide') throw bad('master.insertLayout', 'open View › Slide Master first');
        const mi = open.master;
        const master = ctx.doc.masters[mi];
        const [id, tid] = allocIds(ctx, 2);
        const title = (master.shapes ?? []).find(x => x.ph && isTitlePh(x.ph.kind));
        const shapes = title ? [{...structuredClone(title), id: tid, text: {body: {}, paragraphs: []}}] : [];
        const layouts = [...(master.layouts ?? [])];
        const at = Math.min(open.layout !== null && open.layout !== undefined ? open.layout + 1 : layouts.length, layouts.length);
        layouts.splice(at, 0, {id, name: p.name ?? 'Custom Layout', kind: 'custom', shapes, background: null, showMasterShapes: true, preserve: true});
        ctx.change.set(['masters', mi, 'layouts'], layouts);
        openView(ctx, {kind: 'slide', master: mi, layout: at});
        return {id};
      },
    },
    {
      id: 'master.renameLayout', label: 'Rename Layout', risk: 'edit', dialog: 'dialog.renameLayout',
      description: 'Rename (Slide Master › Edit Master): give the open layout (or {master, layout}) a new `name`.',
      params: s.object({name: s.string({min: 1, max: 255}), master: s.optional(s.integer({min: 0, max: 1000})), layout: s.optional(s.integer({min: 0, max: 1000}))}),
      state: inLayout,
      run(ctx, p) {
        v2('master.renameLayout', ctx);
        const [mi, li] = layoutKey(p, ctx, 'master.renameLayout');
        ctx.change.set(['masters', mi, 'layouts', li, 'name'], p.name);
        return {};
      },
    },
    {
      id: 'master.deleteLayout', label: 'Delete Layout', risk: 'edit',
      description: 'Delete (Slide Master › Edit Master): delete the open layout (or {master, layout}); refused while slides use it or when it is the master\'s last layout.',
      params: s.object({master: s.optional(s.integer({min: 0, max: 1000})), layout: s.optional(s.integer({min: 0, max: 1000}))}),
      state: inLayout,
      run(ctx, p) {
        v2('master.deleteLayout', ctx);
        const [mi, li] = layoutKey(p, ctx, 'master.deleteLayout');
        const master = ctx.doc.masters[mi];
        const id = master.layouts[li].id;
        if (ctx.doc.slides.some(x => x.layout === id)) throw bad('master.deleteLayout', 'slides use this layout');
        if (master.layouts.length <= 1) throw bad('master.deleteLayout', 'a master needs at least one layout');
        const layouts = master.layouts.filter((_, i) => i !== li);
        ctx.change.set(['masters', mi, 'layouts'], layouts);
        openView(ctx, {kind: 'slide', master: mi, layout: Math.min(li, layouts.length - 1)});
        return {};
      },
    },
    {
      id: 'master.insertPlaceholder', label: 'Insert Placeholder', risk: 'edit',
      description: 'Insert Placeholder (Slide Master › Master Layout): add a placeholder to the open layout: {kind: content | text | picture | chart | table | media, rect?: [x, y, w, h]}.',
      params: s.object({kind: s.enum(['content', 'text', 'picture', 'chart', 'table', 'media']), rect: s.optional(s.array(s.number(), {min: 4, max: 4}))}),
      state: inLayout,
      run(ctx, p) {
        v2('master.insertPlaceholder', ctx);
        const t = slideTarget(ctx, 'master.insertPlaceholder');
        if (!t.layout) throw bad('master.insertPlaceholder', 'select a layout in Slide Master view');
        const size = ctx.doc.slideSize;
        const [x, y, w, h] = p.rect ?? [size.width * 0.25, size.height * 0.3, size.width * 0.5, size.height * 0.4];
        const kind = {content: 'obj', text: 'body', picture: 'picture', chart: 'chart', table: 'table', media: 'media'}[p.kind];
        const [id] = allocIds(ctx, 1);
        const idx = Math.max(0, ...t.shapes.map(sh => sh.ph?.idx ?? 0)) + 1;
        ctx.change.set(t.path, [...t.shapes, newShape({id, xfrm: {x, y, w: Math.abs(w), h: Math.abs(h)}, ph: ph(kind, idx), text: {body: {}, paragraphs: []}})]);
        return {id};
      },
    },
    {
      id: 'master.preserve', label: 'Preserve', risk: 'edit',
      description: 'Preserve (Slide Master › Edit Master): keep the open master or layout even when no slide uses it; `preserve` sets it, without it the setting toggles.',
      params: s.object({preserve: s.optional(s.boolean())}),
      state(ctx) {
        const st = inSlideMaster(ctx);
        if (!st.enabled) return st;
        const t = slideTarget(ctx, 'master.preserve');
        return {enabled: true, checked: !!(t.layout ?? t.master).preserve};
      },
      run(ctx, p) {
        v2('master.preserve', ctx);
        const t = slideTarget(ctx, 'master.preserve');
        const cur = !!(t.layout ?? t.master).preserve;
        const next = typeof p.preserve === 'boolean' ? p.preserve : !cur;
        if (next !== cur) ctx.change.set(t.layout ? ['masters', t.m.master, 'layouts', t.m.layout, 'preserve'] : ['masters', t.m.master, 'preserve'], next);
        return {preserve: next};
      },
    },
    {
      id: 'master.placeholders', label: 'Layout Placeholders', risk: 'edit',
      description: 'Master Layout (Slide Master › Master Layout): show or hide the Title and the Footers (date, footer, slide number) placeholders of the open master or layout: {title?, footers?: bool}.',
      params: s.object({title: s.optional(s.boolean()), footers: s.optional(s.boolean()), field: s.optional(s.enum(['title', 'footers']))}),
      state(ctx, p) {
        const st = inSlideMaster(ctx);
        if (!st.enabled) return st;
        const t = slideTarget(ctx, 'master.placeholders');
        const hasTitle = t.shapes.some(x => x.ph && isTitlePh(x.ph.kind)), hasFooters = t.shapes.some(x => x.ph && isFooterKind(x.ph.kind));
        return {enabled: true, checked: p?.field === 'title' || p?.title !== undefined ? hasTitle : p?.field === 'footers' || p?.footers !== undefined ? hasFooters : undefined};
      },
      run(ctx, p) {
        v2('master.placeholders', ctx);
        if (p.title === undefined && p.footers === undefined) throw bad('master.placeholders', 'give title or footers');
        const t = slideTarget(ctx, 'master.placeholders');
        let shapes = [...t.shapes];
        const hasTitle = shapes.some(x => x.ph && isTitlePh(x.ph.kind)), hasFooters = shapes.some(x => x.ph && isFooterKind(x.ph.kind));
        const add = [];
        if (p.title === true && !hasTitle) add.push('title');
        if (p.footers === true && !hasFooters) add.push('date', 'footer', 'slideNum');
        if (p.title === false) shapes = shapes.filter(x => !(x.ph && isTitlePh(x.ph.kind)));
        if (p.footers === false) shapes = shapes.filter(x => !(x.ph && isFooterKind(x.ph.kind)));
        const ids = add.length ? allocIds(ctx, add.length) : [];
        const protos = t.master.shapes ?? [];
        add.forEach((kind, i) => {
          const idx = freeIdx(shapes, PREFERRED_IDX[kind] ?? 1);
          const proto = protos.find(x => (kind === 'title' ? x.ph && isTitlePh(x.ph.kind) : x.ph?.kind === kind));
          shapes.push(proto ? retarget(proto, ids[i], idx) : synthesized(kind, ids[i], idx, ctx.doc.slideSize));
        });
        if (JSON.stringify(shapes) !== JSON.stringify(t.shapes)) ctx.change.set(t.path, shapes);
        return {title: shapes.some(x => x.ph && isTitlePh(x.ph.kind)), footers: shapes.some(x => x.ph && isFooterKind(x.ph.kind))};
      },
    },
    {
      id: 'design.notesHeaderFooter', label: 'Header and Footer (Notes and Handouts)', risk: 'edit',
      description: 'Header and Footer… › Notes and Handouts: {header?, headerText?, date?, dateText? (fixed; empty = automatic), dateFormat?, footer?, footerText?, pageNumber?}: show or hide those placeholders on the notes master and the handout master together (a deck without them gets both) and set their text.',
      params: s.object({header: s.optional(s.boolean()), headerText: s.optional(s.string({max: 10000})), date: s.optional(s.boolean()), dateText: s.optional(s.string({max: 1000})), dateFormat: s.optional(s.string({max: 20})),
        footer: s.optional(s.boolean()), footerText: s.optional(s.string({max: 10000})), pageNumber: s.optional(s.boolean())}),
      state: hasDoc,
      run: notesHandoutsRun,
    },
    {
      id: 'handout.placeholders', label: 'Handout Placeholders', risk: 'edit',
      description: 'Handout Placeholders (Handout Master › Placeholders): show or hide the {header?, date?, footer?, pageNumber?: bool} placeholders of the handout master.',
      params: s.object({header: s.optional(s.boolean()), date: s.optional(s.boolean()), footer: s.optional(s.boolean()), pageNumber: s.optional(s.boolean()), field: s.optional(s.enum(['header', 'date', 'footer', 'pageNumber']))}),
      state(ctx, p) { const key = HANDOUT_KINDS.find(([k]) => p?.field === k || p?.[k] !== undefined); return checkState('handoutMaster', key?.[1])(ctx); },
      run: placeholdersCommand('handout.placeholders', 'handoutMaster', null, HANDOUT_KINDS, handoutPlaceholder),
    },
    {
      id: 'notes.placeholders', label: 'Notes Placeholders', risk: 'edit',
      description: 'Notes Placeholders (Notes Master › Placeholders): show or hide the {header?, date?, slideImage?, body?, footer?, pageNumber?: bool} placeholders of the notes master.',
      params: s.object({header: s.optional(s.boolean()), date: s.optional(s.boolean()), slideImage: s.optional(s.boolean()), body: s.optional(s.boolean()), footer: s.optional(s.boolean()), pageNumber: s.optional(s.boolean()), field: s.optional(s.enum(['header', 'date', 'slideImage', 'body', 'footer', 'pageNumber']))}),
      state(ctx, p) { const key = NOTES_KINDS.find(([k]) => p?.field === k || p?.[k] !== undefined); return checkState('notesMaster', key?.[1])(ctx); },
      run: placeholdersCommand('notes.placeholders', 'notesMaster', null, NOTES_KINDS, notesPlaceholder),
    },
    {
      id: 'handout.perPage', label: 'Slides Per Page', risk: 'read', effect: 'view',
      description: 'Slides Per Page (Handout Master › Page Setup): how many slides a handout page holds: 1, 2, 3, 4, 6 or 9.',
      params: s.object({n: s.optional(s.integer({min: 1, max: 9}))}),
      state: ctx => (isSchema2(ctx.doc) ? {enabled: openMaster(ctx)?.kind === 'handout', reason: 'open View › Handout Master first',
        value: [1, 2, 3, 4, 6, 9].map(n => ({id: String(n), label: `${n} Slide${n === 1 ? '' : 's'}`, value: n, checked: (ctx.view?.handoutPerPage ?? 6) === n}))} : hasDoc(ctx)),
      run(ctx, p) {
        v2('handout.perPage', ctx);
        if (p.n === undefined) return {n: ctx.view?.handoutPerPage ?? 6};
        if (![1, 2, 3, 4, 6, 9].includes(p.n)) throw bad('handout.perPage', 'slides per page: 1, 2, 3, 4, 6 or 9', {path: '/n'});
        ctx.setView({handoutPerPage: p.n});
        return {n: p.n};
      },
    },
  ],
});
