// Every dialog of every app, opened and submitted once through the bridge (the per-app gate,
// docs/architecture.md 17.5: "every dialog of the app opened and submitted once"). A dialog whose
// command is not translated yet is skipped (production hides it). Submitting with the values a
// dialog opens with must either work or be refused with a message the person sees (a field error,
// an approval request, nothing to act on); a crash or an internal error fails the sweep. Captures
// of every implemented dialog go to artifacts/e2e/shell/dialog-sweep/<app>/ for review.
//
// System dialogs are answered by the test-mode script (electron/main.cjs: never a real dialog), so
// Save As, Open and Print run without anything appearing on screen.
//
//   npm run build && node --test tests/e2e/shell/dialog-sweep.e2e.mjs
//   SWEEP_APPS=quill node --test tests/e2e/shell/dialog-sweep.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {devRenderer, launchApp, artifactDir} from '../harness.mjs';
import {createFile} from '../../../core/model.mjs';
import {textPdf, schema1Content} from '../../../core/folio/fixtures.mjs';
import {createContent, validateContent, newPageRecord, SECTION_COLORS} from '../../../core/slate/schema.mjs';

const APPS = (process.env.SWEEP_APPS || 'quill,grid,prism,slate,folio').split(',').map(s => s.trim()).filter(Boolean);
// SWEEP_DIALOGS=colors,tag-editor: only these dialogs (ids with or without the `dialog.` prefix), for a quick look at a few.
const ONLY = (process.env.SWEEP_DIALOGS || '').split(',').map(s => s.trim().replace(/^dialog\./, '')).filter(Boolean);
// Refusals a person sees and can act on: a field or input error, nothing selected to act on, an
// approval prompt, a cancelled system dialog.
const REFUSAL = /^(invalid_params|not_found|disabled|approval_required|unavailable|canceled|cancelled|conflict|failed)$/;
// Close and Quit end the session; the file-lifecycle flows (tests/e2e/common/file-*.e2e.mjs) cover them.
const SKIP = new Set(['dialog.close', 'dialog.quit', 'dialog.saveChanges', 'prompt.save-changes']);

/** A document to sweep: Slate starts from a notebook and PDF from a file (neither has a blank document). */
async function seedFor(product) {
  // Excel opens on a list (headers, numbers, a second sheet) so Sort, Remove Duplicates, Data Validation and the others show what a person sees.
  if (product === 'grid') {
    const file = (await import('../grid/data-kit.mjs')).seed();
    // The data dialogs open on content: a monthly series (Forecast Sheet), a total and a #DIV/0! (Solver, Error Checking), the list (PivotTable, Sort...).
    const cells = file.content.sheets[0].blocks[0];
    cells.H1 = {v: 'Month'}; cells.I1 = {v: 'Sales'};
    [112, 118, 132, 129, 141, 150, 158, 149, 162, 171, 180, 192].forEach((v, i) => { cells[`H${i + 2}`] = {v: i + 1}; cells[`I${i + 2}`] = {v}; });
    cells.K1 = {v: 'Total'}; cells.K2 = {f: 'SUM(D2:D8)'}; cells.K3 = {f: 'D2/(C2-5)'};
    return file;
  }
  if (product === 'folio') {
    const file = createFile('folio', 'Sweep PDF');
    file.id = 'sweep-pdf';
    file.content = await schema1Content(await textPdf({pages: 3}), 'sweep.pdf');
    return file;
  }
  if (product === 'slate') {
    // As tests/e2e/slate/format-home.e2e.mjs seeds one: a schema-2 notebook record.
    const now = '2026-10-30T09:30:00.000Z';
    const content = createContent('Sweep notebook', {now});
    // A section group with two sections and two more sections beside it, each with a page, so the pickers (Move or Copy, Merge, Link) have a tree to draw.
    const first = Object.keys(content.sections)[0];
    const addSection = (id, name, color, title) => {
      content.sections[id] = {id, name, color, created: now, pages: [{id: `p-${id}`, level: 0}]};
      content.pages[`p-${id}`] = newPageRecord({id: `p-${id}`, title, created: now});
    };
    addSection('sweep-notes', 'Meeting Notes', SECTION_COLORS[1], 'Kickoff');
    addSection('sweep-plan', 'Plan', SECTION_COLORS[2], 'Roadmap');
    addSection('sweep-q1', 'Q1', SECTION_COLORS[3], 'Targets');
    addSection('sweep-q2', 'Q2', SECTION_COLORS[4], 'Targets');
    content.groups['sweep-group'] = {id: 'sweep-group', name: 'Projects', items: ['sweep-q1', 'sweep-q2']};
    content.tree = [first, 'sweep-notes', 'sweep-group', 'sweep-plan'];
    validateContent(content);
    return {id: 'sweep-notebook', schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: now, updatedAt: now, starred: false, links: [], content};
  }
  return null;
}
const INTERNAL = /Cannot read|is not a function|undefined|null \(reading|TypeError|ReferenceError|RangeError|Maximum call stack/;

for (const product of APPS) {
  test(`${product}: every implemented dialog opens and submits`, {timeout: 900_000}, async () => {
    const spec = (await import(`../../../src/generated/${product}.spec.ts`)).default;
    const renderer = await devRenderer({newHost: true});
    const seed = await seedFor(product);
    const app = await launchApp({product, flow: `shell/dialog-sweep/${product}`, renderer, files: seed ? [seed] : []});
    const report = {product, opened: 0, submitted: 0, refused: [], failed: [], pending: 0};
    try {
      await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
      const doc = seed ? seed.id : (await app.rpc('documents.create', {})).doc;
      await app.rpc('documents.open', {doc, show: true});
      await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000});
      for (const id of Object.keys(spec.dialogs).sort().filter(d => !SKIP.has(d) && (!ONLY.length || ONLY.includes(d.replace(/^dialog\./, ''))))) {
        let snap;
        // Dialogs that act on a selection open on the right one: the list for the data dialogs, the series, the error cell, the total.
        if (product === 'grid') {
          const at = {'dialog.forecastSheet': ['H1', 'I13'], 'dialog.errorChecking': ['K3', 'K3'], 'dialog.solverOptions': ['K2', 'K2'], 'dialog.goalSeek': ['K2', 'K2']}[id] ?? ['A1', 'D8'];
          await app.rpc('selection.set', {doc, ranges: [{anchor: `/sh:s1/${at[0]}`, focus: `/sh:s1/${at[1]}`}], primary: 0}).catch(() => {});
        }
        // Excel's Protect Sheet is only offered on an unprotected sheet, and every other dialog is drawn on one: an earlier dialog's submit
        // (Protect Sheet) may have protected this one.
        if (product === 'grid' && id !== 'dialog.unprotectSheet') await app.rpc('engine.execute', {doc, command: 'review.unprotectSheet', params: {}}).catch(() => {});
        // Unhide lists the hidden sheets: hide the second one so the list has something in it.
        if (product === 'grid' && id === 'dialog.unhideSheet') await app.rpc('engine.execute', {doc, command: 'sheet.hide', params: {sheet: 'Sheet2'}}).then(() => app.rpc('ui.capture')).catch(() => {});
        try { snap = await app.rpc('ui.dialog.open', {doc, id}); } catch (e) {
          if (REFUSAL.test(e.code ?? '')) { report.refused.push({id, stage: 'open', code: e.code, message: e.message}); continue; }
          report.failed.push({id, stage: 'open', code: e.code ?? null, message: e.message});
          continue;
        }
        if (snap.pending) { report.pending++; await app.rpc('ui.dialog.cancel', {doc}).catch(() => {}); continue; }
        report.opened++;
        // A dialog's own body is a lazy chunk: give it the moment it needs, so the capture shows the dialog and not its first paint.
        await new Promise(r => setTimeout(r, 500));
        await app.capture(id.replace(/^dialog\./, ''));
        try {
          await app.rpc('ui.dialog.submit', {doc, id: snap.key ?? null});
          report.submitted++;
        } catch (e) {
          const entry = {id, stage: 'submit', code: e.code ?? null, message: e.message};
          if (REFUSAL.test(e.code ?? '') && !INTERNAL.test(e.message)) report.refused.push(entry); else report.failed.push(entry);
        }
        // Whatever the submit did, close what is still open (a refused dialog stays open, as in Office).
        for (let i = 0; i < 4; i++) { const ui = await app.rpc('ui.inspect', {doc}); if (!ui.dialog) break; await app.rpc('ui.dialog.cancel', {doc}).catch(() => {}); }
        // A result the worksheet answers with (Remove Duplicates, Goal Seek) is a message box of its own: dismiss it, or it is the "ghost" behind the next capture.
        if (product === 'grid') for (const click of ['OK', 'Close', 'Cancel']) { if (await app.rpc('ui.pointer', {doc, action: 'click', target: 'messageBox', click}).then(() => true, () => false)) break; }
        // Let the closing dialog finish fading, or the next capture shows it as a ghost behind the new one.
        // A capture nobody keeps makes the window paint a frame without the dialog before the next one opens.
        await app.rpc('ui.capture').catch(() => {});
        await new Promise(r => setTimeout(r, 350));
      }
    } catch (e) {
      throw new Error(`${e.message}\n--- app log ---\n${app.log.slice(-40).join('')}`);
    } finally {
      const dir = artifactDir(`shell/dialog-sweep/${product}`);
      await fs.mkdir(dir, {recursive: true});
      await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
      await app.close();
    }
    assert.deepEqual(report.failed, [], `${product}: dialogs that crash or fail inside (report: artifacts/e2e/shell/dialog-sweep/${product}/report.json)`);
  });
}
