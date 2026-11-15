import test from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';import {PDFDocument} from 'pdf-lib';import {createPdfContent} from '../core/pdf-document.mjs';import {inspectPdfForms} from '../core/pdf-workflows.mjs';
test('Electron format worker dispatches form design using a distinct edit payload',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([400,500]);const content=await createPdfContent(await pdf.save(),'form.pdf');
 const result=await new Promise((resolve,reject)=>{const worker=new Worker(new URL('../electron/format-worker.cjs',import.meta.url),{workerData:{operation:'design_pdf_form',content,edit:{type:'add',fieldType:'text',name:'Customer',pageId:content.pages[0].id,rect:{x:10,y:20,width:180,height:24},required:true}}});worker.once('message',message=>message.ok?resolve(message.result):reject(Error(message.error)));worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('worker exited '+code));});});
 const fields=await inspectPdfForms(result);assert.equal(fields[0].name,'Customer');assert.equal(fields[0].required,true);assert.equal(result.pages[0].id,content.pages[0].id);
});
