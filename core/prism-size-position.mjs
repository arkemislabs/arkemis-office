// DeckCraft f893f6af (MIT), engine/src/cmd/shape/size.rs and
// ui-egui/src/dialogs/size_position.rs. See assets/third-party-licenses/artcraft-reference.txt.
export function sizePositionElements(elements,ids,spec){
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!elements.some(e=>e.id===id)))throw Error('Invalid element selection');
 if(!spec||typeof spec!=='object'||Array.isArray(spec)||Object.keys(spec).some(k=>!['x','y','w','h','rot','scaleW','scaleH','lockAspect'].includes(k)))throw Error('Invalid size and position settings');
 if(spec.lockAspect!==undefined&&typeof spec.lockAspect!=='boolean')throw Error('Lock aspect ratio must be true or false');
 for(const key of ['x','y','w','h','rot','scaleW','scaleH'])if(spec[key]!==undefined){const n=spec[key];if(!Number.isFinite(n))throw Error(key+' must be a finite number');if(['x','y'].includes(key)&&Math.abs(n)>100000||['w','h'].includes(key)&&(n<.01||n>15840)||['scaleW','scaleH'].includes(key)&&(n<=0||n>10000))throw Error(key+' is out of range');}
 const selected=new Set(ids);return elements.map(e=>{
  if(!selected.has(e.id))return e;const ratio=e.h>0?e.w/e.h:1;
  let w=spec.w??(spec.scaleW!==undefined?e.w*spec.scaleW/100:e.w),h=spec.h??(spec.scaleH!==undefined?e.h*spec.scaleH/100:e.h);
  const widthSet=spec.w!==undefined||spec.scaleW!==undefined,heightSet=spec.h!==undefined||spec.scaleH!==undefined;
  if(spec.lockAspect&&(widthSet||heightSet)){if(widthSet)h=ratio>0?w/ratio:h;else w=h*ratio;}
  return {...e,x:spec.x??e.x,y:spec.y??e.y,w:Math.max(.01,Math.min(15840,w)),h:Math.max(.01,Math.min(15840,h)),...(spec.rot!==undefined?{rotation:((spec.rot%360)+360)%360}:{})};
 });
}
