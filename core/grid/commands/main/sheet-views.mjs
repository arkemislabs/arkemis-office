// View > Sheet View: named views of one sheet, each keeping the sheet's own AutoFilter and its hidden rows and columns, so a person can filter
// the sheet one way without changing it for anyone else who opens it. Not in gridcraft (not checked against upstream): Office's behaviour,
// done locally. Excel's Sheet Views need a workbook kept on OneDrive or SharePoint for the people sharing it; here the views are kept in
// the workbook (not written to the .xlsx file) and the one being viewed is the session's.
//
//   Sheet View list   Default, then each view of the sheet (the one being viewed is checked); choosing one shows it.
//   New               a view named View1, View2... that starts from the sheet as it is now; it is shown at once.
//   Keep              saves what the sheet looks like now into the view being viewed.
//   Exit              leaves the view and shows the sheet as it was in Default (what was not kept is dropped).
//   Options           Rename, Duplicate and Delete the view being viewed.
// Sorting moves the data itself, so it is not part of a view.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, requireSchema2, failed, bad, baseDoc} from '../../lib/edit-targets.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: []};
const DEFAULT = 'Default';

/** What a sheet view keeps: the AutoFilter and the hidden rows and columns. */
export function snapshot(sheet) {
  const hidden = map => Object.entries(map ?? {}).filter(([, v]) => v && v.hidden).map(([k]) => Number(k)).sort((a, b) => a - b);
  return {autofilter: sheet.autofilter ? structuredClone(sheet.autofilter) : null, rows: hidden(sheet.rows), cols: hidden(sheet.cols)};
}

function restore(ctx, si, snap) {
  const sheet = ctx.doc.sheets[si];
  for (const axis of ['rows', 'cols']) {
    const map = {...(sheet[axis] ?? {})};
    for (const k of Object.keys(map)) {
      if (!map[k]?.hidden) continue;
      const {hidden, ...rest} = map[k];
      void hidden;
      if (Object.keys(rest).length) map[k] = rest; else delete map[k];
    }
    for (const i of snap[axis] ?? []) map[i] = {...(map[i] ?? {}), hidden: true};
    if (Object.keys(map).length) ctx.change.set(['sheets', si, axis], map); else if (sheet[axis]) ctx.change.delete(['sheets', si, axis]);
  }
  if (snap.autofilter) ctx.change.set(['sheets', si, 'autofilter'], structuredClone(snap.autofilter));
  else if (sheet.autofilter) ctx.change.delete(['sheets', si, 'autofilter']);
}

const activeOf = (ctx, sheet) => ctx.view?.sheetViewActive?.[sheet.id] ?? null;
const setActive = (ctx, sheet, name) => {
  const all = {...(ctx.view?.sheetViewActive ?? {})};
  if (name) all[sheet.id] = name; else delete all[sheet.id];
  ctx.setView({sheetViewActive: all});
};
const here = ctx => { const si = gridSel(ctx).sheet; requireSchema2(ctx, si); return {si, sheet: ctx.doc.sheets[si]}; };
const names = sheet => Object.keys(sheet.sheetViews ?? {});
const nextName = sheet => { let n = 1; while ((sheet.sheetViews ?? {})[`View${n}`]) n++; return `View${n}`; };

/** Enter `name` (null: Default). Leaving Default keeps its state to come back to; the view's saved state is shown. */
function show(ctx, si, name) {
  const sheet = ctx.doc.sheets[si];
  const cur = activeOf(ctx, sheet);
  if ((name ?? null) === cur) return;
  let base = sheet.sheetViewDefault ?? null;
  if (cur === null) { base = snapshot(sheet); ctx.change.set(['sheets', si, 'sheetViewDefault'], base); }
  if (name === null) {
    restore(ctx, si, base ?? snapshot(sheet));
    ctx.change.delete(['sheets', si, 'sheetViewDefault']);
  } else restore(ctx, si, sheet.sheetViews[name]);
  setActive(ctx, sheet, name);
}

const viewState = pick => ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  const sheet = ctx.doc.sheets[gridSel(ctx).sheet];
  return pick(sheet, activeOf(ctx, sheet));
};

export default defineCommands({
  family: 'main/sheet-views',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'view.sheetViewSelect', label: 'Sheet View', risk: 'edit',
      description: 'Show a named view of the sheet (`name`), or Default (name Default or empty): its AutoFilter and hidden rows and columns. Without `name`, the list.',
      params: s.object({name: s.optional(s.string({max: 255})), value: s.optional(s.string({max: 255}))}),
      state: viewState((sheet, cur) => ({enabled: true, value: [{id: DEFAULT, label: DEFAULT, value: DEFAULT, checked: cur === null}, ...names(sheet).map(n => ({id: n, label: n, value: n, checked: cur === n}))]})),
      run(ctx, p) {
        baseDoc(ctx);
        const {si, sheet} = here(ctx);
        const want = p.name ?? p.value;
        if (want === undefined) return {views: names(sheet), active: activeOf(ctx, sheet)};
        if (!want || want === DEFAULT) { show(ctx, si, null); return {active: null}; }
        if (!(sheet.sheetViews ?? {})[want]) throw bad('view.sheetViewSelect', `no view named \`${want}\``);
        show(ctx, si, want);
        return {active: want};
      },
    },
    {
      id: 'view.sheetViewNew', label: 'New Sheet View', risk: 'edit',
      description: 'Make a new view of the sheet (View1, View2... or `name`) from the sheet as it is now, and show it.',
      params: s.object({name: s.optional(s.string({min: 1, max: 255}))}),
      state: hasDoc,
      run(ctx, p) {
        baseDoc(ctx);
        const {si, sheet} = here(ctx);
        const name = p.name ?? nextName(sheet);
        if (name === DEFAULT || (sheet.sheetViews ?? {})[name]) throw failed(`There is already a view named ${name}.`);
        const cur = activeOf(ctx, sheet);
        if (cur === null) ctx.change.set(['sheets', si, 'sheetViewDefault'], snapshot(sheet));
        ctx.change.set(['sheets', si, 'sheetViews'], {...(sheet.sheetViews ?? {}), [name]: snapshot(sheet)});
        setActive(ctx, sheet, name);
        return {active: name};
      },
    },
    {
      id: 'view.sheetViewKeep', label: 'Keep Sheet View', risk: 'edit',
      description: 'Save what the sheet looks like now (AutoFilter, hidden rows and columns) into the view being viewed.',
      params: s.object({}),
      state: viewState((sheet, cur) => (cur ? {enabled: true} : {enabled: false, reason: 'no view is being viewed'})),
      run(ctx) {
        baseDoc(ctx);
        const {si, sheet} = here(ctx);
        const cur = activeOf(ctx, sheet);
        if (!cur || !(sheet.sheetViews ?? {})[cur]) throw failed('Choose a view first.');
        ctx.change.set(['sheets', si, 'sheetViews'], {...sheet.sheetViews, [cur]: snapshot(sheet)});
        return {kept: cur};
      },
    },
    {
      id: 'view.sheetViewExit', label: 'Exit Sheet View', risk: 'edit',
      description: 'Leave the view being viewed and show the sheet as it is in Default; what was not kept is dropped.',
      params: s.object({}),
      state: viewState((sheet, cur) => (cur ? {enabled: true} : {enabled: false, reason: 'no view is being viewed'})),
      run(ctx) {
        baseDoc(ctx);
        const {si} = here(ctx);
        show(ctx, si, null);
        return {active: null};
      },
    },
    {
      id: 'view.sheetViewOptions', label: 'Sheet View Options', risk: 'edit',
      description: 'Rename (`name`), duplicate or delete the view being viewed (action rename|duplicate|delete).',
      params: s.object({action: s.optional(s.enum(['rename', 'duplicate', 'delete'])), name: s.optional(s.string({min: 1, max: 255}))}),
      state: viewState((sheet, cur) => (cur ? {enabled: true} : {enabled: false, reason: 'no view is being viewed'})),
      run(ctx, p) {
        baseDoc(ctx);
        const {si, sheet} = here(ctx);
        const cur = activeOf(ctx, sheet);
        if (!cur) throw failed('Choose a view first.');
        const views = {...(sheet.sheetViews ?? {})};
        const action = p.action ?? 'rename';
        if (action === 'delete') {
          // Deleting the view being viewed returns to Default.
          show(ctx, si, null);
          delete views[cur];
          if (Object.keys(views).length) ctx.change.set(['sheets', si, 'sheetViews'], views); else ctx.change.delete(['sheets', si, 'sheetViews']);
          return {deleted: cur};
        }
        const name = String(p.name ?? (action === 'duplicate' ? `${cur} copy` : '')).trim();
        if (!name) throw failed('Type a name for the view.');
        if (name === DEFAULT || (views[name] && name !== cur)) throw failed(`There is already a view named ${name}.`);
        if (action === 'rename') {
          const out = {};
          for (const [k, v] of Object.entries(views)) out[k === cur ? name : k] = v;
          ctx.change.set(['sheets', si, 'sheetViews'], out);
          setActive(ctx, sheet, name);
          return {renamed: name};
        }
        views[name] = structuredClone(views[cur]);
        ctx.change.set(['sheets', si, 'sheetViews'], views);
        return {duplicated: name};
      },
    },
  ],
});
