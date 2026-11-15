import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPdfPages,selectListedPdfPages,parsePdfPageSelection,formatPdfPageSelection} from '../core/pdf-page-selection.mjs';

test('ported upstream open-ended and empty document cases',()=>{
 assert.deepEqual(selectPdfPages(5,'-'),[0,1,2,3,4]);
 assert.throws(()=>selectPdfPages(0,'-'),{code:'NO_PAGES'});
 assert.deepEqual(selectPdfPages(3,''),[0,1,2]);
});
test('print order preserves repeats, descending ranges and physical parity',()=>{
 assert.deepEqual(selectPdfPages(10,'2,7-10',{subset:'even'}),[1,7,9]);
 assert.deepEqual(selectPdfPages(5,'4-2;2',{reverse:true}),[1,1,2,3]);
 assert.deepEqual(selectPdfPages(5,'-2,4-'),[0,1,3,4]);
 assert.deepEqual(selectListedPdfPages(5,[4,1,0,1],{subset:'even',reverse:true}),[1,1]);
 assert.throws(()=>selectListedPdfPages(5,[5]),{code:'OUT_OF_RANGE'});
 assert.throws(()=>selectPdfPages(1,null,{subset:'even'}),{code:'NO_PAGES'});
});
test('logical labels win, including complete hyphenated labels and range endpoints',()=>{
 const labels=['iv','1','A-1','A-2','A-3'];
 assert.deepEqual(selectPdfPages(5,'1',{labels}),[1]);
 assert.deepEqual(selectPdfPages(5,'A-1',{labels}),[2]);
 assert.deepEqual(selectPdfPages(5,'A-1-A-3',{labels}),[2,3,4]);
 assert.deepEqual(selectPdfPages(5,'A-3-A-1',{labels}),[4,3,2]);
 assert.deepEqual(selectPdfPages(5,'A-2-',{labels}),[3,4]);
 assert.deepEqual(selectPdfPages(5,'-A-2',{labels}),[0,1,2,3]);
});
test('ported upstream organization selection fixtures',()=>{
 const selected=parsePdfPageSelection('1,12,16-18,89,92,93,97,99',100);
 assert.deepEqual(selected,[0,11,15,16,17,88,91,92,96,98]);
 assert.equal(formatPdfPageSelection(selected),'1, 12, 16-18, 89, 92-93, 97, 99');
 assert.deepEqual(parsePdfPageSelection('3-1,2',3),[0,1,2]);
 assert.deepEqual(parsePdfPageSelection('  ',0),[]);
 for(const value of ['0','101','1,','x','1--3','18446744073709551616','1-100000000'])assert.throws(()=>parsePdfPageSelection(value,100));
 assert.throws(()=>parsePdfPageSelection('1,'.repeat(10000),100),{code:'LIMIT_EXCEEDED'});
 assert.throws(()=>parsePdfPageSelection('1-1000000,1-1000000',1000000),{code:'LIMIT_EXCEEDED'});
});
test('JS boundary validation and print expansion are bounded',()=>{
 for(const count of [-1,NaN,Infinity,1.5])assert.throws(()=>selectPdfPages(count));
 assert.throws(()=>selectPdfPages(1000001),{code:'LIMIT_EXCEEDED'});
 assert.throws(()=>selectPdfPages(1000000,'1-1000000,1-1000000'),{code:'LIMIT_EXCEEDED'});
 assert.throws(()=>selectPdfPages(2,'1',{labels:['a','b','c']}));
 assert.throws(()=>selectPdfPages(2,'1',{subset:'other'}));
 assert.throws(()=>selectListedPdfPages(2,[-1]));
 assert.deepEqual(selectPdfPages(3,'1,,;3,'),[0,2]);
});
test('organization parse/format round trips arbitrary subsets without mutation',()=>{
 for(let mask=0;mask<256;mask++){
  const pages=Array.from({length:8},(_,i)=>i).filter(i=>mask&(1<<i));
  const shuffled=[...pages].reverse();
  assert.deepEqual(parsePdfPageSelection(formatPdfPageSelection(shuffled),8),pages);
  assert.deepEqual(shuffled,[...pages].reverse());
 }
});
