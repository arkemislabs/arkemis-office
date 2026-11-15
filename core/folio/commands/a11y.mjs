// Prepare for accessibility: Check for accessibility (the options dialog, the results panel with Fix, Skip rule and Explain), Find untagged content, the
// accessibility report, Add alternate text, Automatically tag PDF, Tag form fields, Change reading options, Fix reading order (the Tags panel), Make accessible,
// and the Tags panel's editing (properties, move, mark as artifact).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:712-728     a11y.check, a11y.find_untagged, a11y.report, a11y.autotag, a11y.alt_text, a11y.autotag_fields, a11y.tags,
//                                              a11y.reading_options (Document Properties ▸ Advanced)
//   crates/ui-egui/src/workflows/a11y_ui.rs    the options dialog, the panel (counts, Compare with the last check, categories, rules, Fix / Skip Rule /
//                                              Explain), find_untagged_content, run_accessibility_check (rules skipped by hand stay skipped), the report
//                                              file "<name> Accessibility Report.html", the Set Alternate Text dialog (figure i of n, Decorative figure)
//   crates/a11y                                lib/a11y.mjs
// Not checked against upstream: "Fix reading order" and "Make accessible" (upstream lists them as planned, catalog.rs M12): Fix reading order opens the Tags
// panel, where tags can be moved; Make accessible runs the steps Acrobat's action runs that this app can do (reading options, Automatically tag PDF, Tag form
// fields, the tab order) and then the checker, and says which steps it could not do and which rules need a person. It never says the document is accessible.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/a11y.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {documentOpen, modification} from '../lib/edit-needs.mjs';
import {writeOther, writeState, interactive, stem} from '../lib/page-files.mjs';
import {editable, commit, loadSource} from '../lib/page-source.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {permissionsOf} from '../lib/crypt.mjs';
import {PDFDocument} from 'pdf-lib';
import * as A from '../lib/a11y.mjs';
import {readingOf} from '../dialogs/reading-options.mjs';
import {itemsOf} from '../dialogs/alt-text.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/workflows/a11y_ui.rs', 'crates/ui-egui/src/tools/tags_ui.rs',
  'crates/a11y/src/lib.rs', 'crates/a11y/src/content.rs', 'crates/a11y/src/structure.rs', 'crates/a11y/src/alt.rs', 'crates/a11y/src/tags.rs', 'crates/a11y/src/autotag.rs',
  'crates/a11y/src/autotag_fields.rs', 'crates/a11y/src/report.rs']};

const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };
const ruleIds = A.RULES.map(r => r.id);
const wrap = e => (e instanceof A.A11yError ? new CommandError('failed', e.message) : e);

/** The document as the checker reads it: the model written out (page order, comments), as a pdf-lib document. */
async function checkDoc(ctx) {
  const bytes = await writeFolioPdf(ctx.doc);
  return PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
}

const accessibilityAllowed = content => (content?.security ? permissionsOf(content.security.p, false).accessibility : null);
const view = ctx => ctx.view?.a11y ?? {};
const skippedOf = ctx => new Set(view(ctx).skipped ?? []);

/** run_accessibility_check: the full check, rules skipped by hand stay skipped; the result is the panel's state. */
async function run(ctx, options) {
  const doc = await checkDoc(ctx);
  const report = A.check(doc, {rules: options.rules, pages: options.pages, accessibilityAllowed: accessibilityAllowed(ctx.doc)});
  const skipped = skippedOf(ctx);
  for (const r of report.results) if (skipped.has(r.rule) && r.status !== 'skipped') { r.status = 'skipped'; r.findings = []; }
  const same = JSON.stringify(view(ctx).options ?? null) === JSON.stringify(options);
  const prior = view(ctx).report ?? null;
  ctx.setView({a11y: {...view(ctx), report, options, previous: same && prior ? prior : null, skipped: [...skipped], at: ctx.host?.now?.() ?? Date.now(), file: ctx.doc.sourceName ?? ctx.file?.title ?? 'Document.pdf'}, rightPanel: 'accessibility', panel: null});
  return report;
}

const summaryOf = report => { const x = A.summarize(report); return {passed: x.passed, failed: x.failed, manual: x.manual, skipped: x.skipped, message: x.message}; };
/** What the panel and the bridge read: each rule with its category, status and findings. */
const rows = report => report.results.map(r => ({rule: r.rule, name: A.RULE_BY_ID[r.rule].name, category: A.RULE_BY_ID[r.rule].category, status: r.status, findings: r.findings.map(f => ({page: f.page, object: f.object, message: f.message}))}));

const todayOf = ctx => new Date(ctx.host?.now?.() ?? Date.now()).toISOString().slice(0, 10);

async function saveReport(ctx, p) {
  let st = view(ctx);
  if (!st.report) { await run(ctx, {rules: A.defaultRules(), pages: null}); st = ctx.view?.a11y ?? view(ctx); }
  const report = (ctx.view?.a11y ?? st).report;
  const file = st.file ?? ctx.doc.sourceName ?? 'Document.pdf';
  const html = A.reportHtml(report, file, todayOf(ctx), 'en');
  const name = `${stem(file)} Accessibility Report.html`;
  const out = await writeOther(ctx, {path: p.path}, new TextEncoder().encode(html), {title: 'Save the accessibility report', name, filters: [{name: 'HTML web page', extensions: ['html']}]});
  if (out.canceled) return {canceled: true};
  return {...out, name, message: out.path ? `Saved the accessibility report to ${out.path}` : `Created ${name}`};
}

/** Apply `fn` to the source (one undo step). */
async function edit(ctx, label, fn) {
  const {doc, content} = await editable(ctx.doc, []);
  let result;
  try { result = await fn(doc); } catch (e) { throw wrap(e); }
  await commit(ctx, doc, content);
  ctx.setUndoLabel(label);
  return result;
}

const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);

const toggle = (id, label, panel, description) => ({
  id, label, risk: 'read', effect: 'view', undo: 'none', description,
  params: s.object({open: s.optional(s.boolean())}),
  state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === panel}),
  run(ctx, p) {
    const open = p.open ?? ctx.view?.rightPanel !== panel;
    ctx.setView({rightPanel: open ? panel : null, ...(open ? {panel: null} : {})});
    return {panel: open ? panel : null};
  },
});

const itemSchema = s.object({object: s.string({min: 1, max: 40}), alt: s.optional(s.string({max: 2000})), decorative: s.optional(s.boolean())});
const readingParams = {language: s.optional(s.string({max: 40})), title: s.optional(s.string({max: 1000})), displayTitle: s.optional(s.boolean()), tabOrder: s.optional(s.boolean())};

async function readingValues(ctx) {
  const doc = await loadSource(ctx.doc);
  return {language: A.documentLanguage(doc) ?? '', title: A.infoTitle(doc) ?? '', displayTitle: A.displayDocTitle(doc), tabOrder: false};
}

async function readingOptions(ctx, p) {
  if (!['language', 'title', 'displayTitle', 'tabOrder'].some(k => p[k] !== undefined)) {
    if (interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
      const v = await ctx.host.openDialog('dialog.reading-options', await readingValues(ctx));
      if (!v) throw new CommandError('canceled', 'Canceled');
      const done = await edit(ctx, 'Change reading options', doc => A.setReadingOptions(doc, readingOf(v)));
      return {changed: done};
    }
    return {options: await readingValues(ctx)};
  }
  const done = await edit(ctx, 'Change reading options', doc => A.setReadingOptions(doc, p));
  return {changed: done};
}

export default defineCommands({
  family: 'a11y',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'a11y.check', label: 'Check for accessibility…', risk: 'read', effect: 'view', undo: 'none', needs: 'worker', dialog: 'dialog.accessibility-options',
      description: 'The Accessibility Checker: runs the chosen rules (`rules`: ids from a11y.rules, default all but colour contrast; `pages`: 0-based pages for the page rules, default all; `report`: also save the report) and shows the results in the Accessibility Checker panel. Each rule is Passed, Failed, Needs manual check or Skipped: six rules only a person can judge, and a Passed rule says only that rule found nothing. Rules skipped by hand stay skipped.',
      params: s.object({rules: s.optional(s.array(s.enum(ruleIds), {max: 32})), pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {max: 100000})), report: s.optional(s.boolean()), path: s.optional(s.string({min: 1, max: 4096}))}),
      state: documentOpen,
      async run(ctx, p) {
        const options = {rules: p.rules ?? A.defaultRules(), pages: p.pages ?? null};
        const report = await run(ctx, options);
        const sum = summaryOf(report);
        const out = {...sum, rules: rows(report)};
        if (p.report) { const r = await saveReport(ctx, {path: p.path}); if (r.path || r.base64) Object.assign(out, {report: r.path ?? r.name}); }
        return out;
      },
    },
    {
      id: 'a11y.rules', label: 'Accessibility rules', risk: 'read', effect: 'view', undo: 'none', needs: 'model',
      description: 'The 32 rules of the Accessibility Checker with their category, name, description, explanation, whether only a person can judge them and whether they are on by default.',
      params: s.object({}), state: documentState,
      run() { return {rules: A.RULES.map(({id, category, name, description, explanation, manual, onByDefault}) => ({id, category, name, description, explanation, manual, onByDefault})), fixable: A.FIXABLE}; },
    },
    {
      id: 'a11y.read', label: 'Accessibility Checker results', risk: 'read', effect: 'view', undo: 'none', needs: 'model',
      description: 'The results of the last check of this document (Accessibility Checker panel): the counts and each rule with its status and problems; empty before the first check.',
      params: s.object({}), state: documentState,
      run(ctx) { const st = view(ctx); return st.report ? {checked: true, ...summaryOf(st.report), rules: rows(st.report)} : {checked: false}; },
    },
    {
      id: 'a11y.find_untagged', label: 'Find untagged content', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Find untagged content: runs the Tagged content, Tagged annotations and Tagged form fields rules and shows the results in the Accessibility Checker panel.',
      params: s.object({}), state: documentOpen,
      async run(ctx) {
        const report = await run(ctx, {rules: ['tagged-content', 'tagged-annotations', 'tagged-form-fields'], pages: null});
        const failed = A.countStatus(report, 'failed');
        return {failed, rules: rows(report).filter(r => r.status !== 'skipped'), message: failed === 0 ? 'No untagged content was found.' : `Found ${failed} untagged content problems.`};
      },
    },
    {
      id: 'a11y.report', label: 'Open accessibility report', risk: 'read', undo: 'none', needs: 'worker',
      description: 'Save the accessibility report (an HTML page: the summary, then each rule by category with its status and problems) for the last check, checking first if the document has not been checked. `path` is where to write it (default: the Save dialog, "<name> Accessibility Report.html"; a program gets the page as base64).',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state: both(documentOpen, writeState),
      run: (ctx, p) => saveReport(ctx, p),
    },
    {
      id: 'a11y.skip', label: 'Skip rule', risk: 'read', effect: 'view', undo: 'none', needs: 'model',
      description: 'Skip a rule of the last check by hand (it stays skipped when checking again).',
      params: s.object({rule: s.enum(ruleIds)}), state: documentState,
      run(ctx, p) {
        const st = view(ctx);
        const skipped = [...new Set([...(st.skipped ?? []), p.rule])];
        const report = st.report ? {...st.report, results: st.report.results.map(r => (r.rule === p.rule ? {...r, status: 'skipped', findings: []} : r))} : st.report;
        ctx.setView({a11y: {...st, skipped, report}});
        return {skipped: p.rule};
      },
    },
    {
      id: 'a11y.fix', label: 'Fix', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Fix a failed rule that has a fix: Title (the title shows in the window: the title is set from the file name when the document has none), Tab order (each page with links, comments or fields tabs in structure order) and Primary language (needs `language`, such as en-US; without it the reading options open). The checker runs again afterwards.',
      params: s.object({rule: s.enum(A.FIXABLE), language: s.optional(s.string({min: 2, max: 40}))}),
      state: modification,
      async run(ctx, p) {
        if (p.rule === 'primary-language') {
          if (!p.language) {
            if (interactive(ctx) && typeof ctx.host?.openDialog === 'function') { await readingOptions(ctx, {}); return {opened: 'reading options'}; }
            throw new CommandError('invalid_params', 'Give the `language` (such as en-US).', {path: '/language'});
          }
          await edit(ctx, 'Set document language', doc => A.setReadingOptions(doc, {language: p.language}));
        } else if (p.rule === 'title') {
          await edit(ctx, 'Show document title', doc => A.setReadingOptions(doc, {displayTitle: true, ...(A.infoTitle(doc) ? {} : {title: stem(ctx.doc.sourceName || ctx.file?.title || 'Document')})}));
        } else await edit(ctx, 'Set tab order', doc => A.setReadingOptions(doc, {tabOrder: true}));
        const st = view(ctx);
        if (st.options) await run(ctx, st.options);
        return {fixed: p.rule};
      },
    },
    toggle('a11y.panel', 'Accessibility Checker', 'accessibility', "Show or hide the Accessibility Checker panel in the right rail (the last check's results by category); default: toggle."),
    {
      id: 'a11y.reading_options', label: 'Change reading options…', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Reading options (Document Properties ▸ Advanced): the document `language` (a tag such as en-US), the `title`, whether the window shows the title (`displayTitle`) and whether each page with links, comments or fields tabs in structure order (`tabOrder`). Without params, returns the current ones.',
      params: s.object(readingParams), state: modification,
      run: readingOptions,
    },
    {
      id: 'a11y.reading_options.apply', label: 'Apply reading options', risk: 'edit', undo: 'auto', needs: 'worker', dialog: 'dialog.reading-options',
      description: 'The reading options dialog\'s command: sets the language, the title, the title bar and the tab order in one undo step.',
      params: s.object(readingParams), state: modification,
      async run(ctx, p) { const done = await edit(ctx, 'Change reading options', doc => A.setReadingOptions(doc, p)); return {changed: done}; },
    },
    {
      id: 'a11y.autotag', label: 'Automatically tag PDF', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Automatically tag PDF: a document of text pages gets a structure tree, one P element for each text object. Refuses (saying what) a document that already has tags, form fields, annotations, or pages with anything but text (pictures and lines are not tagged here), and tells how many paragraphs it tagged. Review the tags in the Tags panel afterwards: the reading order is the order of the text in the file.',
      params: s.object({}), state: modification,
      async run(ctx) {
        const r = await edit(ctx, 'Automatically tag PDF', doc => A.autotagText(doc));
        ctx.setView({rightPanel: 'tags', panel: null});
        return {...r, message: `Tagged ${r.paragraphs} paragraphs on ${r.pages} pages. Check the reading order in the Tags panel.`};
      },
    },
    {
      id: 'a11y.autotag_fields', label: 'Tag form fields', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Tag form fields: each untagged form field gets a Form element in the structure tree (a tree is made when there is none). Refuses a document with no form or no untagged field.',
      params: s.object({}), state: modification,
      async run(ctx) {
        const n = await edit(ctx, 'Tag form fields', doc => A.tagFormFields(doc));
        ctx.setView({rightPanel: 'tags', panel: null});
        return {tagged: n, message: `Tagged ${n} form fields.`};
      },
    },
    {
      id: 'a11y.alt_text', label: 'Add alternate text…', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Add alternate text: the tagged figures one by one (Set Alternate Text). `items` sets the alternate text (`alt`, blank removes it) or marks a figure decorative (`decorative`: its content becomes an artifact and the figure leaves the tags) by `object` (from the list this returns without params), in one undo step.',
      params: s.object({items: s.optional(s.array(itemSchema, {max: 5000}))}), state: modification,
      async run(ctx, p) {
        if (!p.items) {
          const figures = A.figures(await loadSource(ctx.doc));
          if (!figures.length) return {figures, message: 'This document has no tagged figures.'};
          if (interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
            const v = await ctx.host.openDialog('dialog.alt-text', {figures: figures.map(f => ({object: f.object, page: f.page, alt: f.alt ?? ''})), index: 0, text: figures[0].alt ?? '', info: `Figure 1 of ${figures.length}${figures[0].page != null ? ` on page ${figures[0].page + 1}` : ''}`, more: figures.length > 1});
            if (!v) throw new CommandError('canceled', 'Canceled');
            const items = itemsOf(v, figures);
            return items.length ? setAlt(ctx, items) : {message: 'No alternate text was changed.'};
          }
          return {figures};
        }
        return setAlt(ctx, p.items);
      },
    },
    {
      id: 'a11y.alt_text.apply', label: 'Save alternate text', risk: 'edit', undo: 'auto', needs: 'worker', dialog: 'dialog.alt-text',
      description: 'The alternate text dialog\'s command: sets the alternate text of the figures that changed and marks the decorative ones, in one undo step.',
      params: s.object({items: s.array(itemSchema, {max: 5000})}), state: modification,
      run: (ctx, p) => setAlt(ctx, p.items),
    },
    {
      id: 'a11y.reading_order', label: 'Fix reading order', risk: 'read', effect: 'view', undo: 'none', needs: 'model',
      description: 'Fix reading order: opens the Tags panel, where a tag can be moved up or down among its siblings (Move up, Move down) and the order the document reads in is the order of the tags. Not checked against upstream (planned there).',
      params: s.object({}), state: documentState,
      run(ctx) { ctx.setView({rightPanel: 'tags', panel: null}); return {panel: 'tags', message: 'Use Move up and Move down in the Tags panel to change the reading order.'}; },
    },
    {
      id: 'a11y.make_accessible', label: 'Make accessible', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Make accessible: runs, in order, the steps this app can do: set the language (`language`, default en-US) and the title bar, set the tab order, Automatically tag PDF (when the document has no tags), Tag form fields, then the Accessibility Checker. Each step says whether it ran or why not. It does not make a document accessible by itself: the report says which rules passed, which failed and which need a person (reading order, colour contrast, flicker, scripts, timed responses, navigation links), and Add alternate text is still to do. Not checked against upstream.',
      params: s.object({language: s.optional(s.string({min: 2, max: 40}))}), state: modification,
      async run(ctx, p) {
        const steps = [];
        const {doc, content} = await editable(ctx.doc, []);
        const language = p.language ?? A.documentLanguage(doc) ?? 'en-US';
        const attempt = (name, fn) => { try { const r = fn(); steps.push({step: name, done: true, ...(r ? {detail: r} : {})}); } catch (e) { steps.push({step: name, done: false, reason: e.message}); } };
        attempt('Set the document language', () => { A.setReadingOptions(doc, {language}); return language; });
        attempt('Show the title in the window', () => { A.setReadingOptions(doc, {displayTitle: true, ...(A.infoTitle(doc) ? {} : {title: stem(ctx.doc.sourceName || ctx.file?.title || 'Document')})}); });
        attempt('Set the tab order', () => A.setReadingOptions(doc, {tabOrder: true}).join(', '));
        if (A.hasStructTree(doc)) steps.push({step: 'Automatically tag PDF', done: false, reason: 'the document already has tags'});
        else attempt('Automatically tag PDF', () => { const r = A.autotagText(doc); return `${r.paragraphs} paragraphs`; });
        attempt('Tag form fields', () => `${A.tagFormFields(doc)} fields`);
        await commit(ctx, doc, content);
        ctx.setUndoLabel('Make accessible');
        const report = await run(ctx, {rules: A.defaultRules(), pages: null});
        const sum = summaryOf(report);
        return {steps, ...sum, rules: rows(report), message: `${sum.message} ${sum.manual} rules need a manual check; Add alternate text and the reading order are still yours to do.`};
      },
    },
    {
      id: 'tags.list', label: 'Tags', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'The document\'s tags as a flat list in document order: object, parent, depth, type, title, actual text, alternate text, language, table summary and scope, page (0-based).',
      params: s.object({}), state: documentState,
      async run(ctx) { return {tags: A.tags(await loadSource(ctx.doc))}; },
    },
    {
      id: 'tags.set', label: 'Set tag property', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Set a property of a tag (`object` from tags.list): `property` is type, title, actual_text, alternate_text, language, summary (Table tags) or scope (TH tags: Row, Column or Both); an empty `value` removes it.',
      params: s.object({object: s.string({min: 1, max: 40}), property: s.enum(A.TAG_PROPERTIES), value: s.string({max: 65536})}), state: modification,
      async run(ctx, p) { await edit(ctx, 'Change tag', doc => A.setTagProperty(doc, p.object, p.property, p.value)); return {object: p.object, property: p.property}; },
    },
    {
      id: 'tags.move', label: 'Move tag', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Move a tag (`object`) before or after a sibling (`anchor`), which changes the reading order.',
      params: s.object({object: s.string({min: 1, max: 40}), anchor: s.string({min: 1, max: 40}), placement: s.optional(s.enum(['before', 'after']))}), state: modification,
      async run(ctx, p) { await edit(ctx, 'Move tag', doc => A.moveTag(doc, p.object, p.anchor, p.placement ?? 'before')); return {moved: p.object}; },
    },
    {
      id: 'tags.artifact', label: 'Mark tag as artifact', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Mark a leaf tag as an artifact: its page content becomes an /Artifact (not read by assistive technology) and the tag leaves the tree.',
      params: s.object({object: s.string({min: 1, max: 40})}), state: modification,
      async run(ctx, p) { await edit(ctx, 'Mark as artifact', doc => A.markTagArtifact(doc, p.object)); return {artifact: p.object}; },
    },
  ],
});

async function setAlt(ctx, items) {
  const result = await edit(ctx, 'Set alternate text', doc => {
    let alts = 0, decorative = 0;
    for (const it of items) {
      if (it.decorative) { A.markDecorative(doc, it.object); decorative++; }
      else if (it.alt !== undefined) { A.setAlt(doc, it.object, it.alt); alts++; }
    }
    return {alts, decorative};
  });
  return {...result, message: `Set alternate text on ${result.alts} figures${result.decorative ? ` and marked ${result.decorative} decorative` : ''}.`};
}
