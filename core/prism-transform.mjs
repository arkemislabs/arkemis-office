// DeckCraft source-to-JavaScript adaptation (MIT):
// f893f6af7d36a5409fd804e81a34fd895cfefedf,
// crates/engine/src/cmd/shape/size.rs rotate/flip and crates/geom/src/lib.rs Xfrm.
// Full notice: assets/third-party-licenses/artcraft-reference.txt.
import {sizePositionElements} from './prism-size-position.mjs';
const normalized=angle=>((angle%360)+360)%360;
export function transformElements(elements,ids,action){
 if(action?.type==='size-position'){const {type,...spec}=action;return sizePositionElements(elements,ids,spec);}
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!elements.some(e=>e.id===id)))throw Error('Invalid element selection');
 if(!action||!['rotate','flip'].includes(action.type))throw Error('Invalid transform');
 if(action.type==='rotate'&&[action.degrees,action.by].some(n=>n!==undefined&&!Number.isFinite(n)))throw Error('Invalid rotation');
 if(action.type==='flip'&&!['horizontal','vertical'].includes(action.axis))throw Error('Invalid flip axis');
 const selection=new Set(ids);
 return elements.map(e=>!selection.has(e.id)?e:action.type==='rotate'?{...e,rotation:normalized((action.degrees??e.rotation??0)+(action.by??0))}:{...e,[action.axis==='vertical'?'flipV':'flipH']:!e[action.axis==='vertical'?'flipV':'flipH'],rotation:normalized(-(e.rotation??0))});
}
export function elementBounds(e){
 const a=(e.rotation??0)*Math.PI/180,c=Math.abs(Math.cos(a)),s=Math.abs(Math.sin(a));
 const w=e.w*c+e.h*s,h=e.w*s+e.h*c;
 return {x:e.x+(e.w-w)/2,y:e.y+(e.h-h)/2,w,h};
}
export function elementTransformCSS(e){return `rotate(${e.rotation??0}deg) scale(${e.flipH?-1:1}, ${e.flipV?-1:1})`;}
// Convert the screen delta back to local shape axes. Keep the opposite corner
// fixed while moving the center halfway along the transformed size delta.
export function resizeTransformedElement(e,dx,dy,keepRatio=false){
 const a=(e.rotation??0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),fx=e.flipH?-1:1,fy=e.flipV?-1:1;
 let w=Math.max(24,e.w+(c*dx+s*dy)*fx),h=Math.max(24,e.h+(-s*dx+c*dy)*fy);
 if(keepRatio){const ratio=e.w/e.h;if(Math.abs(w-e.w)>=Math.abs(h-e.h)*ratio)h=w/ratio;else w=h*ratio;}
 const dw=w-e.w,dh=h-e.h,cx=(c*dw*fx-s*dh*fy)/2,cy=(s*dw*fx+c*dh*fy)/2;
 return {...e,w,h,x:e.x+cx-dw/2,y:e.y+cy-dh/2};
}
