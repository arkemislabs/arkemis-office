// Ribbon icons, check boxes and drawn menus in the real window (design review, 2026-10-30: ribbon controls
// and menus showed text where Office shows icons; Shapes was a text list). Each app's ribbon tabs and
// the menus Office draws (Shapes, Align, Rotate, Borders, line weights and dashes) are opened through
// the bridge (ui.tab, ui.menu) and captured with ui.capture into artifacts/e2e/shell/ribbon-visuals/.
// The spec-side guarantee (every ribbon button has an icon file) is tests/shell/ribbon-icons.test.mjs.
//
//   npm run build && node --test tests/e2e/shell/ribbon-visuals.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';

const FLOWS = [
  {product: 'quill', steps: [['context', 'selection'], ['tab', 'insert'], ['menu', 'insert.illustrations.shapes'], ['tab', 'layout'], ['tab', 'view']]},
  {product: 'grid', steps: [['context', 'cell'], ['context', 'columnHeader'], ['context', 'sheetTab'], ['tab', 'home'], ['menu', 'home.font.borders'], ['tab', 'page-layout'], ['tab', 'view']]},
  {product: 'prism', steps: [['context', 'slide-thumbnail'], ['context', 'slide-canvas'], ['tab', 'home'], ['menu', 'home.drawing.arrange'], ['tab', 'insert'], ['menu', 'insert.illustrations.shapes'], ['tab', 'transitions'], ['tab', 'slide-show'], ['tab', 'view']]},
];

for (const flow of FLOWS) {
  test(`${flow.product}: ribbon icons and drawn menus`, {timeout: 240_000}, async () => {
    const renderer = await devRenderer({newHost: true});
    const app = await launchApp({product: flow.product, flow: `shell/ribbon-visuals/${flow.product}`, renderer});
    try {
      await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000});
      const {doc} = await app.rpc('documents.create', {});
      await app.rpc('documents.open', {doc, show: true});
      const first = await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000});
      const tabs = new Set(first.tabs.map(t => t.id ?? t));
      let tab = null;
      for (const [kind, id] of flow.steps) {
        if (kind === 'context') {
          // Right-click menu by target (ui.contextMenu): what it lists is implemented, and it draws at the point.
          const menu = await app.rpc('ui.contextMenu', {doc, target: id, x: 420, y: 330});
          assert.ok(menu.items.length > 0, `${id} lists entries`);
          assert.ok(menu.items.every(i => i.command || i.dialog || i.submenu), `${id}: every entry runs something or opens a submenu`);
          await app.capture(`context-${id}`);
          await app.rpc('ui.contextMenu', {doc, open: false});
          continue;
        }
        if (kind === 'tab') {
          // A tab whose commands are not translated yet is hidden in production: nothing to capture.
          if (!tabs.has(id)) { tab = null; continue; }
          await app.rpc('ui.tab', {doc, id});
          tab = id;
          await app.capture(`tab-${id}`);
        } else {
          const ctl = (await app.rpc('ui.inspect', {doc})).controls?.find(c => c.id === id || c.id.endsWith(`.${id.split('.').pop()}`) && c.id.startsWith(tab));
          if (!tab) continue;
          assert.ok(ctl, `${id} is on the ${tab} tab`);
          const r = await app.rpc('ui.menu', {doc, control: ctl.id});
          assert.equal(r.menu, ctl.id);
          await app.capture(`menu-${ctl.id}`);
          await app.rpc('ui.menu', {doc, control: ctl.id, open: false});
        }
      }
    } catch (e) {
      throw new Error(`${e.message}\n--- app log ---\n${app.log.slice(-40).join('')}`);
    } finally {
      await app.close();
    }
  });
}
