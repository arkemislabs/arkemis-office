import './common/lib/pdf-guard.mjs';
import {init} from '@embedpdf/pdfium';
import {PDFDocument,PDFDict,PDFName} from 'pdf-lib';
import {validatePdfSource} from './pdf-document.mjs';
import {PDF_MAX_BYTES,pdfBytes,validatePdfContent} from './pdf-model.mjs';

const MAX_OBJECTS=10000,MAX_TEXT=10000;
const fail=message=>{throw new Error(message);};
let enginePromise;
async function engine(options){
 if(!enginePromise){
  if(!(options?.wasmBinary instanceof Uint8Array))fail('PDF text engine requires a locally bundled wasmBinary.');
  enginePromise=init({wasmBinary:options.wasmBinary}).then(engine=>{engine.PDFiumExt_Init();return engine;}).catch(error=>{enginePromise=undefined;throw error;});
 }
 return enginePromise;
}
async function prepare(content,pageId){
 validatePdfContent(content);await validatePdfSource(content);
 const model=content.pages.find(page=>page.id===pageId);if(!model)fail('PDF page not found.');
 const bytes=pdfBytes(content.sourceBase64),document=await PDFDocument.load(bytes,{updateMetadata:false});
 if(document.isEncrypted)fail('Protected PDFs cannot be edited. The original is preserved.');
 const form=document.catalog.lookupMaybe(PDFName.of('AcroForm'),PDFDict);
 if(form?.has(PDFName.of('XFA')))fail('XFA PDFs cannot be edited. The original is preserved.');
 if(document.catalog.has(PDFName.of('Perms'))||document.context.enumerateIndirectObjects().some(([,object])=>object instanceof PDFDict&&(object.has(PDFName.of('ByteRange'))||object.get(PDFName.of('Type'))===PDFName.of('Sig'))))fail('Editing a signed PDF would invalidate its digital signature. The original is preserved.');
 const page=document.getPage(model.sourceIndex),crop=page.getCropBox();
 return {bytes,model,crop,duplicate:content.pages.filter(page=>page.sourceIndex===model.sourceIndex).length>1};
}
function usingDocument(p,bytes,index,callback){
 const m=p.pdfium,input=m.wasmExports.malloc(bytes.length);let doc=0,page=0;
 try{m.HEAPU8.set(bytes,input);doc=p.FPDF_LoadMemDocument(input,bytes.length,'');if(!doc)fail('PDF text engine could not open this document.');page=p.FPDF_LoadPage(doc,index);if(!page)fail('PDF text engine could not load this page.');return callback(doc,page);}
 finally{if(page)p.FPDF_ClosePage(page);if(doc)p.FPDF_CloseDocument(doc);m.wasmExports.free(input);}
}
function buffer(p,size,callback){const pointer=p.pdfium.wasmExports.malloc(size);try{return callback(pointer);}finally{p.pdfium.wasmExports.free(pointer);}}
function textOf(p,object,textPage){
 const size=p.FPDFTextObj_GetText(object,textPage,0,0);if(size<2)return '';if(size>(MAX_TEXT+1)*2)fail('PDF text object exceeds the 10,000 character limit.');
 return buffer(p,size,ptr=>{if(p.FPDFTextObj_GetText(object,textPage,ptr,size)!==size)fail('Could not read PDF source text.');return p.pdfium.UTF16ToString(ptr);});
}
function numbers(p,count,read){return buffer(p,count*4,ptr=>{if(!read(ptr))return null;return Array.from({length:count},(_,i)=>p.pdfium.getValue(ptr+i*4,'float'));});}
function fontName(p,font){const size=p.FPDFFont_GetBaseFontName(font,0,0);if(!size||size>2048)return '';return buffer(p,size,ptr=>{p.FPDFFont_GetBaseFontName(font,ptr,size);return p.pdfium.UTF8ToString(ptr);});}
function snapshot(p,page,duplicate=false){
 const count=p.FPDFPage_CountObjects(page);if(count<0||count>MAX_OBJECTS)fail('PDF page exceeds the 10,000 object editing limit.');
 const textPage=p.FPDFText_LoadPage(page);if(!textPage)fail('Could not inspect PDF page text.');
 const objects=[];let totalText=0;
 try{for(let index=0;index<count;index++){
  const object=p.FPDFPage_GetObject(page,index),type=p.FPDFPageObj_GetType(object);
  const values=numbers(p,4,ptr=>p.FPDFPageObj_GetBounds(object,ptr,ptr+4,ptr+8,ptr+12));
  const bounds=values?Object.fromEntries(['left','bottom','right','top'].map((key,i)=>[key,values[i]])):null;
  const matrix=numbers(p,6,ptr=>p.FPDFPageObj_GetMatrix(object,ptr));
  const record={objectIndex:index,type,bounds,matrix};
  if(type===1){
   const font=p.FPDFTextObj_GetFont(object),text=textOf(p,object,textPage),name=fontName(p,font);
   totalText+=text.length;if(totalText>100000)fail('PDF page exceeds the 100,000 character text limit.');
   const clip=p.FPDFPageObj_GetClipPath(object),renderMode=p.FPDFTextObj_GetTextRenderMode(object);
   const reason=duplicate?'This page shares its source with a duplicate page.':!text?'Empty text objects are not editable.':!font?'The original font is unavailable.':!bounds||!values.every(Number.isFinite)?'Text geometry is unavailable.':renderMode<0||renderMode>2?'Invisible or clipping text is not editable.':clip&&p.FPDFClipPath_CountPaths(clip)>0?'Clipped text objects are not editable.':undefined;
   const color=buffer(p,16,ptr=>p.FPDFPageObj_GetFillColor(object,ptr,ptr+4,ptr+8,ptr+12)?Array.from({length:4},(_,i)=>p.pdfium.getValue(ptr+i*4,'i32')):null);
   Object.assign(record,{text,fontName:name,embedded:p.FPDFFont_GetIsEmbedded(font)===1,fontSize:numbers(p,1,ptr=>p.FPDFTextObj_GetFontSize(object,ptr))?.[0],color,renderMode,editable:!reason,...(reason?{reason}:{})});
  }
  objects.push(record);
 }}finally{p.FPDFText_ClosePage(textPage);}
 return objects;
}
function near(a,b){return typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<.02:JSON.stringify(a)===JSON.stringify(b);}
function verifySnapshot(before,after,target,text){
 if(before.length!==after.length)fail('PDF text edit changed unrelated page objects. The original is preserved.');
 for(let i=0;i<before.length;i++){
  const a=before[i],b=after[i];if(a.type!==b.type||!a.matrix?.every((value,j)=>near(value,b.matrix?.[j])))fail('PDF text edit changed page object layout. The original is preserved.');
  if(a.type===1){if(b.text!==(i===target?text:a.text))fail('The original font cannot encode this replacement exactly. The original is preserved.');for(const key of ['fontName','fontSize','color','renderMode'])if(!near(a[key],b[key]))fail(`The PDF engine cannot preserve this document's ${key==='color'?'text color':'text styling'} while saving. The original is preserved.`);}
  if(i!==target&&JSON.stringify(a.bounds)!==JSON.stringify(b.bounds)&&(!a.bounds||!b.bounds||!Object.keys(a.bounds).every(key=>near(a.bounds[key],b.bounds[key]))))fail('PDF text edit changed unrelated geometry. The original is preserved.');
 }
}
function assertFontCoverage(object,text,objects){
 // Existing embedded fonts can be subsets: only reuse characters already
 // evidenced in text using that font. Nonembedded standard Latin fonts also
 // admit printable ASCII. Saved output is independently reopened below.
 const known=new Set(objects.filter(item=>item.type===1&&item.fontName===object.fontName).flatMap(item=>Array.from(item.text)));
 const standard=!object.embedded&&/^(Helvetica|Times-(Roman|Bold|Italic|BoldItalic)|Courier)(-(Bold|Oblique|BoldOblique))?$/.test(object.fontName);
 if(Array.from(text).some(character=>!known.has(character)&&!(standard&&character>=' '&&character<='~')))fail('Replacement includes glyphs not verified in the original font. Use supported characters; the original is preserved.');
}
function save(p,document){
 const m=p.pdfium,chunks=[];let total=0,overflow=false;
 const callback=m.addFunction((_writer,data,size)=>{if(size<0||total+size>PDF_MAX_BYTES){overflow=true;return 0;}chunks.push(m.HEAPU8.slice(data,data+size));total+=size;return 1;},'iiii');
 try{return buffer(p,8,writer=>{m.setValue(writer,1,'i32');m.setValue(writer+4,callback,'i32');if(!p.FPDF_SaveAsCopy(document,writer,2)||overflow)fail('Edited PDF could not be saved within the 10 MB limit.');const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;});}
 finally{m.removeFunction(callback);}
}
function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return globalThis.btoa(binary);}

/** Exact source coordinates; direct page text objects only, not nested Form XObjects. */
export async function inspectPdfTextObjects(content,pageId,options={}){
 const source=await prepare(content,pageId),p=await engine(options);
 return usingDocument(p,source.bytes,source.model.sourceIndex,(_doc,page)=>snapshot(p,page,source.duplicate).filter(object=>object.type===1).map(({type,matrix,embedded,color,renderMode,...object})=>object));
}
/** Edits a single existing source object; preserves model IDs, overlays and rotations. */
export async function replacePdfTextObject(content,edit,options={}){
 if(!edit||!Number.isInteger(edit.objectIndex)||edit.objectIndex<0||typeof edit.expectedText!=='string'||edit.expectedText.length>MAX_TEXT)fail('Invalid PDF text object selection.');
 if(typeof edit.text!=='string'||edit.text.length<1||edit.text.length>MAX_TEXT||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(edit.text))fail('Replacement must contain between 1 and 10,000 characters without line breaks or control characters.');
 const source=await prepare(content,edit.pageId);if(source.duplicate)fail('Cannot edit shared source text while this page has duplicates.');
 const p=await engine(options);let before;
 const bytes=usingDocument(p,source.bytes,source.model.sourceIndex,(doc,page)=>{
  before=snapshot(p,page);const selected=before[edit.objectIndex];if(!selected||selected.type!==1)fail('Selected PDF text object no longer exists.');
  if(selected.text!==edit.expectedText)fail('PDF source text changed since selection. Select it again.');if(!selected.editable)fail(selected.reason);
  if(edit.text===selected.text)return source.bytes;
  assertFontCoverage(selected,edit.text,before);
  const object=p.FPDFPage_GetObject(page,edit.objectIndex);
  buffer(p,(edit.text.length+1)*2,ptr=>{p.pdfium.stringToUTF16(edit.text,ptr,(edit.text.length+1)*2);if(!p.FPDFText_SetText(object,ptr))fail('The original PDF font cannot encode this replacement.');});
  const changed=snapshot(p,page),bounds=changed[edit.objectIndex].bounds,crop=source.crop;
  if(!bounds||bounds.left<crop.x-.01||bounds.bottom<crop.y-.01||bounds.right>crop.x+crop.width+.01||bounds.top>crop.y+crop.height+.01)fail('Replacement text does not fit inside the page crop bounds. Shorten the text.');
  verifySnapshot(before,changed,edit.objectIndex,edit.text);
  if(!p.FPDFPage_GenerateContent(page))fail('Could not regenerate PDF source content.');
  return save(p,doc);
 });
 if(bytes===source.bytes)return structuredClone(content);
 usingDocument(p,bytes,source.model.sourceIndex,(_doc,page)=>verifySnapshot(before,snapshot(p,page),edit.objectIndex,edit.text));
 const result=validatePdfContent({...structuredClone(content),sourceBase64:base64(bytes)});
 await validatePdfSource(result);
 return result;
}
