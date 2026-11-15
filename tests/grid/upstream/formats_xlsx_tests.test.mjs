// Ported from gridcraft crates/xlsx/src/fmla.rs `mod tests` and crates/xlsx/src/tests/roundtrip.rs
// (package_structure, iterative_calculation_settings_roundtrip, empty_workbook_roundtrip,
// cell_text_carriage_returns_survive_xlsx_roundtrip, spill_and_calc_errors_are_cached_as_value_errors,
// implicit_intersection_is_written_as_single, scroll_position_round_trips_with_and_without_frozen_panes,
// let_lambda_parameters_drop_xlpm_on_read, default_font_survives_a_round_trip) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, plus a full schema-2 round trip of every part this
// unit reads and writes.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: read.rs/sheet_read.rs/styles.rs read a workbook's cells (shared, array and dynamic
//    formulas), styles (Normal = xf 0), merges, sizes, names, tables, conditional formats,
//    validations, hyperlinks, notes, panes and protection; write.rs/sheet_write.rs write them back
//    with cached values, `_xlfn.` spellings and dynamic-array metadata. Excel opens such a file
//    with the same content (new functions keep their `_xlfn.` prefix, spills keep `cm="1"`).
// 2. Ours reads into and writes from the schema-2 workbook (core/grid/formats/xlsx-*.mjs); the
//    values are the calculation engine's, so they are what the sheet shows.
// 3. These tests; the File > Open / Save As flow is tests/e2e/grid/formats-files.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {readXlsx, parseXml, fromFile, colWidthToPx} from '../../../core/grid/formats/xlsx-read.mjs';
import {writeXlsx, toFile, pxToColWidth} from '../../../core/grid/formats/xlsx-write.mjs';
import {validateContent} from '../../../core/grid/schema.mjs';
import {engineFor} from '../../../core/grid/model/calc.mjs';
import {cellAt} from '../../../core/grid/model/store.mjs';
import {styleAt} from '../../../core/grid/model/workbook.mjs';
import {parseCell} from '../../../core/grid/lib/addr.mjs';

const wb = (blocks = {}, extra = {}, sheet = {}) => ({sheets: [{id: 's1', name: 'Sheet1', blocks: {0: blocks}, ...sheet}], activeSheetId: 's1', styles: [{}], names: [], ...extra});
const at = (content, ref, si = 0) => { const c = parseCell(ref); return cellAt(content.sheets[si], c.row, c.col); };
const val = (content, ref, si = 0) => { const c = parseCell(ref); return engineFor(content).sheetValue(si, c.row, c.col); };
async function part(bytes, name) { return (await JSZip.loadAsync(bytes)).file(name)?.async('string') ?? null; }

// fmla.rs tests

test('spill_references', () => {
  assert.equal(toFile('SUM(Sheet1!$D$1#)+B2#'), 'SUM(_xlfn.ANCHORARRAY(Sheet1!$D$1))+_xlfn.ANCHORARRAY(B2)');
  assert.equal(fromFile('SUM(_xlfn.ANCHORARRAY(Sheet1!$D$1))+_xlfn.ANCHORARRAY(B2)'), 'SUM(Sheet1!$D$1#)+B2#');
});

test('implicit_intersection', () => {
  assert.equal(toFile('SUM(@A1:A3*B1:B3)'), 'SUM(_xlfn.SINGLE(A1:A3)*B1:B3)');
  assert.equal(toFile('@A1:A3*2'), '_xlfn.SINGLE(A1:A3)*2');
  assert.equal(fromFile('_xlfn.SINGLE(A1:A3)*2'), '@A1:A3*2');
  assert.equal(fromFile('SUM(_xlfn.SINGLE(A1:A3)*B1:B3)'), 'SUM(@A1:A3*B1:B3)');
});

test('trim_references', () => {
  assert.equal(toFile('SUM(A1:.E10)+SUM(Data!A.:A)'), 'SUM(_xlfn.TRIMRANGE(A1:E10,2,2))+SUM(_xlfn.TRIMRANGE(Data!A:A,1,1))');
});

test('prefixes', () => {
  assert.equal(toFile('XLOOKUP(1,A:A,B:B)+SUM(A1)'), '_xlfn.XLOOKUP(1,A:A,B:B)+SUM(A1)');
  assert.equal(toFile('FILTER(A1:A3,B1:B3)'), '_xlfn._xlws.FILTER(A1:A3,B1:B3)');
  assert.equal(fromFile('_xlfn.XLOOKUP(1,A:A,B:B)'), 'XLOOKUP(1,A:A,B:B)');
  assert.equal(toFile('IFS(A1>0,1)'), '_xlfn.IFS(A1>0,1)');
  assert.equal(toFile('GROUPBY(A1:A3,B1:B3,"SUM")'), '_xlfn.GROUPBY(A1:A3,B1:B3,"SUM")');
});

test('let_lambda_params', () => {
  assert.equal(toFile('LET(x,1,x+1)'), '_xlfn.LET(_xlpm.x,1,_xlpm.x+1)');
  assert.equal(toFile('LET(x,A1*2,y,x+1,x*y)'), '_xlfn.LET(_xlpm.x,A1*2,_xlpm.y,_xlpm.x+1,_xlpm.x*_xlpm.y)');
  assert.equal(toFile('LAMBDA(a,b,a^2+b)(3,4)'), '_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a^2+_xlpm.b)(3,4)');
  assert.equal(toFile('LET(x,1,x)+x'), '_xlfn.LET(_xlpm.x,1,_xlpm.x)+x');
  assert.equal(fromFile('_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'), 'LET(x,1,x+1)');
  assert.equal(fromFile('_xlfn.LAMBDA(_xlpm.a,_xlpm.a*2)(3)'), 'LAMBDA(a,a*2)(3)');
});

test('this_row_long_form', () => {
  const file = toFile('Sales[@Units]*Sales[@[Unit Price]]');
  assert.ok(!file.includes('[@'), file);
  assert.equal(fromFile(file), 'Sales[@Units]*Sales[@[Unit Price]]');
});

test('widths', () => {
  assert.equal(colWidthToPx(9.140625), 64);
  assert.equal(pxToColWidth(64), 9.140625);
  for (const px of [5, 12, 13, 50, 100, 255, 1000]) assert.equal(colWidthToPx(pxToColWidth(px)), px, String(px));
});

// roundtrip.rs tests

test('empty_workbook_roundtrip', async () => {
  const back = await readXlsx(await writeXlsx(wb()), {});
  validateContent(back);
  assert.equal(back.sheets.length, 1);
  assert.equal(back.sheets[0].name, 'Sheet1');
  assert.equal(back.styles.length, 1);
  assert.equal(back.sheets[0].defaultColWidth, undefined);
  assert.equal(back.sheets[0].defaultRowHeight, undefined);
});

test('package_structure', async () => {
  const content = wb({A1: {v: 'x'}, B1: {f: 'XLOOKUP(1,A:A,A:A)'}, C1: {f: 'SEQUENCE(3)', d: true}}, {names: [{name: 'N', formula: 'XLOOKUP(1,Sheet1!A:A,Sheet1!A:A)'}]},
    {notes: {A1: {text: 'n', author: 'a'}}, tables: [{name: 'T', range: 'E1:F3', headerRow: true, columns: [{name: 'a'}, {name: 'b'}]}]});
  const bytes = await writeXlsx(content);
  const z = await JSZip.loadAsync(bytes);
  const names = Object.keys(z.files);
  assert.equal(names[0], '[Content_Types].xml');
  for (const n of ['_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/theme/theme1.xml',
    'xl/sharedStrings.xml', 'xl/metadata.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/tables/table1.xml', 'xl/comments1.xml',
    'xl/drawings/vmlDrawing1.vml']) assert.ok(names.includes(n), `missing ${n}`);
  const texts = {};
  for (const n of names) if (/\.(xml|rels|vml)$/.test(n)) { texts[n] = await z.file(n).async('string'); parseXml(texts[n]); }
  const ct = parseXml(texts['[Content_Types].xml']);
  for (const o of ct.kids('Override')) assert.ok(names.includes(o.attr('PartName').replace(/^\//, '')), `override for missing ${o.attr('PartName')}`);
  for (const [n, t] of Object.entries(texts)) {
    if (!n.endsWith('.rels')) continue;
    const src = n.replace('_rels/', '').replace(/\.rels$/, '');
    const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    for (const r of parseXml(t).kids('Relationship')) {
      if (r.attr('TargetMode') === 'External') continue;
      const parts = dir ? dir.split('/') : [];
      for (const seg of r.attr('Target').split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
      assert.ok(names.includes(parts.join('/')), `${n}: dangling ${parts.join('/')}`);
    }
  }
  assert.ok(texts['xl/worksheets/sheet1.xml'].includes('_xlfn.XLOOKUP('));
  assert.ok(texts['xl/worksheets/sheet1.xml'].includes('cm="1"'));
  assert.ok(texts['xl/workbook.xml'].includes('_xlfn.XLOOKUP('));
});

test('iterative_calculation_settings_roundtrip', async () => {
  const calcPr = async content => {
    const bytes = await writeXlsx(content);
    const c = parseXml(await part(bytes, 'xl/workbook.xml')).child('calcPr');
    return [['calcMode', 'iterate', 'iterateCount', 'iterateDelta'].map(a => c.attr(a) ?? null), (await readXlsx(bytes)).calc];
  };
  assert.deepEqual(await calcPr(wb()), [[null, null, null, null], undefined]);
  const on = wb({}, {calc: {mode: 'manual', iterative: true}});
  const [attrs, back] = await calcPr(on);
  assert.deepEqual(attrs, ['manual', '1', '100', '0.001']);
  assert.deepEqual(back, {mode: 'manual', iterative: true, maxIterations: 100, maxChange: 0.001});
  const off = wb({}, {calc: {maxIterations: 250, maxChange: 0.0005}});
  const [attrs2, back2] = await calcPr(off);
  assert.deepEqual(attrs2, [null, null, '250', '0.0005']);
  assert.deepEqual(back2, {maxIterations: 250, maxChange: 0.0005});
});

test('cell_text_carriage_returns_survive_xlsx_roundtrip', async () => {
  const values = [['A1', 'Line 1\r\nLine 2'], ['A2', 'Part A\rPart B'], ['A3', 'Item 3\nItem 4'], ['A4', 'literal _x000D_ marker']];
  const content = wb(Object.fromEntries(values.map(([k, v]) => [k, {v}])), {}, {notes: {A1: {text: 'Note\r\ntext', author: 'Tester'}}});
  const bytes = await writeXlsx(content);
  const sst = await part(bytes, 'xl/sharedStrings.xml');
  assert.ok(sst.includes('Line 1_x000D_\nLine 2'));
  assert.ok(sst.includes('Part A_x000D_Part B'));
  assert.ok(!sst.includes('\r'));
  const back = await readXlsx(bytes);
  for (const [k, v] of values) assert.equal(at(back, k).v, v, k);
  assert.equal(back.sheets[0].notes.A1.text, 'Note\r\ntext');
});

test('spill_and_calc_errors_are_cached_as_value_errors', async () => {
  const content = wb({A1: {v: 1}, C1: {f: 'A1:A3*2'}, C2: {f: 'FILTER(A1:A3,A1:A3>5)'}, C3: {f: 'NA()'}, E1: {f: 'SEQUENCE(3)'}, E2: {v: 'block'}});
  const bytes = await writeXlsx(content);
  const xml = await part(bytes, 'xl/worksheets/sheet1.xml');
  assert.ok(!xml.includes('#SPILL!') && !xml.includes('#CALC!'), xml);
  const sheet = parseXml(xml);
  const cells = sheet.child('sheetData').kids('row').flatMap(r => r.kids('c'));
  const c = ref => cells.find(x => x.attr('r') === ref);
  assert.equal(c('C2').child('f').text, '_xlfn._xlws.FILTER(A1:A3,A1:A3>5)');
  assert.equal(c('C2').child('v').text, '#VALUE!');
  assert.equal(c('C3').child('v').text, '#N/A');
  assert.equal(c('E1').child('v').text, '#VALUE!', 'a blocked spill is cached as #VALUE!');
});

test('implicit_intersection_is_written_as_single', async () => {
  const content = wb({A1: {v: 1}, A2: {v: 3}, A3: {v: 5}, D3: {f: '@A1:A3*2'}, D4: {f: 'A1*2'}});
  const bytes = await writeXlsx(content);
  const xml = await part(bytes, 'xl/worksheets/sheet1.xml');
  assert.ok(xml.includes('<c r="D3" cm="1"><f t="array" ref="D3">_xlfn.SINGLE(A1:A3)*2</f><v>10</v>'), xml);
  assert.ok(xml.includes('<c r="D4"><f>A1*2</f>'), xml);
  assert.ok(!xml.includes('@'));
  const back = await readXlsx(bytes);
  assert.equal(at(back, 'D3').f, '@A1:A3*2');
  assert.equal(at(back, 'D3').a, undefined);
});

test('scroll_position_round_trips_with_and_without_frozen_panes', async () => {
  let back = await readXlsx(await writeXlsx(wb({}, {}, {topLeft: 'A31'})));
  assert.equal(back.sheets[0].topLeft, 'A31');
  const bytes = await writeXlsx(wb({}, {}, {freeze: {rows: 1, cols: 0}, topLeft: 'C40'}));
  assert.ok((await part(bytes, 'xl/worksheets/sheet1.xml')).includes('<pane ySplit="1" topLeftCell="C40"'));
  back = await readXlsx(bytes);
  assert.equal(back.sheets[0].topLeft, 'C40');
  assert.deepEqual(back.sheets[0].freeze, {rows: 1, cols: 0});
  const xml = await part(await writeXlsx(wb({}, {}, {freeze: {rows: 1, cols: 0}})), 'xl/worksheets/sheet1.xml');
  assert.ok(xml.includes('topLeftCell="A2"'), xml);
});

test('let_lambda_parameters_drop_xlpm_on_read', async () => {
  const content = wb({A1: {f: 'LET(x,1,x+1)'}, A2: {f: 'LAMBDA(a,a*2)(3)'}, B1: {v: 1}, B2: {v: 2}, C1: {f: 'MAP(B1:B2,LAMBDA(v,v+1))', a: 'C1:C2'}});
  const bytes = await writeXlsx(content);
  const xml = await part(bytes, 'xl/worksheets/sheet1.xml');
  assert.ok(xml.includes('_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'), xml);
  assert.ok(xml.includes('_xlpm.v'), xml);
  const back = await readXlsx(bytes);
  assert.equal(at(back, 'A1').f, 'LET(x,1,x+1)');
  assert.equal(at(back, 'A2').f, 'LAMBDA(a,a*2)(3)');
  assert.equal(at(back, 'C1').f, 'MAP(B1:B2,LAMBDA(v,v+1))');
  assert.equal(at(back, 'C1').a, 'C1:C2');
  assert.equal(val(back, 'A1'), 2);
});

/** A minimal package around a sheet body and extra parts (roundtrip.rs `minimal`). */
async function minimal(body, extra = [], rels = '') {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${rels}</Relationships>`);
  z.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</worksheet>`);
  for (const [n, t] of extra) z.file(n, t);
  return z.generateAsync({type: 'uint8array'});
}

test('default_font_survives_a_round_trip', async () => {
  const styles = font0 => `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font>${font0}</font><font><b/><sz val="14"/><color theme="1"/><name val="Arial"/><family val="2"/></font></fonts>
    <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
    <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const rels = '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  const body = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>typed text</t></is></c><c r="B1" s="1"><v>1</v></c></row></sheetData>';
  const file = await minimal(body, [['xl/styles.xml', styles('<sz val="10"/><color theme="1"/><name val="Arial"/><family val="2"/>')]], rels);
  const content = await readXlsx(file);
  validateContent(content);
  const saved = await writeXlsx(content);
  const font0 = parseXml(await part(saved, 'xl/styles.xml')).child('fonts').kids('font')[0];
  assert.deepEqual([font0.child('sz').attr('val'), font0.child('name').attr('val')], ['10', 'Arial']);
  const back = await readXlsx(saved);
  const normal = styleAt(back, back.sheets[0], 5, 5).font;
  assert.deepEqual([normal.name, normal.size], ['Arial', 10], 'empty cells and new input take the Normal font');
  assert.equal(at(back, 'A1').s, undefined);
  const b1 = styleAt(back, back.sheets[0], 0, 1).font;
  assert.ok(b1.bold && b1.size === 14);
  assert.equal(at(back, 'A1').v, 'typed text');
});

test('shared formulas expand relative to their master cell', async () => {
  const body = '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row>'
    + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/></c></row></sheetData>';
  const content = await readXlsx(await minimal(body));
  assert.deepEqual(['B1', 'B2', 'B3'].map(r => at(content, r).f), ['A1*2', 'A2*2', 'A3*2']);
  assert.deepEqual(['B1', 'B2', 'B3'].map(r => val(content, r)), [2, 4, 6]);
});

test('a full workbook round-trips through xlsx', async () => {
  const content = {
    sheets: [{id: 's1', name: 'Data', blocks: {0: {A1: {v: 'Name'}, B1: {v: 'Qty'}, A2: {v: 'x'}, B2: {v: 3, s: 1}, B3: {v: 4}, B4: {f: 'SUM(B2:B3)'}, C1: {f: 'SEQUENCE(3)', d: true},
      D1: {f: 'XLOOKUP(3,B2:B3,A2:A3)'}, E5: {v: true}, E6: {v: {e: '#N/A'}}}},
    merges: ['E1:F2'], freeze: {rows: 1, cols: 0}, cols: {0: {size: 120}, 3: {hidden: true}}, rows: {0: {size: 30, custom: true}}, zoom: 120, showGridlines: false, tabColor: '#FF0000',
    hyperlinks: {A2: {target: 'https://example.com', tooltip: 'go'}, A3: {location: 'Data!B4'}}, notes: {B2: {text: 'hello', author: 'me'}},
    conditionalFormats: [{id: 'c1', ranges: ['B2:B3'], priority: 1, rule: {type: 'cellIs', operator: 'greaterThan', formulas: ['3'], dxf: {font: {bold: true}, fill: {pattern: 'solid', fg: '#FFC7CE'}}}}],
    validations: [{id: 'v1', ranges: ['A2:A3'], type: 'list', formula1: '"x,y"', allowBlank: true, showErrorMessage: true}],
    protection: {enabled: true, formatCells: true, selectLocked: true, selectUnlocked: true},
    tables: [{name: 'T1', range: 'A1:B3', headerRow: true, totalsRow: false, columns: [{name: 'Name'}, {name: 'Qty'}]}]},
    {id: 's2', name: 'Other sheet', blocks: {0: {A1: {f: 'Data!B4*2'}}}, hidden: 'hidden'}],
    activeSheetId: 's1',
    styles: [{}, {numFmt: '0.00%', font: {bold: true, color: '#FF0000', name: 'Arial', size: 12}, fill: {pattern: 'solid', fg: {theme: 4, tint: 0.4}},
      borders: {bottom: {style: 'thin'}, top: {style: 'double', color: '#0000FF'}}, align: {h: 'center', v: 'top', wrap: true, rotation: 45, indent: 2}, protection: {locked: false}}],
    names: [{name: 'Total', formula: 'Data!$B$4', comment: 'sum'}, {name: 'Local', formula: '1', scope: 's2'}, {name: 'Secret', formula: '2', hidden: true}],
    calc: {mode: 'manual'}, dateSystem: 1904, properties: {title: 'T', author: 'A'},
  };
  validateContent(content);
  const back = await readXlsx(await writeXlsx(content));
  validateContent(back);
  const [d, o] = back.sheets;
  assert.deepEqual([d.name, o.name, o.hidden, back.activeSheetId === d.id], ['Data', 'Other sheet', 'hidden', true]);
  for (const ref of ['A1', 'B1', 'A2', 'B3', 'E5']) assert.deepEqual(at(back, ref).v, at(content, ref).v, ref);
  assert.deepEqual(at(back, 'E6').v, {e: '#N/A'});
  assert.equal(at(back, 'B4').f, 'SUM(B2:B3)');
  assert.equal(at(back, 'C1').d, true);
  assert.equal(at(back, 'D1').f, 'XLOOKUP(3,B2:B3,A2:A3)');
  assert.equal(val(back, 'C3'), 3);
  assert.equal(val(back, 'A1', 1), 14);
  assert.deepEqual(styleAt(back, d, 1, 1), styleAt(content, content.sheets[0], 1, 1));
  assert.deepEqual([d.merges, d.freeze, d.cols[0].size, d.cols[3].hidden, d.rows[0], d.zoom, d.showGridlines, d.tabColor],
    [['E1:F2'], {rows: 1, cols: 0}, 120, true, {size: 30, custom: true}, 120, false, '#FF0000']);
  assert.deepEqual(d.hyperlinks, {A2: {target: 'https://example.com', tooltip: 'go'}, A3: {location: 'Data!B4'}});
  assert.deepEqual(d.notes, {B2: {text: 'hello', author: 'me'}});
  const cf = d.conditionalFormats[0];
  assert.deepEqual([cf.ranges, cf.priority, cf.rule], [['B2:B3'], 1, {type: 'cellIs', operator: 'greaterThan', formulas: ['3'], dxf: {font: {bold: true}, fill: {pattern: 'solid', fg: '#FFC7CE'}}}]);
  const dv = d.validations[0];
  assert.deepEqual([dv.ranges, dv.type, dv.formula1, dv.allowBlank, dv.showErrorMessage], [['A2:A3'], 'list', '"x,y"', true, true]);
  assert.equal(d.protection.enabled, true);
  assert.equal(d.protection.formatCells, true);
  assert.equal(d.protection.insertRows, false);
  assert.deepEqual(d.tables.map(t => [t.name, t.range, t.columns.map(c => c.name)]), [['T1', 'A1:B3', ['Name', 'Qty']]]);
  assert.deepEqual(back.names, [{name: 'Total', formula: 'Data!$B$4', comment: 'sum'}, {name: 'Local', formula: '1', scope: o.id}, {name: 'Secret', formula: '2', hidden: true}]);
  assert.deepEqual([back.calc, back.dateSystem, back.properties], [{mode: 'manual'}, 1904, {title: 'T', author: 'A'}]);
});
