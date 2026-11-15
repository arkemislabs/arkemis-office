import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts,degrees} from 'pdf-lib';
import {createPdfContent,createBlankPdfContent,applyPdfOperation,exportPdf,extractPdfStructure,validatePdfContent,structurePdfText} from '../core/pdf-document.mjs';

async function fixture(){const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);const a=pdf.addPage([300,400]);a.drawText('Hello PDF',{x:30,y:350,size:20,font});const b=pdf.addPage([400,300]);b.drawText('Second page',{x:20,y:250,size:15,font});b.setRotation(degrees(90));return pdf.save();}
test('imports source pages with stable geometry and rejects invalid/oversize input',async()=>{
 const content=await createPdfContent(await fixture(),'fixture.pdf');assert.equal(content.pages.length,2);assert.equal(content.pages[0].width,300);assert.equal(content.pages[1].sourceRotation,90);assert.equal(content.pages[1].rotation,0);assert.equal(content.sourceName,'fixture.pdf');
 await assert.rejects(createPdfContent(new Uint8Array(10*1024*1024+1),'large.pdf'),/10 MB/);await assert.rejects(createPdfContent(new TextEncoder().encode('not PDF'),'invalid.pdf'),/PDF/);
});
test('page operations are immutable, bounded and cannot delete the last page',async()=>{
 const content=await createPdfContent(await fixture(),'fixture.pdf');const id=content.pages[0].id;
 const rotated=applyPdfOperation(content,{type:'rotate',pageId:id,degrees:90});assert.equal(rotated.pages[0].rotation,90);assert.equal(content.pages[0].rotation,0);
 const moved=applyPdfOperation(rotated,{type:'move',pageId:id,toIndex:1});assert.equal(moved.pages[1].id,id);
 const removed=applyPdfOperation(moved,{type:'delete',pageId:id});assert.equal(removed.pages.length,1);assert.throws(()=>applyPdfOperation(removed,{type:'delete',pageId:removed.pages[0].id}),/last page/);
 assert.throws(()=>applyPdfOperation(content,{type:'rotate',pageId:id,degrees:45}),/90/);assert.throws(()=>applyPdfOperation(content,{type:'move',pageId:id,toIndex:9}),/index/);
});
test('exports reordered rotated pages and real text overlay into a parseable PDF',async()=>{
 let content=await createPdfContent(await fixture(),'fixture.pdf');const id=content.pages[0].id;
 content=applyPdfOperation(content,{type:'add-overlay',pageId:id,overlay:{id:'note',type:'text',x:40,y:100,width:180,height:25,text:'Added note',fontSize:16,color:'#123456'}});
 content=applyPdfOperation(content,{type:'rotate',pageId:id,degrees:90});content=applyPdfOperation(content,{type:'move',pageId:id,toIndex:1});
 const output=await exportPdf(content);assert.equal(new TextDecoder().decode(output.slice(0,5)),'%PDF-');const loaded=await PDFDocument.load(output);assert.equal(loaded.getPageCount(),2);assert.equal(loaded.getPage(1).getRotation().angle,90);assert.equal(loaded.getPage(0).getWidth(),400);
 const structure=await extractPdfStructure(content);assert.match(structure.pages[1].text,/Added note/);assert.ok(structure.pages[1].words.some(w=>w.text==='Hello'));assert.ok(structure.pages[1].characters.every(c=>Number.isFinite(c.x)&&Number.isFinite(c.y)));assert.equal(structure.pages[1].characters[0].geometry,'estimated');
});
test('validation rejects destructive pretend-redaction, invalid geometry and source references',async()=>{
 const content=await createPdfContent(await fixture(),'fixture.pdf');const pageId=content.pages[0].id;
 assert.throws(()=>applyPdfOperation(content,{type:'add-overlay',pageId,overlay:{id:'bad',type:'redact',x:0,y:0,width:20,height:20}}),/overlay type/);
 assert.throws(()=>applyPdfOperation(content,{type:'add-overlay',pageId,overlay:{id:'bad',type:'highlight',x:290,y:0,width:20,height:20,color:'#ffff00'}}),/bounds/);
 await assert.rejects(exportPdf({...content,pages:[{...content.pages[0],sourceIndex:500}]}),/source page/);
 assert.throws(()=>validatePdfContent({...content,pages:[{...content.pages[0],width:NaN}]}),/dimensions/);
});
test('blank documents are genuine one-page PDFs and source remains immutable after overlays',async()=>{
 const content=await createBlankPdfContent();assert.equal(content.pages.length,1);const source=content.sourceBase64;
 const changed=applyPdfOperation(content,{type:'add-overlay',pageId:content.pages[0].id,overlay:{id:'box',type:'rectangle',x:20,y:20,width:40,height:40,color:'#ff0000'}});assert.equal(changed.sourceBase64,source);assert.equal(content.pages[0].overlays.length,0);assert.equal((await PDFDocument.load(await exportPdf(changed))).getPageCount(),1);
});
test('crop offsets and rotated text coordinates match the exported visible page',async()=>{
 const source=await PDFDocument.create(),page=source.addPage([400,500]);page.setCropBox(50,60,300,400);
 let content=await createPdfContent(await source.save(),'crop.pdf');assert.equal(content.pages[0].width,300);
 const pageId=content.pages[0].id;
 content=applyPdfOperation(content,{type:'add-overlay',pageId,overlay:{id:'text',type:'text',x:40,y:100,width:150,height:30,text:'Rotated',fontSize:16,color:'#000000'}});
 content=applyPdfOperation(content,{type:'rotate',pageId,degrees:90});
 const structure=await extractPdfStructure(content),result=structure.pages[0],word=result.words.find(word=>word.text==='Rotated');
 assert.equal(result.width,400);assert.equal(result.height,300);assert.ok(Math.abs(word.y-40)<1);assert.ok(word.x>275&&word.x<300);
});
test('structured extraction stops at requested character/page budgets',async()=>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const text=structurePdfText({items:[{str:'x'.repeat(200000),width:200000,transform:[10,0,0,10,0,20],fontName:'f',dir:'ltr'}],styles:{f:{ascent:.8}}},{transform:[1,0,0,-1,0,100],scale:1},'page',pdfjs,{maxCharacters:40});
 assert.equal(text.characters.length,40);assert.equal(text.text.length,40);assert.equal(text.truncated,true);
 const content=await createPdfContent(await fixture());const result=await extractPdfStructure(content,{maxPages:1,maxCharacters:5});assert.equal(result.pages.length,1);assert.equal(result.pages[0].characters.length,5);assert.equal(result.truncated,true);
});
test('export preserves existing AcroForm values and rejects unsupported structural form edits',async()=>{
 const source=await PDFDocument.create(),page=source.addPage([300,400]);source.addPage([300,400]);
 const field=source.getForm().createTextField('customer');field.setText('Alice');field.addToPage(page,{x:20,y:300,width:150,height:30});
 const sourceBytes=await source.save(),content=await createPdfContent(sourceBytes,'form.pdf');assert.deepEqual(await exportPdf(content),sourceBytes);
 const annotated=applyPdfOperation(content,{type:'add-overlay',pageId:content.pages[0].id,overlay:{id:'mark',type:'rectangle',x:20,y:150,width:100,height:20,color:'#ff0000'}}),output=await PDFDocument.load(await exportPdf(annotated));
 assert.equal(output.getForm().getTextField('customer').getText(),'Alice');
 await assert.rejects(exportPdf(applyPdfOperation(content,{type:'delete',pageId:content.pages[1].id})),/form|structure/i);
});
test('validation rejects malformed base64 before persistence and export rejects text overflow',async()=>{
 const content=await createBlankPdfContent();assert.throws(()=>validatePdfContent({...content,sourceBase64:'x'}),/encoding/);
 assert.throws(()=>validatePdfContent({...content,sourceBase64:'!!!!'}),/encoding/);
 const changed=applyPdfOperation(content,{type:'add-overlay',pageId:content.pages[0].id,overlay:{id:'overflow',type:'text',x:20,y:20,width:100,height:25,text:Array(30).fill('line').join('\n'),fontSize:16,color:'#000000'}});
 await assert.rejects(exportPdf(changed),/fit|height|overflow/i);
});
