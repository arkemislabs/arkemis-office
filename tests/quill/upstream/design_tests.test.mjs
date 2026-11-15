// Ported from wordcraft crates/engine/src/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): the Design tab's tests. Each test
// names the Rust test it ports. `border_sides_apply_exactly` is ported for its page-border half
// (the paragraph half is U:quill/para's); `custom colours` keeps the design.pageColor lines of
// the test around tests.rs:6916.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from '../format-fixture.mjs';
import {resolveChar, style} from '../../../core/quill/model/styles.mjs';
import {read as readDocx} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';

const sheet = q => q.t.content.styles;
const getStyle = (q, id) => sheet(q).styles.find(x => x.id === id) ?? null;
const styleSize = (q, id) => resolveChar(sheet(q), id, {}).size;

test('border_sides_apply_exactly (page borders)', async () => {
  const q = await quill('Boxed');
  await q.exec('design.pageBorders', {sides: {top: {style: 'dashed', width: 3}}, applyTo: 'document'});
  const pb = q.t.content.lastSection.pageBorders;
  assert.deepEqual([pb.top.style, pb.top.width], ['dashed', 3]);
  assert.ok(!pb.left || pb.left.style === 'none', 'only the top');
  await q.exec('design.pageBorders', {kind: 'box', style: 'thick'});
  assert.equal(q.t.content.lastSection.pageBorders.left.style, 'thick');
  await q.exec('design.pageBorders', {sides: {}});
  assert.equal(q.t.content.lastSection.pageBorders, null);
});

test('custom colours: design.pageColor takes RRGGBB (tests.rs:6916)', async () => {
  const q = await quill('x');
  await q.exec('design.pageColor', {color: '123ABC'});
  assert.deepEqual(q.t.content.settings.pageColor, [0x12, 0x3a, 0xbc]);
});

test('style_set_keeps_imported_styles_latent_styles_and_defaults', async () => {
  for (const name of ['basic', 'lines', 'shaded', 'casual', 'centered', 'minimalist', 'title']) {
    const q = await quill('x', c => {
      const normal = c.styles.styles.find(x => x.id === 'Normal');
      const body = {...structuredClone(normal), id: 'BodyText', name: 'Body Text', builtin: true, basedOn: 'Normal', chr: {...normal.chr, size: 20, color: {Rgb: [255, 0, 0]}}};
      const grid = style({id: 'GridTable4', name: 'Grid Table 4', kind: 'table', builtin: true});
      c.styles.styles.push(body, grid);
      c.styles.latentStyles = '<w:latentStyles/>';
      c.styles.defaultChr = {...c.styles.defaultChr, lang: 'de-DE', size: 11};
      return c;
    });
    const body = structuredClone(getStyle(q, 'BodyText')), grid = structuredClone(getStyle(q, 'GridTable4'));
    await q.exec('design.styleSet', {name});
    assert.deepEqual(getStyle(q, 'BodyText'), body, `${name}: BodyText`);
    assert.deepEqual(getStyle(q, 'GridTable4'), grid, `${name}: GridTable4`);
    assert.equal(sheet(q).latentStyles, '<w:latentStyles/>', name);
    assert.equal(sheet(q).defaultChr.lang, 'de-DE', name);
    assert.equal(sheet(q).defaultChr.size, 11, name);
    assert.equal(sheet(q).styles.filter(x => x.id === 'Heading1').length, 1, name);
    const back = await readDocx(await writeDocx(q.t.content));
    assert.ok(back.styles.styles.some(x => x.id === 'BodyText'), `${name}: BodyText after round trip`);
  }
  const q = await quill('x');
  await q.exec('design.styleSet', {name: 'title'});
  assert.equal(getStyle(q, 'Title').chr.size, 36);
});

test('scale_font_sizes_adds_points_to_every_style', async () => {
  const q = await quill('Title\nHeading\nBody text');
  const ids = sheet(q).styles.map(x => x.id);
  const before = ids.map(i => styleSize(q, i));
  const base = resolveChar(sheet(q), null, {}).size;
  const runs = JSON.stringify(q.t.content.body);
  await q.exec('design.scaleFontSizes', {delta: 2});
  ids.forEach((id, i) => assert.equal(styleSize(q, id), before[i] + 2, id));
  assert.equal(resolveChar(sheet(q), null, {}).size, base + 2);
  assert.equal(JSON.stringify(q.t.content.body), runs, 'runs untouched');
  await q.t.undo();
  ids.forEach((id, i) => assert.equal(styleSize(q, id), before[i], `undo ${id}`));
});

test('scale_font_sizes_percent_and_clamp_and_errors', async () => {
  const q = await quill('x');
  const n = styleSize(q, 'Normal');
  await q.exec('design.scaleFontSizes', {percent: 10});
  assert.equal(styleSize(q, 'Normal'), Math.round(n * 1.1 * 2) / 2);
  await q.exec('design.scaleFontSizes', {delta: -500});
  assert.equal(styleSize(q, 'Normal'), 1);
  for (const bad of [{}, {delta: 1e9}, {percent: -100}, {percent: 1e9}, {delta: 'x'}, {delta: 0}, {percent: 0}, {delta: 1, percent: 10},
    {delta: 2, percent: 'x'}, {percent: 10, delta: null}]) {
    await assert.rejects(() => q.exec('design.scaleFontSizes', bad), undefined, JSON.stringify(bad));
  }
});

test('scale_font_sizes_reaches_char_table_and_cs_sizes_and_unset_default', async () => {
  const q = await quill('x', c => {
    const sh = c.styles;
    sh.defaultChr = {...sh.defaultChr};
    delete sh.defaultChr.size;
    sh.defaultChr.sizeCs = 10;
    sh.styles.push(style({id: 'Big', name: 'Big', kind: 'character', chr: {size: 20, sizeCs: 22}}));
    sh.styles.push(style({id: 'Grid', name: 'Grid', kind: 'table', table: {headerChr: {size: 14}, regions: {band2Horz: {chr: {size: 8}, fill: null, borders: null, align: null, vAlign: null}}}}));
    return c;
  });
  await q.exec('design.scaleFontSizes', {delta: 2});
  const st = sheet(q);
  assert.equal(st.defaultChr.size, 13, 'unset default is 11 pt, made explicit');
  assert.equal(st.defaultChr.sizeCs, 12);
  const big = st.styles.find(x => x.id === 'Big');
  assert.deepEqual([big.chr.size, big.chr.sizeCs], [22, 24]);
  const grid = st.styles.find(x => x.id === 'Grid').table;
  assert.equal(grid.headerChr.size, 16);
  assert.equal(grid.regions.band2Horz.chr.size, 10);
});

