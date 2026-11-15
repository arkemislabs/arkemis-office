const colName = index => { let name=''; for(let n=index+1;n>0;n=Math.floor((n-1)/26)) name=String.fromCharCode(65+(n-1)%26)+name; return name; };
export function pasteCells(cells, row, column, text) {
  const {values}=planPaste(text,row,column);
  const next={...cells};
  values.forEach((line,r)=>line.forEach((value,c)=>{
    const address=`${colName(column+c)}${row+r+1}`;
    next[address]={...next[address],value};
  }));
  return next;
}
export function planPaste(text,row,column) {
  const values=text.replace(/\r\n?/g,'\n').replace(/\n$/,'').split('\n').map(line=>line.split('\t'));
  const rows=row+values.length,columns=column+values.reduce((max,line)=>Math.max(max,line.length),0);
  if(!Number.isInteger(row)||row<0||rows>100000)throw new Error('Paste exceeds the limit of 100,000 rows.');
  if(!Number.isInteger(column)||column<0||columns>1000)throw new Error('Paste exceeds the limit of 1,000 columns.');
  if(values.some(line=>line.some(value=>value.length>32767)))throw new Error('A pasted cell exceeds 32,767 characters.');
  return {values,rows,columns};
}
export function sumTargetRow(first,last,selected,populated) {
  const target=last>first?last+1:selected>0?selected:populated.reduce((max,row)=>Math.max(max,row),-1)+1;
  if(target>=100000)throw new Error('Cannot add a sum below the last row. Select an empty result cell above it.');
  return target;
}
export function reconcileDraft(draft,expected,incoming) {
  if(!draft||!incoming||!expected||draft.sheetId!==incoming.id)return null;
  return expected===incoming||JSON.stringify(expected)===JSON.stringify(incoming)?draft:null;
}
export function slideDimension(element,key,value,width=960,height=540) {
  const edge=key==='x'||key==='w'?width:height;
  const available=key==='x'?edge-element.w:key==='y'?edge-element.h:key==='w'?edge-element.x:edge-element.y;
  return Math.max(key==='x'||key==='y'?0:24,Math.min(value,Math.max(0,available)));
}
export function presentationIndex(index,length) {
  return index===null||length===0?null:Math.max(0,Math.min(length-1,index));
}
export function selectionTSV(cells,r1,c1,r2,c2) {
  const rows=[];
  for(let r=Math.min(r1,r2);r<=Math.max(r1,r2);r++) {
    const values=[];
    for(let c=Math.min(c1,c2);c<=Math.max(c1,c2);c++) values.push((cells[`${colName(c)}${r+1}`]?.value??'').replace(/[\t\r\n]/g,' '));
    rows.push(values.join('\t'));
  }
  return rows.join('\n');
}
export function moveItem(items,from,to) {
  if(from<0||to<0||from>=items.length||to>=items.length) return [...items];
  const next=[...items]; const [item]=next.splice(from,1); next.splice(to,0,item); return next;
}
export function wordCount(node) {
  const text=n=>n.text??(n.type==='hardBreak'?' ':(n.content??[]).map(text).join(['paragraph','heading'].includes(n.type)?'':' '));
  return text(node).trim().split(/\s+/u).filter(Boolean).length;
}
export function rowWindow(scrollTop,rows,rowHeight=30,size=35) {
  const start=Math.max(0,Math.min(Math.floor(scrollTop/rowHeight)-3,Math.max(0,rows-size)));
  return {start,end:Math.min(rows,start+size)};
}
