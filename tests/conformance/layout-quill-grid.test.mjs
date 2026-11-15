// Ribbon layout overlays for Quill and Grid (docs/architecture.md sections 7.3 and 8.4): every
// ribbon tab, contextual ones included, has an overlay; every id an overlay names exists in the
// spec; every control is placed exactly once (nothing falls back to the "unplaced" small control);
// keytips are unique and prefix-free per tab.
//
// Ported upstream tests (data assertions over the overlays, since the geometry now lives in JSON):
//   wordcraft aadb077e072b7de05f724e359d8db82e151f125c crates/ui-egui/src/keytips/tests.rs
//     tab_letters_match_word, letters_are_unique_inside_every_tab, alt_j_t_and_alt_j_l_open_the_table_tabs
//   wordcraft crates/ui-egui/src/ribbon/tests.rs design_style_set_gallery_stays_in_its_box
//     (STYLE_SETS has seven tiles) and previews.rs STYLE_TILES (six Styles tiles)
//   gridcraft 146161b4b450a56e5e59a083ba0478582d1e602b crates/ui-egui/src/keytips/keytip_table.rs
//     tab_letters_exist_for_standard_tabs, control_badges_require_a_known_prefix
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSpecModel, walkControls} from '../../scripts/gen/spec.mjs';
import {Report} from '../../scripts/gen/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPS = ['quill', 'grid'];
const PRIMITIVES = ['large', 'medium', 'small', 'stack', 'rows', 'gallery', 'separator'];
const layoutDir = app => path.join(root, 'docs/spec/layout', app);
const overlayOf = (app, tab) => JSON.parse(fs.readFileSync(path.join(layoutDir(app), `${tab}.json`), 'utf8'));
const placedIds = item => {
  const k = Object.keys(item).find(x => PRIMITIVES.includes(x));
  if (k === 'separator') return [];
  if (k === 'stack') return item.stack;
  if (k === 'rows') return item.rows.flat().map(x => (typeof x === 'string' ? x : x.medium));
  return [item[k]];
};
const prefixFree = tips => tips.every((a, i) => tips.every((b, j) => i === j || !b.startsWith(a)));

const models = new Map();
const reports = new Map();
for (const app of APPS) {
  const report = new Report();
  models.set(app, buildSpecModel(root, app, report));
  reports.set(app, report);
}

for (const app of APPS) {
  const model = models.get(app);
  const report = reports.get(app);

  test(`${app}: the generator accepts every layout overlay without errors`, () => {
    const mine = report.errors.filter(e => e.includes(`docs/spec/layout/${app}/`));
    assert.deepEqual(mine, []);
  });

  test(`${app}: every ribbon tab, contextual ones included, has an overlay`, () => {
    assert.ok(model.tabs.length > 0);
    for (const tab of model.tabs) {
      assert.ok(fs.existsSync(path.join(layoutDir(app), `${tab.id}.json`)), `docs/spec/layout/${app}/${tab.id}.json`);
      assert.equal(tab.layoutSource, `docs/spec/layout/${app}/${tab.id}.json`, `${tab.id} takes its geometry from the overlay`);
    }
    const files = fs.readdirSync(layoutDir(app)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    for (const f of files) assert.ok(model.tabs.some(t => t.id === f), `overlay ${f}.json names a tab of the spec`);
  });

  for (const tab of model.tabs) {
    test(`${app}/${tab.id}: overlay ids exist in the spec and every control is placed once`, () => {
      const overlay = overlayOf(app, tab.id);
      assert.equal(overlay.tab, tab.id);
      assert.match(String(overlay.source ?? ''), /(wordcraft|gridcraft) [0-9a-f]{40} crates\/|Microsoft (Word|Excel) for Windows/, 'source names the upstream file and commit, or the Office app');
      const tabControls = new Map();
      walkControls([tab], c => tabControls.set(c.id, c));
      assert.deepEqual(Object.keys(overlay.groups).sort(), tab.groups.map(g => g.id).sort(), 'one entry per group of the tab');
      for (const g of tab.groups) {
        const og = overlay.groups[g.id];
        const ids = new Set(g.controls.filter(c => c.id).map(c => c.id));
        const seen = new Set();
        assert.ok(Array.isArray(og.layout) && og.layout.length > 0, `${g.id} has a layout`);
        assert.ok(Number.isFinite(og.collapseOrder), `${g.id} has a collapseOrder`);
        for (const item of og.layout) {
          const keys = Object.keys(item).filter(k => PRIMITIVES.includes(k));
          assert.equal(keys.length, 1, `${g.id}: ${JSON.stringify(item)} uses one primitive`);
          if (item.stack) assert.ok(item.stack.length >= 1 && item.stack.length <= 3, `${g.id}: a stack holds one to three controls`);
          if (item.rows) assert.ok(item.rows.length >= 1 && item.rows.length <= 3 && item.rows.every(r => r.length > 0), `${g.id}: one to three non-empty rows`);
          if (item.gallery) {
            assert.equal(tabControls.get(item.gallery)?.type, 'gallery', `${item.gallery} placed as a gallery is a gallery`);
            assert.ok(Number.isInteger(item.columns) && item.columns > 0, `${item.gallery} says how many tiles show`);
          }
          for (const id of placedIds(item)) {
            assert.ok(ids.has(id), `${g.id} places ${id}, a control of that group`);
            assert.ok(!seen.has(id), `${g.id} places ${id} once`);
            seen.add(id);
          }
        }
        assert.deepEqual([...ids].filter(id => !seen.has(id)), [], `${g.id}: every control is placed`);
        assert.ok(!g.layout.some(it => it.unplaced), `${g.id}: nothing falls back to an unplaced small control`);
        for (const id of Object.keys(og.widths ?? {})) {
          assert.ok(ids.has(id), `${g.id} widths name ${id}, a control of that group`);
          assert.ok(['combo', 'spinner'].includes(tabControls.get(id).type), `${id} with a width is a field`);
        }
      }
      const orders = Object.values(overlay.groups).map(g => g.collapseOrder);
      assert.equal(new Set(orders).size, orders.length, 'collapse orders are distinct, so the shrink order is fixed');
      for (const id of Object.keys(overlay.keytips ?? {})) assert.ok(tabControls.has(id), `keytip names ${id}, a control of this tab`);
    });

    test(`${app}/${tab.id}: keytips are unique and prefix-free`, () => {
      const overlay = overlayOf(app, tab.id);
      const tips = [...Object.values(overlay.keytips ?? {}), ...Object.values(overlay.groups).map(g => g.keytip).filter(Boolean)];
      for (const k of tips) assert.match(k, /^[A-Z0-9]{1,3}$/, `keytip ${k}`);
      assert.equal(new Set(tips).size, tips.length, `unique: ${tips.join(' ')}`);
      assert.ok(prefixFree(tips), `prefix-free: ${tips.join(' ')}`);
    });
  }
}

test('quill: tab letters match Word (wordcraft keytips/tests.rs tab_letters_match_word, alt_j_t_and_alt_j_l)', () => {
  const want = {home: 'H', insert: 'N', draw: 'D', design: 'G', layout: 'P', references: 'S', mailings: 'M', review: 'R', view: 'W', help: 'Y',
    'table-design': 'JT', 'table-layout': 'JL'};
  for (const [tab, letter] of Object.entries(want)) {
    assert.equal(overlayOf('quill', tab).keytip, letter, tab);
    assert.equal(models.get('quill').tabs.find(t => t.id === tab).keytip, letter, `${tab} after the overlay`);
  }
  const letters = Object.values(want);
  assert.equal(new Set(letters).size, letters.length);
  assert.ok(!letters.includes('F') && !letters.includes('Q'), 'File and Search keep F and Q');
});

test('quill: gallery tile counts follow wordcraft (STYLE_TILES 6, STYLE_SETS 7)', () => {
  const home = overlayOf('quill', 'home').groups.styles.layout.find(i => i.gallery === 'home.styles.styles');
  assert.equal(home.columns, 6);
  assert.equal(home.inline, true);
  const sets = overlayOf('quill', 'design').groups['document-formatting'].layout.find(i => i.gallery === 'design.document-formatting.style-set');
  assert.equal(sets.columns, 7);
});

test('quill: Home Clipboard is Paste large beside Cut/Copy/Format Painter, as wordcraft home.rs draws it', () => {
  const clip = overlayOf('quill', 'home').groups.clipboard.layout;
  assert.deepEqual(clip, [{large: 'home.clipboard.paste'}, {stack: ['home.clipboard.cut', 'home.clipboard.copy', 'home.clipboard.format-painter']}]);
  const font = overlayOf('quill', 'home').groups.font.layout[0].rows;
  assert.equal(font.length, 2, 'Font is two rows');
  assert.equal(font[0][0], 'home.font.font');
});

const gridTable = JSON.parse(fs.readFileSync(path.join(root, 'docs/spec/grid.json'), 'utf8')).keytips;

test('grid: tab letters exist for the standard tabs (gridcraft keytip_table.rs tab_letters_exist_for_standard_tabs)', () => {
  const tabLetters = new Map(gridTable.filter(e => e.entry === 'Tab' && !/Legacy/.test(e.note ?? '')).map(e => [e.tab, e.keys]));
  for (const tab of models.get('grid').tabs) {
    const letter = tabLetters.get(tab.label);
    if (!letter) continue;
    assert.equal(overlayOf('grid', tab.id).keytip, letter, tab.id);
  }
  for (const t of ['Home', 'Insert', 'Page Layout', 'Formulas', 'Data', 'Review', 'View']) assert.ok(tabLetters.has(t), t);
});

test('grid: every control keytip leads into the keytip table (control_badges_require_a_known_prefix)', () => {
  for (const tab of models.get('grid').tabs) {
    const overlay = overlayOf('grid', tab.id);
    if (!overlay.keytips) continue;
    for (const [id, k] of Object.entries(overlay.keytips)) {
      const full = overlay.keytip + k;
      assert.ok(gridTable.some(e => e.entry !== 'Tab' && e.keys.startsWith(full)), `${tab.id}: ${id} ${full} is a sequence of keytips.json`);
    }
  }
});

test('grid: Home follows gridcraft home.rs (icon-only clipboard column, 150/52 px font fields, 150 px number format)', () => {
  const home = overlayOf('grid', 'home');
  assert.deepEqual(home.groups.clipboard.layout[1], {rows: [['home.clipboard.cut'], ['home.clipboard.copy'], ['home.clipboard.formatPainter']]});
  assert.deepEqual(home.groups.font.widths, {'home.font.name': 150, 'home.font.size': 52});
  assert.deepEqual(home.groups.number.widths, {'home.number.format': 150});
  assert.deepEqual(home.groups.styles.layout.map(i => i.large), ['home.styles.conditionalFormatting', 'home.styles.formatAsTable', 'home.styles.cellStyles']);
});
