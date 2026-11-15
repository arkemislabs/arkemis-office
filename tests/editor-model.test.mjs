import test from 'node:test';
import assert from 'node:assert/strict';
import { pasteCells, planPaste, selectionTSV, moveItem, wordCount, rowWindow, sumTargetRow, reconcileDraft, slideDimension, presentationIndex } from '../core/editor-helpers.mjs';

test('pasting a rectangle preserves cell styles and adjacent cells', () => {
  const cells={A1:{value:'old',bold:true},C1:{value:'keep'}};
  const next=pasteCells(cells,0,0,'new\t=1+2\r\nthird\tfourth\r\n');
  assert.deepEqual(next.A1,{value:'new',bold:true});
  assert.equal(next.B1.value,'=1+2');
  assert.equal(next.B2.value,'fourth');
  assert.equal(next.C1.value,'keep');
  assert.equal(cells.A1.value,'old');
  assert.equal(next.A3,undefined);
});
test('copy selection keeps empty cells in the rectangle',()=>{
  assert.equal(selectionTSV({A1:{value:'one'},B2:{value:'two'}},0,0,1,1),'one\t\n\ttwo');
});
test('reorder respects bounds without mutating the source',()=>{
  const source=['a','b','c'];
  assert.deepEqual(moveItem(source,0,2),['b','c','a']);
  assert.deepEqual(moveItem(source,0,-1),source);
  assert.deepEqual(source,['a','b','c']);
});
test('word count walks rich text nodes and separates blocks',()=>{
  assert.equal(wordCount({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'hello world'}]},{type:'paragraph',content:[{type:'text',text:'next'}]}]}),3);
  assert.equal(wordCount({type:'doc'}),0);
});
test('word count keeps formatting spans inside the same word',()=>{
  assert.equal(wordCount({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'sun'},{type:'text',text:'light',marks:[{type:'bold'}]}]}]}),1);
});
test('row window stays bounded at the end of large sheets',()=>{
  const window=rowWindow(999999,200,30,35);
  assert.equal(window.end,200);
  assert.equal(window.end-window.start,35);
  assert.deepEqual(rowWindow(0,200,30,35),{start:0,end:35});
});
test('clipboard rejects row and column overflow without changing cells',()=>{
  const cells={A1:{value:'safe'}};
  assert.throws(()=>pasteCells(cells,99999,0,'one\ntwo'),/100,000 rows/);
  assert.throws(()=>pasteCells(cells,0,999,'one\ttwo'),/1,000 columns/);
  assert.deepEqual(cells,{A1:{value:'safe'}});
  assert.deepEqual(planPaste('one\r\n',99999,999),{values:[['one']],rows:100000,columns:1000});
});
test('clipboard validates every cell before applying any values',()=>{
  const cells={A1:{value:'safe'}};
  assert.throws(()=>pasteCells(cells,0,0,`replacement\t${'x'.repeat(32768)}`),/32,767 characters/);
  assert.equal(cells.A1.value,'safe');
  assert.equal(pasteCells({},0,0,'x'.repeat(32767)).A1.value.length,32767);
});
test('sum rejects a result row beyond workbook bounds',()=>{
  assert.equal(sumTargetRow(99998,99998,99998,[]),99998);
  assert.throws(()=>sumTargetRow(99998,99999,99999,[]),/last row/);
  assert.throws(()=>sumTargetRow(0,0,0,[99999]),/last row/);
  assert.equal(sumTargetRow(0,2,2,[]),3);
});
test('local echoes keep the draft while accepted external content ends it',()=>{
  const expected={id:'sheet',cells:{A1:{value:'local'}},rows:200,columns:26};
  const draft={sheetId:'sheet',address:'A1',value:'local',original:'before'};
  assert.equal(reconcileDraft(draft,expected,structuredClone(expected)),draft);
  assert.equal(reconcileDraft(draft,expected,{...expected,cells:{A1:{value:'bridge'}}}),null);
  assert.equal(reconcileDraft(draft,expected,{...expected,cells:{...expected.cells,B2:{value:'bridge'}}}),null);
  assert.equal(reconcileDraft(draft,expected,{...expected,id:'other'}),null);
});
test('slide inspector clamps negative positions and oversize dimensions',()=>{
  const element={x:100,y:100,w:300,h:200};
  assert.equal(slideDimension(element,'x',-20),0);
  assert.equal(slideDimension(element,'y',-20),0);
  assert.equal(slideDimension(element,'x',9999),660);
  assert.equal(slideDimension(element,'w',9999),860);
  assert.equal(slideDimension(element,'h',-2),24);
});
test('presentation index stays valid after an incoming slide removal',()=>{
  assert.equal(presentationIndex(4,2),1);
  assert.equal(presentationIndex(null,2),null);
  assert.equal(presentationIndex(0,0),null);
  assert.equal(presentationIndex(-4,2),0);
});
