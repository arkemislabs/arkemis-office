// Forms: Prepare a form (auto-detect fields, add text, check box, radio button, drop-down, list box,
// button, image, date and digital signature fields, move, resize, align, distribute, match size,
// duplicate, delete, Field Properties with every tab, the Fields panel with tab order, calculation
// order), filling forms (real AcroForm values), Clear form, Flatten, Import and Export form data,
// Merge data files into a spreadsheet, Highlight existing fields.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:275-324   catalog ids, labels, Needs (Document, FillForms, HasFields,
//                                           Modification, Nothing)
//   crates/ui-egui/src/commands.rs:547-667  what each id does: panel, flatten, clear, tab order, calculation
//                                           order panel, export / import / merge dialogs, prepare (opens the
//                                           tool, the Fields panel, detects fields in a form-less document),
//                                           detect, properties, the field tools
//   crates/ui-egui/src/tools/prepare.rs     FieldTool (new_field, default_size), placing by click or drag,
//                                           select / move / resize, arrange, delete_selected, nudge keys
//   crates/ui-egui/src/tools/prepare/*.rs, bulk_fields.rs   Field Properties tabs, shared properties
//   crates/ui-egui/src/tools/calc_order_ui.rs               the calculation order panel
//   crates/ui-egui/src/workflows/files.rs, js_ui.rs        import / export / merge / detect_fields
//   crates/forms/src/**, crates/xfdf/src/** (lib/form-*.mjs)
//   crates/engine/src/edit/labels.rs        undo labels
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/form.test.mjs.
//
// Geometry in params is in the bridge convention (docs/architecture.md 14.5): page view points, origin
// at the top-left of the displayed page (crop box, rotation applied).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pagesOf, pageAt, currentPage} from '../lib/comment-geometry.mjs';
import {pageText} from '../model/page-text.mjs';
import {userRectToView} from '../lib/geom.mjs';
import {readOther, writeOther, interactive, readState, writeState, stem} from '../lib/page-files.mjs';
import {loadOther, loadSource, bytesOf} from '../lib/page-source.mjs';
import {formEdit, describeField, modelFields, userRectOf, selectionOf, signedBytes} from '../lib/form-model.mjs';
import * as E from '../lib/form-edit.mjs';
import {readFields, FLAG, TRIGGERS} from '../lib/form-read.mjs';
import {detect, pageShapes} from '../lib/form-detect.mjs';
import * as D from '../lib/form-data.mjs';
import {words} from '../address.mjs';
import {viewRectToUser} from '../lib/geom.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/tools/prepare.rs', 'crates/ui-egui/src/tools/prepare/draft.rs',
    'crates/ui-egui/src/tools/prepare/properties.rs', 'crates/ui-egui/src/tools/prepare/tabs.rs', 'crates/ui-egui/src/tools/bulk_fields.rs',
    'crates/ui-egui/src/tools/calc_order_ui.rs', 'crates/ui-egui/src/workflows/files.rs', 'crates/ui-egui/src/workflows/js_ui.rs',
    'crates/forms/src/lib.rs', 'crates/forms/src/read.rs', 'crates/forms/src/values.rs', 'crates/forms/src/author.rs', 'crates/forms/src/calc_order.rs',
    'crates/forms/src/tab_order.rs', 'crates/forms/src/detect.rs', 'crates/forms/src/af.rs', 'crates/xfdf/src/lib.rs', 'crates/engine/src/edit/labels.rs']};

// ── states (commands.rs Needs) ──────────────────────────────────────────────────────────────

const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);
const loaded = ctx => (ctx.doc?.folio === 2 ? null : {enabled: false, reason: 'the PDF is still opening'});
/** Needs::Modification: the document allows changes. */
function modificationState(ctx) {
  if (!pagesOf(ctx).length) return noPdf;
  if (ctx.doc.permissions && ctx.doc.permissions.modify === false) return {enabled: false, reason: "this PDF's permissions don't allow changes"};
  return loaded(ctx) ?? {enabled: true};
}
/** Needs::FillForms: the document allows filling in forms. */
function fillState(ctx) {
  if (!pagesOf(ctx).length) return noPdf;
  const perm = ctx.doc.permissions;
  if (perm && (perm.fillForms === false || perm.fill === false)) return {enabled: false, reason: "this PDF's permissions don't allow filling in forms"};
  return loaded(ctx) ?? {enabled: true};
}
const fieldsOf = ctx => (Array.isArray(ctx.doc?.fields) ? ctx.doc.fields : []);
/** Needs::HasFields. */
function hasFieldsState(ctx) {
  if (!pagesOf(ctx).length) return noPdf;
  return fieldsOf(ctx).length ? {enabled: true} : {enabled: false, reason: 'the document has no form fields'};
}
const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };

const pageParam = s.optional(s.union([s.string({min: 1, max: 120}), s.integer({min: 1, max: 100000})], {description: 'Page id or 1-based number (default: the page shown)'}));
const rectParam = s.array(s.number({min: -100000, max: 100000}), {min: 4, max: 4, description: '[x, y, width, height] in page view points (top-left origin)'});
const fieldRef = s.object({name: s.string({min: 1, max: 600}), widget: s.optional(s.integer({min: 0, max: 100000}))});

const findField = (ctx, name) => {
  const f = fieldsOf(ctx).find(x => x.name === name);
  if (!f) throw new CommandError('not_found', `there is no field named "${name}"`, {path: '/name'});
  return f;
};

/** Where a widget is, as view rectangle, page record and user rectangle. */
function widgetOf(ctx, f, wi) {
  const w = f.widgets[wi ?? 0];
  if (!w) throw new CommandError('not_found', `${f.name} has no widget ${(wi ?? 0) + 1}`, {path: '/widget'});
  const page = pagesOf(ctx).find(p => p.id === w.pageId);
  return {w, page};
}

// ── the field tools ─────────────────────────────────────────────────────────────────────────

/** prepare.rs FIELD_TOOLS: the command of each field tool and the field it makes. */
const TOOLS = [
  ['form.add.text', 'text', 'Text field'], ['form.add.checkbox', 'checkbox', 'Checkbox'], ['form.add.radio', 'radio', 'Radio button'],
  ['form.add.combo', 'combo', 'Drop-down list'], ['form.add.list', 'list', 'List box'], ['form.add.button', 'button', 'Button'],
  ['form.add.image', 'image', 'Image field'], ['form.add.date', 'date', 'Date field'], ['form.add.signature', 'signature', 'Digital signature'],
];

function newSpec(kind, p, ctx) {
  switch (kind) {
    case 'radio': {
      // Radio buttons dropped next to a selected radio group join it with the next free choice (FieldTool::new_field).
      const sel = selectionOf(ctx)[0];
      const join = p.group ?? (sel && fieldsOf(ctx).find(f => f.name === sel.name && f.kind === 'radio')?.name) ?? null;
      const group = join ? fieldsOf(ctx).find(f => f.name === join && f.kind === 'radio') : null;
      let exportValue = p.exportValue;
      if (!exportValue) {
        const taken = new Set((group?.widgets ?? []).map(w => w.onState));
        for (let i = 1; ; i++) if (!taken.has(`Choice${i}`)) { exportValue = `Choice${i}`; break; }
      }
      return {kind, group: join, exportValue};
    }
    case 'combo': return {kind, options: p.options ?? [], editable: !!p.editable};
    case 'list': return {kind, options: p.options ?? [], multi: !!p.multi};
    case 'button': return {kind, caption: p.caption ?? ''};
    case 'text': return {kind, multiline: !!p.multiline};
    default: return {kind};
  }
}

function addTool([id, kind, label]) {
  return {
    id, label: `Add a ${label.toLowerCase()}`, risk: 'edit', needs: 'worker',
    description: `${label} (Prepare a form ▸ Add form components). With \`rect\` ([x, y, w, h] in page view points) or \`at\` ([x, y]: the default size, top-left at the point) on \`page\` the field is added at once; with neither, picking the tool makes it the quick tool, and the next click on a page adds the field or a drag draws its size.`,
    params: s.object({
      page: pageParam, rect: s.optional(rectParam), at: s.optional(s.array(s.number({min: -100000, max: 100000}), {min: 2, max: 2})),
      name: s.optional(s.string({min: 1, max: 600})), options: s.optional(s.array(s.string({max: 1000}), {max: 1000})),
      multiline: s.optional(s.boolean()), group: s.optional(s.string({min: 1, max: 600})), exportValue: s.optional(s.string({min: 1, max: 200})),
      caption: s.optional(s.string({max: 1000})), editable: s.optional(s.boolean()), multi: s.optional(s.boolean()),
    }),
    state: c => ({...modificationState(c), checked: c.view?.tool === id}),
    async run(ctx, p) {
      if (p.rect === undefined && p.at === undefined) {
        ctx.setView({tool: id, highlighter: false, formPrepare: true});
        return {tool: id};
      }
      const {pi, page} = currentPage(ctx, p.page);
      let rect = p.rect;
      if (!rect) {
        const [w, h] = E.defaultSize(kind);
        rect = [p.at[0], p.at[1], w, h];
      }
      const user = userRectOf(page, rect);
      const sel = newSpec(kind, p, ctx);
      const added = await formEdit(ctx, 'Add field', pdf => E.addField(pdf, sourceFor(ctx, pi), user, sel, p.name ?? null));
      const f = fieldsOf(ctx).find(x => x.name === added.name);
      const wi = f ? f.widgets.findIndex(w => w.id === added.widget) : 0;
      // Placing a field ends the tool and selects the new field (prepare.rs `placed`, `select_added`).
      ctx.setView({tool: null, formSel: [{name: added.name, widget: Math.max(0, wi)}], formPrepare: true});
      return {name: added.name, widget: Math.max(0, wi), page: page.id};
    },
  };
}

/** The source page index to address after the model's pages were made their own source pages (`editable`). */
function sourceFor(ctx, pi) {
  const pages = ctx.doc.pages;
  const shared = pages.some((p, i) => pages.some((q, j) => i !== j && p.sourceIndex === q.sourceIndex));
  return shared ? pi : pages[pi].sourceIndex;
}

const formatSchema = s.optional(s.any({description: 'Format: {kind: none | number {decimals, sep, neg, currency, prepend} | percent {decimals, sep} | date {fmt} | time {fmt} | special {n} | mask {mask}}'}));

const propsSchema = s.object({
  name: s.optional(s.string({min: 1, max: 600})), tooltip: s.optional(s.string({max: 4000})), readOnly: s.optional(s.boolean()), required: s.optional(s.boolean()),
  multiline: s.optional(s.boolean()), maxLen: s.optional(s.nullable(s.integer({min: 0, max: 1000000}))), options: s.optional(s.array(s.any(), {max: 5000})),
  fontSize: s.optional(s.number({min: 0, max: 300})), rect: s.optional(s.any({description: '[widget index, [x, y, w, h] in page view points]'})),
  look: s.optional(s.any({description: '{border, fill, width, style, text, font, size}'})), appearance: s.optional(s.any({description: 'a partial look: only the properties given change'})),
  format: formatSchema, validate: s.optional(s.any()), calculate: s.optional(s.any()), flags: s.optional(s.array(s.any(), {max: 40})),
  quadding: s.optional(s.integer({min: 0, max: 2})), defaultValue: s.optional(s.nullable(s.string({max: 100000}))), locked: s.optional(s.boolean()),
  actions: s.optional(s.array(s.any(), {max: 20})), checkStyle: s.optional(s.string({max: 20})), rotation: s.optional(s.any({description: '[widget index, 0 | 90 | 180 | 270]'})),
  caption: s.optional(s.any({description: '[widget index, text]'})),
  exportValue: s.optional(s.any({description: "[widget index, export value]: a check box or radio button's export value, its appearance state kept (printcraft 8f16855)"})),
  userRect: s.optional(s.any({description: '[widget index, [x0, y0, x1, y1]] in the own user space of the page (Position tab: Left, Bottom, Width, Height)'})),
});

/** view-space rect params of a props object → user space on the widget's page. */
function userProps(ctx, f, props) {
  const out = {...props};
  if (props.userRect) { out.rect = props.userRect; delete out.userRect; }
  else if (props.rect) {
    const [wi, r] = props.rect;
    const {page} = widgetOf(ctx, f, wi);
    out.rect = [wi, userRectOf(page, r)];
  }
  return out;
}

function apply(ctx, name, props, label = 'Change field properties') {
  const f = findField(ctx, name);
  const up = userProps(ctx, f, props);
  return formEdit(ctx, label, pdf => E.setProps(pdf, name, up));
}

/** The widgets as [{name, widget}] the arrange commands work on: the named ones or the selection. */
function targets(ctx, list) {
  const sel = list?.length ? list.map(x => ({name: x.name, widget: x.widget ?? 0})) : selectionOf(ctx);
  if (!sel.length) throw new CommandError('invalid_params', 'select a field first (or pass fields)', {path: '/fields'});
  return sel;
}

const DATA_FILTERS = [{name: 'Comment and form data', extensions: ['xfdf', 'fdf', 'xml', 'xdp', 'csv', 'txt']}];
const EXPORT_FILTERS = [{name: 'XFDF', extensions: ['xfdf']}, {name: 'FDF', extensions: ['fdf']}, {name: 'XML', extensions: ['xml']}, {name: 'CSV', extensions: ['csv']}, {name: 'Text', extensions: ['txt']}];

const toBytes = x => (typeof x === 'string' ? new TextEncoder().encode(x) : x);

export default defineCommands({
  family: 'form',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'form.read', label: 'Read form fields', risk: 'read', effect: 'view',
      description: 'The form fields (or the one named): type, value, options, flags, format, validate and calculate settings, and each widget with its page and rectangle in page view points.',
      params: s.object({name: s.optional(s.string({min: 1, max: 600}))}),
      state: documentState,
      run(ctx, p) {
        const list = p.name ? [findField(ctx, p.name)] : fieldsOf(ctx);
        return {fields: list.map(f => describeField(ctx.doc, f)), count: list.length, selection: selectionOf(ctx)};
      },
    },
    {
      id: 'form.fields', label: 'Form fields panel', risk: 'read', effect: 'view', undo: 'none',
      description: 'Show or hide the Form fields panel in the right rail (the list of fields, tab order arrows, multi-select, Properties…); default: toggle.',
      params: s.object({open: s.optional(s.boolean())}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === 'fields'}),
      run(ctx, p) {
        const open = p.open ?? ctx.view?.rightPanel !== 'fields';
        ctx.setView({rightPanel: open ? 'fields' : null, ...(open ? {panel: null} : {})});
        return {panel: open ? 'fields' : null};
      },
    },
    {
      id: 'form.select', label: 'Select form fields', risk: 'read', effect: 'view', undo: 'none',
      description: 'Select form fields in Prepare a form (the first is the anchor of Align and Match size); `extend` adds to the selection, an empty list clears it.',
      params: s.object({fields: s.array(fieldRef, {max: 10000}), extend: s.optional(s.boolean())}),
      state: documentState,
      run(ctx, p) {
        const have = p.extend ? selectionOf(ctx) : [];
        const next = [...have];
        for (const f of p.fields) {
          const x = findField(ctx, f.name);
          const wi = f.widget ?? 0;
          if (wi >= x.widgets.length) throw new CommandError('not_found', `${f.name} has no widget ${wi + 1}`, {path: '/fields'});
          if (!next.some(n => n.name === f.name && n.widget === wi)) next.push({name: f.name, widget: wi});
        }
        ctx.setView({formSel: next, ...(next.length ? {formPrepare: true} : {})});
        return {selected: next};
      },
    },
    {
      id: 'form.fill', label: 'Fill in a form field', risk: 'edit', needs: 'worker',
      description: 'Fill the field `name` with a value: text for a text field, true or false for a check box, an option for a radio group, the option (or the options of a multi-select list) for a choice field. The value goes through the field\'s Format, keystroke and Validate scripts and the form recalculates (values.rs set_value). A read-only field is refused.',
      params: s.object({name: s.string({min: 1, max: 600}), value: s.any({description: 'string | boolean | string[] | null'})}),
      state: ctx => both(fillState, hasFieldsState)(ctx),
      async run(ctx, p) {
        findField(ctx, p.name);
        await formEdit(ctx, `Fill in ${p.name}`, pdf => E.setValue(pdf, p.name, p.value));
        const f = findField(ctx, p.name);
        return {name: f.name, value: f.value};
      },
    },
    {
      id: 'form.clear', label: 'Clear form', risk: 'edit', needs: 'worker',
      description: 'Clear form (Acrobat: Reset Form): every field goes back to its default value (/DV); `names` limits it to those fields (a group name takes its fields).',
      params: s.object({names: s.optional(s.array(s.string({min: 1, max: 600}), {max: 10000}))}),
      state: ctx => both(fillState, hasFieldsState)(ctx),
      async run(ctx, p) {
        const count = await formEdit(ctx, 'Clear form', pdf => E.reset(pdf, p.names ?? null));
        return {cleared: count};
      },
    },
    {
      id: 'form.detect', label: 'Detect form fields', risk: 'edit', needs: 'worker',
      description: 'Detect form fields: find the blanks of a printed form (underscore runs, rules, empty boxes, rows of comb cells, small squares) on every page (or `pages`, 1-based) and add a field at each, named from the label next to it (detect.rs). Returns the names; nothing changes when none is found.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: modificationState,
      async run(ctx, p) {
        const content = ctx.doc;
        const indices = p.pages ? [...new Set(p.pages.map(n => n - 1))].filter(i => i >= 0 && i < content.pages.length) : content.pages.map((_, i) => i);
        // The page words in user space, per page.
        const perPage = [];
        for (const pi of indices) {
          const page = content.pages[pi];
          const text = await pageText(content, page);
          const ws = words(text).map(([a, b]) => {
            const rects = text.lineRects(a, b + 1);
            const r = rects[0] ?? text.glyphs[a].rect;
            return {text: text.textOf(a, b + 1), rect: viewRectToUser(page, r)};
          });
          perPage.push([pi, ws]);
        }
        // Candidates are found on the source as it is (a page's blanks, its existing widgets, its words).
        const probe = await loadSource(content);
        const taken = readFields(probe).map(f => f.name);
        const planned = [];
        for (const [pi, ws] of perPage) {
          const si = sourceFor(ctx, pi);
          const existing = readFields(probe).flatMap(f => f.widgets.filter(w => w.page === si).map(w => w.rect));
          const cands = detect(ws, pageShapes(probe, si), existing, taken);
          for (const c of cands) taken.push(c.name);
          planned.push([pi, si, cands]);
        }
        const found = [];
        if (!planned.some(x => x[2].length)) return {detected: 0, fields: []};
        await formEdit(ctx, 'Detect form fields', pdf => {
          for (const [pi, si, cands] of planned) {
            for (const c of cands) {
              const r = E.addField(pdf, si, c.rect, c.kind === 'checkbox' ? {kind: 'checkbox'} : {kind: 'text'}, c.name);
              if (c.kind === 'comb') E.setProps(pdf, r.name, {maxLen: c.cells, flags: [[FLAG.COMB, true]]});
              found.push({name: r.name, page: content.pages[pi].id, kind: c.kind, rect: userRectToView(content.pages[pi], c.rect).map(v => Math.round(v * 100) / 100)});
            }
          }
        });
        return {detected: found.length, fields: found};
      },
    },
    {
      id: 'form.prepare', label: 'Prepare a form', risk: 'edit', needs: 'worker',
      description: 'Prepare a form: open the tool (Edit fields on the page, the Form fields panel); like Acrobat, a document with no fields gets them detected on the way in.',
      params: s.object({detect: s.optional(s.boolean({description: 'Detect fields when the document has none (default true)'}))}),
      state: modificationState,
      async run(ctx, p) {
        ctx.setView({formPrepare: true, rightPanel: 'fields', panel: null, leftPanel: 'form', tool: null});
        let detected = 0;
        if ((p.detect ?? true) && !fieldsOf(ctx).length && !signedBytes(ctx.doc)) {
          const r = await ctx.run('form.detect', {});
          detected = r?.result?.detected ?? r?.detected ?? 0;
        }
        return {prepare: true, detected};
      },
    },
    {
      id: 'form.preview', label: 'Preview', risk: 'read', effect: 'view', undo: 'none',
      description: 'Preview / Edit fields: try the form as people filling it in will see it (Prepare a form toggle).',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.formPreview === true}),
      run(ctx, p) {
        const on = p.on ?? !ctx.view?.formPreview;
        ctx.setView({formPreview: on, ...(on ? {tool: null, formSel: []} : {})});
        return {preview: on};
      },
    },
    {
      id: 'form.highlight_fields', label: 'Highlight existing fields', risk: 'read', effect: 'view', undo: 'none',
      description: 'Highlight existing fields: draw every field with the form-field highlight so the fields stand out (upstream offers it from the document notice bar, canvas/bars.rs); default: toggle.',
      params: s.object({on: s.optional(s.boolean())}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.formHighlight === true}),
      run(ctx, p) {
        const on = p.on ?? !ctx.view?.formHighlight;
        ctx.setView({formHighlight: on});
        return {highlight: on};
      },
    },
    ...TOOLS.map(addTool),
    {
      id: 'form.field.properties', label: 'Field properties…', risk: 'edit', needs: 'worker', dialog: 'dialog.field-properties',
      description: 'Field Properties: change a field (`name`, default: the selected one) with `props`: name, tooltip, readOnly, required, multiline, maxLen, options, fontSize, rect ([widget, [x, y, w, h]]), look / appearance (border, fill, width, style, text, font), format, validate, calculate, flags, quadding, defaultValue, locked, actions, checkStyle, rotation, caption. Without `props` the Field Properties window opens. Several fields selected open the shared properties.',
      params: s.object({name: s.optional(s.string({min: 1, max: 600})), props: s.optional(propsSchema), names: s.optional(s.array(s.string({min: 1, max: 600}), {max: 10000}))}),
      state: both(modificationState, hasFieldsState),
      async run(ctx, p) {
        const name = p.name ?? selectionOf(ctx)[0]?.name;
        if (!p.props) {
          if (!name) throw new CommandError('invalid_params', 'select a field first (or pass name)', {path: '/name'});
          return {name, open: true};
        }
        if (p.names?.length) {
          if (!Object.keys(p.props).length) return {names: p.names, changed: 0};
          // Shared properties: only the properties given change, on every field named.
          let last;
          await formEdit(ctx, 'Change field properties', pdf => { for (const n of p.names) last = E.setProps(pdf, n, p.props); });
          return {names: p.names, changed: p.names.length, last: last?.name};
        }
        if (!name) throw new CommandError('invalid_params', 'select a field first (or pass name)', {path: '/name'});
        const selected = selectionOf(ctx);
        if (!Object.keys(p.props).length) return {name, unchanged: true};
        const r = await apply(ctx, name, p.props);
        if (r.name !== name) ctx.setView({formSel: selected.map(x => (x.name === name ? {...x, name: r.name} : x))});
        return {name: r.name, ...(r.undrawn ? {undrawn: r.undrawn} : {})};
      },
    },
    {
      id: 'form.field.set_rect', label: 'Move or resize a field', risk: 'edit', needs: 'worker',
      description: 'Move or resize one widget of a field to `rect` ([x, y, w, h] in page view points), or move it by `dx`, `dy` view points (Prepare a form: drag, resize handles and the arrow keys).',
      params: s.object({name: s.string({min: 1, max: 600}), widget: s.optional(s.integer({min: 0, max: 100000})), rect: s.optional(rectParam), dx: s.optional(s.number({min: -100000, max: 100000})), dy: s.optional(s.number({min: -100000, max: 100000}))}),
      state: both(modificationState, hasFieldsState),
      async run(ctx, p) {
        const f = findField(ctx, p.name);
        const wi = p.widget ?? 0;
        const {w, page} = widgetOf(ctx, f, wi);
        let user;
        if (p.rect) user = userRectOf(page, p.rect);
        else if (p.dx !== undefined || p.dy !== undefined) {
          const v = userRectToView(page, w.rect);
          user = userRectOf(page, [v[0] + (p.dx ?? 0), v[1] + (p.dy ?? 0), v[2] - v[0], v[3] - v[1]]);
        } else throw new CommandError('invalid_params', 'give rect, or dx and dy', {path: '/rect'});
        await formEdit(ctx, 'Change field properties', pdf => E.setProps(pdf, p.name, {rect: [wi, user]}));
        const now = findField(ctx, p.name).widgets[wi];
        return {name: p.name, widget: wi, rect: userRectToView(page, now.rect).map(v => Math.round(v * 100) / 100)};
      },
    },
    {
      id: 'form.field.arrange', label: 'Arrange form fields', risk: 'edit', needs: 'worker',
      description: 'Align (left, right, top, bottom, center vertically = on one horizontal line... see `op`), distribute and match the size of the selected fields (or `fields`) against the first one, which stays put (prepare.rs arrange). One undo step.',
      params: s.object({op: s.enum(E.ARRANGE_OPS), fields: s.optional(s.array(fieldRef, {min: 2, max: 10000}))}),
      state: ctx => { const st = both(modificationState, hasFieldsState)(ctx); if (!st.enabled) return st; return selectionOf(ctx).length > 1 ? st : {enabled: false, reason: 'select two or more fields'}; },
      async run(ctx, p) {
        const sel = targets(ctx, p.fields);
        if (sel.length < 2) throw new CommandError('invalid_params', 'select two or more fields', {path: '/fields'});
        const rectOf = ({name, widget}) => { const f = findField(ctx, name); return {key: `${name}\u0000${widget}`, name, widget, rect: widgetOf(ctx, f, widget).w.rect}; };
        const [anchor, ...others] = sel.map(rectOf);
        const label = p.op.startsWith('align') || p.op.startsWith('center') ? 'Align fields' : p.op.startsWith('distribute') ? 'Distribute fields' : 'Match field sizes';
        const moved = E.arrange(anchor, others, p.op);
        if (!moved.length) return {moved: 0};
        const byKey = new Map([anchor, ...others].map(o => [o.key, o]));
        await formEdit(ctx, label, pdf => { for (const m of moved) { const o = byKey.get(m.key); E.setProps(pdf, o.name, {rect: [o.widget, m.rect]}); } });
        return {moved: moved.length};
      },
    },
    {
      id: 'form.field.delete', label: 'Delete form fields', risk: 'edit', needs: 'worker',
      description: 'Delete the selected fields (or `fields`) in one undoable step. Each selection is one widget: deleting one radio button of a group, or one copy of a duplicated field, deletes only that one; a field\'s last widget takes the field with it (prepare.rs delete_selected).',
      params: s.object({fields: s.optional(s.array(fieldRef, {min: 1, max: 10000}))}),
      state: ctx => { const st = both(modificationState, hasFieldsState)(ctx); if (!st.enabled) return st; return selectionOf(ctx).length ? st : {enabled: false, reason: 'select a field first'}; },
      async run(ctx, p) {
        const sel = targets(ctx, p.fields);
        for (const x of sel) { const f = findField(ctx, x.name); if (x.widget >= f.widgets.length) throw new CommandError('not_found', `${x.name} has no widget ${x.widget + 1}`, {path: '/fields'}); }
        // A field's later widgets first, so the indices of the ones still to go don't shift.
        const order = [...sel].sort((a, b) => b.widget - a.widget);
        await formEdit(ctx, sel.length === 1 ? 'Delete field' : `Delete ${sel.length} fields`, pdf => { for (const x of order) E.deleteWidget(pdf, x.name, x.widget); });
        ctx.setView({formSel: []});
        return {deleted: sel.length};
      },
    },
    {
      id: 'form.field.duplicate', label: 'Duplicate…', risk: 'edit', needs: 'worker', dialog: 'dialog.duplicate-field',
      description: 'Duplicate a field onto other pages (right-click a field ▸ Duplicate…): each page gets a widget at the same place, belonging to the same field, so they share one value. `pages` (1-based; default all pages). Returns how many widgets were added.',
      params: s.object({name: s.optional(s.string({min: 1, max: 600})), pages: s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000})}),
      state: ctx => { const st = both(modificationState, hasFieldsState)(ctx); if (!st.enabled) return st; return selectionOf(ctx).length ? st : {enabled: false, reason: 'select a field first'}; },
      async run(ctx, p) {
        const name = p.name ?? selectionOf(ctx)[0]?.name;
        if (!name) throw new CommandError('invalid_params', 'select a field first (or pass name)', {path: '/name'});
        findField(ctx, name);
        const count = pagesOf(ctx).length;
        const pages = [...new Set(p.pages.map(n => n - 1))];
        for (const n of pages) if (n < 0 || n >= count) throw new CommandError('invalid_params', `page ${n + 1} does not exist`, {path: '/pages'});
        const added = await formEdit(ctx, 'Duplicate field', pdf => E.duplicateField(pdf, name, pages.map(i => sourceFor(ctx, i))));
        return {name, added};
      },
    },
    {
      id: 'form.tab_order.row', label: 'Tab order: by rows', risk: 'edit', needs: 'worker',
      description: 'Tab order by rows on every page (/Tabs R): top to bottom, left to right within a row.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: both(modificationState, hasFieldsState),
      run: (ctx, p) => tabOrder(ctx, p, 'row'),
    },
    {
      id: 'form.tab_order.column', label: 'Tab order: by columns', risk: 'edit', needs: 'worker',
      description: 'Tab order by columns on every page (/Tabs C): left to right, top to bottom within a column.',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: both(modificationState, hasFieldsState),
      run: (ctx, p) => tabOrder(ctx, p, 'column'),
    },
    {
      id: 'form.tab_order.structure', label: 'Tab order: by document structure', risk: 'edit', needs: 'worker',
      description: 'Tab order by document structure on every page (/Tabs S).',
      params: s.object({pages: s.optional(s.array(s.integer({min: 1, max: 100000}), {min: 1, max: 100000}))}),
      state: both(modificationState, hasFieldsState),
      run: (ctx, p) => tabOrder(ctx, p, 'structure'),
    },
    {
      id: 'form.tab_order.move', label: 'Move in tab order', risk: 'edit', needs: 'worker',
      description: 'Order tabs manually: move field `name` (default: the selected one) one place earlier (`earlier` true) or later in its page\'s tab order. The page switches to annotation order (the Form fields panel\'s arrows).',
      params: s.object({name: s.optional(s.string({min: 1, max: 600})), earlier: s.boolean()}),
      state: both(modificationState, hasFieldsState),
      async run(ctx, p) {
        const name = p.name ?? selectionOf(ctx)[0]?.name;
        if (!name) throw new CommandError('invalid_params', 'select a field first (or pass name)', {path: '/name'});
        findField(ctx, name);
        const moved = await formEdit(ctx, 'Set tab order', pdf => E.moveInTabOrder(pdf, name, p.earlier));
        return {moved};
      },
    },
    {
      id: 'form.calculation_order', label: 'Calculation order', risk: 'read', effect: 'view', undo: 'none',
      description: 'Calculation order: open the panel that lists the calculated fields in the order they recalculate, what each reads and what is wrong with the order (Fix order, Earlier / Later). Ends Preview and the page grid.',
      params: s.object({order: s.optional(s.boolean({description: 'Also return the order'}))}),
      state: ctx => ({...documentState(ctx), checked: ctx.view?.calcOrder === true}),
      async run(ctx, p) {
        ctx.setView({calcOrder: true, formPreview: false, organize: false, formPrepare: true, tool: null});
        return p.order ? ctx.run('form.calc.read', {}).then(r => r?.result ?? r) : {panel: 'calculation-order'};
      },
    },
    {
      id: 'form.calc.read', label: 'Read the calculation order', risk: 'read', effect: 'view',
      description: 'The calculated fields in the order they recalculate: each field\'s reads, whether /CO lists it and what is wrong with its place (runs too early, a loop, not in the order); `fixed` is the order Fix order writes; `extra` are /CO entries that calculate nothing.',
      params: s.object({}),
      state: documentState,
      async run(ctx) {
        return E.calculationOrder(await loadSource(ctx.doc));
      },
    },
    {
      id: 'form.calc.fix', label: 'Fix order', risk: 'edit', needs: 'worker',
      description: 'Fix order: every calculated field after the calculated fields it reads, keeping the current order wherever that allows (calc_order.rs `fixed`); the order is written to /CO.',
      params: s.object({}),
      state: both(modificationState, hasFieldsState),
      async run(ctx) {
        const r = await formEdit(ctx, 'Set calculation order', pdf => { const o = E.calculationOrder(pdf); if (!o.fixable) return {changed: false, order: o.fixed}; E.setCalculationOrder(pdf, o.fixed); return {changed: true, order: o.fixed}; });
        return r;
      },
    },
    {
      id: 'form.calc.move', label: 'Move in calculation order', risk: 'edit', needs: 'worker',
      description: 'Move a calculated field one place earlier or later in the calculation order (the panel\'s Up / Down).',
      params: s.object({name: s.optional(s.string({min: 1, max: 600})), earlier: s.boolean()}),
      state: both(modificationState, hasFieldsState),
      async run(ctx, p) {
        const name = p.name ?? ctx.view?.calcSel ?? selectionOf(ctx)[0]?.name;
        if (!name) throw new CommandError('invalid_params', 'pick a field in the order first (or pass name)', {path: '/name'});
        findField(ctx, name);
        const moved = await formEdit(ctx, 'Set calculation order', pdf => E.moveInCalculationOrder(pdf, name, p.earlier));
        return {moved, name};
      },
    },
    {
      id: 'form.calc.select', label: 'Pick a field in the calculation order', risk: 'read', effect: 'view', undo: 'none',
      description: 'Pick a calculated field in the calculation order panel (Earlier / Later and Edit formula act on it); the field is selected on the page too.',
      params: s.object({name: s.string({min: 1, max: 600})}),
      state: documentState,
      run(ctx, p) {
        const f = findField(ctx, p.name);
        ctx.setView({calcSel: f.name, formSel: [{name: f.name, widget: 0}]});
        return {name: f.name};
      },
    },
    {
      id: 'form.calc.back', label: 'Back to Prepare a form', risk: 'read', effect: 'view', undo: 'none',
      description: 'Leave the calculation order panel and go back to Prepare a form.',
      params: s.object({}),
      state: ctx => ({enabled: ctx.view?.calcOrder === true}),
      run(ctx) { ctx.setView({calcOrder: false}); return {panel: 'form'}; },
    },
    {
      id: 'form.flatten', label: 'Flatten form fields', risk: 'edit', needs: 'worker',
      description: 'Flatten form fields: every field\'s appearance (what is typed in it too) is drawn into its page and the fields are removed; signature fields stay (flatten.rs).',
      params: s.object({}),
      state: ctx => both(modificationState, hasFieldsState)(ctx),
      async run(ctx) {
        const drawn = await formEdit(ctx, 'Flatten form fields', pdf => E.flattenFields(pdf));
        ctx.setView({formSel: []});
        return {flattened: drawn};
      },
    },
    {
      id: 'form.export_data', label: 'Export form data…', risk: 'edit', effect: 'persist', undo: 'none', needs: 'worker', dialog: 'system.save-file',
      description: 'Export form data: the field values as XFDF, FDF, XML, CSV or tab-delimited text, by the file name\'s extension (XFDF when unknown; `format` overrides). From the window the system Save dialog asks where; with `path` the file is written there; without either the data comes back as `text` (or `base64` for FDF).',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), format: s.optional(s.enum(['xfdf', 'fdf', 'xml', 'csv', 'txt']))}),
      state(ctx) { const st = hasFieldsState(ctx); return st.enabled ? writeState(ctx) : st; },
      async run(ctx, p) {
        const pdf = await loadSource(ctx.doc);
        const name = ctx.doc?.sourceName ?? 'form.pdf';
        let format = p.format ?? (p.path ? D.formatOfExtension(String(p.path).split('.').pop()) : null) ?? 'xfdf';
        const out = (f, file) => toBytes(D.exportAs(pdf, f, file));
        if (!p.path && interactive(ctx)) {
          const r = await writeOther(ctx, {}, out(format, name), {title: 'Export form data', name: `${stem(name)}.${format}`, filters: EXPORT_FILTERS});
          if (r.canceled) return {canceled: true};
          if (r.path) { const ext = String(r.path).split('.').pop(); const f2 = D.formatOfExtension(ext); if (f2 && f2 !== format) { format = f2; await writeOther(ctx, {path: r.path}, out(format, name)); } }
          return {path: r.path, format};
        }
        const data = out(format, name);
        if (p.path) { const r = await writeOther(ctx, {path: p.path}, data); return {path: r.path, format}; }
        return format === 'fdf' ? {format, base64: (await writeOther(ctx, {}, data)).base64} : {format, text: new TextDecoder().decode(data)};
      },
    },
    {
      id: 'form.import_data', label: 'Import form data…', risk: 'edit', needs: 'worker', dialog: 'system.open-file',
      description: 'Import form data: set the values an XFDF, FDF, XML, CSV or tab-delimited text file holds (`path`, or `base64` with `name`); values go through the form\'s own checks and it recalculates; read-only fields still take imported data. From the window the system Open dialog asks. Returns how many fields took a value and which were refused.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 45_000_000})), name: s.optional(s.string({max: 255})), text: s.optional(s.string({max: 30_000_000}))}),
      state(ctx) { const st = both(fillState, hasFieldsState)(ctx); return st.enabled ? readState(ctx) : st; },
      async run(ctx, p) {
        let bytes;
        if (typeof p.text === 'string') bytes = new TextEncoder().encode(p.text);
        else {
          const file = await readOther(ctx, p, {title: 'Import data', filters: DATA_FILTERS});
          if (!file) return {canceled: true};
          bytes = file.bytes;
        }
        let report;
        await formEdit(ctx, 'Import form data', pdf => { try { report = D.importInto(pdf, bytes); } catch (e) { if (e instanceof D.DataError) throw new CommandError('invalid_params', e.message); throw e; } });
        return report;
      },
    },
    {
      id: 'form.merge_data', label: 'Merge data files into spreadsheet…', risk: 'edit', effect: 'persist', undo: 'none', needs: 'worker', dialog: 'system.open-files', scope: 'app',
      description: 'Merge data files into a spreadsheet: one CSV row per data file (FDF, XFDF or a filled-in PDF form), one column per field name in the order they first appear (xfdf lib.rs merge_csv; formula-looking cells get a leading apostrophe). `files` are paths or {base64, name}; from the window the system Open dialog picks the files, then the Save dialog the CSV. Without `path` the CSV comes back as `csv`.',
      params: s.object({files: s.optional(s.array(s.union([s.string({min: 1, max: 4096}), s.object({base64: s.string({max: 45_000_000}), name: s.optional(s.string({max: 255}))})]), {min: 1, max: 1000})),
        path: s.optional(s.string({min: 1, max: 4096}))}),
      state(ctx) { return ctx.host?.kind === 'renderer' && !interactive(ctx) ? {enabled: true} : readState(ctx); },
      async run(ctx, p) {
        let list = p.files;
        if (!list) {
          if (!interactive(ctx)) throw new CommandError('invalid_params', 'files is required: programmatic calls never open the Open dialog', {path: '/files'});
          const f = ctx.host?.files;
          if (typeof f?.pickOpen !== 'function' || typeof f?.readFile !== 'function') throw new CommandError('unavailable', "this build can't read other files yet");
          let picked = await f.pickOpen({kind: ctx.app, doc: ctx.docId, title: 'Select data files to merge', multiple: true, filters: [{name: 'Form data and PDF forms', extensions: ['fdf', 'xfdf', 'pdf']}]});
          if (!picked) return {canceled: true};
          list = Array.isArray(picked) ? picked : [picked];
        }
        const files = [];
        for (const item of list) {
          const file = await readOther(ctx, typeof item === 'string' ? {path: item} : item, {title: 'Open', filters: DATA_FILTERS});
          if (!file) return {canceled: true};
          const head = String.fromCharCode(...file.bytes.subarray(0, 1024));
          if (head.includes('%PDF-')) files.push(D.valuesOfFilledPdf(await loadOther(file.bytes, file.name)));
          else files.push(D.dataValues(file.bytes));
        }
        const csv = D.mergeCsv(files);
        if (!p.path && interactive(ctx)) {
          const r = await writeOther(ctx, {}, toBytes(csv), {title: 'Save the spreadsheet', name: 'report.csv', filters: [{name: 'CSV', extensions: ['csv']}]});
          return r.canceled ? {canceled: true} : {merged: files.length, path: r.path};
        }
        if (p.path) { const r = await writeOther(ctx, {path: p.path}, toBytes(csv)); return {merged: files.length, path: r.path}; }
        return {merged: files.length, csv};
      },
    },
  ],
});

async function tabOrder(ctx, p, order) {
  const count = pagesOf(ctx).length;
  const pages = p.pages ? [...new Set(p.pages.map(n => n - 1))] : Array.from({length: count}, (_, i) => i);
  for (const n of pages) if (n < 0 || n >= count) throw new CommandError('invalid_params', `page ${n + 1} does not exist`, {path: '/pages'});
  await formEdit(ctx, 'Set tab order', pdf => E.setTabOrder(pdf, pages.map(i => sourceFor(ctx, i)), order));
  return {order, pages: pages.length};
}

export {modelFields, pageAt, TRIGGERS};
