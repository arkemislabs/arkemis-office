// The skeleton families over /v2/rpc on documents no window has open: the headless host runs each
// command by id, writes the result to the store with its revision check, and undo restores it.
// Quill, Grid, Prism, Slate and PDF run on schema 2 (documents.create makes schema 2 for an app the new host
// edits; they are switched on).
import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestBridge} from './helpers.mjs';

const flows = [
  {kind: 'quill', command: 'format.bold', params: {}},
  {kind: 'grid', command: 'home.bold', params: {range: 'A1:B2'}, read: sheet => `${sheet}/B2`, as: 'props', applied: v => v?.bold === true,
    persisted: c => Object.keys(c.styles ?? {}).length > 0},
  {kind: 'prism', command: 'slide.new', params: {layout: 'titleOnly', title: 'Headless'}, read: () => '/', as: 'json',
    applied: v => (v?.slides ?? v?.content?.slides ?? []).length === 2, persisted: c => c.slides.length === 2},
  {kind: 'slate', command: 'section.new', params: {name: 'Headless'}, read: '/sec:Headless', applied: v => v?.name === 'Headless',
    persisted: c => Object.values(c.sections ?? {}).some(sec => sec.name === 'Headless')},
];

test('every skeleton family runs headless over /v2/rpc, persists, and undoes', async () => {
  const t = await startTestBridge({newHost: k => ['quill', 'grid', 'prism', 'slate', 'folio'].includes(k)});
  try {
    for (const flow of flows) {
      const {doc} = await t.rpc('documents.create', {kind: flow.kind, title: `${flow.kind} headless`});
      assert.equal((await t.store.get(doc)).schema, ['quill', 'grid', 'prism', 'slate'].includes(flow.kind) ? 2 : 1, `${flow.kind}: documents.create schema`);
      const listed = await t.rpc('engine.commands', {doc, search: flow.command});
      assert.ok(listed.commands.some(c => c.id === flow.command && c.enabled), `${flow.kind}: ${flow.command} listed and enabled`);
      const run = await t.rpc('engine.execute', {doc, command: flow.command, params: flow.params});
      if (flow.kind === 'quill') {
        // An empty document has only a caret: Bold becomes pending typing formatting, not an edit.
        assert.equal(run.result.pending, true);
        continue;
      }
      assert.match(run.undoLabel, /^Automation: /, `${flow.kind}: bridge undo label`);
      const sheet = flow.kind === 'grid' ? (await t.rpc('document.inspect', {doc})).nodes.find(n => n.address.startsWith('/sh:')).address : null;
      const read = await t.rpc('document.read', {doc, address: typeof flow.read === 'function' ? flow.read(sheet) : flow.read, ...(flow.as ? {as: flow.as} : {})});
      assert.ok(flow.applied(read.value), `${flow.kind}: read back ${JSON.stringify(read.value).slice(0, 200)}`);
      const stored = await t.store.get(doc);
      assert.ok(flow.persisted(stored.content), `${flow.kind}: written to the store`);
      const undo = await t.rpc('engine.execute', {doc, command: 'edit.undo'});
      assert.equal(undo.result.undone, 1);
      const after = await t.rpc('document.read', {doc, address: flow.read}).catch(e => ({missing: e.code}));
      assert.ok(after.missing === 'not_found' || !flow.applied(after.value), `${flow.kind}: undone`);
    }
    // A PDF with no pages: Rotate is disabled with printcraft's reason, over the bridge too.
    const {doc} = await t.rpc('documents.create', {kind: 'folio', title: 'empty'});
    await assert.rejects(t.rpc('engine.execute', {doc, command: 'page.rotate', params: {}}), e => e.code === 'disabled' && e.message === 'no PDF open');
  } finally {
    await t.close();
  }
});

test('a schema-1 document opened by the new host is converted with its migrate.mjs and saved as schema 2', async () => {
  const {createFile} = await import('../../core/model.mjs');
  const t = await startTestBridge({newHost: k => k === 'quill'});
  try {
    const old = createFile('quill', 'Older letter');
    old.content.doc = {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'Dear reader,'}]}]};
    const seeded = await t.store.save(old);
    assert.equal(seeded.schema, 1);
    const body = await t.rpc('document.read', {doc: old.id, address: '/body', as: 'json'});
    assert.match(JSON.stringify(body.value), /Dear reader/);
    // An edit persists the converted document (schema 2) with the change.
    const first = (Array.isArray(body.value) ? body.value[0] : body.value.chunks?.[0]?.[0])?.id;
    assert.ok(first, JSON.stringify(body.value).slice(0, 300));
    await t.rpc('selection.set', {doc: old.id, ranges: [{anchor: `/body/b:${first}/t:0`, focus: `/body/b:${first}/t:4`}]});
    await t.rpc('engine.execute', {doc: old.id, command: 'format.bold', params: {}});
    const stored = await t.store.get(old.id);
    assert.equal(stored.schema, 2);
    assert.match(JSON.stringify(stored.content), /"bold":true/);
  } finally {
    await t.close();
  }
});
