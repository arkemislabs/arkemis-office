import test from 'node:test';import assert from 'node:assert/strict';import {createFile} from '../core/model.mjs';
test('literal formula text survives XLSX and CSV export',async()=>{
 const {exportDocument,importDocument}=await import('../electron/formats.cjs');const {default:ExcelJS}=await import('exceljs');
 const file=createFile('grid','Text');file.content.sheets[0].cells={A1:{value:'=1+1',valueType:'text'},B1:{value:'00123',valueType:'text'}};
 const data=await exportDocument(file,'xlsx');const book=new ExcelJS.Workbook();await book.xlsx.load(data);
 assert.equal(book.worksheets[0].getCell('A1').value,'=1+1');
 const imported=await importDocument(data,'xlsx','Text');assert.equal(imported.content.sheets[0].cells.A1.valueType,'text');
 assert.match((await exportDocument(file,'csv')).toString(),/=1\+1,00123/);
});
test('XLSX export preserves leading zeros and long numeric text identifiers',async()=>{
 const {exportDocument}=await import('../electron/formats.cjs');const {default:ExcelJS}=await import('exceljs');const f=createFile('grid','IDs');f.content.sheets[0].cells={A1:{value:'00123'},A2:{value:'9007199254740993'},A3:{value:'123',valueType:'text'}};
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await exportDocument(f,'xlsx'));
 assert.equal(workbook.worksheets[0].getCell('A1').value,'00123');assert.equal(workbook.worksheets[0].getCell('A2').value,'9007199254740993');assert.equal(workbook.worksheets[0].getCell('A3').value,'123');
});
test('Office exports are real editable OOXML packages and spreadsheet formulas survive import',async()=>{
 const m=await import('../electron/formats.cjs').catch(()=>({}));assert.equal(typeof m.exportDocument,'function');
 const {default:JSZip}=await import('jszip');
 const doc=createFile('quill','Report');doc.content.doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Hello Arkemis',marks:[{type:'bold'}]}]}]};
 const word=await JSZip.loadAsync(await m.exportDocument(doc,'docx'));assert.match(await word.file('word/document.xml').async('string'),/Hello Arkemis/);
 const grid=createFile('grid','Budget');grid.content.sheets[0].cells={A1:{value:'12'},A2:{value:'=A1*2'}};
 const data=await m.exportDocument(grid,'xlsx');const imported=await m.importDocument(data,'xlsx','Imported');assert.equal(imported.content.sheets[0].cells.A2.value,'=A1*2');
 const prism=createFile('prism','Pitch');const ppt=await JSZip.loadAsync(await m.exportDocument(prism,'pptx'));assert.match(await ppt.file('ppt/slides/slide1.xml').async('string'),/A new perspective/);
});
test('Word import retains editable headings, bold runs, paragraph alignment and tables',async()=>{
 const {exportDocument,importDocument}=await import('../electron/formats.cjs');
 const doc=createFile('quill','Styled');doc.content.doc={type:'doc',content:[{type:'heading',attrs:{level:2,textAlign:'center'},content:[{type:'text',text:'Heading',marks:[{type:'bold'}]}]},{type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'Table value'}]}]}]}]}]};
 const result=await importDocument(await exportDocument(doc,'docx'),'docx','Imported');
 assert.equal(result.content.doc.content[0].type,'heading');assert.equal(result.content.doc.content[0].attrs.level,2);
 assert.equal(result.content.doc.content[0].attrs.textAlign,'center');assert.ok(result.content.doc.content[0].content[0].marks.some(m=>m.type==='bold'));
 assert.equal(result.content.doc.content[1].type,'table');
});
test('PowerPoint import retains independent positioned objects, background and notes',async()=>{
 const {exportDocument,importDocument}=await import('../electron/formats.cjs');const f=createFile('prism','Positioned');
 const slide=f.content.slides[0];slide.background='#eeeeee';slide.notes='Presenter notes';slide.elements.push({id:crypto.randomUUID(),type:'shape',x:200,y:350,w:120,h:60,fill:'#0a0a0a'});
 const result=await importDocument(await exportDocument(f,'pptx'),'pptx','Imported');const imported=result.content.slides[0];
 assert.equal(imported.elements.length,3);assert.equal(imported.background.toLowerCase(),'#eeeeee');assert.match(imported.notes,/Presenter notes/);
 assert.ok(Math.abs(imported.elements[0].x-80)<1);assert.ok(Math.abs(imported.elements[0].w-800)<1);assert.equal(imported.elements[2].type,'shape');
});
