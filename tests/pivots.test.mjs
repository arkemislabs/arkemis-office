import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile,validateFile} from '../core/model.mjs';
const pivot=await import('../core/pivots.mjs').catch(()=>({}));
function workbook(rows){const file=createFile('grid');const sheet=file.content.sheets[0];sheet.id='source';file.content.activeSheetId='source';rows.forEach((row,r)=>row.forEach((value,c)=>sheet.cells[String.fromCharCode(65+c)+(r+1)]={value:String(value)}));return file;}
const data=()=>workbook([['Region','Quarter','Sales'],['West','Q1',10],['West','Q2',20],['East','Q1',5],['West','Q1','=C2+5'],['East','Q2',''],['East','Q2','text']]);
const definition=(changes={})=>({sourceSheetId:'source',sourceRange:'A1:C7',rowFields:[0],columnField:null,measures:[{field:2,aggregate:'SUM'}],...changes});
const values=s=>Object.fromEntries(Object.entries(s.cells).map(([a,c])=>[a,c.value]));
test('pivots group rows and evaluate formulas without mutating source',()=>{
 assert.equal(typeof pivot.createPivotSheet,'function');const file=data(),before=structuredClone(file.content);const next=pivot.createPivotSheet(file.content,definition(),'pivot');
 assert.deepEqual(file.content,before);assert.equal(next.activeSheetId,'pivot');assert.deepEqual(values(next.sheets[1]),{A1:'Region',B1:'SUM Sales',A2:'West',B2:'45',A3:'East',B3:'5'});assert.deepEqual(next.sheets[1].pivot,definition());
});
test('column groups and all five measures use independent nonblank/numeric semantics',()=>{
 const measures=['SUM','COUNT','AVG','MIN','MAX'].map(aggregate=>({field:2,aggregate}));const next=pivot.createPivotSheet(data().content,definition({columnField:1,measures}),'pivot');const v=values(next.sheets[1]);
 assert.equal(v.B1,'Q1 · SUM Sales');assert.equal(v.G1,'Q2 · SUM Sales');assert.deepEqual([v.B2,v.C2,v.D2,v.E2,v.F2],['25','2','12.5','10','15']);assert.deepEqual([v.G3,v.H3,v.I3,v.J3,v.K3],['0','1','','','']);
});
test('refresh preserves result identity, replaces stale cells and survives JSON persistence',()=>{
 const content=pivot.createPivotSheet(data().content,definition(),'pivot');content.sheets[1].name='Revenue report';content.sheets[0].cells.C2.value='30';delete content.sheets[0].cells.A4;content.sheets[1].cells.Z99={value:'old'};
 const file=data();file.content=JSON.parse(JSON.stringify(content));validateFile(file);const refreshed=pivot.refreshPivotSheet(file.content,'pivot');assert.equal(refreshed.sheets.length,2);assert.equal(refreshed.sheets[1].id,'pivot');assert.equal(refreshed.sheets[1].name,'Revenue report');assert.equal(refreshed.sheets[1].cells.B2.value,'85');assert.equal(refreshed.sheets[1].cells.Z99,undefined);
});
test('multiple row fields group without delimiter collisions and preserve formula-like labels as text',()=>{
 const file=workbook([['Team','Area','Value'],['a|b','c',2],['a','b|c',3],['=SUM(1,2)','x',4]]);file.content.sheets[0].cells.A4.valueType='text';const s=pivot.createPivotSheet(file.content,definition({sourceRange:'A1:C4',rowFields:[0,1]}),'pivot').sheets[1];
 assert.deepEqual([s.cells.C2.value,s.cells.C3.value,s.cells.C4.value],['2','3','4']);assert.equal(s.cells.A4.value,'=SUM(1,2)');assert.equal(s.cells.A4.valueType,'text');
});
test('source validation rejects bad ranges, headers, missing sources and formula errors',()=>{
 for(const sourceRange of ['A1:C1','C7:A1','A0:C7','A1:ALL100001','A1:Z100000'])assert.throws(()=>pivot.createPivotSheet(data().content,definition({sourceRange}),'pivot'),/range|limit|bounds/i);
 for(const cells of [{B1:{value:''}},{B1:{value:'Region'}},{C3:{value:'=1/0'}}]){const file=data();Object.assign(file.content.sheets[0].cells,cells);assert.throws(()=>pivot.createPivotSheet(file.content,definition(),'pivot'),/header|error/i);}
 assert.throws(()=>pivot.createPivotSheet(data().content,definition({sourceSheetId:'missing'}),'pivot'),/source/i);
});
test('invalid persisted definitions fail document validation without blocking a deleted source snapshot',()=>{
 for(const changes of [{rowFields:[]},{rowFields:[0,0]},{rowFields:[99]},{columnField:0},{measures:[]},{measures:[{field:2,aggregate:'MEDIAN'}]},{sourceRange:'invalid'}]){
 const file=data();file.content.sheets.push({id:'pivot',name:'Pivot',cells:{},rows:1,columns:1,pivot:definition(changes)});assert.throws(()=>validateFile(file),/pivot|range|field/i);
 }
 const file=data();file.content.sheets.push({id:'pivot',name:'Pivot',cells:{},rows:1,columns:1,pivot:definition()});file.content.sheets=file.content.sheets.slice(1);file.content.activeSheetId='pivot';assert.equal(validateFile(file),file);assert.throws(()=>pivot.refreshPivotSheet(file.content,'pivot'),/source/i);
});
test('creation respects workbook limit and refresh enforces output bounds before allocation',()=>{
 const content=data().content;content.sheets=Array.from({length:100},(_,i)=>({...content.sheets[0],id:i?'s'+i:'source'}));assert.throws(()=>pivot.createPivotSheet(content,definition(),'pivot'),/100|limit/i);
 const file=workbook([['Row','Col','Value']]);for(let r=2;r<=1001;r++){file.content.sheets[0].cells['A'+r]={value:'row'+r};file.content.sheets[0].cells['B'+r]={value:'col'+r};file.content.sheets[0].cells['C'+r]={value:'1'};}file.content.sheets[0].rows=1001;
 assert.throws(()=>pivot.createPivotSheet(file.content,definition({sourceRange:'A1:C1001',columnField:1}),'pivot'),/limit|large|columns/i);
});
test('zero column categories are not mislabeled as blank',()=>{
 const file=workbook([['Team','Year','Value'],['A',0,4],['A','',3]]);const result=pivot.createPivotSheet(file.content,definition({sourceRange:'A1:C3',columnField:1}),'pivot');
 assert.equal(result.sheets[1].cells.B1.value,'0 · SUM Value');assert.equal(result.sheets[1].cells.C1.value,'(blank) · SUM Value');
});
test('XLSX export contains editable result values and no misleading native pivot metadata',async()=>{
 const {exportDocument,importDocument}=await import('../electron/formats.cjs');const {default:ExcelJS}=await import('exceljs');const {default:JSZip}=await import('jszip');
 const file=data();file.content=pivot.createPivotSheet(file.content,definition(),'pivot');const bytes=await exportDocument(file,'xlsx'),book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
 assert.equal(book.getWorksheet('Pivot 1').getCell('B2').value,45);assert.equal(book.getWorksheet('Pivot 1').getCell('A2').value,'West');
 const zip=await JSZip.loadAsync(bytes);assert.equal(Object.keys(zip.files).some(name=>name.includes('pivotTable')||name.includes('pivotCache')),false);
 const imported=await importDocument(bytes,'xlsx','Imported');assert.equal(imported.content.sheets[1].cells.B2.value,'45');assert.equal(imported.content.sheets[1].pivot,undefined);
});
test('formula strings beginning with hash are legitimate pivot headers and labels',()=>{
 const file=workbook([['="#Team"','Sales'],['="#hashtag"',7],['Other',4]]);const result=pivot.createPivotSheet(file.content,definition({sourceRange:'A1:B3',measures:[{field:1,aggregate:'SUM'}]}),'pivot');
 assert.equal(result.sheets[1].cells.A1.value,'#Team');assert.equal(result.sheets[1].cells.A2.value,'#hashtag');assert.equal(result.sheets[1].cells.B2.value,'7');
});
test('source structure changes are blocked while a dependent pivot definition would become stale',()=>{
 const content=pivot.createPivotSheet(data().content,definition(),'pivot');assert.throws(()=>pivot.assertPivotSourceStructureAllowed(content,'source'),/pivot|source/i);assert.doesNotThrow(()=>pivot.assertPivotSourceStructureAllowed(content,'pivot'));content.sheets.pop();assert.doesNotThrow(()=>pivot.assertPivotSourceStructureAllowed(content,'source'));
});
