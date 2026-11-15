// U:grid/format bridge E2E: the Home › Font, Alignment, Number, Styles and Cells › Format ribbon
// groups and the Format Cells, Row Height and Column Width dialogs on a schema-2 workbook, each
// change read back over the bridge and painted on the grid (captures), Ctrl+Z undoing.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft cmd/format.rs (apply_style, toggles, borders, merges, number formats),
//    format/cell_styles.rs, format/sizes.rs, ui-egui dialogs/format_cells.rs; Excel's Home tab and
//    Format Cells (Ctrl+1) do the same.
// 2. Ours: the ribbon controls (ui.activate, the handler a click runs), the keyboard (ui.key through
//    KeyRouter) and the dialogs (ui.dialog.*) run the same commands; the canvas paints the styles.
// 3. This flow; captures in artifacts/e2e/grid/format-ribbon/*.png were looked at by the author.
//
// Driven only through the bridge: no OS mouse or keyboard, no screen capture (ui.capture).

import test from 'node:test';
import assert from 'node:assert/strict';
import {devRenderer, launchApp} from '../harness.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';

const NOW = '2026-10-30T09:00:00.000Z';

function seed() {
  const content = {
    sheets: [{id: 's1', name: 'Sheet1', blocks: {0: {
      A1: {v: 'Quarterly sales'},
      A3: {v: 'Region'}, B3: {v: 'Q1'}, C3: {v: 'Q2'}, D3: {v: 'Change'},
      A4: {v: 'North'}, B4: {v: 1234.5}, C4: {v: 1500.25}, D4: {v: 0.2153},
      A5: {v: 'South'}, B5: {v: 980}, C5: {v: 870.5}, D5: {v: -0.1117},
      A6: {v: 'West'}, B6: {v: 2210.75}, C6: {v: 2400}, D6: {v: 0.0856},
      A7: {v: 'Total'}, B7: {f: 'SUM(B4:B6)'}, C7: {f: 'SUM(C4:C6)'},
      A9: {v: 'A note that is long enough to wrap inside its cell'},
    }}, cols: {0: {size: 110}}}],
    activeSheetId: 's1', styles: [{}], names: [],
  };
  return {id: 'grid-format', schema: 2, kind: 'grid', title: 'Format flow', revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [],
    content: validateContent(content)};
}

test('grid format: Font, Alignment, Number, Styles, Cells › Format and Format Cells, painted and undoable', {timeout: 300_000}, async () => {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'grid', flow: 'grid/format-ribbon', renderer, files: [seed()]});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  const doc = 'grid-format';
  const props = async address => (await app.rpc('document.read', {doc, address, as: 'props'})).value;
  const display = async address => (await app.rpc('document.read', {doc, address, as: 'display'})).value;
  const settle = () => new Promise(r => setTimeout(r, 250));
  const select = async (anchor, focus = anchor) => { await app.rpc('selection.set', {doc, ranges: [{anchor: `/sh:s1/${anchor}`, focus: `/sh:s1/${focus}`}], primary: 0}); await settle(); };
  const press = async (control, value) => { await app.rpc('ui.activate', {doc, control, ...(value !== undefined ? {value} : {})}); await settle(); };
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    await app.rpc('documents.open', {doc, show: true});
    await app.until(async () => { const ui = await app.rpc('ui.inspect', {doc}); return ui.doc?.id === doc && ui.tabs?.length ? ui : null; }, {timeout: 60_000})
      .catch(e => { throw new Error(e.message + log()); });
    await settle();
    await app.capture('01-opened');

    // Font group: title bold through the keyboard (Ctrl+B), bigger through the size combo, coloured.
    await select('A1');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+B'});
    await settle();
    assert.equal((await props('/sh:s1/A1')).bold, true);
    await press('home.font.size', '16');
    assert.equal((await props('/sh:s1/A1')).fontSize, 16);
    assert.ok((await props('/sh:s1/A1')).height > 20, 'the row grows to its font (Excel auto-fits)');
    await press('home.font.fontColor', '#1F4E79');
    assert.equal((await props('/sh:s1/A1')).fontColor, '#1F4E79');

    // Header row: bold, fill, centred, bottom double border, through the ribbon.
    await select('A3', 'D3');
    await press('home.font.bold');
    await press('home.font.fillColor', '#DDEBF7');
    await press('home.alignment.center');
    await press('home.font.borders.bottom-double-border');
    const h = await props('/sh:s1/C3');
    assert.equal(h.bold, true);
    assert.equal(h.fill, '#DDEBF7');
    assert.equal(h.hAlign, 'center');
    assert.equal(h.borders.bottom.style, 'double');

    // Number group: Currency on the figures, Percent Style and one more decimal on the change column.
    await select('B4', 'C7');
    await press('home.number.format.currency');
    assert.equal(await display('/sh:s1/B4'), '$1,234.50');
    await select('D4', 'D6');
    await press('home.number.percent');
    await press('home.number.increaseDecimal');
    assert.equal(await display('/sh:s1/D4'), '21.5%');

    // Styles: Total row as the Total cell style; Merge & Center the title across the table.
    await select('A7', 'D7');
    await app.rpc('engine.execute', {doc, command: 'home.cellStyle', params: {name: 'Total'}});
    await settle();
    assert.equal((await props('/sh:s1/B7')).borders.top.style, 'thin');
    await select('A1', 'D1');
    await press('home.alignment.mergeCenter.merge-and-center');
    assert.equal((await props('/sh:s1/A1')).merged, true);
    // Wrap the note and indent the regions.
    await select('A9');
    await press('home.alignment.wrapText');
    assert.equal((await props('/sh:s1/A9')).wrap, true);
    await select('A4', 'A6');
    await press('home.alignment.increaseIndent');
    assert.equal((await props('/sh:s1/A5')).indent, 1);
    await select('A3', 'D7');
    await press('home.font.borders.thick-outside-borders');
    await app.capture('02-formatted-table');

    // Format Cells (Ctrl+1): the Number page proposes the active cell's Currency; switch to two
    // decimals Number with separator and red negatives, then Font italic and a Border inside line.
    await select('B4', 'C6');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+1'});
    await settle();
    let d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.formatCells');
    assert.equal(d.values.category, 'Currency');
    await app.rpc('ui.dialog.set', {doc, values: {category: 'Number'}});
    await app.rpc('ui.dialog.set', {doc, values: {useSeparator: true, negativeNumbers: 1}});
    await settle();
    await app.capture('03-format-cells-number');
    await app.rpc('ui.dialog.set', {doc, tab: 2, values: {fontStyle: 'Italic'}});
    await settle();
    await app.capture('04-format-cells-font');
    await app.rpc('ui.dialog.set', {doc, tab: 3, values: {insideHorizontal: 'dotted'}});
    await settle();
    await app.capture('05-format-cells-border');
    await app.rpc('ui.dialog.set', {doc, tab: 4, values: {}});
    await settle();
    await app.capture('06-format-cells-fill');
    await app.rpc('ui.dialog.set', {doc, tab: 1, values: {}});
    await settle();
    await app.capture('07-format-cells-alignment');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    assert.equal(await display('/sh:s1/B4'), '1,234.50');
    assert.equal((await props('/sh:s1/C5')).italic, true);
    assert.equal((await props('/sh:s1/B4')).borders.bottom.style, 'dotted');

    // Cells › Format: Row Height and Column Width dialogs, AutoFit, hide and unhide.
    await select('B3');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.columnWidth'});
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.values.chars, 8.43);
    await app.rpc('ui.dialog.set', {doc, values: {chars: 12}});
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal((await props('/sh:s1/B3')).width, 89);
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.rowHeight'});
    await app.rpc('ui.dialog.set', {doc, values: {points: 24}});
    await settle();
    await app.capture('08-row-height');
    await app.rpc('ui.dialog.submit', {doc});
    assert.equal((await props('/sh:s1/B3')).height, 32);
    await select('C3');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+0'});
    await settle();
    assert.equal((await props('/sh:s1/C3')).width, 0, 'Ctrl+0 hides the column');
    await app.capture('09-column-hidden');
    await app.rpc('ui.key', {doc, keys: 'Ctrl+Z'});
    await settle();
    assert.equal((await props('/sh:s1/C3')).width, 64, 'undo shows it again');
    await app.capture('10-final');

    // Styles › Conditional Formatting: the menu, the Greater Than box, a data bar and an icon set, painted.
    await app.rpc('ui.menu', {doc, control: 'home.styles.conditionalFormatting'});
    await app.capture('11-conditional-formatting-menu');
    await app.rpc('ui.menu', {doc, control: 'home.styles.conditionalFormatting', open: false});
    await select('B4', 'B6');
    await press('home.styles.conditionalFormatting.highlight-cells-rules.greater-than');
    d = await app.rpc('ui.dialog.get', {doc});
    assert.equal(d.id, 'dialog.cfQuick');
    await app.rpc('ui.dialog.set', {doc, values: {value: '1000'}});
    await settle();
    await app.capture('12-greater-than');
    await app.rpc('ui.dialog.submit', {doc});
    await settle();
    await select('C4', 'C6');
    await press('home.styles.conditionalFormatting.data-bars.gallery', 'dataBar.blue');
    await select('D4', 'D6');
    await press('home.styles.conditionalFormatting.icon-sets.gallery', 'iconSet.3Arrows');
    const rules = (await app.rpc('engine.execute', {doc, command: 'home.manageRules', params: {list: true}})).result.rules;
    assert.deepEqual(rules.map(r => r.type), ['iconSet', 'dataBar', 'cellIs'], 'a new rule goes first');
    await app.rpc('ui.dialog.open', {doc, id: 'dialog.manageRules'});
    await settle();
    await app.capture('13-rules-manager');
    await app.rpc('ui.dialog.cancel', {doc});
    await select('F12');
    await app.capture('14-conditional-painted');

    // Borders › Draw Border: the pen on, a range drawn with it, the pen off again.
    await press('home.font.borders.draw-border');
    await app.rpc('engine.execute', {doc, command: 'home.drawBorder', params: {range: 'F3:G5', apply: true}});
    assert.equal((await props('/sh:s1/F3')).borders.top.style, 'thin');
    await press('home.font.borders.draw-border');
    await app.capture('15-draw-border');
    // Format as Table: the gallery's value makes the block around the active cell a table.
    await app.rpc('ui.menu', {doc, control: 'home.styles.formatAsTable'});
    await app.capture('16-format-as-table-gallery');
    await app.rpc('ui.menu', {doc, control: 'home.styles.formatAsTable', open: false});
    await select('B5');
    const made = await app.rpc('ui.activate', {doc, control: 'home.styles.formatAsTable', value: 'TableStyleMedium9'});
    await settle();
    assert.equal(made.result.range, 'A3:D7', JSON.stringify(made));
    await select('F12');
    await app.capture('17-format-as-table');
  } finally {
    await app.close();
  }
});
