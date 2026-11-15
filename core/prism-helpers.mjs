import {elementBounds} from './prism-transform.mjs';
export function arrangeElements(elements,ids,action,width=960,height=540){
 const chosen=elements.filter(e=>ids.includes(e.id)).map(e=>({...elementBounds(e),id:e.id}));if(!chosen.length)return elements;
 const left=chosen.length===1?0:Math.min(...chosen.map(e=>e.x)),top=chosen.length===1?0:Math.min(...chosen.map(e=>e.y));
 const right=chosen.length===1?width:Math.max(...chosen.map(e=>e.x+e.w)),bottom=chosen.length===1?height:Math.max(...chosen.map(e=>e.y+e.h));
 // Union-bounds distribution adapted from DeckCraft arrange.rs at
 // f893f6af7d36a5409fd804e81a34fd895cfefedf (MIT; see assets/third-party-licenses/artcraft-reference.txt).
 if(action.startsWith('distribute-')){if(chosen.length<3)return elements;const axis=action==='distribute-x'?'x':'y',size=axis==='x'?'w':'h';const ordered=[...chosen].sort((a,b)=>a[axis]-b[axis]);const start=axis==='x'?left:top,end=axis==='x'?right:bottom;const gap=(end-start-ordered.reduce((sum,e)=>sum+e[size],0))/(ordered.length-1);let cursor=start;const positions=new Map(ordered.map(e=>{const at=cursor;cursor+=e[size]+gap;return[e.id,at];}));return elements.map(e=>positions.has(e.id)?{...e,[axis]:e[axis]+positions.get(e.id)-elementBounds(e)[axis]}:e);}
 return elements.map(e=>{if(!ids.includes(e.id))return e;const b=elementBounds(e);const point=({left:{x:left},center:{x:(left+right-b.w)/2},right:{x:right-b.w},top:{y:top},middle:{y:(top+bottom-b.h)/2},bottom:{y:bottom-b.h}}[action]??{});return {...e,...(point.x===undefined?{}:{x:e.x+point.x-b.x}),...(point.y===undefined?{}:{y:e.y+point.y-b.y})};});
}
export function nudgeElements(elements,ids,dx,dy,width=960,height=540){const selected=elements.filter(e=>ids.includes(e.id)).map(elementBounds);if(!selected.length)return elements;dx=Math.max(-Math.min(...selected.map(e=>e.x)),Math.min(dx,width-Math.max(...selected.map(e=>e.x+e.w))));dy=Math.max(-Math.min(...selected.map(e=>e.y)),Math.min(dy,height-Math.max(...selected.map(e=>e.y+e.h))));return elements.map(e=>ids.includes(e.id)?{...e,x:e.x+dx,y:e.y+dy}:e);}
// Source-to-source adaptation of DeckCraft arrange.rs::order_list, MIT.
// Revision and full notice: assets/third-party-licenses/artcraft-reference.txt.
export function layerElements(elements,ids,direction){
 if(!['front','back','forward','backward'].includes(direction))throw new Error('Invalid layer direction');
 const selected=new Set(ids);
 let result;
 if(direction==='front'||direction==='back'){
  const chosen=[],other=[];
  for(const element of elements)(selected.has(element.id)?chosen:other).push(element);
  result=direction==='front'?[...other,...chosen]:[...chosen,...other];
 }else{
  result=[...elements];
  if(direction==='forward'){
   for(let i=result.length-2;i>=0;i--)if(selected.has(result[i].id)&&!selected.has(result[i+1].id))
    [result[i],result[i+1]]=[result[i+1],result[i]];
  }else{
   for(let i=1;i<result.length;i++)if(selected.has(result[i].id)&&!selected.has(result[i-1].id))
    [result[i-1],result[i]]=[result[i],result[i-1]];
  }
 }
 return result.every((element,i)=>element===elements[i])?elements:result;
}
export function resizeImage(element,w,h,width=960,height=540){const ratio=element.w/element.h;const desired=Math.abs(w-element.w)>=Math.abs(h-element.h)*ratio?w:h*ratio;const next=Math.max(1,Math.min(Math.max(24,24*ratio,desired),width-element.x,(height-element.y)*ratio));return {w:next,h:next/ratio};}

// Navigation is session state; only actual slide edits invalidate local history.
export function samePresentationContent(a,b){
 const equal=(left,right)=>{
  if(left===right)return true;
  if(left===null||right===null||typeof left!=='object'||typeof right!=='object')return false;
  if(Array.isArray(left)!==Array.isArray(right))return false;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&equal(left[key],right[key]));
 };
 return equal(a.slides,b.slides);
}

export function duplicateElements(elements,ids,newId,width=960,height=540){
 return nudgeElements(elements,ids,20,20,width,height).filter(element=>ids.includes(element.id)).map(element=>({...element,id:newId()}));
}
