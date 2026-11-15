// U:grid/insert and U:grid/page-layout bridge E2E: the chart menus' new kinds (3-D Pie, Bar of Pie, Pareto, 3-D Bubble, Custom Combo),
// WordArt, Signature Line and Equation from the Insert tab, then Page Layout's Arrange on objects picked together (Align, Distribute,
// Group, Rotate, Flip, the Selection Pane), Sheet Right-to-Left and Customize Colors, from the ribbon and its dialogs.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: gridcraft crates/engine/src/cmd/extra/objects.rs and cmd/view.rs where it has the command; the rest follows Excel (not
//    checked against upstream), see tests/grid/insert-layout.test.mjs for the line by line account.
// 2. Ours runs the same commands from the ribbon controls and their dialogs and reads the sheet back.
// 3. This flow; captures in artifacts/e2e/grid/insert-layout/*.png were looked at by the author.

import test from 'node:test';
import {startData, assert} from './data-kit.mjs';

test('grid insert and page layout: new chart kinds, text objects, arrange, selection pane, right-to-left, theme colours', {timeout: 600_000}, async () => {
  const t = await startData('grid/insert-layout', {tab: 'insert'});
  const {app, doc, select, press, exec, settle, submit} = t;
  const objects = async () => (await exec('object.list')).result;
  const openMenu = async (tab, id) => { await app.rpc('ui.tab', {doc, id: tab}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(400); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  try {
    // Insert > Charts: the Pie menu lists 3-D Pie, Pie of Pie and Bar of Pie; Statistic has Pareto; Scatter has 3-D Bubble.
    await exec('range.setValues', {range: 'A12', values: [['Item', 'Sales', 'Cost', 'Size'], ['Apples', 40, 10, 3], ['Pears', 25, 20, 5], ['Plums', 15, 5, 2], ['Figs', 10, 8, 4], ['Limes', 6, 2, 1]]});
    await select('A12', 'B17');
    await openMenu('insert', 'insert.charts.pieDoughnut');
    await app.capture('01-menu-pie');
    await closeMenu('insert.charts.pieDoughnut');
    await select('A12', 'B17');
    await press('insert.charts.recommended');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.recommendedCharts');
    await settle(700);
    await app.capture('00a-recommended-charts');
    await app.rpc('ui.dialog.set', {doc, values: {tab: 1}});
    await settle(300);
    await app.capture('00b-all-charts');
    await app.rpc('ui.dialog.cancel', {doc});
    await press('insert.charts.pieDoughnut', 'pie3d');
    let list = await objects();
    assert.deepEqual(list.map(o => o.chart), ['pie3d']);
    await exec('object.move', {kind: 'chart', id: list[0].id, at: 'F2', width: 300, height: 160});
    await select('A12', 'B17');
    await exec('insert.chart', {kind: 'barOfPie', at: 'N2', width: 300, height: 160});
    await select('A12', 'B17');
    await press('insert.charts.statistic', 'pareto');
    list = await objects();
    const pareto = list.find(o => o.chart === 'pareto');
    assert.ok(pareto);
    await exec('object.move', {kind: 'chart', id: pareto.id, at: 'F11', width: 320, height: 160});
    await select('B12', 'D17');
    await press('insert.charts.scatterBubble', 'bubble3d');
    const bubble = (await objects()).find(o => o.chart === 'bubble3d');
    assert.ok(bubble);
    await exec('object.move', {kind: 'chart', id: bubble.id, at: 'N11', width: 300, height: 160});
    await settle(400);
    await app.capture('02-charts');

    // Create Custom Combo Chart: its dialog lists the series with a type and a Secondary Axis box.
    await select('A12', 'C17');
    await openMenu('insert', 'insert.charts.hierarchy');
    await app.capture('03-menu-hierarchy');
    await closeMenu('insert.charts.hierarchy');
    await press('insert.charts.hierarchy.create-custom-combo-chart');
    const dlg = await app.rpc('ui.dialog.get', {doc});
    assert.equal(dlg.id, 'dialog.customCombo');
    assert.ok(dlg.values.names.length >= 2);
    await app.rpc('ui.dialog.set', {doc, values: {kinds: ['columnStacked', 'lineMarkers', ...dlg.values.kinds.slice(2)], secondary: [false, true, ...dlg.values.secondary.slice(2)]}});
    await settle(300);
    await app.capture('04-custom-combo-dialog');
    await submit();
    const combo = (await objects()).find(o => o.chart === 'combo');
    assert.ok(combo, 'the combo chart is on the sheet');
    await exec('object.move', {kind: 'chart', id: combo.id, at: 'V2', width: 300, height: 220});

    // Insert > Text and Symbols: WordArt, Signature Line, Equation.
    await openMenu('insert', 'insert.text.wordArt');
    await app.capture('05-menu-wordart');
    await closeMenu('insert.text.wordArt');
    const park = async (at, w, h) => { const o = (await objects()).filter(x => x.kind === 'shape').pop(); await exec('object.move', {kind: 'shape', id: o.id, at, width: w, height: h}); };
    await press('insert.text.wordArt', 'accent2-hard-shadow');
    await park('F20', 420, 60);
    await press('insert.text.signatureLine');
    assert.equal((await app.rpc('ui.dialog.get', {doc})).id, 'dialog.signatureSetup');
    await app.rpc('ui.dialog.set', {doc, values: {signer: 'Ada Lovelace', title: 'Analyst', email: 'ada@example.com', instructions: 'Please sign', comments: true}});
    await settle(200);
    await app.capture('06-signature-setup');
    await submit();
    await park('F24', 220, 60);
    await openMenu('insert', 'insert.symbols.equation');
    await app.capture('07-menu-equation');
    await closeMenu('insert.symbols.equation');
    await exec('insert.equation', {builtIn: 'Quadratic Formula', at: 'F28', width: 300, height: 50});
    const shapes = (await objects()).filter(o => o.kind === 'shape');
    assert.deepEqual(shapes.map(o => o.shape), ['wordArt', 'signature', 'equation']);
    await settle(500);
    await app.capture('08-text-objects');

    // Page Layout > Arrange on the three: pick together, Align, Distribute, Group, Rotate, Flip.
    await app.rpc('ui.tab', {doc, id: 'page-layout'});
    await settle(200);
    const ids = shapes.map(o => o.id);
    const rectOf = async id => (await app.rpc('ui.pointer', {doc, action: 'click', target: 'object', kind: 'shape', id})).rect;
    await app.rpc('ui.pointer', {doc, action: 'click', target: 'object', kind: 'shape', id: ids[0]});
    await app.rpc('ui.pointer', {doc, action: 'click', target: 'object', kind: 'shape', id: ids[1], modifiers: ['Shift']});
    await app.rpc('ui.pointer', {doc, action: 'click', target: 'object', kind: 'shape', id: ids[2], modifiers: ['Shift']});
    await settle(300);
    await openMenu('page-layout', 'pageLayout.arrange.align');
    await app.capture('09-menu-align');
    await closeMenu('pageLayout.arrange.align');
    await press('pageLayout.arrange.align.align-left');
    const leftEdge = async () => { const rs = []; for (const id of ids) rs.push((await rectOf(id)).x); return rs; };
    const xs = await leftEdge();
    assert.ok(xs.every(x => Math.abs(x - xs[0]) < 2), `the left edges line up: ${xs}`);
    await press('pageLayout.arrange.align.distribute-vertically');
    await settle(300);
    await app.capture('10-aligned-distributed');
    await press('pageLayout.arrange.group.group');
    const grouped = (await exec('arrange.selectionPane', {list: true})).result;
    const members = grouped.filter(x => x.kind === 'shape');
    assert.equal(new Set(members.map(x => x.group)).size, 1, 'one group');
    assert.ok(members.length === 3 && members.every(x => Number.isInteger(x.group)));
    await openMenu('page-layout', 'pageLayout.arrange.group');
    await app.capture('11-menu-group');
    await closeMenu('pageLayout.arrange.group');
    // Dragging a group moves every member.
    const before = await rectOf(ids[0]);
    await app.rpc('ui.pointer', {doc, action: 'drag', target: 'object', kind: 'shape', id: ids[0], dx: 40, dy: 20});
    await settle(300);
    const after = await rectOf(ids[0]);
    assert.ok(after.x > before.x + 30, `the group moved right (${before.x} to ${after.x})`);
    // The Shape Format tab's Arrange group is the same commands.
    await press('shapeFormat.arrange.group.ungroup');
    assert.ok((await exec('arrange.selectionPane', {list: true})).result.filter(x => x.kind === 'shape').every(x => x.group === undefined));
    await press('pageLayout.arrange.group.regroup');
    assert.ok((await exec('arrange.selectionPane', {list: true})).result.filter(x => x.kind === 'shape').every(x => Number.isInteger(x.group)));
    await press('shapeFormat.arrange.rotate.rotate-right-90');
    await press('shapeFormat.arrange.rotate.flip-horizontal');
    await press('shapeFormat.arrange.align.distribute-horizontally');
    await settle(300);
    await openMenu('page-layout', 'pageLayout.arrange.rotate');
    await app.capture('12-menu-rotate');
    await closeMenu('pageLayout.arrange.rotate');
    await app.capture('13-rotated-flipped');

    // The Selection Pane lists every object with its eye; hiding one takes it off the sheet.
    await press('pageLayout.arrange.selectionPane');
    await settle(500);
    await app.capture('14-selection-pane');
    const pane = await app.rpc('ui.inspect', {doc});
    assert.equal(pane.panes.find(p => p.id === 'pane.selection')?.open, true, 'the pane is open');
    await exec('arrange.rename', {kind: 'shape', id: ids[0], name: 'Title art'});
    await exec('arrange.setVisible', {kind: 'chart', id: pareto.id, visible: false});
    await settle(400);
    await app.capture('15-pane-hidden-object');
    await exec('arrange.setVisible', {all: true});
    await press('pageLayout.arrange.selectionPane');
    assert.equal((await app.rpc('ui.inspect', {doc})).panes.find(p => p.id === 'pane.selection')?.open, false, 'the button closes it');

    // Snap, and Sheet Right-to-Left.
    await press('pageLayout.arrange.align.snap-to-grid');
    assert.equal((await app.rpc('ui.inspect', {doc})).view?.snapToGrid ?? true, true);
    await press('pageLayout.arrange.align.snap-to-grid');
    await press('pageLayout.sheetOptions.rightToLeft');
    await settle(500);
    await app.capture('16-right-to-left');
    assert.equal((await t.read('/sh:s1', 'props')).rightToLeft, true);
    await press('pageLayout.sheetOptions.rightToLeft');
    assert.notEqual((await t.read('/sh:s1', 'props')).rightToLeft, true);

    // Customize Colors: Excel's twelve boxes and a name.
    await press('pageLayout.themes.colors.customize-colors');
    const cc = await app.rpc('ui.dialog.get', {doc});
    assert.equal(cc.id, 'dialog.createThemeColors');
    await app.rpc('ui.dialog.set', {doc, values: {color4: '#B3261E', name: 'Brick'}});
    await settle(200);
    await app.capture('17-create-theme-colors');
    await submit();
    await settle(400);
    await app.capture('18-theme-brick');
  } catch (e) {
    throw new Error(`${e.message}${t.log()}`, {cause: e});
  } finally {
    await app.close();
  }
});
