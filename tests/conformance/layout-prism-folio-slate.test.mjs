// Ribbon layout overlays for Prism, PDF (folio) and Slate (docs/architecture.md sections 7.3, 8.4):
// every tab of the three specs has a geometry overlay, every id an overlay places exists in that
// group of the spec, nothing is left unplaced, and the arrangement keeps the upstream geometry
// (deckcraft crates/ui-egui/src/ribbon/*.rs @ f893f6af, printcraft crates/ui-egui/src/** @ 3109bb23,
// OneNote for Slate) for the controls the renderer draws large, stacked, in rows or as galleries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSpecModel} from '../../scripts/gen/spec.mjs';
import {Report, SPEC_DIRS} from '../../scripts/gen/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPS = ['prism', 'folio', 'slate'];
const PRIMITIVES = ['large', 'medium', 'small', 'stack', 'rows', 'gallery', 'separator'];
const UPSTREAM = {prism: /^deckcraft crates\/ui-egui\/src\/ribbon\/.+ @ f893f6af7d36a5409fd804e81a34fd895cfefedf|^office: PowerPoint/,
  folio: /^printcraft crates\/.+ @ 3109bb2359759e24ef490e1cdbdba00722b20972/, slate: /^office: OneNote/};

const report = new Report();
const models = Object.fromEntries(APPS.map(app => [app, buildSpecModel(root, app, report)]));
const overlayFiles = app => SPEC_DIRS[app].flatMap(dir => {
  const d = path.join(root, 'docs/spec/layout', dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => ({file: `docs/spec/layout/${dir}/${f}`, json: JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))})) : [];
});
const placed = item => {
  const k = Object.keys(item).find(x => PRIMITIVES.includes(x));
  if (k === 'separator') return [];
  if (k === 'stack') return item.stack;
  if (k === 'rows') return item.rows.flat().map(x => (typeof x === 'string' ? x : x.medium));
  return [item[k]];
};
const group = (app, tab, gid) => models[app].tabs.find(t => t.id === tab)?.groups.find(g => g.id === gid);
const itemOf = (app, tab, gid, id) => group(app, tab, gid)?.layout.find(i => placed(i).includes(id));

for (const app of APPS) {
  test(`${app}: every ribbon tab has a layout overlay`, () => {
    const model = models[app];
    assert.ok(model, `${app} has a spec`);
    const files = new Set(overlayFiles(app).map(o => path.basename(o.file, '.json')));
    for (const tab of model.tabs) {
      assert.ok(files.has(tab.id), `${app}/${tab.id} has docs/spec/layout/${SPEC_DIRS[app][0]}/${tab.id}.json`);
      assert.notEqual(tab.layoutSource, 'default', `${app}/${tab.id} is laid out by its overlay`);
    }
  });

  test(`${app}: overlays name only real tabs, groups and controls and place every control once`, () => {
    const mine = report.errors.filter(e => SPEC_DIRS[app].some(d => e.startsWith(`docs/spec/layout/${d}/`)));
    assert.deepEqual(mine, [], 'the generator accepts every overlay');
    for (const {file, json} of overlayFiles(app)) {
      const tabId = path.basename(file, '.json');
      const tab = models[app].tabs.find(t => t.id === tabId);
      assert.ok(tab, `${file}: tab ${tabId} exists in the spec`);
      assert.equal(json.tab, tabId, `${file}: "tab" matches the file name`);
      assert.match(json.source ?? '', UPSTREAM[app], `${file} names its upstream source and commit`);
      for (const [gid, g] of Object.entries(json.groups)) {
        const sg = tab.groups.find(x => x.id === gid);
        assert.ok(sg, `${file}: group ${gid} exists`);
        const ids = new Set(sg.controls.filter(c => c.id).map(c => c.id));
        const seen = [];
        for (const item of g.layout) {
          const keys = Object.keys(item).filter(k => PRIMITIVES.includes(k));
          assert.equal(keys.length, 1, `${file}/${gid}: one primitive per item`);
          if (item.stack) assert.ok(item.stack.length >= 1 && item.stack.length <= 3, `${file}/${gid}: a stack holds one to three controls`);
          if (item.rows) assert.ok(item.rows.length >= 1 && item.rows.length <= 3, `${file}/${gid}: rows are one to three`);
          for (const id of placed(item)) { assert.ok(ids.has(id), `${file}/${gid}: ${id} is a control of the group`); seen.push(id); }
        }
        assert.equal(new Set(seen).size, seen.length, `${file}/${gid}: nothing is placed twice`);
        assert.deepEqual([...ids].filter(id => !seen.includes(id)), [], `${file}/${gid}: every control is placed`);
        for (const id of Object.keys(g.widths ?? {})) assert.ok(ids.has(id), `${file}/${gid}: width for its own control ${id}`);
        if (g.collapsedIcon) assert.ok(sg.controls.some(c => c.icon === g.collapsedIcon), `${file}/${gid}: the collapsed icon is one the group already draws`);
      }
      assert.deepEqual(Object.keys(json.groups).sort(), tab.groups.map(g => g.id).sort(), `${file}: every group of the tab is laid out`);
    }
    for (const tab of models[app].tabs) for (const g of tab.groups) assert.ok(!g.layout.some(i => i.unplaced), `${app}/${tab.id}/${g.id} has no unplaced control`);
  });

  test(`${app}: collapse order and keytips are well formed`, () => {
    for (const tab of models[app].tabs) {
      const orders = tab.groups.map(g => g.collapseOrder);
      assert.ok(orders.every(Number.isFinite), `${app}/${tab.id}: every group has a collapseOrder`);
      assert.equal(new Set(orders).size, orders.length, `${app}/${tab.id}: collapse steps are distinct`);
      const tips = [];
      for (const g of tab.groups) {
        if (g.keytip) tips.push(g.keytip);
        const visit = c => { if (!c || !c.id) return; if (c.keytip) tips.push(c.keytip); (c.items ?? []).forEach(visit); };
        g.controls.forEach(visit);
      }
      assert.equal(new Set(tips).size, tips.length, `${app}/${tab.id}: keytips are unique`);
      for (const a of tips) for (const b of tips) if (a !== b) assert.ok(!b.startsWith(a), `${app}/${tab.id}: keytip ${a} is not a prefix of ${b}`);
      for (const t of tips) assert.match(t, /^[A-Z0-9]{1,3}$/, `${app}/${tab.id}: keytip ${t}`);
    }
    const tabTips = models[app].tabs.filter(t => t.keytip).map(t => t.keytip);
    assert.equal(new Set(tabTips).size, tabTips.length, `${app}: tab keytips are unique`);
  });
}

test('prism keeps deckcraft\'s ribbon geometry', () => {
  // home.rs: Paste and New Slide are big buttons; Cut/Copy/Format and Layout/Reset/Section stack beside them.
  assert.deepEqual(itemOf('prism', 'home', 'clipboard', 'home.clipboard.paste'), {large: 'home.clipboard.paste'});
  assert.deepEqual(itemOf('prism', 'home', 'slides', 'home.slides.new-slide'), {large: 'home.slides.new-slide'});
  assert.deepEqual(itemOf('prism', 'home', 'slides', 'home.slides.layout'), {stack: ['home.slides.layout', 'home.slides.reset', 'home.slides.section']});
  // font_group / paragraph_group: two rows of small controls, the font and size combos at 150 and 52 px.
  const font = itemOf('prism', 'home', 'font', 'home.font.bold');
  assert.equal(font.rows.length, 2);
  assert.deepEqual(font.rows[0].slice(0, 2), ['home.font.family', 'home.font.size']);
  assert.deepEqual(group('prism', 'home', 'font').widths, {'home.font.family': 150, 'home.font.size': 52});
  assert.equal(itemOf('prism', 'home', 'paragraph', 'home.paragraph.align-left').rows.length, 2);
  // drawing_group: Shapes, Text Box, Arrange and Quick Styles big; Fill/Outline/Effects in one column.
  for (const id of ['home.drawing.shapes', 'home.drawing.text-box', 'home.drawing.arrange', 'home.drawing.quick-styles']) assert.ok(itemOf('prism', 'home', 'drawing', id).large, id);
  assert.deepEqual(itemOf('prism', 'home', 'drawing', 'home.drawing.fill').stack, ['home.drawing.fill', 'home.drawing.outline', 'home.drawing.effects']);
  // Transitions and Animations: in-ribbon galleries (transitions.rs, animations.rs: one row of 54 and 50 px tiles, 12 and 13 of them,
  // about 650 px; the shell's tiles are wider, so eight fill the same width).
  assert.deepEqual(itemOf('prism', 'transitions', 'transition-to-this-slide', 'transitions.gallery'), {gallery: 'transitions.gallery', inline: true, columns: 8});
  assert.deepEqual(itemOf('prism', 'animations', 'animation', 'animations.gallery'), {gallery: 'animations.gallery', inline: true, columns: 8});
  // arrange.rs arrange_group: four big buttons then Group/Rotate stacked, on every contextual tab.
  for (const [tab, p] of [['shape-format', 'shapeformat'], ['picture-format', 'pictureformat'], ['layout', 'tablelayout'], ['chart-design', 'chartdesign'], ['smart-art-design', 'smartart']]) {
    assert.deepEqual(group('prism', tab, 'arrange').layout.map(i => Object.keys(i)[0]), ['large', 'large', 'large', 'large', 'stack'], tab);
    assert.deepEqual(itemOf('prism', tab, 'arrange', `${p}.arrange.group`).stack, [`${p}.arrange.group`, `${p}.arrange.rotate`], tab);
  }
  // Group launchers stay where the spec puts them (Clipboard pane, Font and Paragraph dialogs).
  assert.equal(group('prism', 'home', 'font').launcher.dialog, 'dialog.font');
  assert.equal(group('prism', 'home', 'clipboard').launcher.pane, 'clipboard');
  assert.equal(models.prism.tabs.find(t => t.id === 'home').keytip, 'H');
});

test('PDF lays its tools out as printcraft\'s panels list them', () => {
  // catalog.rs: one-entry tools are a single big button, the rest icon-and-label rows in sections.
  assert.deepEqual(group('folio', 'all-tools', 'combine').layout, [{large: 'alltools.combine.add-files-to-combine'}]);
  const edit = group('folio', 'all-tools', 'edit').layout;
  assert.equal(edit.filter(i => i.separator).length, 2, 'Modify page | Add content | object tools');
  assert.deepEqual(edit[0], {stack: ['alltools.edit.edit-text-images', 'alltools.edit.rotate-pages', 'alltools.edit.insert-pages']});
  // format_text_ui.rs: font; size, colour, lists, alignment; B I U sup sub â€” three rows.
  assert.deepEqual(itemOf('folio', 'edit', 'format-text', 'edit.format.font').rows.map(r => r.length), [1, 5, 5]);
  // bars.rs: the quick tools bar is one row of tools in bar order.
  assert.deepEqual(itemOf('folio', 'quick-tools', 'quick-bar', 'quick.bar.select').rows[0].slice(0, 3), ['quick.bar.select', 'quick.bar.hand', 'quick.bar.comment']);
});

test('Slate follows OneNote\'s ribbon', () => {
  assert.deepEqual(itemOf('slate', 'home', 'clipboard', 'home.clipboard.paste'), {large: 'home.clipboard.paste'});
  const basic = itemOf('slate', 'home', 'basic-text', 'home.basic-text.bold');
  assert.equal(basic.rows.length, 2);
  assert.deepEqual(basic.rows[0].slice(0, 2), ['home.basic-text.font', 'home.basic-text.font-size']);
  assert.ok(itemOf('slate', 'home', 'tags', 'home.tags.tags').inline, 'the Tags gallery sits in the ribbon');
  assert.deepEqual(itemOf('slate', 'insert', 'time-stamp', 'insert.time-stamp.date').stack, ['insert.time-stamp.date', 'insert.time-stamp.time', 'insert.time-stamp.date-and-time']);
  assert.equal(group('slate', 'equation', 'structures').layout.length, 11, 'eleven big structure buttons');
});
