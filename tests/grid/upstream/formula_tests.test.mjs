// Port of gridcraft crates/formula/src/tests.rs (146161b4b450a56e5e59a083ba0478582d1e602b).
// Each test names the Rust test it translates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, print, printR1C1, tokenize, references, referenceA1, shiftRelative, adjust, renameSheet, deleteSheet, MAX_FORMULA_LEN} from '../../../core/grid/lib/formula.mjs';
import {parseRange, MAX_ROWS} from '../../../core/grid/lib/addr.mjs';

const rt = src => { try { return print(parse(src)); } catch (e) { return `${src}: ${e.message}`; } };

test('range_end_repeating_sheet_name_round_trips', () => {
  assert.equal(rt("'a'!A1:'a'!B2"), 'a!A1:a!B2');
  assert.equal(rt('Sheet1!A1:Sheet1!B2'), 'Sheet1!A1:Sheet1!B2');
  assert.equal(rt('SUM(a!A1:a!B2)'), 'SUM(a!A1:a!B2)');
  assert.equal(rt('Sheet1!A1:SHEET1!B2'), 'Sheet1!A1:SHEET1!B2');
});

test('quoted_sheet_qualified_name_keeps_quotes', () => {
  assert.equal(rt("'My Sheet'!Total"), "'My Sheet'!Total");
  assert.equal(rt("'Data'!Total"), 'Data!Total');
  assert.equal(rt("'It''s'!Total+1"), "'It''s'!Total+1");
});

test('intersection_with_deleted_operand_reparses', () => {
  assert.equal(rt('A1:B2 #REF!'), 'A1:B2 #REF!');
  assert.equal(rt('#REF! A1:B2'), '#REF! A1:B2');
});

test('roundtrips', () => {
  for (const f of ['1+2*3', 'SUM(A1:B2)', 'SUM($A$1:B$2,C3)', 'IF(A1>0,"yes","no")', '-2^2', 'A1%', "Sheet2!A1+'My Sheet'!$B$3",
    'SUM(Sheet1:Sheet3!A1)', 'SUM(A:A)', 'SUM(3:5)', '{1,2;3,4}', '{-1,"a",TRUE,#N/A}', 'VLOOKUP(A1,Table1[#All],2,FALSE)',
    'Table1[Sales]', 'Table1[@Sales]', 'Table1[[#Headers],[A]:[C]]', '"a""b"&C1', 'SUM((A1:A3,C1:C3))', 'A1:C3 B2:B5',
    'LAMBDA(x,x+1)(2)', 'F(1,,3)', '@A1:A10', 'A1<>B1', 'A1<=B1', '#REF!+1', '1E+20', 'MyName*2', 'Sheet1!MyName', 'SUM(A1:B2) ']) {
    assert.equal(rt(f), f.trim(), `round trip of ${f}`);
  }
});

test('normalises', () => {
  assert.equal(rt('=sum(a1:b2)'), 'SUM(A1:B2)');
  assert.equal(rt('= 1 + 2'), '1+2');
  assert.equal(rt('_xlfn.XLOOKUP(1,A:A,B:B)'), 'XLOOKUP(1,A:A,B:B)');
  assert.equal(rt('_xlfn.GROUPBY(A1:A3,B1:B3,_xleta.SUM)'), 'GROUPBY(A1:A3,B1:B3,SUM)');
  assert.equal(rt('_XLUDF.concat("a","b")'), '_xludf.CONCAT("a","b")');
  assert.equal(rt('true'), 'TRUE');
  assert.equal(rt("'Sheet1'!A1"), 'Sheet1!A1');
});

test('spill_operator', () => {
  for (const f of ['A1#', 'Sheet1!$D$1#', 'SUM(B2#)', "'My Sheet'!A1#*2", 'ROWS(A1#)+1', 'IF(A1,#N/A,#REF!)']) assert.equal(rt(f), f);
  assert.equal(parse('A1#').op, 'spill');
  assert.equal(rt('_xlfn.ANCHORARRAY(Sheet1!$D$1)'), 'Sheet1!$D$1#');
  assert.equal(rt('SUM(ANCHORARRAY(B2))'), 'SUM(B2#)');
  assert.throws(() => parse('A1:B2#'));
  assert.throws(() => parse('Name#'));
  assert.equal(print(deleteSheet(parse('SUM(Data!A1#)'), 'Data', [])), 'SUM(#REF!)');
});

test('delete_sheet_shrinks_3d_span', () => {
  const order = ['Sheet1', 'Sheet2', 'Sheet3', 'Results'];
  const del = (f, n) => print(deleteSheet(parse(f), n, order));
  assert.equal(del('SUM(Sheet1:Sheet3!A1)', 'Sheet1'), 'SUM(Sheet2:Sheet3!A1)');
  assert.equal(del('SUM(Sheet1:Sheet3!A1)', 'Sheet3'), 'SUM(Sheet1:Sheet2!A1)');
  assert.equal(del('SUM(Sheet3:Sheet1!A1)', 'Sheet1'), 'SUM(Sheet3:Sheet2!A1)');
  assert.equal(del('SUM(Sheet1:Sheet3!A1)', 'Sheet2'), 'SUM(Sheet1:Sheet3!A1)');
  assert.equal(del('SUM(Sheet1:Sheet2!A1)', 'Sheet1'), 'SUM(Sheet2!A1)');
  assert.equal(del('Sheet1!A1+Sheet3!A1', 'Sheet1'), '#REF!+Sheet3!A1');
});

test('precedence', () => {
  assert.equal(parse('1+2*3').op, '+');
  assert.equal(parse('-2^2').op, '^');
  assert.equal(parse('1&2="12"').op, '=');
  const e = parse('2^3^2');
  assert.equal(e.op, '^');
  assert.equal(e.a.op, '^');
});

test('errors', () => {
  for (const bad of ['1+', 'SUM(1,2', '(1', '{1,2;3}', '"abc', 'A1:', '1 2', '{A1}', ')', 'Sheet1!', '#FOO!']) assert.throws(() => parse(bad), undefined, bad);
});

test('no_panic_on_garbage', () => {
  for (const s of ['(((((', '[[[', "'''", '!!!', '$$$', '=@@@', 'A1:B2:C3:D4', '{,}', '{;}', 'F(,,,,)', ':::', '1e', '1e+', '.', '..', '$A$', 'XFD1048577']) {
    try { parse(s); } catch (e) { assert.equal(e.name, 'FormulaError'); }
  }
  assert.throws(() => parse('('.repeat(5000) + '1' + ')'.repeat(5000)));
});

test('references', () => {
  assert.deepEqual(references(parse('SUM(A1:B2)+Sheet2!C3*D4')).map(r => referenceA1(r)), ['A1:B2', 'Sheet2!C3', 'D4']);
});

test('copy_shift', () => {
  assert.equal(print(shiftRelative(parse('A1+$A1+A$1+$A$1+SUM(B2:C3)'), 2, 1)), 'B3+$A3+B$1+$A$1+SUM(C4:D5)');
  assert.equal(print(shiftRelative(parse('A1'), -1, 0)), '#REF!');
  assert.equal(print(shiftRelative(parse('SUM(A:A)'), 5, 1)), 'SUM(B:B)');
});

test('insert_delete', () => {
  const ins = {type: 'insert', axis: 'rows', at: 2, count: 2};
  assert.equal(print(adjust(parse('A1+A3+SUM(A2:A5)+Other!A3'), 'Sheet1', 'Sheet1', ins)), 'A1+A5+SUM(A2:A7)+Other!A3');
  const del = {type: 'delete', axis: 'rows', at: 2, count: 2};
  assert.equal(print(adjust(parse('A1+A3+SUM(A2:A5)+A6'), 'Sheet1', 'Sheet1', del)), 'A1+#REF!+SUM(A2:A3)+A4');
  const delc = {type: 'delete', axis: 'cols', at: 0, count: 1};
  assert.equal(print(adjust(parse('SUM(A1:C1)+B2'), 'S', 'S', delc)), 'SUM(A1:B1)+A2');
  assert.equal(print(adjust(parse('Sheet1!B2'), 'Other', 'Sheet1', delc)), 'Sheet1!A2');
  assert.equal(print(adjust(parse('SUM(A:A)'), 'S', 'S', delc)), 'SUM(#REF!)');
});

test('insert_delete_cells', () => {
  const adj = (f, e) => print(adjust(parse(f), 'S', 'S', e));
  assert.equal(adj('SUM(A1:A5)+A2+A3+$A$9+B3+SUM(A1:B5)+SUM(A:A)', {type: 'insertCells', axis: 'rows', range: parseRange('A3:A4')}),
    'SUM(A1:A7)+A2+A5+$A$11+B3+SUM(A1:B5)+SUM(A:A)');
  assert.equal(adj('A2+B2+C2+B3+SUM(A2:C2)', {type: 'insertCells', axis: 'cols', range: parseRange('B2')}), 'A2+C2+D2+B3+SUM(A2:D2)');
  assert.equal(adj('A2+A3+A4+A5+B5+SUM(A1:A10)+SUM(A3:A4)+SUM(A1:B10)', {type: 'deleteCells', axis: 'rows', range: parseRange('A3:A4')}),
    'A2+#REF!+#REF!+A3+B5+SUM(A1:A8)+SUM(#REF!)+SUM(A1:B10)');
  assert.equal(adj('A1+B1+D1+D2+D3+SUM(A1:E1)', {type: 'deleteCells', axis: 'cols', range: parseRange('B1:C2')}), 'A1+#REF!+B1+B2+D3+SUM(A1:C1)');
});

test('moves_and_renames', () => {
  assert.equal(print(adjust(parse('A1+B2+C3+SUM(A1:B2)'), 'S', 'S', {type: 'move', from: parseRange('A1:B2'), toRow: 9, toCol: 3})), 'D10+E11+C3+SUM(D10:E11)');
  assert.equal(print(adjust(parse('SUM(B:B)+SUM($C:$C)+D1'), 'S', 'S', {type: 'move', from: parseRange('B:C'), toRow: 0, toCol: 4})), 'SUM(E:E)+SUM($F:$F)+D1');
  assert.equal(print(renameSheet(parse("Old!A1+'Old'!B2"), 'Old', 'New Name')), "'New Name'!A1+'New Name'!B2");
});

test('rename_sheet_updates_qualified_names', () => {
  assert.equal(print(renameSheet(parse('Data!MyName+MyName+Other!MyName'), 'data', 'Numbers')), 'Numbers!MyName+MyName+Other!MyName');
  assert.equal(print(renameSheet(parse('Data!MyName'), 'Data', 'New Name')), "'New Name'!MyName");
  const e = renameSheet(parse('Data!MyName'), 'Data', "It's");
  assert.deepEqual(e, {t: 'name', v: "It's!MyName"});
  assert.equal(print(renameSheet(e, "It's", 'Totals')), 'Totals!MyName');
});

test('moves_between_sheets', () => {
  const mv = {type: 'moveToSheet', from: parseRange('A1:B2'), toSheet: 'New Name', toRow: 9, toCol: 3};
  for (const [host, input, expected] of [
    ['Source', 'A1+$B$2+C3+SUM(A1:B2)', "'New Name'!D10+'New Name'!$E$11+C3+SUM('New Name'!D10:E11)"],
    ['Other', 'A1+sOuRcE!$B2+Other!B2', "A1+'New Name'!$E11+Other!B2"],
    ['Source', 'SUM(A1:C3)+SUM(Source:Other!A1)', 'SUM(A1:C3)+SUM(Source:Other!A1)'],
  ]) assert.equal(print(adjust(parse(input), host, 'Source', mv)), expected);
  assert.equal(print(adjust(parse('B2'), 'Source', 'Source', {...mv, toRow: MAX_ROWS - 1})), '#REF!');
  for (const [from, input, row, col, expected] of [['A:A', '$A:$A', 0, 2, 'Dest!$C:$C'], ['1:1', '$1:$1', 2, 0, 'Dest!$3:$3']]) {
    assert.equal(print(adjust(parse(input), 'Source', 'Source', {type: 'moveToSheet', from: parseRange(from), toSheet: 'Dest', toRow: row, toCol: col})), expected);
  }
});

test('r1c1', () => {
  assert.equal(printR1C1(parse('A1+$B$2+SUM(C:C)'), {row: 1, col: 1}), 'R[-1]C[-1]+R2C2+SUM(C[1])');
});

test('spans', () => {
  const a1 = tokenize('SUM(A1, B2)').find(t => t.tok === 'word' && t.v === 'A1');
  assert.deepEqual([a1.start, a1.end], [4, 6]);
});

test('unbracketed_this_row_column', () => {
  const e = parse('[[#This Row],Units]*[[#This Row],Price]');
  assert.deepEqual([e.a.specifiers, e.a.colStart], [['thisRow'], 'Units']);
  assert.equal(rt('[[#This Row],Units]*[[#This Row],Price]'), '[@Units]*[@Price]');
  assert.equal(rt('Sales[[#This Row],Units]'), 'Sales[@Units]');
  assert.equal(rt('Sales[[#This Row], Units ]'), 'Sales[@Units]');
  assert.equal(rt('[[#This Row],Units]+[@[Unit Price]]+Sales[[#This Row],[Qty]]'), '[@Units]+[@[Unit Price]]+Sales[@Qty]');
  for (const bad of ['[[#This Row]x]', '[[#This Row],[A]]x', '[[#Data],Col]', '[[#This Row],A:B]', '[x[#This Row]]', '[[#This Row],]x',
    'Sales[[#All],[A]]junk', 'Sales[[A],[B],[C]]', 'Sales[@[A]x]']) assert.throws(() => parse(bad), undefined, bad);
});

test('struct_column_keeps_edge_spaces', () => {
  assert.equal(parse('Table1[Qty ]').colStart, 'Qty ');
  assert.equal(parse('Table1[ Qty]').colStart, ' Qty');
  assert.equal(rt('Table1[Qty ]'), 'Table1[[Qty ]]');
  for (const f of ['Table1[[Qty ]]', 'Table1[[ Sum for Q2 ]]', 'Table1[[#Totals],[Qty ]]', 'Table1[@[Qty ]]', 'Table1[Unit Price]']) assert.equal(rt(f), f);
});

test('trim_references', () => {
  for (const f of ['SUM(A1:.E10)', 'SUM(A1.:E10)', 'SUM(A1.:.E10)', 'SUM(A:.A)', 'SUM($A.:.$C)', 'ROWS(1:.5)', 'ROWS($1.:$5)', 'ROWS(1.:.5)',
    'Sheet2!$A$1:.B9', 'Q1.2026!A1.:.B2', "'Q1 2026'!A1:.B2", 'SUM(A1:.A9,B1.:B9)', 'A1:.A9*2']) assert.equal(rt(f), f, `round trip of ${f}`);
  const sum = parse('SUM(A1:.E10)');
  assert.equal(sum.args[0].op, 'trim');
  assert.equal(sum.args[0].mode, 'trailing');
  assert.equal(sum.args[0].x.t, 'ref');
  assert.deepEqual(parse('1.5+.5'), {t: 'binary', op: '+', a: {t: 'num', v: 1.5}, b: {t: 'num', v: 0.5}});
  for (const f of ['SUM(1:5)', 'Q1.2026!A1:B2', 'my.name+1', 'SUM(A1:B2)*1.5', '1.:5']) assert.equal(rt(f), f);
  assert.equal(rt("'Q1.2026'!A1:B2"), 'Q1.2026!A1:B2');
  assert.equal(parse('Q1.2026!A1:B2').t, 'ref');
  assert.equal(rt('SUM(_xlfn._TRO_TRAILING(A1:E10))'), 'SUM(A1:.E10)');
  assert.equal(rt('_xlfn._TRO_LEADING(A:A)'), 'A.:A');
  assert.equal(rt('_xlfn._TRO_ALL(Sheet1!A1:B2)'), 'Sheet1!A1.:.B2');
  assert.equal(rt('_xlfn._TRO_ALL(B2)'), 'TRIMRANGE(B2,3,3)');
  for (const bad of ['A1.:', '.:A1', 'A1:.:B2', 'A1.:.:B2']) assert.throws(() => parse(bad), undefined, bad);
  assert.equal(printR1C1(parse('SUM(A1:.B2)+ROWS(2.:2)'), {row: 0, col: 0}), 'SUM(RC:.R[1]C[1])+ROWS(R[1].:R[1])');
});

test('trim_references_adjust', () => {
  assert.equal(print(adjust(parse('SUM(A1:.A5)+SUM(B:.B)+ROWS(2.:.4)'), 'S', 'S', {type: 'insert', axis: 'rows', at: 2, count: 2})), 'SUM(A1:.A7)+SUM(B:.B)+ROWS(2.:.6)');
  assert.equal(print(adjust(parse('SUM(A1.:C1)+SUM(A:.A)'), 'S', 'S', {type: 'delete', axis: 'cols', at: 0, count: 1})), 'SUM(A1.:B1)+SUM(#REF!)');
  assert.equal(print(shiftRelative(parse('SUM(A1.:.B2)'), 1, 1)), 'SUM(B2.:.C3)');
  assert.deepEqual(references(parse('SUM(Sheet2!A1:.B5)')).map(r => referenceA1(r)), ['Sheet2!A1:B5']);
});

test('prints_long_flat_chain_without_deep_recursion', () => {
  let e = {t: 'num', v: 1};
  for (let i = 0; i < 20000; i++) e = {t: 'binary', op: '+', a: e, b: {t: 'num', v: 1}};
  const text = print(e);
  assert.equal(text, Array(20001).fill('1').join('+'));
  assert.equal(printR1C1(e, {row: 0, col: 0}), text);
});

test('hostile_formulas_are_errors_not_stack_overflows', () => {
  assert.throws(() => parse('1' + '%'.repeat(1000)));
  assert.throws(() => parse('LAMBDA(x,x)(1)' + '(1)'.repeat(1000)));
  assert.throws(() => parse('1' + '+1'.repeat(100000)));
  assert.ok(parse('1' + '%'.repeat(100)));
  assert.ok(parse('LAMBDA(x,x)(1)(2)'));
});

test('formulas_longer_than_excel_allows_are_refused', () => {
  const atLimit = '1' + '+1'.repeat((MAX_FORMULA_LEN - 1) / 2 | 0);
  assert.equal(atLimit.length, MAX_FORMULA_LEN - 1);
  assert.ok(parse(atLimit));
  assert.ok(parse('=' + atLimit));
  assert.throws(() => parse(atLimit + '+1'), e => /8192/.test(e.message));
  assert.ok(parse(`"${'é'.repeat(8000)}"`));
});
