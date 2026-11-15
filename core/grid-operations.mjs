import {columnName,parseAddress,evaluateCell,evaluateSheet,getSpillInfo} from './formulas.mjs';

// Saving through IPC returns fresh objects. Compare content, not identity, so a save
// acknowledgment does not discard undo. Reference equality avoids work on local edits.
export function sameWorkbookContent(a,b) {
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a),otherKeys=Object.keys(b);
  return keys.length===otherKeys.length&&keys.every(key=>Object.hasOwn(b,key)&&sameWorkbookContent(a[key],b[key]));
}

export function insertAutoSum(cells,address,formula) {
  if(cells[address]&&cells[address].value!=='')throw new Error(`${address} is not empty. Choose an empty cell for AutoSum; existing data was not changed.`);
  return {...cells,[address]:{...cells[address],value:formula}};
}

// Sort exactly the rectangle; retain each cell object so its formatting travels with it.
export function sortRange(cells,range,direction='asc',context={}) {
  const {r1,r2,c1,c2}=range;
  if(r2<=r1)throw new Error('Select at least two rows to sort.');
  const calculation=evaluateSheet(cells,context);for(const key of calculation.values.keys()){const p=parseAddress(key);if(p.row>=r1&&p.row<=r2&&p.col>=c1&&p.col<=c2&&getSpillInfo(calculation.cache,key))throw new Error('A spilled array cannot be sorted independently. Edit its anchor formula instead.');}
  if(Object.keys(cells).some(key=>{const p=parseAddress(key);return p&&p.row>=r1&&p.row<=r2&&p.col>=c1&&p.col<=c2&&cells[key].value.trimStart().startsWith('=');}))throw new Error('Ranges containing formulas cannot be sorted yet because relative references would need updating. No cells were changed.');
  if(c1===c2&&Object.keys(cells).some(key=>{const p=parseAddress(key);return p&&p.row>=r1&&p.row<=r2&&p.col!==c1&&cells[key].value!=='';}))throw new Error('Select the whole table width before sorting to keep related columns together.');
  const key=(r,c)=>`${columnName(c)}${r+1}`;
  const order=Array.from({length:r2-r1+1},(_,i)=>({row:r1+i,value:evaluateCell(cells,key(r1+i,c1),new Set(),new Map(),context)}));
  order.sort((a,b)=>{
    const av=String(a.value??''),bv=String(b.value??'');
    if(av===''||bv==='')return av===''?(bv===''?0:1):-1;
    const difference=Number.isFinite(Number(av))&&Number.isFinite(Number(bv))?Number(av)-Number(bv):av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'});
    return direction==='desc'?-difference:difference;
  });
  const result={...cells};
  order.forEach(({row},i)=>{for(let c=c1;c<=c2;c++){const from=cells[key(row,c)],to=key(r1+i,c);if(from)result[to]=from;else delete result[to];}});
  return result;
}

export function findCells(cells,query,context={}) {
  const needle=query.toLocaleLowerCase();if(!needle)return [];
  const calculation=evaluateSheet(cells,context);return [...new Set([...Object.keys(cells),...calculation.values.keys()])].filter(key=>String(cells[key]?.value??'').toLocaleLowerCase().includes(needle)||String(calculation.values.get(key)??'').toLocaleLowerCase().includes(needle)).map(key=>{const p=parseAddress(key);return {r:p.row,c:p.col};}).sort((a,b)=>a.r-b.r||a.c-b.c);
}

export function columnWindow(scrollLeft,columns,columnWidth=112,viewportWidth=1200) {
  const start=Math.max(0,Math.min(columns-1,Math.floor(scrollLeft/columnWidth)-2));
  return {start,end:Math.min(columns,start+Math.ceil(viewportWidth/columnWidth)+4)};
}

// Immutable workbook references share unchanged sheets and cells. Retain at most 20 actions.
export function createHistory(limit=20) {
  const past=[],future=[];
  return {
    get canUndo(){return past.length>0;},get canRedo(){return future.length>0;},
    record(before,after){if(before===after)return;past.push(before);if(past.length>limit)past.shift();future.length=0;},
    undo(current){if(!past.length)return current;future.push(current);return past.pop();},
    redo(current){if(!future.length)return current;past.push(current);return future.pop();},
    reset(){past.length=0;future.length=0;},
  };
}
