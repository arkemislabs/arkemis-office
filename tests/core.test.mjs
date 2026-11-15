import test from 'node:test';
import assert from 'node:assert/strict';
test('native imports reject malformed rich trees and bridge writes expand visible sheet dimensions',async()=>{
 const {createFile,validateFile,applyCommand}=await import('../core/model.mjs');
 const bad=createFile('quill','Invalid');bad.content.doc.content='invalid';assert.throws(()=>validateFile(bad),/rich/i);
 const grid=createFile('grid','Large');const next=applyCommand(grid,{type:'set_cells',baseRevision:0,sheetId:grid.content.activeSheetId,cells:{AB250:{value:'Visible'}}});
 assert.equal(next.content.sheets[0].rows,250);assert.equal(next.content.sheets[0].columns,28);
});

const formulaPath = new URL('../core/formulas.mjs', import.meta.url);
test('explicit spreadsheet text preserves numeric identifiers and formula-like literals',async()=>{
 const {evaluateCell}=await import(formulaPath);
 assert.equal(evaluateCell({A1:{value:'00123',valueType:'text'}},'A1'),'00123');
 assert.equal(evaluateCell({A1:{value:'=1+1',valueType:'text'}},'A1'),'=1+1');
});
test('deleted cell reference errors propagate while lazy IF can skip them',async()=>{const {evaluateCell}=await import(formulaPath);assert.equal(evaluateCell({A1:{value:'=#REF!+1'}},'A1'),'#REF!');assert.equal(evaluateCell({A1:{value:'=IF(TRUE,7,#REF!)'}},'A1'),7);});
test('calculations match installed Excel on lazy IF and negative half rounding',async()=>{
 const {evaluateCell}=await import(formulaPath);
 assert.equal(evaluateCell({A1:{value:'=IF(42=42,7,1/0)'}},'A1'),7);
 assert.equal(evaluateCell({A1:{value:'=IF(FALSE,1/0,IF(TRUE,9,1/0))'}},'A1'),9);
 assert.equal(evaluateCell({A1:{value:'=ROUND(-1.5,0)'}},'A1'),-2);
 assert.equal(evaluateCell({A1:{value:'=-2^2'}},'A1'),4);
});
test('formula engine computes ranges, precedence and chained references without eval', async()=>{
 const m = await import(formulaPath).catch(()=>({}));
 assert.equal(typeof m.evaluateCell,'function','formula evaluator must exist');
 const cells={A1:{value:'10'},A2:{value:'20'},A3:{value:'=SUM(A1:A2)'},B1:{value:'=A3*2+5'},B2:{value:'=(2+3)*4'},B3:{value:'=AVERAGE(A1:A2)'}};
 assert.equal(m.evaluateCell(cells,'B1'),65); assert.equal(m.evaluateCell(cells,'B2'),20); assert.equal(m.evaluateCell(cells,'B3'),15);
 assert.equal(m.evaluateCell({A1:{value:'=A2'},A2:{value:'=A1'}},'A1'),'#CYCLE!');
 assert.equal(m.evaluateCell({A1:{value:'=1/0'}},'A1'),'#DIV/0!');
 assert.equal(m.evaluateCell({A1:{value:'=globalThis.process.exit()'}},'A1'),'#ERROR!');
});
test('CSV parser roundtrips embedded commas, quotes and multiline text',async()=>{
 const m=await import(formulaPath).catch(()=>({})); assert.equal(typeof m.parseCSV,'function');
 const rows=[['name','note'],['a,b','one\ntwo'],['quoted','"yes"']];
 assert.deepEqual(m.parseCSV(m.toCSV(rows)),rows);
});
test('document model validates content and applies revisioned commands', async()=>{
 const m=await import('../core/model.mjs').catch(()=>({})); assert.equal(typeof m.createFile,'function');
 const f=m.createFile('grid','Budget'); assert.equal(f.schema,1);
 const sid=f.content.activeSheetId;
 const next=m.applyCommand(f,{type:'set_cells',baseRevision:0,sheetId:sid,cells:{A1:{value:'12'}}});
 assert.equal(next.content.sheets[0].cells.A1.value,'12'); assert.equal(next.revision,1);
 assert.throws(()=>m.applyCommand(next,{type:'rename',baseRevision:0,title:'Lost update'}),/conflict/i);
 assert.throws(()=>m.validateFile({...f,id:'../../outside'}),/id/i);
 assert.throws(()=>m.validateFile({...f,kind:'other'}),/kind/i);
 assert.equal(f.content.sheets[0].cells.A1,undefined);
});
