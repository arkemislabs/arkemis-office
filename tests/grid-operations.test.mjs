import test from 'node:test';
import assert from 'node:assert/strict';
import {sortRange,findCells,columnWindow,createHistory,insertAutoSum,sameWorkbookContent} from '../core/grid-operations.mjs';

test('sort moves complete selected rows with styles, uses numbers, and leaves outside cells alone',()=>{
  const cells={A1:{value:'10',bold:true},B1:{value:'ten'},A2:{value:'2'},B2:{value:'two',color:'#ff0000'},C1:{value:'outside'}};
  const result=sortRange(cells,{r1:0,r2:1,c1:0,c2:1},'asc');
  assert.equal(result.A1.value,'2');assert.deepEqual(result.B1,cells.B2);assert.deepEqual(result.A2,cells.A1);assert.equal(result.C1,cells.C1);assert.equal(cells.A1.value,'10');
  assert.equal(sortRange(result,{r1:0,r2:1,c1:0,c2:1},'desc').A1.value,'10');
});
test('sort rejects one row and single-column selections beside other data',()=>{
  assert.throws(()=>sortRange({A1:{value:'2'}},{r1:0,r2:0,c1:0,c2:1},'asc'),/two rows/i);
  assert.throws(()=>sortRange({A1:{value:'2'},B1:{value:'keep together'}},{r1:0,r2:1,c1:0,c2:0},'asc'),/whole table/i);
});
test('sort keeps blanks last and deletes old sparse destinations',()=>{
  const result=sortRange({A1:{value:''},B1:{value:'blank'},A2:{value:'3'},A3:{value:'1'},B3:{value:'one'}},{r1:0,r2:2,c1:0,c2:1},'desc');
  assert.equal(result.A1.value,'3');assert.equal(result.B1,undefined);assert.equal(result.B3.value,'blank');
});
test('sort refuses mixed numeric and formula rows without changing any original cells',()=>{
  const cells={A1:{value:'10'},B1:{value:'=A1*2',bold:true},A2:{value:'2'},B2:{value:'4'}};
  const original=structuredClone(cells);
  for(const direction of ['asc','desc'])assert.throws(()=>sortRange(cells,{r1:0,r2:1,c1:0,c2:1},direction),/formulas.*cannot.*sort/i);
  assert.deepEqual(cells,original);
});
test('AutoSum refuses occupied numeric, text, and formula destinations without changing cells',()=>{
  for(const value of ['0','Keep this','=SUM(B1:B2)']){
    const cells={A1:{value:'2'},A2:{value:'3'},A3:{value,bold:true}};
    const original=structuredClone(cells);
    assert.throws(()=>insertAutoSum(cells,'A3','=SUM(A1:A2)'),/A3.*not empty/i);
    assert.deepEqual(cells,original);
  }
});
test('AutoSum writes only to empty destinations and preserves their formatting',()=>{
  const cells={A1:{value:'2'},A2:{value:'3'},A3:{value:'',bold:true}};
  const result=insertAutoSum(cells,'A3','=SUM(A1:A2)');
  assert.deepEqual(result.A3,{value:'=SUM(A1:A2)',bold:true});assert.equal(cells.A3.value,'');assert.equal(result.A1,cells.A1);
  assert.equal(insertAutoSum(cells,'B3','=SUM(B1:B2)').B3.value,'=SUM(B1:B2)');
});
test('find searches formulas and computed values in row-major order without case sensitivity',()=>{
  const cells={Z9:{value:'HELLO'},A1:{value:'=SUM(B1:B2)'},B1:{value:'2'},B2:{value:'3'}};
  assert.deepEqual(findCells(cells,'sum'),[{r:0,c:0}]);assert.deepEqual(findCells(cells,'5'),[{r:0,c:0}]);assert.deepEqual(findCells(cells,'hello'),[{r:8,c:25}]);assert.deepEqual(findCells(cells,''),[]);
});
test('column windows stay bounded and reveal distant columns in thousand-column sheets',()=>{
  const near=columnWindow(0,1000,112,1200);assert.equal(near.start,0);assert.ok(near.end<=15);
  const far=columnWindow(110000,1000,112,1200);assert.ok(far.start>970);assert.ok(far.end<=1000);assert.ok(far.end-far.start<=16);
});
test('history groups a draft, bounds memory, clears redo on edits, and resets on external replacement',()=>{
  const h=createHistory(2);h.record('a','b');h.record('b','c');h.record('c','d');
  assert.equal(h.undo('d'),'c');assert.equal(h.undo('c'),'b');assert.equal(h.undo('b'),'b');assert.equal(h.redo('b'),'c');
  h.record('c','new');assert.equal(h.redo('new'),'new');h.reset();assert.equal(h.undo('external'),'external');
  h.record('same','same');assert.equal(h.canUndo,false);
});
test('autosave roundtrips preserve history but actual external changes invalidate it',()=>{
  const before={activeSheetId:'one',sheets:[{id:'one',name:'Sheet 1',rows:200,columns:26,cells:{}}]};
  const edited=structuredClone(before);edited.sheets[0].cells.C1={value:'Undo this',bold:true};
  const saved=JSON.parse(JSON.stringify(edited));
  const history=createHistory();history.record(before,edited);
  assert.equal(sameWorkbookContent(edited,saved),true);
  if(!sameWorkbookContent(edited,saved))history.reset();
  assert.deepEqual(history.undo(saved),before);assert.deepEqual(history.redo(before),saved);
  const external=structuredClone(saved);external.sheets[0].cells.C1.value='External change';
  assert.equal(sameWorkbookContent(saved,external),false);
  if(!sameWorkbookContent(saved,external))history.reset();
  assert.equal(history.undo(external),external);
});
test('workbook equivalence ignores object key order but detects style, sheet order, and active sheet changes',()=>{
  const first={activeSheetId:'a',sheets:[{id:'a',cells:{A1:{value:'1',bold:true},B1:{value:'2'}}},{id:'b',cells:{}}]};
  const reordered={sheets:[{cells:{B1:{value:'2'},A1:{bold:true,value:'1'}},id:'a'},{cells:{},id:'b'}],activeSheetId:'a'};
  assert.equal(sameWorkbookContent(first,reordered),true);
  const style=structuredClone(first);style.sheets[0].cells.A1.bold=false;assert.equal(sameWorkbookContent(first,style),false);
  assert.equal(sameWorkbookContent(first,{...first,sheets:[...first.sheets].reverse()}),false);
  assert.equal(sameWorkbookContent(first,{...first,activeSheetId:'b'}),false);
});
