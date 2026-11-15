import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';
import {createPdfRenderQueue} from '../../core/pdf-render-queue.mjs';
const enqueue=createPdfRenderQueue(2);
export function PdfThumbnail({document,pageNumber,width,height}:{document:PDFDocumentProxy|null;pageNumber:number;width:number;height:number}){
 const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),[visible,setVisible]=useState(false),[ready,setReady]=useState(false),[failed,setFailed]=useState(false);
 useEffect(()=>{const node=host.current;if(!node)return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{root:node.closest('.folio-pages'),rootMargin:'120px'});observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  setReady(false);setFailed(false);if(!document||!visible)return;
  const controller=new AbortController();let task:RenderTask|undefined;
  void enqueue(async()=>{
   if(controller.signal.aborted)return;const page=await document.getPage(pageNumber);if(controller.signal.aborted||!canvas.current)return;
   const original=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(104/original.width,144/original.height)}),target=canvas.current;
   target.width=Math.ceil(viewport.width*1.5);target.height=Math.ceil(viewport.height*1.5);target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   task=page.render({canvas:target,viewport,transform:[1.5,0,0,1.5,0,0]});await task.promise;if(!controller.signal.aborted)setReady(true);
  },{signal:controller.signal}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
  return()=>{controller.abort();task?.cancel();};
 },[document,pageNumber,visible]);
 return <div className="folio-thumbnail" ref={host} style={{minHeight:Math.min(144,104*height/width)}}><canvas ref={canvas} aria-label={`Page ${pageNumber} thumbnail`} style={{visibility:ready?'visible':'hidden'}}/>{!ready&&<span>{failed?'Preview unavailable':visible?'…':''}</span>}</div>;
}
