// GridCraft source: engine/src/fill.rs (Series/Alternate/Copy and directional lanes).
import {translateFormula} from './grid-structure.mjs';
import {assertGridTransferRange,checkGridRange,gridKey} from './grid-clipboard.mjs';
const mod=(n,d)=>((n%d)+d)%d;
export function fillTarget(source,point){const dr=point.r<source.r1?point.r-source.r1:Math.max(0,point.r-source.r2),dc=point.c<source.c1?point.c-source.c1:Math.max(0,point.c-source.c2);return Math.abs(dr)>=Math.abs(dc)?{...source,r1:Math.min(source.r1,point.r),r2:Math.max(source.r2,point.r)}:{...source,c1:Math.min(source.c1,point.c),c2:Math.max(source.c2,point.c)};}
const number=cell=>cell&&cell.valueType!=='text'&&cell.value.trim()!==''&&!cell.value.startsWith('=')&&Number.isFinite(Number(cell.value))?Number(cell.value):null;
const isDate=cell=>cell?.format==='date'||/y|d/i.test((cell?.numFmt??'').replace(/"[^"]*"|\[[^\]]*\]|\\./g,''));
export function fillGridRange(sheet,source,target,{alternate=false}={}){
 checkGridRange(source);checkGridRange(target);
 const vertical=source.c1===target.c1&&source.c2===target.c2,horizontal=source.r1===target.r1&&source.r2===target.r2;
 if((!vertical&&!horizontal)||target.r1>source.r1||target.r2<source.r2||target.c1>source.c1||target.c2<source.c2||!(source.r1===target.r1||source.r2===target.r2)||!(source.c1===target.c1||source.c2===target.c2))throw Error('Fill must extend the selection in one direction.');
 assertGridTransferRange(sheet,source,{source:true});assertGridTransferRange(sheet,target);
 const cells={...sheet.cells},length=vertical?source.r2-source.r1+1:source.c2-source.c1+1;
 for(let lane=vertical?source.c1:source.r1;lane<=(vertical?source.c2:source.r2);lane++){
  const originals=Array.from({length},(_,i)=>sheet.cells[gridKey(vertical?source.r1+i:lane,vertical?lane:source.c1+i)]),nums=originals.map(number);
  const step=nums.every(n=>n!==null)?length>1?nums[1]-nums[0]:isDate(originals[0])||alternate?1:null:null;
  const linear=step!==null&&nums.every((n,i)=>Math.abs(n-(nums[0]+step*i))<1e-8*Math.max(1,Math.abs(n)));
  const series=linear&&(!alternate||length===1&&!isDate(originals[0]));
  for(let pos=vertical?target.r1:target.c1;pos<=(vertical?target.r2:target.c2);pos++){
   const i=pos-(vertical?source.r1:source.c1);if(i>=0&&i<length)continue;
   const index=mod(i,length),original=originals[index],r=vertical?pos:lane,c=vertical?lane:pos,key=gridKey(r,c);
   if(!original){delete cells[key];continue;}
   const sr=vertical?source.r1+index:lane,sc=vertical?lane:source.c1+index;
   const value=original.valueType!=='text'&&original.value.startsWith('=')?translateFormula(original.value,r-sr,c-sc):series?String(nums[0]+step*i):original.value;
   if(series&&!Number.isFinite(Number(value)))throw Error('Fill series exceeds the numeric limit.');cells[key]={...structuredClone(original),value};
  }
 }
 return {...sheet,cells,rows:Math.max(sheet.rows,target.r2+1),columns:Math.max(sheet.columns,target.c2+1)};
}
