// scripts/generate.mjs and scripts/gen/*: spec normalization of all five real specs, synthetic
// shape variations, patches, overlays, registry validation, icons, and the ownership check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {generate} from '../../scripts/generate.mjs';
import {buildSpecModel, normalizeSpec, walkControls, familyOf, commandInText, validateSpecModel} from '../../scripts/gen/spec.mjs';
import {checkSvg} from '../../scripts/gen/icons.mjs';
import {checkOwnership, normalizeUnit, mayEdit} from '../../scripts/gen/ownership.mjs';
import {Report, APPS} from '../../scripts/gen/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kernel = name => pathToFileURL(path.join(root, 'core/kernel', name)).href;
const real = generate({root, check: true});

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true}); });
function tmpRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkemis-gen-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  }
  return dir;
}
const family = (fam, app, ids, extra = '') => `import {defineCommands} from ${JSON.stringify(kernel('command.mjs'))};
import {s} from ${JSON.stringify(kernel('schema.mjs'))};
export default defineCommands({family: ${JSON.stringify(fam)}, app: ${JSON.stringify(app)}, upstream: {repo: 'office', files: []},
  commands: ${JSON.stringify(ids)}.map(id => ({id, label: id, risk: 'edit', params: s.object({mode: s.optional(s.enum(['a', 'b']))}), run() {}${extra}}))});\n`;

const EXPECTED = {
  quill: {qat: ['file.save', 'edit.undo', 'edit.redo'], minTabs: 15, minDialogs: 80, minCommands: 600},
  grid: {qat: null, minTabs: 15, minDialogs: 100, minCommands: 350},
  prism: {qat: ['app.home', 'file.save', 'app.exportDialog', 'edit.undo', 'edit.redo', 'show.fromStart'], minTabs: 20, minDialogs: 50, minCommands: 400},
  folio: {qat: [], minTabs: 10, minDialogs: 80, minCommands: 300},
  slate: {qat: ['nav.back', 'edit.undo', 'edit.redo', 'view.dock', 'view.fullPage', 'view.touchMode', 'tools.customizeRibbon'], minTabs: 10, minDialogs: 50, minCommands: 290},
};

for (const app of APPS) {
  test(`spec normalization: docs/spec for ${app} normalizes without errors`, () => {
    const report = new Report();
    const model = buildSpecModel(root, app, report);
    assert.ok(model, 'model built');
    assert.deepEqual(report.errors, []);
    const e = EXPECTED[app];
    assert.ok(model.tabs.length >= e.minTabs, `${model.tabs.length} tabs`);
    assert.ok(Object.keys(model.dialogs).length >= e.minDialogs);
    assert.ok(Object.keys(model.commands).length >= e.minCommands);
    if (e.qat) assert.deepEqual(model.qat.map(c => c.command), e.qat);
    const tabIds = model.tabs.map(t => t.id);
    assert.equal(new Set(tabIds).size, tabIds.length, 'tab ids unique');
    const ids = [];
    walkControls(model.tabs, c => {
      ids.push(c.id);
      assert.ok(c.type, `${c.id} has a renderer type`);
      assert.ok(c.args === null || typeof c.args === 'object');
    });
    for (const c of model.qat) ids.push(c.id);
    assert.equal(new Set(ids).size, ids.length, 'control ids unique');
    for (const tab of model.tabs) {
      if (tab.contextual) assert.match(tab.contextFor, /^[A-Za-z0-9_-]+$/, `${tab.id} has a flag`);
      for (const g of tab.groups) {
        const inGroup = new Set(g.controls.filter(c => c.id).map(c => c.id));
        const placed = g.layout.flatMap(i => i.large ?? i.small ?? i.medium ?? i.gallery ?? i.stack ?? i.rows?.flat().map(x => (typeof x === 'string' ? x : x.medium)) ?? []);
        assert.deepEqual(new Set(placed), inGroup, `${tab.id}/${g.id} layout places every control once`);
      }
    }
    for (const d of Object.values(model.dialogs)) {
      assert.ok(Array.isArray(d.buttons), `${d.id} has a button list (palettes have none)`);
      for (const b of d.buttons) assert.ok(['ok', 'cancel', 'apply', 'help', 'other'].includes(b.role));
      for (const f of d.tabs.flatMap(x => x.fields)) assert.ok(Array.isArray(f.options));
    }
    for (const c of Object.values(model.commands)) assert.match(c.family, /^[A-Za-z0-9_-]+$/);
    for (const sc of model.shortcuts) assert.ok(sc.command || sc.dialog);
    const result = validateSpecModel(model, new Report());
    assert.ok(Array.isArray(result.missingCommands));
    assert.ok(JSON.parse(JSON.stringify(model)), 'serializable');
  });
}

test('families come from upstream cmd modules, Slate modules, else the id prefix', () => {
  assert.deepEqual(familyOf({id: 'format.bold', sourceRef: 'crates/engine/src/cmd/format.rs:12'}), {family: 'format', fromSource: true});
  assert.deepEqual(familyOf({id: 'tools.x', sourceRef: 'crates/engine/src/cmd/tools/specs.rs:51'}), {family: 'tools', fromSource: true});
  assert.deepEqual(familyOf({id: 'clipboard.paste', sourceRef: 'core/slate-clipboard.mjs'}), {family: 'clipboard', fromSource: true});
  assert.deepEqual(familyOf({id: 'view.zoom.in', sourceRef: 'crates/ui-egui/src/menus.rs:60'}), {family: 'view', fromSource: false});
  assert.deepEqual(familyOf({id: 'a11y.check', sourceRef: null}), {family: 'a11y', fromSource: false});
  assert.equal(commandInText('Cut (edit.cut)'), 'edit.cut');
  assert.equal(commandInText('[spelling] suggestions… (review.applySuggestion {text})'), 'review.applySuggestion');
  assert.equal(commandInText('Plain'), null);
});

test('shape variations from the five spec authors all normalize', () => {
  const report = new Report();
  const raw = {
    app: 'grid', product: 'Test', upstream: 'gridcraft',
    ribbon: [
      {tab: 'Home', contextual: false, groups: [
        {group: 'Clipboard', dialogLauncher: {pane: 'pane.clipboard'}, controls: [
          {id: 'home.clipboard.paste', label: 'Paste', kind: 'split', command: 'edit.paste', params: {what: 'all'}, icon: 'clipboard-paste',
            items: [{label: 'Paste Values', command: 'edit.pasteSpecial', params: {what: 'values'}}, {separator: true},
              {label: 'More', submenu: [{label: 'A', command: 'x.a'}]}, {header: 'Library'}]},
          {id: 'home.clipboard.launcher', label: 'Clipboard', kind: 'launcher', command: 'view.pane', params: {pane: 'clipboard'}},
          {id: 'home.clipboard.sign', label: 'Sign', kind: 'split', command: 'sign.x', menu: [{command: 'sign.y', label: 'Change'}]},
          {id: 'home.clipboard.size', label: 'Size', kind: 'combo', command: 'format.size', options: [8, {value: '9', label: 'Nine'}]},
          {id: 'home.clipboard.odd', label: 'Odd', kind: 'tile', command: null},
        ]},
      ]},
      {tab: 'Table Design', contextual: true, when: 'caret in a table', groups: []},
      {tab: 'Table Design', contextual: true, tabSet: 'Table Tools', groups: []},
    ],
    quickAccessToolbar: {available: [{command: 'file.save', label: 'Save'}], defaults: ['file.save', 'edit.undo']},
    backstage: [{id: 'file.info', label: 'Info', kind: 'page', sections: [{label: 'Protect', items: ['Encrypt (file.encrypt)']}]}],
    dialogs: [
      {id: 'dialog.a', title: 'A', applies: 'x.a', tabs: [{name: '', fields: [{id: 'f', label: 'F', kind: 'radio', options: [{value: 'r', label: 'Right'}], password: true}]}], buttons: ['Insert', 'Cancel']},
      {id: 'dialog.a', title: 'dup'},
      {id: 'dialog.b', title: 'B', tabs: [], buttons: ['OK', 'Close', 'Apply', 'Help', 'Options…']},
      {id: 'dialog.c', title: 'C', command: 'file.save', tabs: [], buttons: ["Don't Save", 'Cancel', 'Save']},
    ],
    commands: [{id: 'edit.paste', args: ['mode: a|b'], sourceRef: 'crates/engine/src/cmd/edit.rs:1', summary: 'Paste'}, {id: 'x.a', params: '{a}', sourceRef: null}],
    contextMenus: [{target: 'cell', items: ['Cut', 'Paste (edit.paste)', '-', 'Insert…'], commands: {Cut: 'edit.cut', 'Insert…': 'dialog.insertCells'}},
      {target: 'slide', items: [{label: 'Copy', command: 'edit.copy'}, '-', {label: 'Layout', kind: 'submenu', items: [{label: 'L1', command: 'slide.layout'}]}]},
      {target: 'page', items: ['One', 'Two'], commands: ['a.one', 'a.two']}],
    panes: [{id: 'pane.x', label: 'X', dock: 'start', width: 260}],
    statusBar: ['Page {n} of {m}', 'Words'],
    shortcuts: [{keys: 'Ctrl+V', command: 'edit.paste'}, {keys: 'Arrow keys', command: 'caret.move'}, {keys: 'F1', command: null}],
  };
  const m = normalizeSpec(raw, {app: 'grid', report, file: 'synthetic.json'});
  const group = m.tabs[0].groups[0];
  assert.deepEqual(group.launcher, {dialog: null, pane: 'pane.clipboard', command: null, args: null, label: null});
  assert.equal(group.controls.length, 4, 'the launcher control became the group launcher');
  const paste = group.controls[0];
  assert.deepEqual(paste.args, {what: 'all'});
  assert.equal(paste.type, 'split');
  assert.equal(paste.items[0].id, 'home.clipboard.paste.paste-values');
  assert.deepEqual(paste.items[1], {separator: true});
  assert.equal(paste.items[2].items[0].command, 'x.a');
  assert.deepEqual(paste.items[3], {header: 'Library'});
  assert.equal(group.controls[1].items[0].command, 'sign.y');
  assert.deepEqual(group.controls[2].options, [{value: 8, label: '8'}, {value: '9', label: 'Nine'}]);
  assert.equal(group.controls[3].type, 'button');
  assert.deepEqual(m.tabs.map(t => [t.id, t.contextFor]), [['home', null], ['table-design', 'table-design'], ['table-design-table-tools', 'table-design-table-tools']]);
  assert.deepEqual(m.qat.map(c => c.command), ['file.save', 'edit.undo']);
  assert.equal(m.backstage[0].children[0].children[0].command, 'file.encrypt');
  assert.equal(m.dialogs['dialog.a'].command, 'x.a');
  assert.equal(m.dialogs['dialog.a'].buttons[0].role, 'ok', 'Insert is the primary button');
  assert.equal(m.dialogs['dialog.a'].tabs[0].fields[0].masked, true);
  assert.deepEqual(m.dialogs['dialog.b'].buttons.map(b => b.role), ['ok', 'cancel', 'apply', 'help', 'other']);
  assert.deepEqual(m.dialogs['dialog.c'].buttons.map(b => [b.id, b.role]), [['dont-save', 'other'], ['cancel', 'cancel'], ['save', 'ok']]);
  assert.equal(m.commands['x.a'].paramsDoc, '{a}');
  assert.deepEqual(m.contextMenus[0].items.map(i => i.command ?? i.dialog ?? (i.separator ? '-' : null)), ['edit.cut', 'edit.paste', '-', 'dialog.insertCells']);
  assert.equal(m.contextMenus[1].items[2].items[0].command, 'slide.layout');
  assert.deepEqual(m.contextMenus[2].items.map(i => i.command), ['a.one', 'a.two']);
  assert.equal(m.panes[0].side, 'start');
  assert.deepEqual(m.statusBar.map(x => x.id), ['page-n-of-m', 'words']);
  assert.equal(m.shortcuts.length, 2);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some(w => w.includes('duplicate dialog ids')));
  assert.ok(report.warnings.some(w => w.includes('do not parse')));
  assert.equal(normalizeSpec('nope', {app: 'grid', report: new Report()}), null);
});

const slateSpec = {
  app: 'slate', upstream: null,
  ribbon: [{tab: 'Home', contextual: false, groups: [{group: 'Font', controls: [
    {id: 'home.font.bold', label: 'Bold', kind: 'toggle', command: 'format.bold', shortcut: 'Ctrl+B', dialog: null, icon: 'bold-B', source: 'office', sourceRef: 'x'},
    {id: 'home.font.italic', label: 'Italic', kind: 'toggle', command: 'format.italic', shortcut: 'Ctrl+I', dialog: null, icon: 'italic-I', source: 'office', sourceRef: 'x'},
    {id: 'home.font.grow', label: 'Grow', kind: 'button', command: 'format.grow', args: {step: 1}, dialog: null, icon: 'grow', source: 'office', sourceRef: 'x'},
  ]}]}, {tab: 'Table Layout', contextual: true, contextFor: 'table', groups: []}],
  quickAccessToolbar: [], backstage: [],
  dialogs: [{id: 'dialog.font', title: 'Font', command: 'format.font', tabs: [{name: 'Font', fields: [{id: 'size', label: 'Size', kind: 'number', options: []}]}], buttons: ['OK', 'Cancel']}],
  commands: [{id: 'format.bold', args: [], sourceRef: 'core/slate-format.mjs', summary: 'Bold'}, {id: 'format.italic', args: [], sourceRef: 'core/slate-format.mjs', summary: 'Italic'},
    {id: 'format.grow', args: ['step'], sourceRef: 'core/slate-format.mjs', summary: 'Grow'}, {id: 'format.font', args: [], sourceRef: 'core/slate-format.mjs', summary: 'Font'}],
  contextMenus: [], panes: [], statusBar: [], shortcuts: [],
};

test('patches merge by id, insert controls, and two patches on one key fail naming both files', async () => {
  const dir = tmpRoot({
    'docs/spec/slate.json': slateSpec,
    'docs/spec/patches/slate/format.json': {controls: {'home.font.grow': {icon: 'font-grow'}}, commands: {'format.grow': {args: ['step?: number']}},
      insertAfter: {'home.font.italic': [{id: 'home.font.underline', label: 'Underline', kind: 'toggle', command: 'format.underline', icon: 'underline-U'}]},
      dialogs: {'dialog.font': {title: 'Font Settings'}}, tabs: {'table-layout': {contextFor: 'table-cell'}}},
    'docs/spec/patches/slate/zzz.json': {controls: {'home.font.grow': {label: 'Grow Font'}}},
  });
  const r = await generate({root: dir, check: true});
  const m = r.models.get('slate');
  const ids = m.tabs[0].groups[0].controls.map(c => c.id);
  assert.deepEqual(ids, ['home.font.bold', 'home.font.italic', 'home.font.underline', 'home.font.grow']);
  assert.equal(m.tabs[0].groups[0].controls[3].icon, 'font-grow');
  assert.equal(m.tabs[0].groups[0].controls[3].label, 'Grow', 'the second patch was refused');
  assert.deepEqual(m.commands['format.grow'].args, ['step?: number']);
  assert.equal(m.dialogs['dialog.font'].title, 'Font Settings');
  assert.equal(m.tabs[1].contextFor, 'table-cell');
  const conflict = r.errors.find(e => e.includes('home.font.grow'));
  assert.match(conflict, /docs\/spec\/patches\/slate\/zzz\.json: .*already patched by docs\/spec\/patches\/slate\/format\.json/);
  const bad = tmpRoot({'docs/spec/slate.json': slateSpec, 'docs/spec/patches/slate/x.json': {controls: {'home.font.nope': {icon: 'x'}}, bogus: {}}});
  const rb = await generate({root: bad, check: true});
  assert.ok(rb.errors.some(e => e.includes('no control "home.font.nope"')));
  assert.ok(rb.errors.some(e => e.includes('unknown patch section "bogus"')));
});

test('layout overlays place controls; unknown ids, double placement and keytip clashes fail', async () => {
  const dir = tmpRoot({
    'docs/spec/slate.json': slateSpec,
    'docs/spec/layout/slate/home.json': {tab: 'home', keytip: 'H', groups: {font: {keytip: 'FN', collapseOrder: 3, launcher: {dialog: 'dialog.font'},
      layout: [{rows: [['home.font.bold', 'home.font.italic']]}], widths: {'home.font.bold': 40}}}, keytips: {'home.font.bold': '1', 'home.font.italic': '2'}},
    'docs/spec/layout/slate/dialogs/font.json': {size: {width: 420, height: 380}, fieldOrder: ['size']},
  });
  const r = await generate({root: dir, check: true});
  assert.deepEqual(r.errors, []);
  const tab = r.models.get('slate').tabs[0];
  assert.equal(tab.layoutSource, 'docs/spec/layout/slate/home.json');
  assert.equal(tab.keytip, 'H');
  const g = tab.groups[0];
  assert.deepEqual(g.layout, [{rows: [['home.font.bold', 'home.font.italic']]}, {small: 'home.font.grow', unplaced: true}]);
  assert.equal(g.launcher.dialog, 'dialog.font');
  assert.equal(g.collapseOrder, 3);
  assert.equal(g.controls[0].keytip, '1');
  assert.deepEqual(r.models.get('slate').dialogs['dialog.font'].layout.size, {width: 420, height: 380});
  assert.deepEqual(r.coverage.slate.unplacedControls, ['home.font.grow']);
  const bad = tmpRoot({
    'docs/spec/slate.json': slateSpec,
    'docs/spec/layout/slate/home.json': {groups: {font: {layout: [{large: 'home.font.nope'}, {stack: ['home.font.bold']}, {large: 'home.font.bold'}, {weird: 1}]},
      nogroup: {}}, keytips: {'home.font.bold': 'B', 'home.font.italic': 'B'}},
    'docs/spec/layout/slate/insert.json': {},
    'docs/spec/layout/slate/dialogs/font.json': {fieldOrder: ['nope']},
  });
  const rb = await generate({root: bad, check: true});
  const text = rb.errors.join('\n');
  for (const m of ['places "home.font.nope"', 'places "home.font.bold" twice', 'must use exactly one of', 'no group "nogroup"', 'keytip "B" is used by',
    'no tab "insert"', 'unknown field "nope"']) assert.ok(text.includes(m), m);
});

test('the generator writes indexes with zero command modules and catches module contract errors', async () => {
  const empty = tmpRoot({'README.md': 'x'});
  const r0 = await generate({root: empty});
  assert.deepEqual(r0.errors, []);
  for (const app of APPS) {
    const idx = await import(pathToFileURL(path.join(empty, 'core/generated', `${app}.commands.mjs`)).href);
    assert.deepEqual(idx.modules, []);
    assert.ok(fs.existsSync(path.join(empty, 'src/generated', `${app}.ui.ts`)));
    assert.match(fs.readFileSync(path.join(empty, 'src/generated', `${app}.spec.ts`), 'utf8'), /const spec: SpecModel \| null = null/);
  }
  assert.ok(fs.existsSync(path.join(empty, 'core/generated/manifest.json')));
  const apps = await import(pathToFileURL(path.join(empty, 'core/generated/apps.mjs')).href);
  assert.deepEqual(Object.keys(apps.apps), APPS);

  const dir = tmpRoot({
    'core/common/commands/edit.mjs': family('edit', '*', ['edit.undo']),
    'core/grid/commands/data.mjs': family('data', 'grid', ['data.sort', 'edit.undo']),
    'core/grid/commands/format/font.mjs': family('format', 'grid', ['home.bold']),
    'core/grid/commands/view.mjs': family('view', 'quill', ['view.x']),
    'core/grid/commands/_template.mjs': 'export default null;\n',
    'core/grid/commands/keys.mjs': family('keys', 'grid', ['keys.a', 'keys.b'], ", shortcut: 'Mod+K'"),
    'core/quill/commands/ui.mjs': family('ui', 'quill', ['ui.caret'], ", needs: 'view'"),
    'core/quill/commands/broken.mjs': 'export default {;\n',
    'core/grid/dialogs/sortDialog.mjs': `import {defineDialog} from ${JSON.stringify(kernel('dialog.mjs'))};
export default defineDialog({id: 'dialog.sort', init: () => ({}), validate: () => [], toCommand: () => ({command: 'data.sort', params: {}})});\n`,
    'core/grid/formats/csv-read.mjs': 'export const read = () => null;\n',
    'core/grid/formats/oops.mjs': 'export const x = 1;\n',
  });
  const r = await generate({root: dir, check: true});
  const text = r.errors.join('\n');
  for (const m of [
    'command id "edit.undo" is defined in core/common/commands/edit.mjs and core/grid/commands/data.mjs',
    'family is "format" but the file says "format/font"',
    'app is "quill" but the file lives in core/grid',
    "shortcut Ctrl+K (win, app) is bound to keys.a",
    "needs:'view' commands live in src/apps",
    'core/quill/commands/broken.mjs: cannot be imported',
    'dialog id "dialog.sort" belongs in sort.mjs',
    'format modules are named',
  ]) assert.ok(text.includes(m), `${m}\n---\n${text}`);
  assert.ok(!text.includes('_template'), 'files starting with _ are skipped');
});

test('renderer indexes list manifests, ui-commands and lazy dialogs, panes, backstage pages and extensions', async () => {
  const dir = tmpRoot({
    'src/apps/grid/manifest.ts': 'export default {ready: false};\n',
    'src/apps/grid/ui-commands/view.ts': 'export default null;\n',
    'src/apps/grid/dialogs/formatCells.tsx': 'export const Preview = null;\n',
    'src/apps/grid/panes/selection.tsx': 'export default null;\n',
    'src/apps/grid/backstage/export.tsx': 'export default null;\n',
    'src/apps/grid/extensions/linked.tsx': 'export default null;\n',
    'core/grid/formats/csv-read.mjs': 'export const read = () => null;\n',
    'core/grid/formats/csv-write.mjs': 'export const write = () => null;\n',
    'core/grid/schema.mjs': 'export const validateContent = () => {};\n',
    'core/grid/address.mjs': 'export const parse = () => null;\n',
  });
  const r = await generate({root: dir});
  assert.deepEqual(r.errors, []);
  const ui = fs.readFileSync(path.join(dir, 'src/generated/grid.ui.ts'), 'utf8');
  assert.match(ui, /export \{default as manifest\} from "\.\.\/apps\/grid\/manifest";/);
  assert.match(ui, /import u0 from "\.\.\/apps\/grid\/ui-commands\/view";/);
  assert.match(ui, /"formatCells": \(\) => import\("\.\.\/apps\/grid\/dialogs\/formatCells"\)/);
  for (const k of ['selection', 'export', 'linked']) assert.ok(ui.includes(`"${k}": () => import(`), k);
  const formats = await import(pathToFileURL(path.join(dir, 'core/generated/grid.formats.mjs')).href);
  assert.deepEqual(Object.keys(formats.formats.csv).sort(), ['read', 'write']);
  const apps = await import(pathToFileURL(path.join(dir, 'core/generated/apps.mjs')).href);
  assert.equal(typeof apps.apps.grid.schema.validateContent, 'function');
  assert.equal(typeof apps.apps.grid.address.parse, 'function');
  assert.equal(apps.apps.quill.schema, undefined, 'missing foundations are skipped');
});

test('icons: the drawing rules are enforced and clean icons are inlined', async () => {
  const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><!-- B --><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"/><rect class="accent" x="4" y="19" width="16" height="2.5" fill="currentColor" stroke="none"/></svg>';
  const r = checkSvg(good);
  assert.deepEqual(r.errors, []);
  assert.match(r.inner, /^<g fill="none" stroke="currentColor"/);
  assert.match(r.inner, /<rect class="accent"/);
  const cases = {
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24"><path d="M1 1"/></svg>': 'root attribute width',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1"/></svg>': 'viewBox="0 0 24 24"',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>x</script></svg>': 'element <script>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><use href="#a"/></svg>': 'element <use>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path id="a" d="M1 1"/></svg>': 'attribute id',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path style="x" d="M1 1"/></svg>': 'attribute style',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path onclick="x" d="M1 1"/></svg>': 'event attribute',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff0000" d="M1 1"/></svg>': 'paint with currentColor',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path class="red" d="M1 1"/></svg>': 'only "accent" and "tone"',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path stroke-width="2" d="M1 1"/></svg>': 'stroke-width must be 1.5',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path stroke-linecap="butt" d="M1 1"/></svg>': 'must be round',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12.3" cy="12" r="4"/></svg>': 'off the half-pixel grid',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1.1 1"/></svg>': 'quarter-pixel grid',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">hello</svg>': 'text content',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g><path d="M1 1"/></svg>': 'unclosed <g>',
  };
  for (const [svg, expected] of Object.entries(cases)) {
    const e = checkSvg(svg).errors.join(' | ');
    assert.ok(e.includes(expected), `${expected} <- ${e}`);
  }
  assert.deepEqual(checkSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path stroke-width="2" d="M1 1"/></svg>', {size: 32}).errors, []);
  const dir = tmpRoot({
    'docs/spec/slate.json': slateSpec,
    'assets/icons/ribbon/bold-B.svg': good,
    'assets/icons/ribbon/grow.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="x.png"/></svg>',
  });
  const out = await generate({root: dir});
  assert.ok(out.errors.some(e => e.startsWith('assets/icons/ribbon/grow.svg: element <image>')));
  const icons = fs.readFileSync(path.join(dir, 'src/generated/icons.ts'), 'utf8');
  assert.match(icons, /"bold-B": \{"d24":"<g fill=\\"none\\"/);
  assert.deepEqual(out.coverage.slate.iconsMissing.map(m => m.icon), ['grow', 'italic-I']);
  assert.equal(out.iconOwners['bold-B'].owner, 'I', 'shared basics belong to the integrator');
  assert.equal(out.iconOwners.grow.owner, 'U:slate/format');
  const owners = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts/coverage/icons.json'), 'utf8'));
  assert.equal(owners['bold-B'].present, true);
});

test('ownership: paths map to the unit that owns them', async () => {
  const {ownership} = await real;
  const o = ownership.ownerOf;
  const cases = {
    'core/kernel/session.mjs': 'I', 'core/common/commands/edit.mjs': 'I', 'scripts/gen/spec.mjs': 'I', 'tests/kernel/x.test.mjs': 'I',
    'core/generated/manifest.json': 'G', 'src/generated/icons.ts': 'G', 'docs/spec/grid.json': 'spec', 'docs/spec/pdf.json': 'spec',
    'core/grid/commands/data.mjs': 'U:grid/data', 'core/grid/commands/format/font.mjs': 'U:grid/format', 'core/grid/commands/_template.mjs': 'I',
    'core/grid/lib/data-sort.mjs': 'U:grid/data', 'core/grid/lib/ranges.mjs': 'F:grid',
    'core/quill/model/blocks.mjs': 'F:quill/model', 'core/quill/layout/flow.mjs': 'F:quill/layout', 'src/apps/quill/surface/PageView.tsx': 'F:quill/surface',
    'core/grid/address.mjs': 'F:grid', 'src/apps/grid/manifest.ts': 'F:grid',
    'core/folio/formats/pdf-read.mjs': 'U:folio/formats-pdf', 'src/apps/grid/panes/selection.tsx': 'U:grid/pane-selection',
    'src/apps/prism/backstage/export.tsx': 'U:prism/backstage-export', 'src/apps/grid/ui-commands/view.ts': 'U:grid/view',
    'docs/spec/layout/quill/home.json': 'U:quill/layout-home', 'docs/spec/patches/grid/data.json': 'U:grid/data',
    'docs/spec/layout/pdf/edit.json': 'U:folio/layout-edit',
    'tests/grid/data-validation.test.mjs': 'U:grid/data', 'tests/quill/upstream/table_style_borders.test.mjs': 'U:quill/table_style',
    'tests/quill/table.test.mjs': 'U:quill/table', 'tests/grid/benchmark.test.mjs': 'F:grid',
    'tests/e2e/grid/data-sort.e2e.mjs': 'U:grid/data', 'tests/e2e/grid/smoke.e2e.mjs': 'U:grid/e2e-smoke', 'tests/e2e/harness.mjs': 'I',
    'core/quill/dialogs/zoom.mjs': 'I', 'docs/requests/grid-data--quill-table--x.md': 'requests:grid-data', 'assets/icons/ribbon/undo.svg': 'I',
  };
  for (const [file, owner] of Object.entries(cases)) assert.equal(o(file), owner, file);
  assert.equal(o('core/grid/dialogs/insertCells.mjs'), ownership.commandOwner('grid', 'home.insertCells'));
  assert.equal(o('src/apps/grid/dialogs/insertCells.tsx'), o('core/grid/dialogs/insertCells.mjs'));
  assert.equal(ownership.commandOwner('quill', 'edit.undo'), 'I', 'common commands belong to the integrator');
  assert.equal(ownership.commandOwner('quill', 'format.bold'), 'U:quill/format');
  assert.equal(ownership.commandOwner('slate', 'clipboard.paste'), 'U:slate/clipboard');
  const check = checkOwnership(ownership, 'grid/data', ['core/grid/commands/data.mjs', 'tests/grid/data.test.mjs', 'core/grid/commands/sheet.mjs', 'core/generated/grid.commands.mjs', 'docs/spec/grid.json']);
  assert.equal(check.unit, 'U:grid/data');
  assert.deepEqual(check.violations.map(v => v.file), ['core/grid/commands/sheet.mjs', 'core/generated/grid.commands.mjs', 'docs/spec/grid.json']);
  assert.equal(checkOwnership(ownership, 'F:quill', ['core/quill/model/a.mjs', 'core/quill/address.mjs']).ok, true);
  assert.equal(checkOwnership(ownership, 'F:quill/model', ['core/quill/layout/a.mjs']).ok, false);
  assert.equal(mayEdit('U:grid/data', 'requests:grid-data'), true);
  assert.equal(mayEdit('U:grid/sheet', 'requests:grid-data'), false);
  // Foundation grants: surface flows, the foundation's surface view commands, F-<app>-- request prefixes.
  const grants = {
    'tests/e2e/grid/surface-render.e2e.mjs': 'F:grid', 'tests/e2e/quill/surface-page-view.e2e.mjs': 'F:quill/surface',
    'tests/e2e/slate/skeleton.e2e.mjs': 'I', 'src/apps/folio/ui-commands/surface.ts': 'F:folio',
    'src/apps/quill/ui-commands/surface.ts': 'F:quill/surface', 'docs/requests/F-folio--integrator--x.md': 'requests:F-folio',
  };
  for (const [file, owner] of Object.entries(grants)) assert.equal(o(file), owner, file);
  assert.equal(mayEdit('F:folio', 'requests:F-folio'), true);
  assert.equal(mayEdit('F:quill/surface', 'requests:F-quill-surface'), true);
  assert.equal(mayEdit('F:quill', 'requests:F-quill-surface'), true);
  assert.equal(mayEdit('F:grid', 'requests:F-folio'), false);
  assert.equal(mayEdit('U:quill/layout-home', 'requests:U-quill-layout-home'), true);
  assert.equal(checkOwnership(ownership, 'F:grid', ['tests/e2e/grid/surface-render.e2e.mjs', 'docs/requests/F-grid--integrator--y.md']).ok, true);
  // Icons go to the family that owns the control's command, else the app's icons unit; layout units draw none.
  const {iconOwners} = await real;
  const layoutOwned = Object.entries(iconOwners).filter(([, v]) => /\/layout-/.test(v.owner)).map(([id]) => id);
  assert.deepEqual(layoutOwned, []);
  assert.equal(ownership.iconOwner('quill', {id: 'x', command: 'format.bold'}), 'U:quill/format');
  assert.equal(ownership.iconOwner('quill', {id: 'x', items: [{id: 'y', command: 'format.bold'}]}), 'U:quill/format');
  assert.equal(ownership.iconOwner('quill', {id: 'x'}), 'U:quill/icons');
  assert.equal(normalizeUnit('integrator'), 'I');
  assert.equal(normalizeUnit('U:pdf/edit'), 'U:folio/edit');
  assert.throws(() => normalizeUnit('nonsense'), /Unrecognized unit/);
});

test('--check-ownership exits non-zero when a change touches another owner', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/generate.mjs'), '--check-ownership', ...args], {cwd: root, encoding: 'utf8'});
  const ok = run('U:grid/data', '--files', 'core/grid/commands/data.mjs', 'tests/grid/data.test.mjs');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ownership ok/);
  const bad = run('U:grid/data', '--files', 'core/grid/commands/data.mjs,core/kernel/session.mjs');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not yours: core\/kernel\/session\.mjs \(owner I\)/);
  assert.equal(run('U:grid/data').status, 2);
});

test('the real tree generates cleanly and quickly', async () => {
  const r = await real;
  assert.deepEqual(r.errors, []);
  // Timed on a run of its own: `real` starts at import, and the ownership test's spawnSync runs of the
  // generator block this file's event loop while it is in flight, so its own `ms` counts their time too.
  // About 3 s alone; npm test runs every file in parallel on the same cores, so allow for that load.
  const timed = await generate({root, check: true});
  assert.ok(timed.ms < 25_000, `${timed.ms} ms`);
  for (const app of APPS) assert.ok(r.coverage[app].counts.controls > 100, app);
});
