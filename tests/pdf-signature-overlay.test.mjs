import test from 'node:test';import assert from 'node:assert/strict';import {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createBlankPdfContent,applyPdfOperation,exportPdf} from '../core/pdf-document.mjs';
test('drawn signature persists as bounded vector strokes and exports actual ink',async()=>{
 const source=await createBlankPdfContent(),pageId=source.activePageId;
 const overlay={id:'sig',type:'signature',x:20,y:30,width:100,height:40,color:'#123456',strokes:[[{x:0,y:0},{x:.5,y:1},{x:1,y:0}]]};
 const next=applyPdfOperation(source,{type:'add-overlay',pageId,overlay});assert.equal(source.pages[0].overlays.length,0);assert.deepEqual(next.pages[0].overlays[0].strokes,overlay.strokes);
 const pdf=await PDFDocument.load(await exportPdf(next)),streams=pdf.getPage(0).node.lookup(PDFName.of('Contents'),PDFArray);const operators=streams.asArray().map(ref=>Buffer.from(decodePDFRawStream(pdf.context.lookup(ref,PDFRawStream)).decode()).toString()).join('\n');
 assert.match(operators,/20 [\d.]+ m/);assert.match(operators,/70 [\d.]+ l/);assert.match(operators,/120 [\d.]+ l/);
 assert.throws(()=>applyPdfOperation(source,{type:'add-overlay',pageId,overlay:{...overlay,strokes:[[{x:2,y:0},{x:1,y:1}]]}}),/stroke/i);
 assert.throws(()=>applyPdfOperation(source,{type:'add-overlay',pageId,overlay:{...overlay,strokes:[]}}),/stroke/i);
});
