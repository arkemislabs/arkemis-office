import {columnName,evaluateCell,parseAddress,isCalculationError} from './formulas.mjs';

const AGGREGATES=new Set(['SUM','COUNT','AVG','MIN','MAX']);
const MAX_CELLS=200000;
export function assertPivotSourceStructureAllowed(content,sheetId){
 const dependent=content.sheets.find(sheet=>sheet.pivot?.sourceSheetId===sheetId);
 if(dependent)throw new Error(`This source is used by “${dependent.name}”. Delete its dependent pivot result sheets before inserting or deleting source rows or columns. Cell values can still be edited and refreshed.`);
}
export function pivotRange(value){
 if(typeof value!=='string'||!/^\$?[A-Z]{1,3}\$?[1-9]\d{0,5}:\$?[A-Z]{1,3}\$?[1-9]\d{0,5}$/i.test(value))throw new Error('Enter a pivot source range such as A1:D100.');
 const [start,end]=value.split(':').map(parseAddress);
 if(start.row>=end.row||start.col>end.col||end.row>=100000||end.col>=1000)throw new Error('Pivot range must include a header and data rows within sheet bounds.');
 const width=end.col-start.col+1,height=end.row-start.row+1;
 if(width*height>MAX_CELLS)throw new Error('Pivot source range exceeds the 200,000 cell limit.');
 return {r1:start.row,r2:end.row,c1:start.col,c2:end.col,width,height};
}
export function validatePivotDefinition(definition){
 if(!definition||typeof definition!=='object'||typeof definition.sourceSheetId!=='string'||!definition.sourceSheetId||definition.sourceSheetId.length>200)throw new Error('Invalid pivot source sheet.');
 const range=pivotRange(definition.sourceRange),validField=field=>Number.isInteger(field)&&field>=0&&field<range.width;
 if(!Array.isArray(definition.rowFields)||!definition.rowFields.length||definition.rowFields.length>8||definition.rowFields.some(field=>!validField(field))||new Set(definition.rowFields).size!==definition.rowFields.length)throw new Error('Choose one to eight distinct pivot row fields.');
 if(definition.columnField!==null&&(!validField(definition.columnField)||definition.rowFields.includes(definition.columnField)))throw new Error('Choose a pivot column field different from the row fields.');
 if(!Array.isArray(definition.measures)||!definition.measures.length||definition.measures.length>16||definition.measures.some(measure=>!measure||!validField(measure.field)||!AGGREGATES.has(measure.aggregate)))throw new Error('Choose one to sixteen valid pivot measures.');
 if(new Set(definition.measures.map(m=>`${m.field}:${m.aggregate}`)).size!==definition.measures.length)throw new Error('Remove duplicate pivot measures.');
 return range;
}
export function pivotHeaders(sheet,sourceRange,context={}){
 const range=pivotRange(sourceRange);
 if(!sheet||range.r2>=sheet.rows||range.c2>=sheet.columns)throw new Error('Pivot source range is outside the source sheet bounds.');
 const headers=[],seen=new Set(),cache=new Map();
 for(let c=range.c1;c<=range.c2;c++){
  const address=columnName(c)+(range.r1+1),value=evaluateCell(sheet.cells,address,new Set(),cache,context),header=String(value).trim();
  if(!header||header.length>240||seen.has(header.toLowerCase())||isCalculationError(cache,address))throw new Error('Source headers must be nonempty, unique and error-free (up to 240 characters).');
  seen.add(header.toLowerCase());headers.push(header);
 }
 return headers;
}
function buildResult(content,definition,id,name){
 const range=validatePivotDefinition(definition),source=content.sheets.find(s=>s.id===definition.sourceSheetId);
 if(!source)throw new Error('Pivot source sheet is missing. Choose another source in Configure pivot.');
 if(source.id===id||source.pivot)throw new Error('Choose a regular source sheet, not a pivot result.');
 const headers=pivotHeaders(source,definition.sourceRange,{...content,sheetId:source.id}),groups=new Map(),columns=new Map(),cache=new Map();
 if(definition.columnField===null)columns.set('[]',[]);
 for(let r=range.r1+1;r<=range.r2;r++){
  const values=[];for(let c=range.c1;c<=range.c2;c++){
   const address=columnName(c)+(r+1),value=evaluateCell(source.cells,address,new Set(),cache,{...content,sheetId:source.id});
   if(isCalculationError(cache,address))throw new Error(`Source formula error at ${address}: ${value}. Fix it before refreshing the pivot.`);
   values.push(value);
  }
  if(values.every(value=>value===''))continue;
  const rowValues=definition.rowFields.map(field=>values[field]),rowKey=JSON.stringify(rowValues),columnValues=definition.columnField===null?[]:[values[definition.columnField]],columnKey=JSON.stringify(columnValues);
  if(!groups.has(rowKey))groups.set(rowKey,{labels:rowValues,buckets:new Map()});
  columns.set(columnKey,columnValues);
  const width=definition.rowFields.length+columns.size*definition.measures.length;
  if(width>1000||(groups.size+1)*width>MAX_CELLS)throw new Error('Pivot result exceeds the 1,000 column or 200,000 cell limit. Reduce grouping fields or measures.');
  const group=groups.get(rowKey);if(!group.buckets.has(columnKey))group.buckets.set(columnKey,definition.measures.map(()=>({count:0,numeric:0,sum:0,min:Infinity,max:-Infinity})));
  group.buckets.get(columnKey).forEach((bucket,i)=>{const value=values[definition.measures[i].field];if(value!=='')bucket.count++;if(typeof value==='number'&&Number.isFinite(value)){bucket.numeric++;bucket.sum+=value;bucket.min=Math.min(bucket.min,value);bucket.max=Math.max(bucket.max,value);if(!Number.isFinite(bucket.sum))throw new Error('Pivot aggregation overflow. Reduce the numeric values in the source.');}});
 }
 if(!columns.size)columns.set('[]',['(blank)']);
 const cells={},put=(r,c,value,header=false)=>{const text=String(value);if(text.length>32767)throw new Error('Pivot label exceeds the cell text limit.');cells[columnName(c)+(r+1)]={value:text,valueType:typeof value==='number'?'number':'text',...(header?{bold:true,background:'#e8edf4'}:{})};};
 definition.rowFields.forEach((field,c)=>put(0,c,headers[field],true));
 let column=definition.rowFields.length;for(const labels of columns.values())for(const measure of definition.measures)put(0,column++,`${labels.length?String(labels[0]===''?'(blank)':labels[0])+' · ':''}${measure.aggregate} ${headers[measure.field]}`,true);
 let row=1;for(const group of groups.values()){
  group.labels.forEach((label,c)=>put(row,c,label===''?'(blank)':label));let column=definition.rowFields.length;
  for(const key of columns.keys())definition.measures.forEach((measure,i)=>{const bucket=group.buckets.get(key)?.[i];let value='';if(measure.aggregate==='COUNT')value=bucket?.count??0;else if(measure.aggregate==='SUM')value=bucket?.sum??0;else if(bucket?.numeric)value=measure.aggregate==='AVG'?bucket.sum/bucket.numeric:measure.aggregate==='MIN'?bucket.min:bucket.max;put(row,column++,value);});row++;
 }
 return {id,name,cells,rows:Math.max(20,row),columns:Math.max(1,column),pivot:structuredClone(definition)};
}
export function createPivotSheet(content,definition,id=globalThis.crypto.randomUUID()){
 if(content.sheets.length>=100)throw new Error('A workbook supports up to 100 sheets.');
 if(content.sheets.some(s=>s.id===id))throw new Error('Pivot result id already exists.');
 let n=1;while(content.sheets.some(s=>s.name===`Pivot ${n}`))n++;
 const result=buildResult(content,definition,id,`Pivot ${n}`);
 return {...content,sheets:[...content.sheets,result],activeSheetId:id};
}
/** @param {any} content @param {string} id @param {any} [definition] */
export function refreshPivotSheet(content,id,definition=undefined){
 const sheet=content.sheets.find(s=>s.id===id);if(!sheet?.pivot)throw new Error('Choose a pivot result sheet to refresh.');
 const result=buildResult(content,definition??sheet.pivot,id,sheet.name);
 return {...content,sheets:content.sheets.map(s=>s.id===id?result:s)};
}


