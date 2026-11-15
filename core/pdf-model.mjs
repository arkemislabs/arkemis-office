import {validatePdfBookmarks,applyPdfBookmarkOperation,clearDeletedBookmarkTargets} from './pdf-bookmarks.mjs';
import {validatePdfLabelRanges,dropDeletedPdfLabelPages} from './pdf-page-labels.mjs';
export const PDF_MAX_BYTES=10*1024*1024;
const MAX_PAGES=1000,MAX_OVERLAYS=2000;
const id=()=>globalThis.crypto.randomUUID();
const rotation=value=>((value%360)+360)%360;
const fail=message=>{throw new Error(message);};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function pdfBytes(base64){
 if(typeof base64!=='string'||base64.length>Math.ceil(PDF_MAX_BYTES/3)*4)fail('PDF source must be at most 10 MB.');
 if(!base64||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))fail('Invalid PDF source encoding.');
 const binary=globalThis.atob(base64);const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 if(bytes.length>PDF_MAX_BYTES)fail('PDF source must be at most 10 MB.');
 return bytes;
}
function validateOverlay(overlay,page){
 if(!overlay||typeof overlay.id!=='string'||!overlay.id||overlay.id.length>120)fail('Invalid overlay id.');
 if(!['text','highlight','rectangle','signature'].includes(overlay.type))fail('Unsupported overlay type. Overlays do not redact source content.');
 if(![overlay.x,overlay.y,overlay.width,overlay.height].every(finite)||overlay.x<0||overlay.y<0||overlay.width<=0||overlay.height<=0||overlay.x+overlay.width>page.width+.01||overlay.y+overlay.height>page.height+.01)fail('Overlay geometry exceeds page bounds.');
 if(typeof overlay.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(overlay.color))fail('Overlay color must be a six-digit hex color.');
 if(overlay.type==='signature'){
  if(!Array.isArray(overlay.strokes)||!overlay.strokes.length||overlay.strokes.length>100)fail('A signature must contain between 1 and 100 strokes.');
  let points=0;for(const stroke of overlay.strokes){if(!Array.isArray(stroke)||stroke.length<2)fail('Each signature stroke needs at least two points.');points+=stroke.length;if(points>5000)fail('A signature supports up to 5000 stroke points.');for(const point of stroke)if(!point||!finite(point.x)||!finite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)fail('Signature stroke points must be inside the drawing area.');}
 }
 if(overlay.type==='text'){
  if(typeof overlay.text!=='string'||overlay.text.length>10000)fail('Text overlay must contain at most 10,000 characters.');
  if(!finite(overlay.fontSize)||overlay.fontSize<6||overlay.fontSize>144)fail('Text size must be between 6 and 144 points.');
 }
 return overlay;
}
export function validatePdfContent(content){
 if(!content||typeof content.sourceBase64!=='string'||typeof content.sourceName!=='string'||content.sourceName.length>500||!Array.isArray(content.pages)||typeof content.activePageId!=='string')fail('Invalid PDF document.');
 if(content.bookmarks!==undefined)validatePdfBookmarks(content.bookmarks,content.pages.map(page=>page.id));
 if(content.pageLabels!==undefined){validatePdfLabelRanges(content.pageLabels,content.pages.length);if(content.pageLabels.some((range,i)=>i&&range.start<=content.pageLabels[i-1].start))fail('PDF page label ranges must be sorted by page position.');}
 if(content.sourceBase64===''&&content.pages.length===0&&content.activePageId==='')return content;
 if(content.sourceBase64.length>Math.ceil(PDF_MAX_BYTES/3)*4)fail('PDF source must be at most 10 MB.');
 if(content.sourceBase64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(content.sourceBase64))fail('Invalid PDF source encoding.');
 if(!content.sourceBase64||content.pages.length<1||content.pages.length>MAX_PAGES)fail('PDF must contain between 1 and 1000 pages.');
 const ids=new Set();let overlayCount=0;
 for(const page of content.pages){
  if(page.duplicateOf!==undefined&&(typeof page.duplicateOf!=='string'||!page.duplicateOf||page.duplicateOf.length>120||page.duplicateOf===page.id))fail('Invalid duplicate page identity.');
  if(typeof page.id!=='string'||!page.id||page.id.length>120||ids.has(page.id))fail('Invalid or duplicate PDF page id.');ids.add(page.id);
  if(!Number.isInteger(page.sourceIndex)||page.sourceIndex<0||page.sourceIndex>=MAX_PAGES)fail('Invalid source page index.');
  if(!finite(page.width)||!finite(page.height)||page.width<1||page.height<1||page.width>20000||page.height>20000)fail('Invalid PDF page dimensions.');
  if(![0,90,180,270].includes(page.rotation)||![0,90,180,270].includes(page.sourceRotation))fail('PDF rotation must be a multiple of 90 degrees.');
  if(!Array.isArray(page.overlays))fail('Invalid PDF overlays.');
  const overlayIds=new Set();for(const overlay of page.overlays){validateOverlay(overlay,page);if(overlayIds.has(overlay.id))fail('Duplicate overlay id.');overlayIds.add(overlay.id);}
  overlayCount+=page.overlays.length;if(overlayCount>MAX_OVERLAYS)fail('PDF supports up to 2000 overlays.');
 }
 if(!ids.has(content.activePageId))fail('Active PDF page does not exist.');
 return content;
}
export function applyPdfOperation(content,operation){
 validatePdfContent(content);if(!operation||typeof operation.type!=='string')fail('Invalid PDF operation.');
 if(operation.type.startsWith('bookmark-')&&content.bookmarks===undefined)fail('Inspect this PDF’s bookmarks before changing them.');
 if(operation.type.startsWith('bookmark-'))return validatePdfContent({...content,bookmarks:applyPdfBookmarkOperation(content.bookmarks??[],operation,content.pages.map(page=>page.id))});
 const index=content.pages.findIndex(page=>page.id===operation.pageId);if(index<0)fail('PDF page not found.');
 const page=content.pages[index];let pages=[...content.pages],activePageId=content.activePageId;
 switch(operation.type){
  case 'select':activePageId=page.id;break;
  case 'rotate':if(!Number.isInteger(operation.degrees)||operation.degrees%90!==0)fail('Rotation must be a multiple of 90 degrees.');pages[index]={...page,rotation:rotation(page.rotation+operation.degrees)};break;
  case 'move':if(!Number.isInteger(operation.toIndex)||operation.toIndex<0||operation.toIndex>=pages.length)fail('Invalid destination page index.');pages.splice(index,1);pages.splice(operation.toIndex,0,page);break;
  case 'delete':if(pages.length===1)fail('Cannot delete the last page.');pages.splice(index,1);if(activePageId===page.id)activePageId=pages[Math.min(index,pages.length-1)].id;break;
  case 'duplicate':{const copy={...page,id:operation.newPageId??id(),duplicateOf:page.duplicateOf??page.id,overlays:page.overlays.map(overlay=>({...overlay,id:id()}))};pages.splice(index+1,0,copy);activePageId=copy.id;break;}
  case 'add-overlay':validateOverlay(operation.overlay,page);pages[index]={...page,overlays:[...page.overlays,{...operation.overlay}]};break;
  case 'update-overlay':{const found=page.overlays.find(overlay=>overlay.id===operation.overlayId);if(!found)fail('PDF overlay not found.');if(operation.patch?.id!==undefined&&operation.patch.id!==found.id)fail('Overlay id cannot change.');const overlay={...found,...operation.patch};validateOverlay(overlay,page);pages[index]={...page,overlays:page.overlays.map(item=>item.id===found.id?overlay:item)};break;}
  case 'delete-overlay':if(!page.overlays.some(overlay=>overlay.id===operation.overlayId))fail('PDF overlay not found.');pages[index]={...page,overlays:page.overlays.filter(overlay=>overlay.id!==operation.overlayId)};break;
  default:fail('Unsupported PDF operation.');
 }
 const pageLabels=content.pageLabels!==undefined&&operation.type==='delete'?dropDeletedPdfLabelPages(content.pageLabels,[index],pages.length):content.pageLabels;
 const bookmarks=content.bookmarks!==undefined&&operation.type==='delete'?clearDeletedBookmarkTargets(content.bookmarks,page.id):content.bookmarks;
 return validatePdfContent({...content,pages,activePageId,...(bookmarks!==undefined?{bookmarks}:{}),...(pageLabels!==undefined?{pageLabels}:{})});
}
