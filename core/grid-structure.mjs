import {shiftGridTables} from './grid-tables.mjs';
export function adjustGridReference(ref,axis,index,delta){
 const coord=axis==='row'?'row':'col';
  const ends=ref.split(':').map(r=>parts(r.trim()));
  if(ends.length===2&&delta===-1){const [a,b]=ends;const low=Math.min(a[coord],b[coord]),high=Math.max(a[coord],b[coord]);if(low===high&&low===index)return '#REF!';
   for(const p of ends){if(p[coord]>index)p[coord]--;else if(p[coord]===index&&p[coord]===high)p[coord]--;}
  }else for(const p of ends){if(delta===-1&&p[coord]===index)return '#REF!';if(p[coord]>=index)p[coord]+=delta;}
  return ends.map(label).join(':');
 }

import {mapReferences,mapCells,assertSafeWorkbookReferences,assertSafeReferenceFormula} from './grid-workbook-references.mjs';
import {shiftXlsxLayout} from './grid-xlsx-layout.mjs';
import {columnName,parseAddress} from './formulas.mjs';
const reference=/\$?[A-Z]{1,3}\$?[1-9]\d{0,5}/gi;
function parts(ref){const m=/^(\$?)([A-Z]+)(\$?)(\d+)$/i.exec(ref);return {...parseAddress(ref),ac:m[1],ar:m[3]};}
function label(p){return p.col<0||p.row<0||p.col>=1000||p.row>=100000?'#REF!':`${p.ac}${columnName(p.col)}${p.ar}${p.row+1}`;}
function rewrite(value,transform){return value.split(/("(?:[^"]|"")*")/g).map((part,i)=>i%2?part:part.replace(/(?<![\w.])\$?[A-Z]{1,3}\$?[1-9]\d{0,5}(?:\s*:\s*\$?[A-Z]{1,3}\$?[1-9]\d{0,5})?(?![\w(])/gi,transform)).join('');}
export function translateFormula(value,dr,dc){assertSafeReferenceFormula(value);return mapReferences(value,({prefix,ref})=>prefix+ref.replace(reference,r=>{const p=parts(r);if(!p.ac)p.col+=dc;if(!p.ar)p.row+=dr;return label(p);}));}
export function shiftSheet(sheet,axis,index,delta){
 const key=axis==='row'?'rows':'columns',coord=axis==='row'?'row':'col',limit=axis==='row'?100000:1000;
 if(!['row','column'].includes(axis)||![1,-1].includes(delta)||!Number.isInteger(index)||index<0||index>=sheet[key])throw new Error('Invalid structural edit');
 if(sheet[key]+delta>limit)throw new Error('Dimension limit reached');if(sheet[key]+delta<1)throw new Error('Cannot delete the last row or column');
 for(const cell of Object.values(sheet.cells))if(cell.valueType!=='text'&&cell.value.startsWith('='))assertSafeReferenceFormula(cell.value);
 const adjust=ref=>adjustGridReference(ref,axis,index,delta);
 const cells={};for(const [address,cell] of Object.entries(sheet.cells)){const pos=parseAddress(address);if(delta===-1&&pos[coord]===index)continue;if(pos[coord]>=index)pos[coord]+=delta;
  cells[columnName(pos.col)+(pos.row+1)]={...cell,value:cell.valueType!=='text'&&cell.value.startsWith('=')?mapReferences(cell.value,({name,prefix,ref,match})=>!name||name.toUpperCase()===sheet.name.toUpperCase()?prefix+adjust(ref):match):cell.value};
 }
 return {...sheet,[key]:sheet[key]+delta,cells,...(sheet.tables?{tables:shiftGridTables(sheet,axis,index,delta)}:{}),...(sheet.xlsxLayout?{xlsxLayout:shiftXlsxLayout(sheet.xlsxLayout,axis,index,delta)}:{})};
}
export function fillRange(cells,range,direction){
 const {r1,r2,c1,c2}=range;if(!['down','right'].includes(direction)||r1<0||c1<0||r2<r1||c2<c1||r2>=100000||c2>=1000||(r2-r1+1)*(c2-c1+1)>100000)throw new Error('Invalid or oversized fill range');
 const next={...cells};for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++){
  const sr=direction==='down'?r1:r,sc=direction==='right'?c1:c,key=columnName(c)+(r+1),source=cells[columnName(sc)+(sr+1)];
  if(!source){delete next[key];continue;}next[key]={...source,value:source.valueType!=='text'&&source.value.startsWith('=')?translateFormula(source.value,r-sr,c-sc):source.value};
 }return next;
}

export function shiftWorkbookSheet(content,id,axis,index,delta){assertSafeWorkbookReferences(content);const original=content.sheets.find(s=>s.id===id);if(!original)throw new Error('Sheet not found');const shifted=shiftSheet(original,axis,index,delta);const transform=(value,current)=>mapReferences(value,({name,prefix,ref,match})=>{if(name?name.toUpperCase()!==original.name.toUpperCase():current!==id)return match;const adjusted=adjustGridReference(ref,axis,index,delta);return adjusted==='#REF!'?'#REF!':prefix+adjusted;});return {...content,sheets:content.sheets.map(s=>s.id===id?shifted:{...s,cells:mapCells(s.cells,v=>transform(v,s.id))}),namedRanges:content.namedRanges?.map(n=>({...n,reference:transform(n.reference,n.sheetId??id)}))};}
