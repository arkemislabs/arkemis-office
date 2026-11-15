// U:grid/charts-objects bridge E2E: Chart Design's Axes, Data Table, Error Bars, Lines and Up/Down Bars; the Format tab of a chart (Chart
// Elements, Shape Styles, effects, WordArt, Reset to Match Style); the Sparkline tab (points, marker colours, styles, axis, group);
// the Shape Format and Picture Format tabs (styles, effects, WordArt, corrections, artistic effects, crop). Driven only through the bridge:
// no OS mouse or keyboard, no screen capture.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: none of these tabs has an engine in gridcraft.
// 2. Ours: Excel's behaviour, run from the ribbon controls and read back from the document.
// 3. This flow; captures in artifacts/e2e/grid/charts-objects/*.png were looked at by the author.

import test from 'node:test';
import zlib from 'node:zlib';
import {startData, assert} from './data-kit.mjs';

const crc = (() => { const tab = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); return b => { let c = 0xFFFFFFFF; for (const x of b) c = tab[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }; })();
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Sky, sun and hills, 96 x 72.
const PHOTO = png(96, 72, (x, y) => {
  const hill = 44 + 10 * Math.sin(x / 11);
  if (Math.hypot(x - 70, y - 18) < 8) return [245, 197, 66, 255];
  if (y > hill) return [84, 130, 53, 255];
  return [91 + y, 155 + y / 2, 213, 255];
}).toString('base64');

test('grid chart elements, sparkline points and groups, shape and picture formatting from the ribbon', {timeout: 600_000}, async () => {
  const t = await startData('grid/charts-objects', {tab: 'home'});
  const {app, doc, select, press, exec, settle} = t;
  const inspect = () => app.rpc('ui.inspect', {doc});
  const sheet = async () => (await app.rpc('document.read', {doc, address: '/sh:s1', as: 'json'})).value;
  const chartOf = async () => ((await sheet()).charts ?? [])[0];
  const openMenu = async (tab, id) => { await app.rpc('ui.tab', {doc, id: tab}); await settle(150); await app.rpc('ui.menu', {doc, control: id}); await settle(350); };
  const closeMenu = async id => { await app.rpc('ui.menu', {doc, control: id, open: false}); await settle(100); };
  const idsOf = async () => new Set(((await inspect()).controls ?? []).map(c => c.id));
  try {
    // ---- Chart Design: Axes, Data Table, Error Bars, Lines, Up/Down Bars ----
    await select('A1', 'D8');
    await exec('insert.chart', {type: 'line', range: 'A1:D8', at: 'F5', title: 'Sales'});
    await settle(400);
    await app.rpc('ui.tab', {doc, id: 'chart-design'});
    await settle(300);
    await openMenu('chart-design', 'chartDesign.layouts.addElement');
    await app.capture('01-add-chart-element');
    await app.rpc('ui.menu', {doc, control: 'chartDesign.layouts.addElement.error-bars'});
    await settle(300);
    await app.capture('02-error-bars-menu');
    await closeMenu('chartDesign.layouts.addElement');
    await press('chartDesign.layouts.addElement.error-bars.percentage');
    await press('chartDesign.layouts.addElement.lines.high-low-lines');
    await press('chartDesign.layouts.addElement.up-down-bars.up-down-bars');
    await settle(500);
    let c = await chartOf();
    assert.equal(c.errorBars.type, 'percentage');
    assert.equal(c.lines, 'highLow');
    assert.equal(c.upDownBars, true);
    await app.capture('03-line-error-bars-high-low-up-down');
    await press('chartDesign.layouts.addElement.data-table.with-legend-keys');
    await press('chartDesign.layouts.addElement.axes.primary-vertical');
    await settle(500);
    c = await chartOf();
    assert.deepEqual(c.dataTable, {keys: true});
    assert.deepEqual(c.axes, {value: false});
    await app.capture('04-data-table-no-vertical-axis');
    await press('chartDesign.layouts.addElement.axes.primary-vertical');
    await press('chartDesign.layouts.addElement.lines.drop-lines');
    await press('chartDesign.layouts.addElement.up-down-bars.none');
    await press('chartDesign.layouts.addElement.error-bars.none');
    await settle(400);
    await app.capture('05-drop-lines');
    c = await chartOf();
    assert.deepEqual([c.lines, c.upDownBars, c.errorBars, c.axes], ['drop', undefined, undefined, undefined]);

    // ---- Chart Format: Chart Elements, Shape Styles, effects, WordArt ----
    await app.rpc('ui.tab', {doc, id: 'format'});
    await settle(300);
    const fids = await idsOf();
    for (const id of ['chartFormat.selection.elements', 'chartFormat.selection.resetToMatchStyle', 'chartFormat.shapeStyles.gallery', 'chartFormat.shapeStyles.outline', 'chartFormat.shapeStyles.effects', 'chartFormat.wordArt.gallery',
      'chartFormat.wordArt.textFill', 'chartFormat.wordArt.textOutline', 'chartFormat.wordArt.textEffects', 'chartFormat.accessibility.altText']) assert.ok(fids.has(id), `${id} is on the chart Format tab`);
    await app.capture('06-chart-format-tab');
    await openMenu('format', 'chartFormat.shapeStyles.gallery');
    await app.capture('07-shape-styles-gallery');
    await closeMenu('chartFormat.shapeStyles.gallery');
    await press('chartFormat.shapeStyles.gallery', 31);
    await exec('chart.selectElement', {element: 'Plot Area'});
    await press('chartFormat.shapeStyles.fill', '#F2F6FC');
    await exec('chart.selectElement', {element: 'Chart Area'});
    await openMenu('format', 'chartFormat.shapeStyles.effects');
    await app.rpc('ui.menu', {doc, control: 'chartFormat.shapeStyles.effects.shadow'});
    await settle(300);
    await app.capture('08-chart-effects-menu');
    await closeMenu('chartFormat.shapeStyles.effects');
    await press('chartFormat.shapeStyles.effects.shadow.offset-bottom-right');
    await settle(400);
    await app.capture('09a-chart-green-auto-text');
    await press('chartFormat.wordArt.textFill.colors', '#FFE9A8');
    await settle(500);
    c = await chartOf();
    assert.equal(c.areaStyle, 31);
    assert.ok(c.fx.shadow, 'the chart has a shadow');
    assert.equal(c.plot.fill, '#F2F6FC');
    assert.deepEqual(c.textFx.fill.color, [0xFF, 0xE9, 0xA8]);
    await app.capture('09-chart-formatted');
    await press('chartFormat.selection.resetToMatchStyle');
    await settle(400);
    c = await chartOf();
    assert.deepEqual([c.area, c.plot, c.fx, c.textFx], [undefined, undefined, undefined, undefined]);
    await app.capture('10-chart-reset');

    // ---- Sparkline: points, marker colours, styles, axis, group ----
    await exec('insert.sparkline', {range: 'B2:D2', location: 'H2'});
    await exec('insert.sparkline', {range: 'B3:D3', location: 'H3', type: 'column'});
    await select('H2');
    await exec('object.select', {});
    await settle(400);
    await app.rpc('ui.tab', {doc, id: 'sparkline'});
    await settle(300);
    const sids = await idsOf();
    for (const id of ['sparkline.show.highPoint', 'sparkline.show.lowPoint', 'sparkline.show.negativePoints', 'sparkline.show.firstPoint', 'sparkline.show.lastPoint', 'sparkline.style.gallery', 'sparkline.style.markerColor',
      'sparkline.group.axis', 'sparkline.group.group', 'sparkline.group.ungroup']) assert.ok(sids.has(id), `${id} is on the Sparkline tab`);
    await app.capture('11-sparkline-tab');
    await press('sparkline.show.highPoint');
    await press('sparkline.show.lowPoint');
    await press('sparkline.show.lastPoint');
    await openMenu('sparkline', 'sparkline.style.gallery');
    await app.capture('12-sparkline-styles');
    await closeMenu('sparkline.style.gallery');
    await press('sparkline.style.gallery', 25);
    await openMenu('sparkline', 'sparkline.group.axis');
    await app.rpc('ui.menu', {doc, control: 'sparkline.group.axis.min'});
    await settle(300);
    await app.capture('13-sparkline-axis-menu');
    await closeMenu('sparkline.group.axis');
    await press('sparkline.group.axis.show-axis');
    let sp = (await sheet()).sparklines.find(s => s.cell === 'H2');
    assert.deepEqual([sp.flags.high, sp.flags.low, sp.flags.last, sp.style, sp.axis.show], [true, true, true, 25, true]);
    await select('H2', 'H3');
    await press('sparkline.group.group');
    await settle(400);
    const grouped = (await sheet()).sparklines;
    assert.ok(grouped[0].group && grouped[0].group === grouped[1].group, 'the two are grouped');
    assert.equal(grouped[1].style, 25, 'the group takes the first look');
    await app.capture('14-sparklines-grouped');
    await press('sparkline.group.ungroup');
    assert.equal(((await sheet()).sparklines)[0].group, undefined);

    // ---- Picture Format ----
    await exec('insert.picture', {base64: PHOTO, at: 'B14', width: 192, height: 144, alt: 'Hills and sun'});
    await settle(600);
    await app.rpc('ui.tab', {doc, id: 'picture-format'});
    await settle(300);
    const pids = await idsOf();
    for (const id of ['pictureFormat.adjust.removeBackground', 'pictureFormat.adjust.corrections', 'pictureFormat.adjust.color', 'pictureFormat.adjust.artisticEffects', 'pictureFormat.adjust.transparency', 'pictureFormat.adjust.compress',
      'pictureFormat.adjust.change', 'pictureFormat.adjust.reset', 'pictureFormat.styles.gallery', 'pictureFormat.styles.border', 'pictureFormat.styles.effects', 'pictureFormat.accessibility.altText', 'pictureFormat.size.crop']) assert.ok(pids.has(id), `${id} is on Picture Format`);
    await app.capture('15-picture-format-tab');
    await openMenu('picture-format', 'pictureFormat.adjust.corrections');
    await app.capture('16-corrections-gallery');
    await closeMenu('pictureFormat.adjust.corrections');
    await press('pictureFormat.adjust.corrections', 'brightness=20,contrast=20');
    await openMenu('picture-format', 'pictureFormat.adjust.color');
    await app.capture('17-color-gallery');
    await closeMenu('pictureFormat.adjust.color');
    await openMenu('picture-format', 'pictureFormat.adjust.artisticEffects');
    await app.capture('18-artistic-effects-gallery');
    await closeMenu('pictureFormat.adjust.artisticEffects');
    await press('pictureFormat.adjust.artisticEffects', 'blur');
    await settle(700);
    let pic = ((await sheet()).images ?? [])[0];
    assert.equal(pic.look.effect, 'blur');
    assert.equal(pic.adjust.brightness, 20);
    await app.capture('19-blurred-brighter');
    await press('pictureFormat.adjust.artisticEffects', 'none');
    await openMenu('picture-format', 'pictureFormat.styles.gallery');
    await app.capture('20-picture-styles-gallery');
    await closeMenu('pictureFormat.styles.gallery');
    await press('pictureFormat.styles.gallery', 'reflectedOval');
    await settle(700);
    await app.capture('21-reflected-oval');
    await press('pictureFormat.styles.gallery', 'metalRoundedRectangle');
    await openMenu('picture-format', 'pictureFormat.styles.effects');
    await app.rpc('ui.menu', {doc, control: 'pictureFormat.styles.effects.glow'});
    await settle(300);
    await app.capture('22-picture-effects-menu');
    await closeMenu('pictureFormat.styles.effects');
    await press('pictureFormat.styles.effects.glow.8-pt');
    await press('pictureFormat.size.crop.aspect-ratio.1-1');
    await settle(700);
    pic = ((await sheet()).images ?? [])[0];
    assert.deepEqual([pic.geom, !!pic.fx.glow, Math.abs(pic.anchor.width - pic.anchor.height) <= 1], ['roundRect', true, true]);
    await app.capture('23-rounded-glow-square');
    await press('pictureFormat.adjust.reset.reset-picture');
    await settle(400);
    pic = ((await sheet()).images ?? [])[0];
    assert.deepEqual([pic.geom, pic.fx, pic.crop, pic.adjust], [undefined, undefined, undefined, undefined]);

    // ---- Shape Format ----
    await exec('insert.shape', {kind: 'roundedRectangle', at: 'J14', width: 160, height: 70, text: 'Quarterly results'});
    await settle(500);
    await app.rpc('ui.tab', {doc, id: 'shape-format'});
    await settle(300);
    const hids = await idsOf();
    for (const id of ['shapeFormat.insertShapes.editShape', 'shapeFormat.styles.gallery', 'shapeFormat.styles.effects', 'shapeFormat.wordArt.gallery', 'shapeFormat.wordArt.textFill', 'shapeFormat.wordArt.textOutline',
      'shapeFormat.wordArt.textEffects', 'shapeFormat.accessibility.altText']) assert.ok(hids.has(id), `${id} is on Shape Format`);
    await app.capture('24-shape-format-tab');
    await openMenu('shape-format', 'shapeFormat.styles.gallery');
    await app.capture('25-shape-styles-gallery');
    await closeMenu('shapeFormat.styles.gallery');
    await press('shapeFormat.styles.gallery', 32);
    await openMenu('shape-format', 'shapeFormat.wordArt.gallery');
    await app.capture('26-wordart-gallery');
    await closeMenu('shapeFormat.wordArt.gallery');
    await press('shapeFormat.wordArt.gallery', 'glowing');
    await openMenu('shape-format', 'shapeFormat.insertShapes.editShape');
    await app.rpc('ui.menu', {doc, control: 'shapeFormat.insertShapes.editShape.change-shape'});
    await settle(300);
    await app.capture('27-change-shape-menu');
    await closeMenu('shapeFormat.insertShapes.editShape');
    await press('shapeFormat.insertShapes.editShape.change-shape.ellipse');
    await press('shapeFormat.styles.effects.reflection.half');
    await settle(700);
    const sh = ((await sheet()).shapes ?? [])[0];
    assert.deepEqual([sh.kind, sh.style, !!sh.textFx.glow, !!sh.fx.reflection, sh.text], ['ellipse', 32, true, true, 'Quarterly results']);
    await app.capture('28-shape-ellipse-wordart-reflection');
  } finally {
    await t.app.close();
  }
});
