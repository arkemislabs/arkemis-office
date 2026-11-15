// The scaffold's end-to-end proof, shared by tests/e2e/<app>/skeleton.e2e.mjs: one command family
// per app runs from the bridge (/v2/rpc engine.execute on a document by id, with addresses), is
// read back through the bridge (document.read), shows in the ribbon state (ui.inspect), is undone
// (edit.undo), runs again from its ribbon control (ui.activate), its shortcut (ui.key, through
// KeyRouter) or the surface's own input (ui.pointer / ui.type, routed to the surface handle), and
// the window is captured (ui.capture → webContents.capturePage) to artifacts/skeleton/<app>.png.
// Seeds are schema-2 documents (the new host converts older ones when it opens them). The app runs
// with the new shell compiled in (devRenderer) in test mode: inactive, non-focusable windows; no
// pointer, keyboard or OS input.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {devRenderer, launchApp, root} from './harness.mjs';

const OUT = path.join(root, 'artifacts', 'skeleton');

/**
 * @param {{
 *   app: string, product?: string, seed: object, tab?: string,
 *   setup?: (ctx: {app: any, doc: string}) => Promise<void>,
 *   command: string, params?: object, undoLabel: string,
 *   control?: string, keys?: string, checked?: boolean,
 *   again?: (ctx: {app: any, doc: string}) => Promise<string>,
 *   read: string, as?: string, applied: (value: any) => boolean,
 * }} flow
 *   again: step 5 through the surface's own input (ui.pointer / ui.type) instead of a control or keys;
 *   returns what it did, for the step log.
 */
export async function runSkeleton(flow) {
  const product = flow.product ?? flow.app;
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product, flow: `${flow.app}/skeleton`, files: [flow.seed], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const steps = [];
  const step = (name, detail) => steps.push(detail === undefined ? name : `${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  try {
    const doc = flow.seed.id;
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => {
      const ui = await app.rpc('ui.inspect', {doc});
      return ui.doc?.id === doc && ui.tabs?.length && Object.keys(ui.levels ?? {}).length ? ui : null;
    }, {timeout: 45_000}).catch(e => { throw new Error(e.message + log()); });
    step('opened in the new shell');

    if (flow.setup) await flow.setup({app, doc});
    // No tab: stay on the first visible one (an app whose family has no ribbon control yet).
    if (flow.tab) await app.rpc('ui.tab', {doc, id: flow.tab});
    step('ribbon tabs', (await app.rpc('ui.inspect', {doc})).tabs);
    const inspectControl = async () => {
      const ui = await app.rpc('ui.inspect', {doc});
      return flow.control ? ui.controls.find(c => c.id === flow.control) ?? null : null;
    };
    if (flow.control) {
      const before = await app.until(inspectControl, {timeout: 15_000})
        .catch(() => { throw new Error(`control ${flow.control} is not on the ${flow.tab} tab`); });
      assert.equal(before.enabled, true, `${flow.control} is enabled`);
      assert.equal(before.pending, false, `${flow.control} is implemented`);
      if (flow.checked !== undefined) assert.equal(before.checked, false, `${flow.control} starts unchecked`);
      step('ribbon control before', {id: before.id, enabled: before.enabled, checked: before.checked});
    }

    // 1. The bridge runs the command by id on the document (address params / selection).
    const listed = await app.rpc('engine.commands', {doc, search: flow.command});
    const entry = listed.commands.find(c => c.id === flow.command);
    assert.ok(entry, `${flow.command} is listed by engine.commands`);
    assert.equal(entry.enabled, true);
    const v0 = (await app.rpc('ui.inspect', {doc})).doc.version;
    const run = await app.rpc('engine.execute', {doc, command: flow.command, params: flow.params ?? {}, baseVersion: v0});
    assert.equal(run.undoLabel, flow.undoLabel);
    assert.equal(run.version, v0 + 1);
    step('engine.execute', {command: flow.command, params: flow.params ?? {}, version: run.version, undoLabel: run.undoLabel, changed: run.changed});

    // 2. Read back through the bridge.
    const readBack = () => app.rpc('document.read', {doc, address: flow.read, ...(flow.as ? {as: flow.as} : {})});
    let read = await readBack();
    assert.ok(flow.applied(read.value), `document.read ${flow.read} shows the change: ${JSON.stringify(read.value).slice(0, 300)}`);
    step('document.read after run', {address: read.address, version: read.version});

    // 3. The ribbon state follows.
    if (flow.control && flow.checked !== undefined) {
      await app.until(async () => (await inspectControl())?.checked === flow.checked || null, {timeout: 10_000});
      step('ribbon state after run', {checked: flow.checked});
    }

    // 4. Undo through the bridge restores it.
    const undo = await app.rpc('engine.execute', {doc, command: 'edit.undo'});
    assert.equal(undo.result.undone, 1);
    read = await readBack();
    assert.ok(!flow.applied(read.value), `undo reverted ${flow.read}: ${JSON.stringify(read.value).slice(0, 300)}`);
    if (flow.control && flow.checked !== undefined) await app.until(async () => (await inspectControl())?.checked === false || null, {timeout: 10_000});
    step('edit.undo', {version: undo.version, labels: undo.result.labels});

    // 5. The ribbon control, the shortcut (through KeyRouter) or the surface's own input runs it again.
    if (flow.again) {
      step('surface input', await flow.again({app, doc}));
    } else if (flow.control) {
      await app.rpc('ui.activate', {doc, control: flow.control});
      step('ui.activate', flow.control);
    } else {
      await app.rpc('ui.key', {doc, keys: flow.keys});
      step('ui.key', flow.keys);
    }
    read = await app.until(async () => {
      const r = await readBack();
      return flow.applied(r.value) ? r : null;
    }, {timeout: 10_000});
    if (flow.control && flow.checked !== undefined) await app.until(async () => (await inspectControl())?.checked === flow.checked || null, {timeout: 10_000});
    const ui = await app.rpc('ui.inspect', {doc});
    const undoQat = ui.qat.find(c => c.command === 'edit.undo');
    step('after the ribbon/shortcut run', {version: read.version, undoEnabled: undoQat?.enabled ?? null});

    // 6. Evidence: the window with the change applied and its control state showing.
    await fs.mkdir(OUT, {recursive: true});
    const shot = await app.rpc('ui.capture', {doc});
    const file = path.join(OUT, `${flow.app}.png`);
    await fs.writeFile(file, Buffer.from(shot.png, 'base64'));
    step('ui.capture', `${path.relative(root, file)} ${shot.width}x${shot.height}`);

    // 7. Undo again: the person's and the bridge's edits share one stack.
    const again = await app.rpc('engine.execute', {doc, command: 'edit.undo'});
    assert.equal(again.result.undone, 1);
    read = await readBack();
    assert.ok(!flow.applied(read.value), 'the second undo reverted the ribbon run');
    const redo = await app.rpc('engine.execute', {doc, command: 'edit.redo'});
    assert.equal(redo.result.redone, 1);
    read = await readBack();
    assert.ok(flow.applied(read.value), 'redo brought it back');
    step('edit.undo + edit.redo', {version: redo.version});
    await fs.writeFile(path.join(OUT, `${flow.app}.txt`), steps.join('\n') + '\n');
    return {steps, shot: file};
  } catch (e) {
    await fs.mkdir(OUT, {recursive: true}).catch(() => {});
    await fs.writeFile(path.join(OUT, `${flow.app}.txt`), [...steps, `FAILED: ${e?.stack ?? e}`, log()].join('\n') + '\n').catch(() => {});
    throw e;
  } finally {
    await app.close();
  }
}
