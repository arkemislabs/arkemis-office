// U:prism/smartart: SmartArt (insert.smartArt, the smartArt.* outline commands, the dialog) and its shapes.
//
// 1. deckcraft: crates/engine/src/cmd/smartart.rs and smartart/*.rs. PowerPoint: Insert > SmartArt, SmartArt Design.
// 2. Ours: core/prism/commands/smartart.mjs, lib/smartart.mjs, dialogs/smartart.mjs.
// 3. These tests and tests/e2e/prism/smartart.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import smartart from '../../core/prism/commands/smartart.mjs';
import dialog from '../../core/prism/dialogs/smartart.mjs';
import {withNew, curSlide} from './upstream/text_deck.mjs';
import {expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {exportPptx} from '../../core/prism/formats/pptx-write.mjs';
import {importPptx} from '../../core/prism/formats/pptx-read.mjs';
import {bodyText} from '../../core/prism/model/text.mjs';
import {xfrmOf} from '../../core/prism/model/doc.mjs';
import insert from '../../core/prism/commands/insert.mjs';
import JSZip from 'jszip';
import {LAYOUT_IDS, STYLE_IDS, normalize, nodesFromLines, groups, addNode, removeNode, promote, demote, thumb, build} from '../../core/prism/lib/smartart.mjs';

const TAB = String.fromCharCode(9);
const deck = async () => {
  const t = await withNew({extra: [smartart]});
  await t.exec('slide.go', {index: 0});
  return t;
};
const graphic = t => curSlide(t).shapes.find(s => s.diagram);
const texts = g => g.kind.children.filter(c => c.text).map(c => bodyText(c.text));

test('the outline: levels are normalised, lines read leading tabs, groups gather sub-points', () => {
  assert.deepEqual(normalize([{text: 'a', level: 3}, {text: 'b', level: 5}, {text: 'c', level: 0}]).map(n => n.level), [0, 1, 0]);
  const nodes = nodesFromLines(['One', `${TAB}Under one`, `${TAB}${TAB}Deeper`, 'Two']);
  assert.deepEqual(nodes.map(n => n.level), [0, 1, 2, 0]);
  assert.deepEqual(groups(nodes), [[0, 1, 2], [3]]);
  assert.deepEqual(addNode(nodes, 0, 'after', 'x').nodes.map(n => n.text), ['One', 'Under one', 'Deeper', 'x', 'Two'], 'after the subtree');
  assert.equal(addNode(nodes, 0, 'below', 'y').nodes[1].level, 1);
  assert.deepEqual(removeNode(nodes, 0).map(n => [n.text, n.level]), [['Under one', 0], ['Deeper', 1], ['Two', 0]], 'sub-points move up');
  assert.deepEqual(promote(nodes, 1).map(n => n.level), [0, 0, 1, 0]);
  assert.equal(promote(nodes, 0), null);
  assert.deepEqual(demote(nodes, 3).map(n => n.level), [0, 1, 2, 1]);
  assert.equal(demote(nodes, 0), null);
});

test('every layout draws shapes inside its area', () => {
  const nodes = nodesFromLines(['One', `${TAB}detail`, 'Two', 'Three', 'Four']);
  for (const kind of LAYOUT_IDS) {
    const items = thumb(kind, nodes);
    assert.ok(items.length >= 3, `${kind} draws`);
    for (const it of items) assert.ok(it.x.x >= -1 && it.x.y >= -1 && it.x.x + it.x.w <= 161 && it.x.y + it.x.h <= 101, `${kind}: ${JSON.stringify(it.x)} inside`);
  }
});

test('insert.smartArt makes a selected group with a diagram and its shapes; undo removes it', async () => {
  const t = await deck();
  await expectUndoRoundTrip(t, 'insert.smartArt', {kind: 'process', items: ['Plan', 'Build', 'Ship']});
  const g = graphic(t);
  assert.equal(g.kind.type, 'group');
  assert.equal(g.diagram.kind, 'process');
  assert.deepEqual(texts(g), ['Plan', 'Build', 'Ship']);
  assert.ok(g.kind.children.length >= 5, 'three shapes and two arrows');
  assert.equal(g.name, 'Basic Process');
  await assert.rejects(t.exec('insert.smartArt', {kind: 'spiral'}), /unknown layout/);
});

test('the Text Pane commands change the nodes and redraw the shapes inside the same rectangle', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'list', items: ['A', 'B']});
  const box = {...graphic(t).xfrm};
  await t.exec('smartArt.addNode', {index: 1, position: 'after', text: 'C'});
  assert.deepEqual(graphic(t).diagram.nodes.map(n => n.text), ['A', 'B', 'C']);
  assert.deepEqual(texts(graphic(t)), ['A', 'B', 'C']);
  await t.exec('smartArt.addNode', {index: 0, position: 'below', text: 'sub'});
  assert.equal(graphic(t).diagram.nodes[1].level, 1);
  await t.exec('smartArt.setNodes', {index: 0, text: 'Alpha'});
  assert.equal(graphic(t).diagram.nodes[0].text, 'Alpha');
  await expectUndoRoundTrip(t, 'smartArt.removeNode', {index: 1});
  assert.deepEqual(graphic(t).xfrm, box, 'the graphic keeps its size and place');
  const out = await t.exec('smartArt.nodes', {});
  assert.ok((out.result ?? out).nodes.length >= 3);
  await t.exec('smartArt.setNodes', {lines: ['One', `${TAB}Two`, 'Three']});
  assert.deepEqual(graphic(t).diagram.nodes.map(n => n.level), [0, 1, 0]);
  await expectUndoRoundTrip(t, 'smartArt.promote', {index: 1});
  assert.deepEqual(graphic(t).diagram.nodes.map(n => n.level), [0, 0, 0]);
  await t.exec('smartArt.demote', {index: 2});
  assert.deepEqual(graphic(t).diagram.nodes.map(n => n.level), [0, 0, 1]);
  await t.exec('smartArt.promote', {});
  assert.deepEqual(graphic(t).diagram.nodes.map(n => n.level), [0, 0, 0], 'no index: the last node');
  await assert.rejects(t.exec('smartArt.promote', {index: 0}), /not possible/);
});

test('Change Layout and Change Colors; Convert to Text and Convert to Shapes', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'process', items: ['A', 'B', 'C', 'D']});
  await expectUndoRoundTrip(t, 'smartArt.layout', {kind: 'cycle'});
  assert.equal(graphic(t).diagram.kind, 'cycle');
  await t.exec('smartArt.setNodes', {lines: ['Boss', `${TAB}Left`, `${TAB}Right`]});
  await t.exec('smartArt.layout', {kind: 'hierarchy'});
  assert.ok(graphic(t).kind.children.some(c => c.geom?.name === 'line'), 'connectors of the tree');
  await t.exec('smartArt.colors', {colors: 'accent2'});
  const fills = graphic(t).kind.children.filter(c => c.text).map(c => c.fill.color.base.slot);
  assert.ok(fills.every(f => f === 'accent2'));
  await assert.rejects(t.exec('smartArt.colors', {colors: 'neon'}), /unknown colours/);
  const id = graphic(t).id;
  await t.exec('smartArt.toShapes', {});
  const plain = curSlide(t).shapes.find(s => s.id === id);
  assert.equal(plain.diagram, undefined);
  assert.equal(plain.kind.type, 'group');
  const u = await deck();
  await u.exec('insert.smartArt', {kind: 'list', items: ['Top', `${TAB}sub`]});
  await u.exec('smartArt.toText', {});
  const box = curSlide(u).shapes.find(s => s.textBox);
  assert.equal(bodyText(box.text), 'Top\nsub');
  assert.equal(box.text.paragraphs[1].level, 1);
});

test('a SmartArt graphic is saved as real diagram parts and read back as the same graphic', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'matrix', items: ['Q1', 'Q2', 'Q3', 'Q4']});
  await t.exec('smartArt.style', {style: 'polished'});
  await t.exec('smartArt.colors', {colors: 'accent3Grad'});
  const bytes = await exportPptx(t.content);
  const zip = await JSZip.loadAsync(bytes);
  for (const part of ['data', 'layout', 'quickStyle', 'colors', 'drawing']) assert.ok(zip.file(`ppt/diagrams/${part}1.xml`), `ppt/diagrams/${part}1.xml`);
  const types = await zip.file('[Content_Types].xml').async('string');
  for (const ct of ['diagramData+xml', 'diagramLayout+xml', 'diagramStyle+xml', 'diagramColors+xml', 'diagramDrawing+xml']) assert.ok(types.includes(ct), ct);
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(slide, /<p:graphicFrame>[\s\S]*drawingml\/2006\/diagram[\s\S]*<dgm:relIds/, 'a graphic frame naming the diagram parts');
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  for (const k of ['diagramData', 'diagramLayout', 'diagramQuickStyle', 'diagramColors', 'diagramDrawing']) assert.ok(rels.includes(k), k);
  const data = await zip.file('ppt/diagrams/data1.xml').async('string');
  assert.match(data, /qsTypeId="[^"]*3d1"/);
  assert.match(data, /csTypeId="[^"]*accent3_3"/);
  assert.match(data, /layout\/matrix3/);
  const back = await importPptx(bytes);
  const g = back.slides[0].shapes.find(x => x.diagram);
  assert.ok(g, 'it is a SmartArt graphic again');
  assert.equal(g.kind.type, 'group');
  assert.deepEqual([g.diagram.kind, g.diagram.style, g.diagram.colors, g.diagram.imported], ['matrix', 'polished', 'accent3Grad', true]);
  assert.deepEqual(g.diagram.nodes.map(n => [n.text, n.level]), [['Q1', 0], ['Q2', 0], ['Q3', 0], ['Q4', 0]]);
  assert.deepEqual(texts(g), ['Q1', 'Q2', 'Q3', 'Q4'], 'the drawing comes back as its shapes');
  assert.ok(g.diagram.layoutXml?.includes('matrix3') && g.diagram.styleXml && g.diagram.colorsXml, 'the layout, style and colour parts are kept');
  // Written again untouched, the parts are the ones it came with.
  const again = await JSZip.loadAsync(await exportPptx(back));
  assert.equal(await again.file('ppt/diagrams/layout1.xml').async('string'), g.diagram.layoutXml);
});

test('the outline, assistants, titles, pictures, direction and branch layout survive the diagram parts', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'nameTitleOrgChart', nodes: [{text: 'CEO', level: 0, title: 'Chief'}, {text: 'Aide', level: 1, assistant: true}, {text: 'CTO', level: 1}, {text: 'Dev', level: 2}]});
  await t.exec('smartArt.branch', {branch: 'left'});
  await t.exec('smartArt.rtl', {});
  const back = await importPptx(await exportPptx(t.content));
  const g = back.slides[0].shapes.find(x => x.diagram);
  assert.deepEqual(g.diagram.nodes.map(n => [n.text, n.level, !!n.assistant, n.title ?? '']), [['CEO', 0, false, 'Chief'], ['Aide', 1, true, ''], ['CTO', 1, false, ''], ['Dev', 2, false, '']]);
  assert.deepEqual([g.diagram.kind, g.diagram.rtl, g.diagram.hang], ['nameTitleOrgChart', true, 'left']);
  const u = await deck();
  await u.exec('insert.smartArt', {kind: 'pictureList', items: ['One', 'Two']});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await u.exec('smartArt.picture', {index: 0, data: png, name: 'dot.png'});
  const zip = await JSZip.loadAsync(await exportPptx(u.content));
  assert.ok(Object.keys(zip.files).some(n => /^ppt\/media\/image\d+\.png$/.test(n)), 'the picture is a media part');
  assert.ok(zip.file('ppt/diagrams/_rels/data1.xml.rels'), 'the data part points at it');
  const again = (await importPptx(await exportPptx(u.content))).slides[0].shapes.find(x => x.diagram);
  assert.ok(again.diagram.nodes[0].picture, 'the node keeps its picture');
  assert.ok(!again.diagram.nodes[1].picture);
});

test('a drawing shape with its own text rectangle (dsp:txXfrm) lays its text out on it', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'blockList', items: ['Plan', 'Build']});
  const zip = await JSZip.loadAsync(await exportPptx(t.content));
  let drawing = await zip.file('ppt/diagrams/drawing1.xml').async('string');
  const m = /<dsp:spPr><a:xfrm><a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(drawing);
  const [x, y, w, h] = m.slice(1).map(Number);
  const pad = 254000;
  const tx = `<dsp:txXfrm><a:off x="${x + pad}" y="${y + pad}"/><a:ext cx="${w - 2 * pad}" cy="${h - 2 * pad}"/></dsp:txXfrm>`;
  drawing = drawing.replace('</dsp:sp>', `${tx}</dsp:sp>`);
  zip.file('ppt/diagrams/drawing1.xml', drawing);
  const g = (await importPptx(await zip.generateAsync({type: 'uint8array'}))).slides[0].shapes.find(c => c.diagram);
  const first = g.kind.children.find(c => c.text && bodyText(c.text) === 'Plan');
  assert.ok(first, 'the text is still on a shape');
  const inset = first.text.body.insetL ?? 0;
  const box = first.xfrm;
  assert.ok(inset >= 7.2 + 19 || box.w < w / 12700, `its text is kept inside the rectangle: inset ${inset}, box ${box.w}`);
});

test('an imported graphic keeps its drawing until it is edited, then its shapes are drawn again from the outline', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'process', items: ['A', 'B', 'C']});
  const back = await importPptx(await exportPptx(t.content));
  const g = back.slides[0].shapes.find(x => x.diagram);
  // The imported graphic takes the place of the inserted one (and its id, so it stays selected).
  const u = t;
  const slide = curSlide(u);
  g.id = graphic(u).id;
  slide.shapes.splice(slide.shapes.findIndex(x => x.diagram), 1, g);
  const before = graphic(u).kind.children.map(c => c.id).join();
  await u.exec('smartArt.addNode', {id: g.id, text: 'D'});
  const after = graphic(u);
  assert.equal(after.diagram.imported, false);
  assert.ok(after.diagram.layoutXml, 'the layout part it came with is kept: same layout');
  assert.notEqual(after.kind.children.map(c => c.id).join(), before);
  assert.deepEqual(texts(after), ['A', 'B', 'C', 'D']);
  await u.exec('smartArt.layout', {id: g.id, kind: 'cycle'});
  assert.equal(graphic(u).diagram.layoutXml, undefined, 'a new layout drops the old layout part');
});

test('text typed into a diagram shape is read back into the nodes, before a command and when it is saved', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'process', items: ['Plan', 'Build', 'Ship']});
  const g = graphic(t);
  const shapeIx = g.kind.children.findIndex(c => c.text && bodyText(c.text) === 'Build');
  const path = ['slides', 0, 'shapes', curSlide(t).shapes.indexOf(g), 'kind', 'children', shapeIx, 'text', 'paragraphs', 0, 'runs', 0, 'text'];
  let node = t.content;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path.at(-1)] = 'Test';
  assert.deepEqual((await t.exec('smartArt.nodes', {})).result.nodes.map(n => n.text), ['Plan', 'Test', 'Ship']);
  const zip = await JSZip.loadAsync(await exportPptx(t.content));
  assert.match(await zip.file('ppt/diagrams/data1.xml').async('string'), /<a:t>Test<\/a:t>/);
  await t.exec('smartArt.addNode', {text: 'More'});
  assert.deepEqual(texts(graphic(t)), ['Plan', 'Test', 'Ship', 'More'], 'the redraw keeps the typed text');
});

test('Move Up, Move Down, Right to Left, the branch Layout and Reset Graphic', async () => {
  let t = await deck();
  await t.exec('insert.smartArt', {kind: 'list', nodes: [{text: 'A', level: 0}, {text: 'a1', level: 1}, {text: 'B', level: 0}, {text: 'C', level: 0}]});
  const names = () => graphic(t).diagram.nodes.map(n => n.text);
  await expectUndoRoundTrip(t, 'smartArt.moveDown', {index: 0});
  assert.deepEqual(names(), ['B', 'A', 'a1', 'C'], 'the node takes its sub-points along');
  await assert.rejects(t.exec('smartArt.moveUp', {index: 2}), /no node above/);
  await t.exec('smartArt.moveUp', {index: 1});
  assert.deepEqual(names(), ['A', 'a1', 'B', 'C'], 'moving it back restores the order');
  await assert.rejects(t.exec('smartArt.moveUp', {index: 0}), /no node above/);
  await assert.rejects(t.exec('smartArt.moveDown', {index: 3}), /no node below/);
  t = await deck();
  await t.exec('insert.smartArt', {kind: 'process', items: ['One', 'Two', 'Three']});
  const order = () => graphic(t).kind.children.filter(s => s.text).sort((a, b) => a.xfrm.x - b.xfrm.x).map(s => bodyText(s.text));
  assert.deepEqual(order(), ['One', 'Two', 'Three']);
  await expectUndoRoundTrip(t, 'smartArt.rtl', {});
  assert.deepEqual(order(), ['Three', 'Two', 'One'], 'the graphic is mirrored');
  assert.equal((await t.exec('smartArt.rtl', {value: false})).result.rtl, false);
  assert.deepEqual(order(), ['One', 'Two', 'Three']);
  // The branch layouts are for organization charts.
  await assert.rejects(t.exec('smartArt.branch', {branch: 'left'}), /organization charts/);
  t = await deck();
  await t.exec('insert.smartArt', {kind: 'orgChart', nodes: [{text: 'Boss', level: 0}, {text: 'X', level: 1}, {text: 'Y', level: 1}, {text: 'Z', level: 1}]});
  const ys = () => graphic(t).kind.children.filter(s => s.text).map(s => Math.round(s.xfrm.y));
  assert.equal(new Set(ys()).size, 2, 'standard: a row of children');
  for (const branch of ['left', 'right', 'both']) {
    await expectUndoRoundTrip(t, 'smartArt.branch', {branch});
    await t.exec('smartArt.branch', {branch});
    const g = graphic(t);
    assert.equal(g.diagram.hang, branch);
    assert.ok(new Set(ys()).size >= (branch === 'both' ? 3 : 4), `${branch}: the children are stacked`);
    const area = g.xfrm;
    for (const c of g.kind.children) assert.ok(c.xfrm.x >= area.x - 1 && c.xfrm.x + c.xfrm.w <= area.x + area.w + 1, `${branch}: inside the width`);
  }
  await t.exec('smartArt.branch', {branch: 'standard'});
  assert.equal(graphic(t).diagram.hang, undefined);
  // Reset Graphic: colours, style, direction and branch go back; the text stays.
  await t.exec('smartArt.style', {style: 'cartoon'});
  await t.exec('smartArt.colors', {colors: 'accent2'});
  await t.exec('smartArt.rtl', {});
  await expectUndoRoundTrip(t, 'smartArt.reset', {});
  await t.exec('smartArt.reset', {});
  const d = graphic(t).diagram;
  assert.deepEqual([d.style, d.colors, d.rtl, d.hang], ['flat', 'colorful', undefined, undefined]);
  assert.deepEqual(d.nodes.map(n => n.text), ['Boss', 'X', 'Y', 'Z']);
});

test('the dialog picks a layout by category and submits it', () => {
  const v = dialog.init({});
  assert.equal(v.kind, 'process');
  const next = {...v, category: 'Cycle', ...dialog.derive({...v, category: 'Cycle'}, ['category'])};
  assert.equal(next.kind, 'cycle');
  assert.deepEqual(dialog.toCommand(next), {command: 'insert.smartArt', params: {kind: 'cycle'}});
  assert.equal(dialog.validate({kind: 'nothing'}).length, 1);
});

test('all 45 layouts of deckcraft draw, in every style, with the text of the nodes', () => {
  assert.equal(LAYOUT_IDS.length, 45);
  const nodes = nodesFromLines(['Alpha', `${TAB}one`, 'Beta', 'Gamma', `${TAB}two`, 'Delta']);
  for (const kind of LAYOUT_IDS) {
    for (const style of STYLE_IDS) {
      const d = {kind, nodes, colors: style === 'flat' ? 'range34' : 'accent2Grad', style};
      let n = 0;
      const shapes = build(d, {x: 20, y: 30, w: 600, h: 320}, () => String(++n));
      assert.ok(shapes.length >= 3, `${kind}/${style} draws`);
      for (const sh of shapes) assert.ok(Number.isFinite(sh.xfrm.x + sh.xfrm.y + sh.xfrm.w + sh.xfrm.h), `${kind}: finite boxes`);
      if (style === 'flat' && !kind.startsWith('picture')) {
        const text = shapes.filter(s => s.text).map(s => bodyText(s.text)).join(' ');
        assert.match(text, /Alpha/, `${kind} shows the first node`);
      }
    }
    assert.ok(thumb(kind).length >= 2, `${kind} has a gallery picture`);
  }
});

test('the styles paint what deckcraft does: outline, subtle, intense gradient, bevelled 3-D', () => {
  const nodes = nodesFromLines(['A', 'B', 'C']);
  const first = style => build({kind: 'process', nodes, colors: 'colorful', style}, {x: 0, y: 0, w: 400, h: 200}, () => '1').find(s => s.text);
  assert.equal(first('outline').fill.color.base.slot, 'lt1');
  assert.equal(first('outline').line.width, 2.25);
  assert.ok(first('subtle').effects.outerShadow);
  assert.equal(first('intense').fill.kind, 'gradient');
  assert.equal(first('polished').effects.bevel, 'circle');
  assert.match(first('brick').effects.raw3d, /isometricOffAxis2Top/);
  assert.equal(first('powder').text.paragraphs[0].runs[0].props.fill.color.base.slot, 'tx1', 'dark text on the pale fill');
});

test('Change Colors: colorful, ranges and gradient ranges', () => {
  const sh = colors => build({kind: 'blockList', nodes: nodesFromLines(['A', 'B', 'C', 'D']), colors, style: 'flat'}, {x: 0, y: 0, w: 400, h: 300}, () => '1').filter(s => s.text).map(s => s.fill.color);
  assert.deepEqual(sh('colorful').map(c => c.base.slot), ['accent1', 'accent2', 'accent3', 'accent4']);
  assert.deepEqual(sh('range45').map(c => c.base.slot), ['accent4', 'accent5', 'accent4', 'accent5']);
  assert.deepEqual(sh('accent3Grad').map(c => [c.base.slot, c.mods[0]?.val]), [['accent3', 100000], ['accent3', 85000], ['accent3', 70000], ['accent3', 55000]]);
});

test('a new graphic fills the empty content placeholder, else the space below the title', async () => {
  const t = await withNew({extra: [smartart]});
  await t.exec('slide.new', {layout: 'titleAndContent'});
  const content = curSlide(t).shapes.find(s => s.ph?.kind === 'obj');
  await t.exec('insert.smartArt', {kind: 'process'});
  const g = graphic(t);
  const title = curSlide(t).shapes.find(s => s.ph?.kind === 'title');
  const tb = xfrmOf(t.content, curSlide(t).id, title);
  assert.ok(g.xfrm.y >= tb.y + tb.h - 1, 'clear of the title');
  if (content) assert.ok(!curSlide(t).shapes.some(s => s.id === content.id), 'the empty content placeholder is replaced');
  const u = await withNew({extra: [smartart]});
  await u.exec('slide.new', {layout: 'titleOnly'});
  await u.exec('insert.smartArt', {kind: 'cycle'});
  const g2 = graphic(u);
  const t2 = curSlide(u).shapes.find(s => s.ph?.kind === 'title');
  const tb2 = xfrmOf(u.content, curSlide(u).id, t2);
  assert.ok(g2.xfrm.y >= tb2.y + tb2.h - 1, 'below the title of a Title Only slide');
  assert.ok(g2.xfrm.y + g2.xfrm.h <= 541, 'on the slide');
});

test('SmartArt Styles, pictures and Convert to SmartArt', async () => {
  const t = await deck();
  await t.exec('insert.smartArt', {kind: 'pictureList', items: ['One', 'Two']});
  await expectUndoRoundTrip(t, 'smartArt.style', {style: 'cartoon'});
  assert.equal(graphic(t).diagram.style, 'cartoon');
  await assert.rejects(t.exec('smartArt.style', {style: 'glass'}), /unknown style/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
  await expectUndoRoundTrip(t, 'smartArt.picture', {index: 1, data: png, name: 'dot.png'});
  assert.ok(graphic(t).diagram.nodes[1].picture, 'the node has a picture');
  assert.ok(graphic(t).kind.children.some(c => c.fill?.kind === 'picture'), 'the placeholder shows it');
  await t.exec('smartArt.picture', {index: 1, reset: true});
  assert.equal(graphic(t).diagram.nodes[1].picture, undefined);
  // Convert to SmartArt turns a text box into a graphic in its place, one node per paragraph.
  const u = await withNew({extra: [smartart, insert]});
  await u.exec('slide.go', {index: 0});
  await u.exec('insert.textBox', {rect: [60, 60, 200, 80], text: 'Plan\nBuild\nShip'});
  const box = curSlide(u).shapes.find(s => s.textBox);
  const before = curSlide(u).shapes.length;
  await expectUndoRoundTrip(u, 'smartArt.fromText', {kind: 'process'});
  const g = graphic(u);
  assert.deepEqual(g.diagram.nodes.map(n => n.text), ['Plan', 'Build', 'Ship']);
  assert.equal(curSlide(u).shapes.length, before);
  assert.ok(!curSlide(u).shapes.some(s => s.id === box.id), 'in the place of the text box');
  assert.ok(g.xfrm.w >= 479, 'a small box grows to a size a diagram can use');
  assert.ok(g.xfrm.x >= 0 && g.xfrm.x + g.xfrm.w <= 960 && g.xfrm.y + g.xfrm.h <= 540, 'inside the slide');
  assert.ok(g.xfrm.h >= 540 * 0.35 && g.xfrm.y > 60, 'in the content frame, not at the small box');
});

test('several top-level nodes are separate trees (deckcraft joins only parent and child), and an empty title draws no strip', () => {
  const nodes = ['Discover', 'Interviews', 'Design', 'Build'].map((text, i) => ({text, level: i === 1 ? 1 : 0}));
  for (const kind of ['orgChart', 'nameTitleOrgChart']) {
    let n = 0;
    const shapes = build({kind, nodes, colors: 'colorful', style: 'flat'}, {x: 0, y: 0, w: 800, h: 400}, () => String(++n));
    const boxes = shapes.filter(s => s.text && s.geom?.name !== 'line');
    assert.equal(boxes.length, 4, `${kind}: a box per node and no empty title strips`);
    const joined = b => shapes.some(s => s.geom?.name === 'line' && Math.abs(s.xfrm.x + s.xfrm.w / 2 - (b.xfrm.x + b.xfrm.w / 2)) < 1.5 && Math.abs(s.xfrm.y + s.xfrm.h - b.xfrm.y) < 1.5);
    assert.ok(joined(boxes.find(x => bodyText(x.text) === 'Interviews')), `${kind}: a child is joined to its parent`);
    for (const r of ['Design', 'Build']) assert.ok(!joined(boxes.find(x => bodyText(x.text) === r)), `${kind}: ${r} is a root of its own, not joined to Discover`);
  }
});

test('an organization chart takes assistants beside their parent and a name and title box', () => {
  const nodes = [{text: 'CEO', level: 0, title: 'Chief'}, {text: 'Aide', level: 1, assistant: true}, {text: 'CTO', level: 1}, {text: 'CFO', level: 1}];
  for (const kind of ['orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart']) {
    let n = 0;
    const shapes = build({kind, nodes, colors: 'colorful', style: 'flat'}, {x: 0, y: 0, w: 600, h: 300}, () => String(++n));
    assert.ok(shapes.filter(s => s.geom?.name === 'line').length >= 4, `${kind} joins its boxes`);
    const aide = shapes.find(s => s.text && bodyText(s.text) === 'Aide');
    const ceo = shapes.find(s => s.text && bodyText(s.text) === 'CEO');
    assert.ok(aide.xfrm.y > ceo.xfrm.y, 'the assistant is on a row of its own');
    if (kind === 'nameTitleOrgChart') assert.ok(shapes.some(s => s.text && bodyText(s.text) === 'Chief'), 'the title box');
  }
});
