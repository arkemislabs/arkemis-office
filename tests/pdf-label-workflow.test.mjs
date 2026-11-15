import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFHexString} from 'pdf-lib';
import {readPdfLabelRanges,writePdfLabelRanges} from '../core/pdf-label-tree.mjs';
import {numberPdfPages,labelAt} from '../core/pdf-page-labels.mjs';
import {createPdfContent,exportPdf} from '../core/pdf-document.mjs';
import {applyPdfOperation,validatePdfContent} from '../core/pdf-model.mjs';
const r=(start,style='D',prefix='',first=1)=>({start,style,prefix,first});
async function fixture(){const doc=await PDFDocument.create();for(let i=0;i<6;i++)doc.addPage([200,300]);doc.setTitle('Keep this metadata');return doc;}
test('source numbering replaces interval and restores subsequent labels',()=>{
 const ranges=numberPdfPages([r(0,'r'),r(3,'D','A-',10)],6,1,4,'A','Part-',27);
 assert.deepEqual(Array.from({length:6},(_,i)=>labelAt(ranges,i,6)),['i','Part-AA','Part-BB','Part-CC','Part-DD','A-12']);
 assert.deepEqual(numberPdfPages([],6,0,5,'D','',1),[]);
});
test('nested number tree resolves Unicode prefixes and duplicate starts later wins',async()=>{
 const doc=await fixture(),ctx=doc.context;
 const spec=ctx.obj({S:PDFName.of('r'),P:PDFHexString.fromText('章-'),St:1});
 const child=ctx.register(ctx.obj({Nums:[0,spec,3,ctx.obj({S:PDFName.of('D'),St:4})]}));
 doc.catalog.set(PDFName.of('PageLabels'),ctx.register(ctx.obj({Kids:[child,ctx.register(ctx.obj({Nums:[3,ctx.obj({S:PDFName.of('A'),St:27})]}))]})));
 const ranges=readPdfLabelRanges(doc);assert.equal(labelAt(ranges,0,6),'章-i');assert.equal(labelAt(ranges,3,6),'AA');
});
test('cyclic and excessive prefixes rejected without rewriting source',async()=>{
 const doc=await fixture(),ctx=doc.context,tree=ctx.obj({}),ref=ctx.register(tree);tree.set(PDFName.of('Kids'),ctx.obj([ref]));doc.catalog.set(PDFName.of('PageLabels'),ref);
 assert.throws(()=>readPdfLabelRanges(doc),/cycle|repeats/);
 tree.delete(PDFName.of('Kids'));tree.set(PDFName.of('Nums'),ctx.obj([0,ctx.obj({P:PDFHexString.fromText('é'.repeat(513))})]));assert.throws(()=>readPdfLabelRanges(doc),/prefix/);
});
test('import edit export reopen preserves source, metadata and page labels',async()=>{
 const doc=await fixture();writePdfLabelRanges(doc,[r(0,'r'),r(2,'D','A-',1)]);const bytes=await doc.save();const content=await createPdfContent(bytes);
 assert.equal(labelAt(content.pageLabels,0,6),'i');assert.deepEqual(await exportPdf(content),bytes);
 const edited={...content,pageLabels:numberPdfPages(content.pageLabels,6,2,3,'A','Ex-',27)};
 validatePdfContent(edited);const output=await exportPdf(edited),reopened=await createPdfContent(output);
 assert.equal((await PDFDocument.load(output)).getTitle(),'Keep this metadata');assert.equal(content.sourceBase64,edited.sourceBase64);
 assert.deepEqual(Array.from({length:6},(_,i)=>labelAt(reopened.pageLabels,i,6)),['i','ii','Ex-AA','Ex-BB','A-3','A-4']);
});
test('organization deletion shifts source ranges and renumbers gap, move keeps physical ranges',async()=>{
 const doc=await fixture();writePdfLabelRanges(doc,[r(0,'r'),r(2,'D','A-',1)]);let content=await createPdfContent(await doc.save());
 content=applyPdfOperation(content,{type:'delete',pageId:content.pages[0].id});assert.deepEqual(content.pageLabels,[r(0,'r'),r(1,'D','A-',1)]);
 content=applyPdfOperation(content,{type:'move',pageId:content.pages[4].id,toIndex:0});const result=await createPdfContent(await exportPdf(content));assert.equal(labelAt(result.pageLabels,1,5),'A-1');
});
test('reset labels removes tree and invalid edit leaves source model intact',async()=>{
 const doc=await fixture();writePdfLabelRanges(doc,[r(0,'r')]);const content=await createPdfContent(await doc.save()),snapshot=JSON.stringify(content);
 assert.throws(()=>validatePdfContent({...content,pageLabels:[r(0,'r','x'.repeat(1024))]}));assert.equal(JSON.stringify(content),snapshot);assert.throws(()=>validatePdfContent({...content,pageLabels:[r(3),r(0)]}),/sorted/);
 const reset=await PDFDocument.load(await exportPdf({...content,pageLabels:[]}));assert.equal(reset.catalog.has(PDFName.of('PageLabels')),false);
});
