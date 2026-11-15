// Conformance over the generated registry (docs/architecture.md section 17.3). Driven by
// core/generated/manifest.json and the generated per-app indexes, so every command any unit adds is
// checked without editing this file. Spec commands not yet implemented are reported in
// artifacts/coverage/<app>.json, not failed here (until a --strict release).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate} from '../../scripts/generate.mjs';
import {buildRegistry} from '../../core/kernel/registry.mjs';
import {createSession} from '../../core/kernel/session.mjs';
import {createTestHost} from '../../core/kernel/host.mjs';
import {isSchema, toJSONSchema, validate} from '../../core/kernel/schema.mjs';
import {RISKS} from '../../core/kernel/risk.mjs';
import {APP_IDS, EFFECTS} from '../../core/kernel/command.mjs';
import {validateDialog} from '../../core/kernel/dialog.mjs';
import {fixedArgs} from '../../scripts/gen/coverage.mjs';
import {walkControls} from '../../scripts/gen/spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'core/generated/manifest.json'), 'utf8'));
const indexes = Object.fromEntries(await Promise.all(APP_IDS.map(async app => [app, {
  commands: await import(`../../core/generated/${app}.commands.mjs`),
  dialogs: await import(`../../core/generated/${app}.dialogs.mjs`),
}])));
const generated = generate({root, check: true});

/** Text of every test file, to prove each command id is exercised somewhere. */
function testCorpus() {
  const out = [];
  const visit = dir => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') visit(full); }
      else if (/\.(test|e2e)\.mjs$/.test(e.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  visit(path.join(root, 'tests'));
  return out.join('\n');
}

test('the manifest lists every registered command with its contract', () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.apps, APP_IDS);
  assert.ok(manifest.commands.length > 0);
  for (const c of manifest.commands) {
    const at = `${c.app}:${c.id}`;
    assert.ok(typeof c.label === 'string' && c.label.trim(), `${at} has a label`);
    assert.ok(RISKS.includes(c.risk), `${at} has a risk`);
    assert.ok(EFFECTS.includes(c.effect), `${at} has an effect`);
    assert.equal(c.params?.type, 'object', `${at} params compile to an object JSON Schema`);
    assert.equal(typeof c.params.properties, 'object', `${at} params list properties`);
    assert.ok(Array.isArray(c.ribbon), `${at} lists its ribbon paths`);
    assert.ok(c.source && fs.existsSync(path.join(root, c.source)), `${at} names its module`);
    assert.ok(c.upstream?.repo, `${at} names its upstream`);
    if (c.risk === 'edit' && c.effect === 'content') assert.equal(c.undo, 'auto', `${at}: content edits are undoable`);
    if (c.undo === 'none' && c.risk === 'edit') assert.ok(['view', 'persist', 'prefs'].includes(c.effect), `${at}: only view, persistence and prefs skip undo`);
    assert.notEqual(c.needs, 'view', `${at}: view commands live in src/apps/<app>/ui-commands`);
  }
});

test('registry modules honour the contract at runtime', () => {
  for (const app of APP_IDS) {
    const {modules, sources} = indexes[app].commands;
    assert.equal(modules.length, sources.length);
    const registry = buildRegistry(modules, {app, sources});
    for (const c of registry.list()) {
      const at = `${app}:${c.id}`;
      assert.ok(isSchema(c.params), `${at} params is a schema`);
      assert.doesNotThrow(() => JSON.stringify(toJSONSchema(c.params)), at);
      assert.equal(typeof c.run, 'function', at);
      if (c.risk === 'destructive' || c.risk === 'irreversible' || c.riskFor) assert.equal(typeof c.summary, 'function', `${at} implements summary()`);
      if (c.state) assert.equal(typeof c.state, 'function', at);
    }
  }
});

test('every command id appears in at least one test file', () => {
  const corpus = testCorpus();
  const missing = [...new Set(manifest.commands.map(c => c.id))].filter(id => !corpus.includes(id));
  assert.deepEqual(missing, [], `commands without a test: ${missing.join(', ')}`);
});

test('every dialog model is well formed and every spec dialog with a registered submit command has a model', async () => {
  const {models} = await generated;
  const problems = [];
  for (const app of APP_IDS) {
    const dialogs = indexes[app].dialogs.dialogs;
    for (const [id, d] of Object.entries(dialogs)) {
      assert.deepEqual(validateDialog(d), [], `${app}:${id}`);
      assert.equal(d.id, id);
    }
    const model = models.get(app);
    if (!model) continue;
    const registered = new Set(indexes[app].commands.modules.flatMap(m => m.commands.map(c => c.id)));
    for (const d of Object.values(model.dialogs)) {
      if (d.command && registered.has(d.command) && !dialogs[d.id]) problems.push(`${app}:${d.id} (submit ${d.command})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('spec control args validate against their registered command params', async () => {
  const {models, coverage} = await generated;
  for (const app of APP_IDS) {
    assert.deepEqual(coverage[app].argProblems ?? [], [], app);
    const model = models.get(app);
    if (!model) continue;
    const registry = buildRegistry(indexes[app].commands.modules, {app});
    walkControls(model.tabs, c => {
      const cmd = c.command && c.args && registry.get(c.command);
      if (cmd) assert.equal(validate(cmd.params, fixedArgs(c.args), {partial: true}).ok, true, `${app}:${c.id}`);
    });
  }
});

test('every registered command runs headless far enough to answer state() without throwing', () => {
  for (const app of APP_IDS) {
    const registry = buildRegistry(indexes[app].commands.modules, {app});
    const session = createSession({app, registry, host: createTestHost()});
    session.open({id: 'conformance', schema: 2, kind: app, title: 'Conformance', revision: 0, content: {}});
    for (const id of registry.ids()) {
      const st = session.state('conformance', id);
      assert.equal(typeof st.enabled, 'boolean', `${app}:${id}`);
    }
  }
});

test('the generator reports no errors for the tree as committed', async () => {
  const r = await generated;
  assert.deepEqual(r.errors, []);
});
