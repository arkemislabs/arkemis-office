import {inflateSync} from 'node:zlib';
import test from 'node:test';import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFHexString,degrees} from 'pdf-lib';
import {createPdfContent,exportPdf,applyPdfOperation,extractPdfStructure} from '../core/pdf-document.mjs';
const workflows=await import('../core/pdf-workflows.mjs').catch(()=>({}));
async function plain(width=300,pages=1){const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([width,400]);return doc.save();}
async function formFixture({signature=false,signed=false,xfa=false}={}){
 const doc=await PDFDocument.create(),page=doc.addPage([400,600]),form=doc.getForm();
 const text=form.createTextField('customer');text.setMaxLength(20);text.setText('Alice');text.addToPage(page,{x:20,y:530,width:200,height:24});
 const checkbox=form.createCheckBox('approved');checkbox.addToPage(page,{x:20,y:490,width:20,height:20});
 const dropdown=form.createDropdown('department');dropdown.addOptions(['Sales','Support']);dropdown.select('Sales');dropdown.addToPage(page,{x:20,y:440,width:200,height:30});
 const radio=form.createRadioGroup('delivery');radio.addOptionToPage('Email',page,{x:20,y:400,width:15,height:15});radio.addOptionToPage('Post',page,{x:80,y:400,width:15,height:15});radio.select('Email');
 const list=form.createOptionList('services');list.addOptions(['Design','Support','Training']);list.enableMultiselect();list.select(['Design']);list.addToPage(page,{x:20,y:300,width:200,height:75});
 const locked=form.createTextField('account');locked.setText('LOCKED');locked.enableReadOnly();locked.addToPage(page,{x:20,y:260,width:200,height:24});
 if(signature||signed){const dictionary=doc.context.obj({FT:'Sig',T:PDFHexString.fromText('signHere')});if(signed)dictionary.set(PDFName.of('V'),doc.context.obj({Type:'Sig',ByteRange:[0,10,20,30],Contents:PDFHexString.of('00')}));form.acroForm.addField(doc.context.register(dictionary));}
 if(xfa)form.acroForm.dict.set(PDFName.of('XFA'),PDFHexString.fromText('xfa-payload'));
 return doc.save({updateFieldAppearances:false});
}
test('combine preserves page order, geometry and rotation without modifying input bytes',async()=>{
 assert.equal(typeof workflows.combinePdfs,'function');const doc=await PDFDocument.create(),page=doc.addPage([500,300]);page.setRotation(degrees(90));const a=await plain(),b=await doc.save(),originalA=a.slice(),originalB=b.slice();
 const content=await workflows.combinePdfs([a,b]),combined=await PDFDocument.load(await exportPdf(content));assert.equal(combined.getPageCount(),2);assert.equal(combined.getPage(0).getWidth(),300);assert.equal(combined.getPage(1).getWidth(),500);assert.equal(combined.getPage(1).getRotation().angle,90);assert.deepEqual(a,originalA);assert.deepEqual(b,originalB);
});
test('combine rejects oversized inputs, excessive pages, malformed data and semantic catalogs',async()=>{
 const small=await plain();await assert.rejects(workflows.combinePdfs([small]),/two|2/i);await assert.rejects(workflows.combinePdfs([small,new Uint8Array(10*1024*1024)]),/10 MB/i);await assert.rejects(workflows.combinePdfs([small,new Uint8Array([1,2,3])]),/PDF/i);await assert.rejects(workflows.combinePdfs([await plain(300,1000),small]),/1000/i);
 for(const key of ['AcroForm','Outlines','Names','StructTreeRoot','Perms','OCProperties','Collection','AF','OpenAction','Metadata','OutputIntents']){const doc=await PDFDocument.create();doc.addPage();doc.catalog.set(PDFName.of(key),doc.context.obj({}));await assert.rejects(workflows.combinePdfs([small,await doc.save({updateFieldAppearances:false})]),/preserv|unsupported|combine/i);}
 const annotated=await PDFDocument.create(),page=annotated.addPage();page.node.set(PDFName.of('Annots'),annotated.context.obj([annotated.context.register(annotated.context.obj({Type:'Annot',Subtype:'Text',Rect:[0,0,20,20]}))]));await assert.rejects(workflows.combinePdfs([small,await annotated.save()]),/annotation|preserv/i);
});
test('form inspection reports safe typed values, options and nonfillable read-only/signature fields',async()=>{
 const content=await createPdfContent(await formFixture({signature:true})),before=structuredClone(content),fields=await workflows.inspectPdfForms(content),byName=Object.fromEntries(fields.map(field=>[field.name,field]));
 assert.equal(byName.customer.type,'text');assert.equal(byName.customer.value,'Alice');assert.equal(byName.customer.maxLength,20);assert.equal(byName.approved.type,'checkbox');assert.equal(byName.approved.value,false);assert.deepEqual(byName.department.options,['Sales','Support']);assert.equal(byName.delivery.value,'Email');assert.deepEqual(byName.services.value,['Design']);assert.equal(byName.account.readOnly,true);assert.equal(byName.signHere.type,'signature');assert.equal(byName.signHere.readOnly,true);assert.deepEqual(content,before);
});
test('fill updates native forms while preserving annotations, rotations and source immutability',async()=>{
 let content=await createPdfContent(await formFixture({signature:true}),'application.pdf');const pageId=content.pages[0].id;content=applyPdfOperation(content,{type:'rotate',pageId,degrees:90});content=applyPdfOperation(content,{type:'add-overlay',pageId,overlay:{id:'note',type:'text',text:'Recorded note',x:20,y:400,width:200,height:30,fontSize:12,color:'#222222'}});const before=structuredClone(content);
 const result=await workflows.fillPdfForms(content,{customer:'Bob',approved:true,department:'Support',delivery:'Post',services:['Support','Training']}),doc=await PDFDocument.load(await exportPdf(result)),form=doc.getForm();
 assert.equal(form.getTextField('customer').getText(),'Bob');assert.equal(form.getCheckBox('approved').isChecked(),true);assert.deepEqual(form.getDropdown('department').getSelected(),['Support']);assert.equal(form.getRadioGroup('delivery').getSelected(),'Post');assert.deepEqual(form.getOptionList('services').getSelected(),['Support','Training']);assert.equal(form.getTextField('account').getText(),'LOCKED');assert.ok(form.getSignature('signHere'));assert.equal(doc.getPage(0).getRotation().angle,90);assert.ok((doc.getPage(0).node.Annots()?.size()??0)>=7);assert.match((await extractPdfStructure(result)).pages[0].text,/Recorded note/);assert.deepEqual(result.pages[0].overlays,content.pages[0].overlays);assert.equal(result.pages[0].rotation,90);const removed=applyPdfOperation(result,{type:'delete-overlay',pageId,overlayId:'note'});assert.doesNotMatch((await extractPdfStructure(removed)).pages[0].text,/Recorded note/);assert.deepEqual(content,before);
});
test('all form updates validate atomically including missing, wrong-type, choice, length and locked fields',async()=>{
 const content=await createPdfContent(await formFixture({signature:true})),before=structuredClone(content);
 for(const updates of [{customer:'Bob',missing:'x'},{customer:'Bob',approved:'true'},{department:'Unknown'},{delivery:'Unknown'},{services:['Unknown']},{account:'changed'},{signHere:'signature'},{customer:'x'.repeat(21)},{customer:'\u{10FFFD}'},{services:['Design','Design']}])await assert.rejects(workflows.fillPdfForms(content,updates),/field|option|text|length|character|signature|read.only|duplicate/i);
 assert.deepEqual(content,before);assert.equal((await PDFDocument.load(await exportPdf(content))).getForm().getTextField('customer').getText(),'Alice');
});
test('XFA and signed documents are not silently modified by form operations',async()=>{
 const xfa=await createPdfContent(await formFixture({xfa:true}));await assert.rejects(workflows.inspectPdfForms(xfa),/XFA/i);await assert.rejects(workflows.fillPdfForms(xfa,{customer:'Bob'}),/XFA/i);
 const signed=await createPdfContent(await formFixture({signed:true}));const fields=await workflows.inspectPdfForms(signed);assert.ok(fields.every(field=>field.readOnly));await assert.rejects(workflows.fillPdfForms(signed,{customer:'Bob'}),/sign|certif/i);
});
test('form values can be cleared without flattening fields',async()=>{
 const content=await createPdfContent(await formFixture()),result=await workflows.fillPdfForms(content,{customer:'',approved:false,department:'',delivery:'',services:[]}),form=(await PDFDocument.load(await exportPdf(result))).getForm();
 assert.equal(form.getTextField('customer').getText()??'','');assert.equal(form.getCheckBox('approved').isChecked(),false);assert.deepEqual(form.getDropdown('department').getSelected(),[]);assert.equal(form.getRadioGroup('delivery').getSelected(),undefined);assert.deepEqual(form.getOptionList('services').getSelected(),[]);assert.equal(form.getFields().length,6);
});
test('multiline native text fields accept line breaks and retain active page identity',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage(),field=doc.getForm().createTextField('notes');field.enableMultiline();field.addToPage(page,{x:20,y:200,width:200,height:100});const content=await createPdfContent(await doc.save());
 const result=await workflows.fillPdfForms(content,{notes:'First line\nSecond line'});assert.equal((await PDFDocument.load(await exportPdf(result))).getForm().getTextField('notes').getText(),'First line\nSecond line');assert.equal(result.activePageId,content.activePageId);assert.equal(result.pages[0].id,content.pages[0].id);
});
test('choice fields expose display labels while preserving native export values and appearances',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage(),form=doc.getForm();
 for(const [name,kind] of [['department','dropdown'],['services','list']]){const field=kind==='dropdown'?form.createDropdown(name):form.createOptionList(name);if(kind==='list')field.enableMultiselect();field.addOptions(['Sales','Support']);field.select('Sales');field.addToPage(page,{x:20,y:kind==='dropdown'?400:200,width:200,height:80});field.acroField.setOptions([{value:PDFHexString.fromText('S'),display:PDFHexString.fromText('Sales')},{value:PDFHexString.fromText('T'),display:PDFHexString.fromText('Support')}]);field.acroField.dict.set(PDFName.of('V'),PDFHexString.fromText('S'));}
 const content=await createPdfContent(await doc.save({updateFieldAppearances:false})),fields=await workflows.inspectPdfForms(content);assert.equal(fields.find(field=>field.name==='department').value,'Sales');assert.deepEqual(fields.find(field=>field.name==='services').value,['Sales']);
 const result=await workflows.fillPdfForms(content,{department:'Support',services:['Sales','Support']}),output=await PDFDocument.load(await exportPdf(result));assert.deepEqual(output.getForm().getDropdown('department').getSelected(),['T']);assert.deepEqual(output.getForm().getOptionList('services').getSelected(),['S','T']);assert.deepEqual(output.getForm().getDropdown('department').getOptions(),['Sales','Support']);assert.equal((await workflows.inspectPdfForms(result)).find(field=>field.name==='department').value,'Support');
 const appearance=field=>inflateSync(field.acroField.getWidgets()[0].dict.lookup(PDFName.of('AP')).lookup(PDFName.of('N')).contents).toString();assert.match(appearance(output.getForm().getDropdown('department')),/537570706F7274/i);assert.match(appearance(output.getForm().getOptionList('services')),/53616C6573/i);
});


test('an emoji in a form value is accepted only when an installed font has its glyph; a private-use character never is',async()=>{
 // The window's fonts come from a host reader; here it serves only the fonts a test names, so what is accepted follows what fontkit says those fonts hold.
 const fs=await import('node:fs/promises'),{createRequire}=await import('node:module'),require=createRequire(import.meta.url);
 await import('regenerator-runtime/runtime.js');const fontkit=require('@pdf-lib/fontkit');
 const dir='C:/Windows/Fonts/',open=async name=>{try{const f=fontkit.create(new Uint8Array(await fs.readFile(dir+name)));return f.fonts?f.fonts[0]:f;}catch{return null;}};
 const plainFont=await open('segoeui.ttf'),symbols=await open('seguisym.ttf'),emoji=0x1F600;
 if(!plainFont||!symbols)return;   // these Windows fonts are not here
 assert.equal(plainFont.hasGlyphForCodePoint(emoji),false,'Segoe UI has no emoji');assert.equal(symbols.hasGlyphForCodePoint(emoji),true,'Segoe UI Symbol has it');
 const serve=names=>({files:{readSystemFont:async file=>{const base=String(file).split('/').pop();return names.includes(base)?new Uint8Array(await fs.readFile(file)):null;}}});
 const content=await createPdfContent(await formFixture());
 try{
  globalThis.studio=serve(['segoeui.ttf']);
  await assert.rejects(workflows.fillPdfForms(content,{customer:String.fromCodePoint(emoji)}),/character|font/i);
  assert.equal((await PDFDocument.load(await exportPdf(content))).getForm().getTextField('customer').getText(),'Alice','nothing written');
  globalThis.studio=serve(['segoeui.ttf','seguisym.ttf']);
  const filled=await workflows.fillPdfForms(content,{customer:String.fromCodePoint(emoji)});
  assert.equal((await PDFDocument.load(await exportPdf(filled))).getForm().getTextField('customer').getText(),String.fromCodePoint(emoji));
  await assert.rejects(workflows.fillPdfForms(content,{customer:'\u{10FFFD}'}),/character|font/i);
  await assert.rejects(workflows.fillPdfForms(content,{customer:`ok ${String.fromCodePoint(emoji)} \u{10FFFD}`}),/character|font/i);
 }finally{delete globalThis.studio;}
});
