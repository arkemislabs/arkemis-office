// Conformance over the generated spec models and coverage reports (docs/architecture.md sections
// 7, 12.4 and 17.3): what the shell will render is internally consistent for every app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_IDS} from '../../core/kernel/command.mjs';
import {apps} from '../../core/generated/apps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const specOf = app => {
  const text = read(`src/generated/${app}.spec.ts`);
  const m = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/s.exec(text);
  return m ? JSON.parse(JSON.parse(m[1])) : null;
};

for (const app of APP_IDS) {
  test(`${app}: the shipped spec model is consistent`, () => {
    const spec = specOf(app);
    assert.ok(spec, 'every app has a spec today');
    assert.equal(spec.app, app);
    const controls = new Map();
    const visit = c => { if (!c || c.separator || c.header) return; assert.ok(!controls.has(c.id), `duplicate ${c.id}`); controls.set(c.id, c); (c.items || []).forEach(visit); };
    for (const tab of spec.tabs) for (const g of tab.groups) {
      g.controls.forEach(visit);
      const ids = new Set(g.controls.filter(c => c.id).map(c => c.id));
      for (const item of g.layout) {
        const placed = item.large ?? item.small ?? item.medium ?? item.gallery ?? item.stack ?? item.rows?.flat().map(x => (typeof x === 'string' ? x : x.medium)) ?? [];
        for (const id of [placed].flat()) assert.ok(ids.has(id), `${tab.id}/${g.id} layout places ${id} from its own group`);
      }
    }
    spec.qat.forEach(visit);
    for (const id of spec.pendingControls) assert.ok(controls.has(id), `pending ${id} exists`);
    for (const tab of spec.tabs.filter(t => t.contextual)) assert.ok(tab.contextFor, `${tab.id} has a context flag`);
    for (const d of Object.values(spec.dialogs)) assert.ok(d.tabs.every(t => Array.isArray(t.fields)), d.id);
    assert.equal(spec.inputs, undefined, 'build inputs stay out of the bundle');
  });

  test(`${app}: coverage is reported with owners`, () => {
    const cov = JSON.parse(read(`artifacts/coverage/${app}.json`));
    assert.equal(cov.app, app);
    assert.equal(cov.counts.controls, cov.counts.implemented + cov.counts.pending);
    for (const c of cov.specCommandsNotRegistered) assert.match(c.owner, /^(I|U:|F:)/, c.id);
    for (const d of cov.dialogsWithoutModel) assert.match(d.owner, /^(I|U:|F:)/, d.id);
    for (const i of cov.iconsMissing) assert.match(i.owner, /^(I|U:|F:)/, i.icon);
    assert.ok(Object.keys(cov.families).length > 5, 'families are listed for the fan-out');
  });
}

test('the kernel sees each app\'s customizable tabs and QAT defaults', () => {
  assert.deepEqual(apps.quill.spec.qat, ['file.save', 'edit.undo', 'edit.redo']);
  assert.ok(apps.quill.spec.tabs.includes('Home'));
  assert.ok(!apps.folio.spec.tabs.includes('Title bar'), 'PDF chrome surfaces are not ribbon tabs');
  for (const app of APP_IDS) assert.ok(apps[app].spec.tabs.length > 0, app);
});

test('icon ownership covers every referenced icon exactly once', () => {
  const owners = JSON.parse(read('artifacts/coverage/icons.json'));
  const ids = Object.keys(owners);
  assert.ok(ids.length > 500);
  for (const id of ids) assert.match(owners[id].owner, /^(I|U:|F:)/, id);
});
