import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createPdfContent} from '../core/pdf-document.mjs';
const workerUrl=new URL('../runtime/format-worker.cjs',import.meta.url);
function run(data){return new Promise((resolve,reject)=>{const worker=new Worker(workerUrl,{workerData:data}),timer=setTimeout(()=>{worker.terminate();reject(new Error('PDF text worker timed out'));},30000);worker.once('message',message=>{clearTimeout(timer);worker.terminate();message.ok?resolve(message.result):reject(new Error(message.error));});worker.once('error',error=>{clearTimeout(timer);reject(error);});});}
test('built CJS conversion worker initializes PDFium and edits actual source text',async t=>{
 try{await fs.access(workerUrl);}catch{t.skip('Run npm run build to exercise the packaged conversion worker');return;}
 const doc=await PDFDocument.create(),page=doc.addPage([400,200]),font=await doc.embedFont(StandardFonts.Helvetica);page.drawText('Worker original',{x:30,y:100,size:14,font});const content=await createPdfContent(await doc.save());
 const objects=await run({operation:'inspect_pdf_text',content,pageId:content.activePageId});assert.equal(objects[0].text,'Worker original');
 const result=await run({operation:'replace_pdf_text',content,edit:{pageId:content.activePageId,objectIndex:objects[0].objectIndex,expectedText:'Worker original',text:'Worker edited'}});
 assert.equal((await run({operation:'inspect_pdf_text',content:result,pageId:result.activePageId}))[0].text,'Worker edited');
});
