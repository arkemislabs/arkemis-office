// GridCraft source: engine/src/cmd/edit/{clipboard,paste_special}.rs.
// Clipboard snapshots intentionally contain cells, never live references to a sheet.
import {columnName} from './formulas.mjs';
import {translateFormula} from './grid-structure.mjs';
import {mergeRects} from './grid-geometry.mjs';
import {tableBounds} from './grid-tables.mjs';
import {planPaste} from './editor-helpers.mjs';
export const gridKey=(r,c)=>columnName(c)+(r+1);
export const intersectsGridRange=(a,b)=>a.r1<=b.r2&&a.r2>=b.r1&&a.c1<=b.c2&&a.c2>=b.c1;
export function checkGridRange(range){const {r1,c1,r2,c2}=range;if(![r1,c1,r2,c2].every(Number.isInteger)||r1<0||c1<0||r2<r1||c2<c1||r2>=100000||c2>=1000||(r2-r1+1)*(c2-c1+1)>100000)throw Error('Selection exceeds the limit of 100,000 cells, 100,000 rows or 1,000 columns.');}
export function assertGridTransferRange(sheet,range,{source=false}={}){checkGridRange(range);if(mergeRects(sheet.xlsxLayout).some(m=>intersectsGridRange(m,range)))throw Error('Unmerge cells before copying, pasting or filling this range.');if(!source)for(const table of sheet.tables??[]){const {a,b}=tableBounds(table.range);if(table.headerRow&&intersectsGridRange(range,{r1:a.row,r2:a.row,c1:a.col,c2:b.col}))throw Error('Use Edit table to change table headers.');if(table.totalsRow&&intersectsGridRange(range,{r1:b.row,r2:b.row,c1:a.col,c2:b.col}))throw Error('Paste or fill in the table body, outside its totals row.');}}
export function captureGridClipboard(sheet,range,valueAt){assertGridTransferRange(sheet,range,{source:true});const cells=[],values=[];for(let r=range.r1;r<=range.r2;r++){const row=[],vr=[];for(let c=range.c1;c<=range.c2;c++){const key=gridKey(r,c),cell=sheet.cells[key]??{value:''};row.push(structuredClone(cell));vr.push(valueAt?valueAt(key):cell.value);}cells.push(row);values.push(vr);}return {range:{...range},cells,values,external:false,sheetName:sheet.name};}
export function externalGridClipboard(text){const {values}=planPaste(text,0,0);const width=Math.max(...values.map(row=>row.length));const range={r1:0,c1:0,r2:values.length-1,c2:width-1};checkGridRange(range);return {range,cells:values.map(row=>Array.from({length:width},(_,c)=>({value:row[c]??''}))),values:values.map(row=>Array.from({length:width},(_,c)=>row[c]??'')),external:true,sheetName:''};}
export function gridClipboardText(clip){return clip.cells.map(row=>row.map(c=>c.value.replace(/[\t\r\n]/g,' ')).join('\t')).join('\n');}
const contentKeys=new Set(['value','valueType']);
const formatOf=cell=>Object.fromEntries(Object.entries(cell).filter(([key])=>!contentKeys.has(key)));
const isFormula=cell=>cell.valueType!=='text'&&cell.value.startsWith('=');
export function pasteGridClipboard(sheet,clip,at,options={}){
 const {mode='all',transpose=false,skipBlanks=false,operation='none'}=options;
 if(!['all','values','formulas','formats'].includes(mode)||!['none','add','subtract','multiply','divide'].includes(operation))throw Error('Unknown paste option.');
 if(mode==='formats'&&operation!=='none')throw Error('Arithmetic requires cell contents.');
 if(mode==='formats'&&clip.external)throw Error('Copy cells in Grid before pasting formats.');
 const height=transpose?clip.cells[0].length:clip.cells.length,width=transpose?clip.cells.length:clip.cells[0].length;
 const dest={r1:at.r,c1:at.c,r2:at.r+height-1,c2:at.c+width-1};assertGridTransferRange(sheet,dest);
 const cells={...sheet.cells};
 for(let r=0;r<height;r++)for(let c=0;c<width;c++){
  const sr=transpose?c:r,sc=transpose?r:c,source=clip.cells[sr][sc],value=clip.values[sr][sc],key=gridKey(at.r+r,at.c+c),old=sheet.cells[key]??{value:''};
  if(skipBlanks&&source.value==='')continue;
  const formula=isFormula(source);let incoming=source.value;
  if(formula&&!clip.external&&mode!=='values')incoming=translateFormula(incoming,at.r+r-(clip.range.r1+sr),at.c+c-(clip.range.c1+sc));
  if(mode==='values')incoming=String(value??'');
  let next=mode==='formats'?{...structuredClone(formatOf(source)),value:old.value,...(old.valueType?{valueType:old.valueType}:{})}:mode==='all'&&!clip.external?{...structuredClone(source),value:incoming}:{...old,value:incoming,valueType:mode==='values'?(typeof value==='string'&&(!clip.external||value.startsWith('='))?'text':undefined):source.valueType};
  if(operation!=='none'){
   const operand=Number(value??'');if((typeof value==='string'&&value.trim()!==''&&!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))||!Number.isFinite(operand))throw Error('Arithmetic paste requires numeric source values.');
   const symbol={add:'+',subtract:'-',multiply:'*',divide:'/'}[operation];
   if(isFormula(old))next={...next,value:`=(${old.value.slice(1)})${symbol}(${operand})`,valueType:undefined};
   else{const existing=Number(old.value);if(!Number.isFinite(existing))throw Error('Arithmetic paste requires numeric destination values.');const result=operation==='add'?existing+operand:operation==='subtract'?existing-operand:operation==='multiply'?existing*operand:existing/operand;next={...next,value:operation==='divide'&&operand===0?'#DIV/0!':String(result),valueType:undefined};if(!Number.isFinite(result)&&!(operation==='divide'&&operand===0))throw Error('Arithmetic result exceeds the numeric limit.');}
  }
  cells[key]=next;
 }
 return {...sheet,cells,rows:Math.max(sheet.rows,dest.r2+1),columns:Math.max(sheet.columns,dest.c2+1)};
}
/** Native clipboard ownership is tied to an unguessable HTML marker, never text equality alone. */
const gridCopyToken=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function gridClipboardHTML(clip,token){
 if(!gridCopyToken.test(token))throw Error('Invalid clipboard ownership token.');
 const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 return `<!--arkemis-grid-copy:${token}--><table><tbody>${clip.cells.map(row=>`<tr>${row.map(cell=>`<td>${escape(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function gridClipboardToken(html){
 if(typeof html!=='string')return null;
 const matches=[...html.matchAll(/<!--arkemis-grid-copy:([^<>]*?)-->/g)];
 return matches.length===1&&gridCopyToken.test(matches[0][1])?matches[0][1]:null;
}
export function ownsGridClipboard(payload,copy){return !!copy&&payload.text===copy.text&&gridClipboardToken(payload.html)===copy.token;}
