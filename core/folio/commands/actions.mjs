// Action Wizard: an action is a list of steps run in order on the open document (Prepare for Distribution, Optimize Scanned Documents, Add Page Numbers, Mark as Confidential,
// Sanitize Documents, Make Accessible, Archive Documents, and the actions a person makes), as one undo step.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/engine/src/actions.rs (Step and its ids and labels,
// `builtin`, `apply_step`: a step that removes information that finds nothing logs "nothing to remove", any other step that fails logs why and the action goes on, a step that
// removes information may stop it) and crates/ui-egui/src/workflows/actions_ui.rs (the list of actions, the steps of the one chosen, New Action, Edit, Delete).
// Differences: upstream runs an action over files and writes the results into a folder; this window has one document, so the action runs on it and one undo step undoes it.
// "Run a JavaScript" is not a step (a document's scripts are never run, and neither are a person's). Not in upstream and not checked against it: the steps Make accessible (the
// Make accessible action of lib/a11y.mjs) and Save as PDF/A (the Archive Documents action: the conversion, then what remains); Set document title writes the title and the title
// bar. Actions a person makes are kept in the preferences.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/actions.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {modification, documentOpen} from '../lib/edit-needs.mjs';
import {materialize, commit} from '../lib/page-source.mjs';
import {optimizeDocument, DEFAULTS as OPTIMIZE} from '../lib/optimize.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/engine/src/actions.rs', 'crates/ui-egui/src/workflows/actions_ui.rs']};
const FOOTER = 4, HEADER = 1;
const size = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

/** actions.rs `Step::all`, in upstream's order, then this window's own: id, label, whether it takes text, and what it runs. */
export const STEPS = [
  {id: 'recognize_text', label: 'Recognize text', run: ctx => ctx.run('ocr.recognize', {}).then(r => `${r?.words ?? r?.recognized ?? 0} words`)},
  {id: 'reduce_file_size', label: 'Reduce file size', async run(ctx) {
    const before = (await writeFolioPdf(ctx.doc)).length;
    const {doc, content} = await materialize(ctx.doc);
    optimizeDocument(doc, OPTIMIZE);
    const bytes = await commit(ctx, doc, content);
    return `${size(before)} → ${size(bytes.length)}`;
  }},
  {id: 'remove_hidden_information', label: 'Remove hidden information', removes: true, run: ctx => ctx.run('protect.remove_hidden', {})},
  {id: 'sanitize', label: 'Sanitize document', removes: true, run: ctx => ctx.run('redact.sanitize', {})},
  {id: 'flatten_comments', label: 'Flatten comments', run: ctx => ctx.run('comment.flatten', {})},
  {id: 'flatten_fields', label: 'Flatten form fields', run: ctx => ctx.run('form.flatten', {})},
  {id: 'add_watermark', label: 'Add watermark', arg: 'Watermark text', run: (ctx, arg) => ctx.run('edit.watermark', {text: arg})},
  {id: 'add_header', label: 'Add header', arg: 'Header text', run: (ctx, arg) => ctx.run('edit.header_footer', {text: Array.from({length: 6}, (_, i) => (i === HEADER ? arg : ''))})},
  {id: 'add_footer', label: 'Add footer', arg: 'Footer text', run: (ctx, arg) => ctx.run('edit.header_footer', {text: Array.from({length: 6}, (_, i) => (i === FOOTER ? arg : ''))})},
  {id: 'set_title', label: 'Set document title', arg: 'Title', run: (ctx, arg) => ctx.run('a11y.reading_options', {title: arg, displayTitle: true})},
  {id: 'detect_form_fields', label: 'Detect form fields', run: ctx => ctx.run('form.detect', {})},
  {id: 'make_accessible', label: 'Make accessible', run: ctx => ctx.run('a11y.make_accessible', {}).then(r => r?.message)},
  {id: 'save_as_pdfa', label: 'Save as PDF/A', run: ctx => ctx.run('standards.pdfa.convert', {}).then(r => r?.message)},
];
const stepOf = id => STEPS.find(x => x.id === id);

/** actions.rs `builtin`, with Acrobat's Make Accessible and Archive Documents (not checked against upstream). */
export const BUILTIN = [
  {name: 'Prepare for Distribution', description: 'Remove hidden information and flatten comments and form fields, so recipients see only the pages.', steps: [{id: 'remove_hidden_information'}, {id: 'flatten_comments'}, {id: 'flatten_fields'}]},
  {name: 'Optimize Scanned Documents', description: 'Make scans searchable, then make them smaller.', steps: [{id: 'recognize_text'}, {id: 'reduce_file_size'}]},
  {name: 'Add Page Numbers', description: 'Number every page in the footer.', steps: [{id: 'add_footer', arg: 'Page <<1>> of <<n>>'}]},
  {name: 'Mark as Confidential', description: 'A diagonal CONFIDENTIAL watermark on every page.', steps: [{id: 'add_watermark', arg: 'CONFIDENTIAL'}]},
  {name: 'Sanitize Documents', description: 'Remove hidden information, metadata, scripts and embedded content, and rewrite the files.', steps: [{id: 'sanitize'}]},
  {name: 'Make Accessible', description: 'Set the language and title bar, tag the document, then check it: the steps this app can do, and a report of what needs a person.', steps: [{id: 'make_accessible'}]},
  {name: 'Archive Documents', description: 'Make the document PDF/A as far as can be done, and say what remains.', steps: [{id: 'save_as_pdfa'}]},
].map(a => ({...a, builtin: true}));

const customOf = ctx => (Array.isArray(ctx.prefs?.actions) ? ctx.prefs.actions : []).filter(a => a && typeof a.name === 'string' && Array.isArray(a.steps));
const allActions = ctx => [...BUILTIN, ...customOf(ctx).map(a => ({...a, builtin: false}))];
const stepParam = s.object({id: s.enum(STEPS.map(x => x.id)), arg: s.optional(s.string({max: 2000}))});

export default defineCommands({
  family: 'actions',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'actions.list', label: 'Actions', risk: 'read', effect: 'view', undo: 'none', scope: 'app',
      description: 'The actions of the Action Wizard (the built-in ones and the ones made here), each with its description and its steps, and the steps an action can be made of.',
      params: s.object({}), state: () => ({enabled: true}),
      run(ctx) {
        return {actions: allActions(ctx).map(a => ({name: a.name, description: a.description ?? '', builtin: !!a.builtin, steps: a.steps.map(x => ({id: x.id, label: stepOf(x.id)?.label ?? x.id, ...(x.arg !== undefined ? {arg: x.arg} : {})}))})),
          steps: STEPS.map(x => ({id: x.id, label: x.label, ...(x.arg ? {arg: x.arg} : {})}))};
      },
    },
    {
      id: 'actions.save', label: 'Save action', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Make an action, or change one made here (`name`, `description`, its `steps`: id from actions.list and `arg` for the steps that take text). A built-in action cannot be changed or taken over by name.',
      params: s.object({name: s.string({min: 1, max: 120}), description: s.optional(s.string({max: 500})), steps: s.array(stepParam, {min: 1, max: 40})}),
      state: () => ({enabled: true}),
      run(ctx, p) {
        const name = p.name.trim();
        if (!name) throw new CommandError('invalid_params', 'Type a name for the action', {path: '/name'});
        if (BUILTIN.some(a => a.name.toLowerCase() === name.toLowerCase())) throw new CommandError('invalid_params', `"${name}" is a built-in action: choose another name`, {path: '/name'});
        for (const [i, st] of p.steps.entries()) if (stepOf(st.id).arg && !String(st.arg ?? '').trim()) throw new CommandError('invalid_params', `${stepOf(st.id).label} needs its ${stepOf(st.id).arg.toLowerCase()}`, {path: `/steps/${i}/arg`});
        const mine = customOf(ctx).filter(a => a.name.toLowerCase() !== name.toLowerCase());
        ctx.updatePrefs({actions: [...mine, {name, description: p.description ?? '', steps: p.steps.map(x => ({id: x.id, ...(stepOf(x.id).arg ? {arg: String(x.arg).trim()} : {})}))}]});
        return {saved: name};
      },
    },
    {
      id: 'actions.delete', label: 'Delete action', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Delete an action made here (`name`); the built-in actions stay.',
      params: s.object({name: s.string({min: 1, max: 120})}), state: () => ({enabled: true}),
      run(ctx, p) {
        if (BUILTIN.some(a => a.name === p.name)) throw new CommandError('invalid_params', 'A built-in action cannot be deleted', {path: '/name'});
        const mine = customOf(ctx);
        if (!mine.some(a => a.name === p.name)) throw new CommandError('not_found', `there is no action ${p.name}`, {path: '/name'});
        ctx.updatePrefs({actions: mine.filter(a => a.name !== p.name)});
        return {deleted: p.name};
      },
    },
    {
      id: 'actions.run', label: 'Run action', risk: 'edit', undo: 'auto', needs: 'worker', dialog: 'dialog.action-wizard',
      description: 'Run an action (`action`, by name from actions.list) on the document, step by step, as one undo step. A step that removes information and finds nothing says so; any other step that cannot be done says why and the action goes on; a step that removes information may stop it. `steps` runs a list of steps without saving it as an action. The result says what each step did.',
      params: s.object({action: s.optional(s.string({min: 1, max: 120})), steps: s.optional(s.array(stepParam, {min: 1, max: 40}))}),
      state: both(documentOpen, modification),
      async run(ctx, p) {
        let steps = p.steps, name = 'Custom steps';
        if (!steps) {
          const a = allActions(ctx).find(x => x.name.toLowerCase() === String(p.action ?? '').trim().toLowerCase());
          if (!a) throw new CommandError('not_found', p.action ? `there is no action ${p.action}` : 'give the `action` to run', {path: '/action'});
          steps = a.steps; name = a.name;
        }
        const log = [];
        for (const st of steps) {
          const step = stepOf(st.id);
          if (!step) { log.push({step: st.id, status: 'failed', detail: 'this step does not exist'}); continue; }
          try {
            const r = await step.run(ctx, st.arg ?? '');
            log.push({step: step.label, status: 'done', ...(typeof r === 'string' && r ? {detail: r} : {})});
          } catch (e) {
            const message = e?.message ?? String(e);
            if (step.removes && /nothing to (remove|apply)|There are no redaction marks/i.test(message)) { log.push({step: step.label, status: 'skipped', detail: 'nothing to remove'}); continue; }
            if (step.removes) throw new CommandError('failed', `${step.label}: ${message}`);
            log.push({step: step.label, status: 'failed', detail: message});
          }
        }
        ctx.setUndoLabel(name);
        const failed = log.filter(x => x.status === 'failed').length;
        return {action: name, steps: log, failed, message: failed ? `${name}: ${failed} of ${log.length} steps could not be done` : `${name}: ${log.length} step${log.length === 1 ? '' : 's'} done`};
      },
    },
  ],
});

function both(a, b) { return ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; }; }
