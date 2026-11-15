import test from 'node:test';import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';import {PDFDocument} from 'pdf-lib';
import {createPdfContent} from '../core/pdf-document.mjs';
function run(content){return new Promise((resolve,reject)=>{
 const worker=new Worker(new URL('../runtime/format-worker.cjs',import.meta.url),{workerData:{operation:'inspect_pdf_signatures',content}});
 const timer=setTimeout(()=>{worker.terminate();reject(Error('Signature worker timed out'));},30000);
 worker.once('message',m=>{clearTimeout(timer);worker.terminate();m.ok?resolve(m.result):reject(Error(m.error));});
 worker.once('error',e=>{clearTimeout(timer);worker.terminate();reject(e);});
});}
test('packaged signature worker inspects unsigned PDF without modifying content',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const content=await createPdfContent(await pdf.save());const original=JSON.stringify(content);
 assert.deepEqual(await run(content),[]);assert.equal(JSON.stringify(content),original);
 await assert.rejects(()=>run({...content,sourceBase64:'invalid'}));
});
