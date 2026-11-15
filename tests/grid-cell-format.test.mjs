import test from 'node:test';import assert from 'node:assert/strict';import ExcelJS from 'exceljs';
import {importDocument,exportDocument} from '../electron/formats.cjs';
import {applyCellFormatting} from '../core/grid-cell-format.mjs';
test('border color/style changes retain each selected cell edge pattern',()=>{
 const empty={value:'a'},bordered={value:'b',borders:{top:{style:'double',color:'#000000'},left:{style:'thin',color:'#000000'}}};
 assert.deepEqual(applyCellFormatting(empty,{}, {color:'#123456'}).borders,{});
 const result=applyCellFormatting(bordered,{}, {color:'#123456'});assert.deepEqual(Object.keys(result.borders),['top','left']);assert.equal(result.borders.top.style,'double');assert.equal(result.borders.left.color,'#123456');assert.equal(bordered.borders.top.color,'#000000');
 assert.deepEqual(applyCellFormatting(bordered,{borders:{}},{style:'dashed'}).borders,{});
});
test('editable XLSX cell typography, alignment, borders and custom number format survive',async()=>{
 const book=new ExcelJS.Workbook(),s=book.addWorksheet('Styled');const c=s.getCell('B2');c.value=123.45;
 c.font={name:'Georgia',size:18,bold:true,italic:true,underline:'double',strike:true,color:{argb:'FF126734'}};
 c.alignment={horizontal:'center',vertical:'middle',wrapText:true,textRotation:45,indent:2};c.numFmt='0.0000';
 c.border={top:{style:'double',color:{argb:'FF235678'}},bottom:{style:'thin',color:{argb:'FF123456'}}};
 const file=await importDocument(Buffer.from(await book.xlsx.writeBuffer()),'xlsx','Styled');const cell=file.content.sheets[0].cells.B2;
 assert.equal(cell.fontFamily,'Georgia');assert.equal(cell.fontSize,18);assert.equal(cell.italic,true);assert.equal(cell.underline,'double');assert.equal(cell.wrap,true);assert.equal(cell.verticalAlign,'middle');assert.equal(cell.rotation,45);assert.equal(cell.numFmt,'0.0000');
 cell.value='456.78';const out=new ExcelJS.Workbook();await out.xlsx.load(await exportDocument(file,'xlsx'));const result=out.worksheets[0].getCell('B2');
 assert.equal(result.value,456.78);assert.equal(result.font.name,'Georgia');assert.equal(result.font.italic,true);assert.equal(result.font.underline,'double');assert.equal(result.alignment.textRotation,45);assert.equal(result.alignment.wrapText,true);assert.equal(result.border.top.style,'double');assert.equal(result.border.top.color.argb,'FF235678');assert.equal(result.numFmt,'0.0000');
});
