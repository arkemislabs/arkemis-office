import './common/lib/pdf-guard.mjs';
import {readPdfBookmarks,writePdfBookmarks} from './pdf-outline-tree.mjs';
import {PDFDocument,StandardFonts,PDFName,breakTextIntoLines,degrees,rgb} from 'pdf-lib';
import {textFace,wrapLines} from './folio/lib/unicode-text.mjs';

import {readPdfLabelRanges,writePdfLabelRanges} from './pdf-label-tree.mjs';
import {dropDeletedPdfLabelPages} from './pdf-page-labels.mjs';
import {PDF_MAX_BYTES,pdfBytes,validatePdfContent} from './pdf-model.mjs';
export {PDF_MAX_BYTES,pdfBytes,validatePdfContent,applyPdfOperation} from './pdf-model.mjs';
const MAX_PAGES=1000;
const id=()=>globalThis.crypto.randomUUID();
const rotation=value=>((value%360)+360)%360;
const fail=message=>{throw new Error(message);};
function base64Of(bytes){let binary='';for(let start=0;start<bytes.length;start+=8192)binary+=String.fromCharCode(...bytes.subarray(start,start+8192));return globalThis.btoa(binary);}
export async function createPdfContent(input,sourceName='Document.pdf'){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes.length>PDF_MAX_BYTES)fail('PDF source must be at most 10 MB.');
 if(bytes.length<5||!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))fail('This file is not a PDF.');
 // Password security (folio/lib/protect.mjs): a file that opens with no password is decrypted into the plain working copy
 // and keeps its security record (Save writes it again); one that needs a password becomes a locked, empty document that
 // asks for it (`protect.open`), so no password has to travel through the import.
 let opened=bytes,security=null;
 if(new TextDecoder('latin1').decode(bytes).includes('/Encrypt')){
  const {openPdf}=await import('./folio/lib/protect.mjs');
  try{const r=await openPdf(bytes,'');opened=r.bytes;security=r.security;}
  catch(e){if(e?.code==='password_required')return validatePdfContent({sourceBase64:'',sourceName,pages:[],activePageId:'',locked:{sourceBase64:base64Of(bytes)}});throw e;}
 }
 const source=await PDFDocument.load(opened,{updateMetadata:false});
 if(source.getPageCount()>MAX_PAGES)fail('PDF supports up to 1000 pages.');
 const pages=source.getPages().map((page,sourceIndex)=>{const box=page.getCropBox();return {id:id(),sourceIndex,width:box.width,height:box.height,sourceRotation:rotation(page.getRotation().angle),rotation:0,overlays:[]};});
 const content=validatePdfContent({sourceBase64:base64Of(opened),sourceName,pages,bookmarks:readPdfBookmarks(source,pages),pageLabels:readPdfLabelRanges(source),activePageId:pages[0]?.id??''});
 if(security){const {permissionsOfRecord}=await import('./folio/lib/protect.mjs');content.security=security;const permissions=permissionsOfRecord(security);if(permissions)content.permissions=permissions;}
 return content;
}
export async function createBlankPdfContent(){const doc=await PDFDocument.create();doc.addPage([595.28,841.89]);return createPdfContent(await doc.save(),'Untitled.pdf');}
function colorOf(value){return rgb(parseInt(value.slice(1,3),16)/255,parseInt(value.slice(3,5),16)/255,parseInt(value.slice(5,7),16)/255);}
async function loadPdfSource(content){
 validatePdfContent(content);if(!content.pages.length)fail('Open or create a PDF first.');
 const source=await PDFDocument.load(pdfBytes(content.sourceBase64),{updateMetadata:false});
 for(const page of content.pages){
  if(page.sourceIndex>=source.getPageCount())fail('Invalid source page index.');
  const original=source.getPage(page.sourceIndex),box=original.getCropBox();
  if(Math.abs(box.width-page.width)>.01||Math.abs(box.height-page.height)>.01||rotation(original.getRotation().angle)!==page.sourceRotation)fail('PDF source page dimensions or rotation do not match.');
 }
 return source;
}
export async function getPdfBookmarks(content){return content.bookmarks??readPdfBookmarks(await loadPdfSource(content),content.pages);}
export async function getPdfLabelRanges(content){
 if(content.pageLabels!==undefined)return content.pageLabels;
 const source=await loadPdfSource(content),ranges=readPdfLabelRanges(source);
 return dropDeletedPdfLabelPages(ranges,source.getPages().map((_,i)=>i).filter(i=>!content.pages.some(page=>page.sourceIndex===i)),content.pages.length);
}
export async function validatePdfSource(content){if(content?.sourceBase64===''&&content?.pages?.length===0){validatePdfContent(content);return true;}await loadPdfSource(content);return true;}
export async function exportPdf(content){
 const output=await loadPdfSource(content),originalPages=output.getPages();
 const sourceBookmarks=readPdfBookmarks(output,content.pages),bookmarksChanged=content.bookmarks!==undefined&&JSON.stringify(content.bookmarks)!==JSON.stringify(sourceBookmarks);
 const sourceLabels=readPdfLabelRanges(output),labelsChanged=content.pageLabels!==undefined&&JSON.stringify(content.pageLabels)!==JSON.stringify(sourceLabels);
 const structural=content.pages.length!==originalPages.length||content.pages.some((page,i)=>page.sourceIndex!==i);
 if(!bookmarksChanged&&!labelsChanged&&!structural&&content.pages.every(page=>page.rotation===0&&page.overlays.length===0))return pdfBytes(content.sourceBase64);
 if(structural&&(['AcroForm','Names','StructTreeRoot'].some(key=>output.catalog.has(PDFName.of(key)))||originalPages.some(page=>(page.node.Annots()?.size()??0)>0)))fail('Page structure changes for PDFs with forms, named data, tags or existing annotations are not supported yet. The original source is preserved.');
 // Keep the original document catalog and references. Copying every page into a
 // fresh PDF loses forms, outlines and attachments even when nothing changed.
 const ordered=[],representatives=new Map();
 for(const model of content.pages){const previous=representatives.get(model.sourceIndex);if(!previous||previous.duplicateOf&&!model.duplicateOf)representatives.set(model.sourceIndex,model);}
 const retainOriginalTargets=nodes=>{for(const node of nodes){if(node.sourceKey!==undefined&&!node.retarget&&node.pageId){const model=content.pages.find(page=>page.id===node.pageId);if(model&&!model.duplicateOf)representatives.set(model.sourceIndex,model);}retainOriginalTargets(node.children);}};if(content.bookmarks)retainOriginalTargets(content.bookmarks);
 if(content.bookmarks===undefined&&output.catalog.has(PDFName.of('Outlines'))&&content.pages.some(model=>!model.duplicateOf&&content.pages.filter(other=>other.sourceIndex===model.sourceIndex&&!other.duplicateOf).length>1))fail('This older document has duplicated pages without original-page identities. Reopen the original PDF before exporting bookmark destinations.');
 for(const model of content.pages){if(representatives.get(model.sourceIndex)!==model){const [copy]=await output.copyPages(output,[model.sourceIndex]);ordered.push(copy);}else ordered.push(originalPages[model.sourceIndex]);}
 if(structural){for(let i=originalPages.length-1;i>=0;i--)output.removePage(i);for(const page of ordered)output.addPage(page);}
 const font=content.pages.some(page=>page.overlays.some(overlay=>overlay.type==='text'))?await output.embedFont(StandardFonts.Helvetica):null;
 const face=font?await textFace(output,font,content.pages.flatMap(page=>page.overlays.filter(overlay=>overlay.type==='text').map(overlay=>overlay.text))):null;
 for(let i=0;i<ordered.length;i++){
  const page=ordered[i],model=content.pages[i],box=page.getCropBox();page.setRotation(degrees(rotation(model.sourceRotation+model.rotation)));
  for(const overlay of model.overlays){
   const x=box.x+overlay.x,y=box.y+box.height-overlay.y-overlay.height,color=colorOf(overlay.color);
   if(overlay.type==='text'){
    let lines;try{lines=face.unicode?wrapLines(overlay.text,overlay.width,value=>face.width(value,overlay.fontSize)):breakTextIntoLines(overlay.text,output.defaultWordBreaks,overlay.width,value=>font.widthOfTextAtSize(value,overlay.fontSize));if(!face.unicode)for(const line of lines)font.encodeText(line);}catch{fail('Text overlays currently support characters in the standard Latin PDF font. Use supported text before exporting.');}
    const descent=font.heightAtSize(overlay.fontSize,{descender:true})-font.heightAtSize(overlay.fontSize,{descender:false});
    if(lines.some(line=>face.width(line,overlay.fontSize)>overlay.width+.01)||lines.length&&(lines.length-1)*overlay.fontSize*1.2+overlay.fontSize+descent>overlay.height+.01)fail('Text does not fit inside the annotation box. Increase its width or height, reduce the font size, or shorten the text.');
    if(face.unicode)lines.forEach((line,k)=>{if(line)face.draw(page,line,{x,y:box.y+box.height-overlay.y-overlay.fontSize-k*overlay.fontSize*1.2,size:overlay.fontSize,color});});
    else page.drawText(overlay.text,{x,y:box.y+box.height-overlay.y-overlay.fontSize,font,size:overlay.fontSize,color,maxWidth:overlay.width,lineHeight:overlay.fontSize*1.2});
   }else if(overlay.type==='signature'){for(const stroke of overlay.strokes)for(let point=1;point<stroke.length;point++){const a=stroke[point-1],b=stroke[point];page.drawLine({start:{x:x+a.x*overlay.width,y:y+(1-a.y)*overlay.height},end:{x:x+b.x*overlay.width,y:y+(1-b.y)*overlay.height},thickness:1.5,color});}}else page.drawRectangle({x,y,width:overlay.width,height:overlay.height,...(overlay.type==='highlight'?{color,opacity:.3}:{borderColor:color,borderWidth:1.5})});
  }
 }
 const labels=content.pageLabels??(structural?dropDeletedPdfLabelPages(sourceLabels,originalPages.map((_,i)=>i).filter(i=>!content.pages.some(page=>page.sourceIndex===i)),content.pages.length):sourceLabels);
 if(labelsChanged||structural)writePdfLabelRanges(output,labels);
 if(bookmarksChanged||structural)writePdfBookmarks(output,content.bookmarks??sourceBookmarks,content.pages);
 output.setProducer('Arkemis PDF');return output.save();
}

// PDF.js exposes text-run transforms, not individual glyph boxes. Derived word
// and character boxes deliberately carry an estimated geometry marker.
export function structurePdfText(textContent,viewport,pageId,pdfjs,options={}){
 const maxCharacters=Math.max(1,Math.min(100000,Math.floor(options.maxCharacters??100000)));
 const runs=[],words=[],characters=[];let offset=0,truncated=false;
 for(const item of textContent.items){
  if(typeof item.str!=='string'||!item.str)continue;
  const remaining=maxCharacters-characters.length;if(remaining<=0){truncated=true;break;}
  const letters=Array.from(item.str.slice(0,remaining*2)).slice(0,remaining),value=letters.join('');if(value.length<item.str.length)truncated=true;
  const matrix=pdfjs.Util.transform(viewport.transform,item.transform),angle=Math.atan2(matrix[1],matrix[0]);
  const height=Math.hypot(matrix[2],matrix[3]),width=Math.abs(item.width*viewport.scale)*value.length/item.str.length,ascent=(textContent.styles[item.fontName]?.ascent??.8)*height;
  const ux=Math.cos(angle),uy=Math.sin(angle),vx=Math.sin(angle),vy=-Math.cos(angle);
  const box=(start,end)=>{const x=matrix[4]+ux*start+vx*ascent,y=matrix[5]+uy*start+vy*ascent;const points=[[x,y],[x+ux*(end-start),y+uy*(end-start)],[x-vx*height,y-vy*height],[x+ux*(end-start)-vx*height,y+uy*(end-start)-vy*height]];const left=Math.min(...points.map(p=>p[0])),top=Math.min(...points.map(p=>p[1]));return {x:left,y:top,width:Math.max(...points.map(p=>p[0]))-left,height:Math.max(...points.map(p=>p[1]))-top};};
  const runId=`${pageId}:run:${runs.length}`,unit=width/Math.max(1,letters.length);
  runs.push({id:runId,text:value,...box(0,width),fontName:item.fontName,direction:item.dir,transform:item.transform,geometry:'run-derived'});
  let localOffset=0,wordStart=-1;
  const flush=end=>{if(wordStart>=0){words.push({id:`${pageId}:word:${words.length}`,runId,text:letters.slice(wordStart,end).join(''),...box(unit*wordStart,unit*end),geometry:'estimated'});wordStart=-1;}};
  letters.forEach((text,i)=>{characters.push({id:`${pageId}:char:${characters.length}`,runId,text,offset:offset+localOffset,...box(unit*i,unit*(i+1)),geometry:'estimated'});localOffset+=text.length;if(/\s/u.test(text))flush(i);else if(wordStart<0)wordStart=i;});flush(letters.length);offset+=item.str.length+1;
 }
 return {text:runs.map(run=>run.text).join('\n'),runs,words,characters,truncated};
}
export function pdfLocalResources(baseUrl){return {cMapUrl:new URL('./pdfjs/cmaps/',baseUrl).href,cMapPacked:true,standardFontDataUrl:new URL('./pdfjs/standard_fonts/',baseUrl).href,wasmUrl:new URL('./pdfjs/wasm/',baseUrl).href};}
export async function extractPdfStructure(content,options={}){
 const pdfjs=options.pdfjs??await import('pdfjs-dist/legacy/build/pdf.mjs');
 const maxCharacters=Math.max(1,Math.min(100000,Math.floor(options.maxCharacters??100000))),maxPages=Math.max(1,Math.min(100,Math.floor(options.maxPages??100))),startPage=Math.max(0,Math.floor(options.startPage??0));
 const resources=typeof document==='undefined'?{}:pdfLocalResources(document.baseURI);
 const bytes=await exportPdf(content),task=pdfjs.getDocument({data:bytes,useSystemFonts:true,...resources});let doc;
 try{doc=await task.promise;const pageLabels=await doc.getPageLabels();const pages=[];let remaining=maxCharacters;for(let i=startPage;i<Math.min(doc.numPages,startPage+maxPages)&&remaining>0;i++){const page=await doc.getPage(i+1),viewport=page.getViewport({scale:1}),structure=structurePdfText(await page.getTextContent(),viewport,content.pages[i].id,pdfjs,{maxCharacters:remaining});pages.push({id:content.pages[i].id,index:i,label:pageLabels?.[i]||String(i+1),width:viewport.width,height:viewport.height,rotation:viewport.rotation,...structure});remaining-=structure.characters.length;}return {bookmarks:await getPdfBookmarks(content),coordinateSpace:'page-top-left-points-after-rotation',characterGeometry:'estimated-from-text-runs',totalPages:doc.numPages,startPage,truncated:startPage+pages.length<doc.numPages||pages.some(page=>page.truncated),pages};}
 finally{await task.destroy();}
}
