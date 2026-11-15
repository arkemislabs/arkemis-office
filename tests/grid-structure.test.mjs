import test from 'node:test';import assert from 'node:assert/strict';
test('inserting a row moves cell styles and updates absolute references without rewriting strings',async()=>{
 const {shiftSheet}=await import('../core/grid-structure.mjs');
 const s={id:'s',name:'Sheet',rows:200,columns:26,cells:{A1:{value:'2',bold:true},A2:{value:'3'},B3:{value:'=SUM($A$1:A2)+IF(TRUE,0,"A2")'}}};
 const next=shiftSheet(s,'row',1,1);assert.equal(next.cells.A3.value,'3');assert.equal(next.cells.B4.value,'=SUM($A$1:A3)+IF(TRUE,0,"A2")');assert.equal(next.cells.A1.bold,true);assert.equal(s.cells.A2.value,'3');
});
test('deletion shrinks ranges and identifies references to removed cells',async()=>{
 const {shiftSheet}=await import('../core/grid-structure.mjs');const s={id:'s',name:'Sheet',rows:200,columns:26,cells:{A2:{value:'3'},B1:{value:'=SUM(A1:A3)'},C1:{value:'=$A$2'}}};
 const n=shiftSheet(s,'row',1,-1);assert.equal(n.cells.B1.value,'=SUM(A1:A2)');assert.equal(n.cells.C1.value,'=#REF!');assert.equal(n.cells.A2,undefined);
});
test('fill down adjusts relative references and preserves absolute ones and literal text',async()=>{
 const {fillRange}=await import('../core/grid-structure.mjs');const cells={A1:{value:'=$B1+C$2+$D$4',bold:true},B1:{value:'=literal',valueType:'text'}};
 const next=fillRange(cells,{r1:0,r2:2,c1:0,c2:1},'down');assert.equal(next.A3.value,'=$B3+C$2+$D$4');assert.equal(next.A3.bold,true);assert.equal(next.B3.value,'=literal');assert.equal(cells.A3,undefined);
});
test('structural edits reject overflow and whole-dimension deletion',async()=>{
 const {shiftSheet}=await import('../core/grid-structure.mjs');assert.throws(()=>shiftSheet({rows:100000,columns:26,cells:{}},'row',0,1),/limit/i);assert.throws(()=>shiftSheet({rows:1,columns:26,cells:{}},'row',0,-1),/last/i);
});
test('structural edits handle spaced ranges and remain usable after reference deletion',async()=>{const {shiftSheet,translateFormula}=await import('../core/grid-structure.mjs');const s={rows:200,columns:26,cells:{B4:{value:'=SUM(A1 : A3)'},C4:{value:'=A1'}}};const n=shiftSheet(s,'row',0,-1);assert.equal(n.cells.B3.value,'=SUM(A1:A2)');assert.equal(n.cells.C3.value,'=#REF!');assert.doesNotThrow(()=>shiftSheet(n,'row',0,1));assert.equal(translateFormula('=Q1!A1',1,0),'=Q1!A2');});
