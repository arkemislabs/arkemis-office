import * as pdfjs from 'pdfjs-dist';
import {extractPdfStructure,pdfLocalResources} from '../core/pdf-document.mjs';
import {validatePdfContent} from '../core/pdf-model.mjs';
import type {PdfContent} from './editors/pdf-types';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',document.baseURI).href;
Object.defineProperty(window,'arkemisPdfStructure',{value:(content:PdfContent,options:{startPage?:number;maxPages?:number;maxCharacters?:number}={})=>extractPdfStructure(content,{...options,pdfjs})});
Object.defineProperty(window,'arkemisPdfRaster',{value:async(content:PdfContent,{pageId}:{pageId:string})=>{
 validatePdfContent(content);const model=content.pages.find(page=>page.id===pageId);if(!model)throw new Error('PDF page not found');
 const data=Uint8Array.from(atob(content.sourceBase64),character=>character.charCodeAt(0));
 const loading=pdfjs.getDocument({data,...pdfLocalResources(document.baseURI),maxImageSize:16000000,canvasMaxAreaInBytes:64000000});
 try{const doc=await loading.promise,page=await doc.getPage(model.sourceIndex+1),original=page.getViewport({scale:1,rotation:0});
  const scale=Math.min(2,Math.sqrt(6000000/(original.width*original.height)),8192/Math.max(original.width,original.height));
  const viewport=page.getViewport({scale,rotation:0}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  const context=canvas.getContext('2d');if(!context)throw new Error('Could not prepare this page for scanning');
  await page.render({canvas,canvasContext:context,viewport,background:'#ffffff'}).promise;
  return {pngBase64:canvas.toDataURL('image/png').split(',')[1],width:original.width,height:original.height};
 }finally{await loading.destroy();}
}});
