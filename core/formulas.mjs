import {structuredReference,tableAt} from './grid-tables.mjs';
import {shapedArray,asArray,isArrayError,arrayError} from './gridcraft-dynamic-arrays.mjs';
import {extendedFunction,joinFormulaText} from './formula-functions.mjs';
const calculationErrors=new WeakMap();
export const isCalculationError=(cache,address)=>calculationErrors.get(cache)?.has(address.replaceAll('$','').toUpperCase())??false;
const spillCalculations=new WeakMap();
const normalizeAddress=a=>a.replaceAll('$','').toUpperCase();
const workbookContexts=new WeakMap();
function workbookContext(cells,cache,context){if(!context.sheets)return context;if(context._workbook)return context;const existing=workbookContexts.get(cache);if(existing&&existing.sheets===context.sheets&&existing.namedRanges===context.namedRanges)return {...context,sheetId:context.sheetId??context.sheets.find(s=>s.cells===cells)?.id,_workbook:existing};if(existing){cache.clear();spillCalculations.delete(cache);calculationErrors.delete(cache);}const session={sheets:context.sheets,namedRanges:context.namedRanges,caches:new Map(),active:new Set(),names:new Set()};const id=context.sheetId??context.sheets.find(s=>s.cells===cells)?.id;session.caches.set(id,cache);workbookContexts.set(cache,session);return {...context,sheetId:id,_workbook:session};}
function formulaTokens(raw){const tokens=raw.match(/(?:[\p{L}_][\p{L}\p{N}_.]*)?\[(?:[^\[\]]|\[[^\[\]]*\])*\]|\s+|#[A-Za-z0-9/]+[!?]|'(?:[^']|'')*'|(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?|\$?[\p{L}_][\p{L}\p{N}_$.]*|"(?:[^"]|"")*"|>=|<=|<>|[+\-*/^%(),:<>&==#!]/gu)||[];if(tokens.join('')!==raw||tokens.length>2048)throw new Error('#ERROR!');return tokens.filter(x=>x.trim()).map(x=>x.startsWith('"')||x.startsWith("'")?x:x.toUpperCase());}
function spillState(cells,cache,context){
 let state=spillCalculations.get(cache);if(!state||state.cells!==cells||state.dateSystem!==context.dateSystem){
  if(state){cache.clear();calculationErrors.delete(cache);}
  const anchors=Object.keys(cells).filter(a=>cells[a].valueType!=='text'&&String(cells[a].value).startsWith('=')&&(context.namedRanges?.length||String(cells[a].value).includes('!')||String(cells[a].value).includes('[')||/(?:TEXTSPLIT|SEQUENCE|TRANSPOSE)\s*\(|[A-Z][0-9]+\s*#|[A-Z][0-9]+\s*:/i.test(String(cells[a].value).replace(/"(?:[^"]|"")*"/g,'')))).sort((a,b)=>{const x=parseAddress(a),y=parseAddress(b);return x.row-y.row||x.col-y.col;});
  state={cells,dateSystem:context.dateSystem,anchors,spills:new Map(),owners:new Map(),dependencies:new Map(),initializing:false,initialized:false,totalSpillCells:0};spillCalculations.set(cache,state);
 }return state;
}
export function getSpillInfo(cache,address){const state=spillCalculations.get(cache),key=normalizeAddress(address),anchor=state?.owners.get(key)??(state?.spills.has(key)?key:null),spill=state?.spills.get(anchor);return spill?{anchor,rows:spill.rows,columns:spill.columns,range:spill.range,isAnchor:key===anchor}:null;}
export function evaluateSheet(cells,context={}){const cache=new Map(),state=spillState(cells,cache,context);for(const a of state.anchors)evaluateCell(cells,a,new Set(),cache,context);for(const a of Object.keys(cells))evaluateCell(cells,a,new Set(),cache,context);return {cache,values:cache,spills:state.spills};}
export function columnName(index) {
 let name=''; for(let n=index+1;n>0;n=Math.floor((n-1)/26)) name=String.fromCharCode(65+(n-1)%26)+name; return name;
}
export function parseAddress(address) {
 const m=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,5})$/i.exec(address); if(!m) throw new Error('Invalid cell address');
 let col=0; for(const c of m[1].toUpperCase()) col=col*26+c.charCodeAt(0)-64;
 return {row:Number(m[2])-1,col:col-1};
}
export function evaluateCell(cells,address,seen=new Set(),cache=new Map(),context={}) {
 context=workbookContext(cells,cache,context);
 const state=spillState(cells,cache,context);
 const errors=calculationErrors.get(cache)??new Set();calculationErrors.set(cache,errors);
 address=address.replaceAll('$','').toUpperCase();
 if(!seen.size&&!state.initialized&&!state.initializing){state.initializing=true;try{for(const candidate of state.anchors)evaluateCell(cells,candidate,new Set(),cache,context);}finally{state.initializing=false;state.initialized=true;}}
 if(cache.has(address))return cache.get(address);
 if(seen.has(address)||seen.size>200){errors.add(address);return '#CYCLE!';}
 const raw=String(cells[address]?.value??'');
 if(raw===''&&!state.owners.has(address)){
  const target=parseAddress(address);for(const candidate of state.anchors){if(candidate===address||seen.has(candidate)||cache.has(candidate))continue;const at=parseAddress(candidate);if(at.row>target.row||at.col>target.col)continue;evaluateCell(cells,candidate,seen,cache,context);if(cache.has(address))return cache.get(address);if(errors.has(candidate)&&cache.get(candidate)==='#CYCLE!'&&state.dependencies.get(candidate)?.has(address)){errors.add(address);cache.set(address,'#CYCLE!');return '#CYCLE!';}}
 }
 if(cells[address]?.valueType==='text'){cache.set(address,raw);return raw;}
 if(!raw.startsWith('=')){const result=raw.trim()!==''&&Number.isFinite(Number(raw))?Number(raw):raw;cache.set(address,result);return result;}
 const path=new Set(seen); path.add(address);const workbook=context._workbook,globalKey=context.sheetId+'!'+address;if(workbook&&(workbook.active.has(globalKey)||workbook.active.size>200)){errors.add(address);return '#CYCLE!';}workbook?.active.add(globalKey);
 try {
  let t=formulaTokens(raw.slice(1)),p=0,referenceScope=null;
  const readCell=(a)=>{for(const parent of path){const deps=state.dependencies.get(parent)??new Set();deps.add(normalizeAddress(a));state.dependencies.set(parent,deps);}const v=evaluateCell(cells,a,path,cache,context);if(errors.has(normalizeAddress(a)))return arrayError(v);return v;};
  const readReference=(a,target=referenceScope)=>{if(!target||target.id===context.sheetId)return readCell(a);const session=context._workbook;if(!session)throw new Error('#REF!');let targetCache=session.caches.get(target.id);if(!targetCache){targetCache=new Map();session.caches.set(target.id,targetCache);}const v=evaluateCell(target.cells,a,new Set(),targetCache,{...context,sheetId:target.id});return isCalculationError(targetCache,a)?arrayError(v):v;};
  const reference=(x,target=referenceScope)=>{if(!/^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(x))throw new Error('#REF!');const pos=parseAddress(x);if(pos.row>=100000||pos.col>=1000)throw new Error('#REF!');if(t[p]===':'){p++;const start=pos;let endToken=t[p++];if(t[p]==='!'){p++;const endName=endToken.startsWith("'")?endToken.slice(1,-1).replaceAll("''","'"):endToken;const expected=target??context.sheets?.find(s=>s.id===context.sheetId);if(!expected||expected.name.toUpperCase()!==endName.toUpperCase())throw new Error('#REF!');endToken=t[p++];}const end=parseAddress(endToken??'');if(end.row>=100000||end.col>=1000)throw new Error('#REF!');const rows=Math.abs(end.row-start.row)+1,cols=Math.abs(end.col-start.col)+1;if(rows*cols>100000)throw new Error('#LIMIT!');const values=[];for(let r=Math.min(start.row,end.row);r<=Math.max(start.row,end.row);r++)for(let c=Math.min(start.col,end.col);c<=Math.max(start.col,end.col);c++)values.push(readReference(columnName(c)+(r+1),target));return shapedArray(rows,cols,values);}if(t[p]==='#'){p++;const value=readReference(x,target);if(isArrayError(value))return value;const refCache=target&&target.id!==context.sheetId?context._workbook.caches.get(target.id):cache;const spill=spillCalculations.get(refCache)?.spills.get(normalizeAddress(x));if(!spill)throw new Error('#REF!');return spill.array;}return readReference(x,target);};
  const readName=(x,target)=>{const scope=target?.id??context.sheetId;const named=context.namedRanges?.find(n=>n.name.toUpperCase()===x&&n.sheetId===scope)??context.namedRanges?.find(n=>n.name.toUpperCase()===x&&!n.sheetId);if(!named)throw new Error('#NAME?');const key=(named.sheetId??'')+':'+x,session=context._workbook;if(!session||session.names.has(key)||session.names.size>100)throw new Error('#CYCLE!');const old=t,position=p,oldScope=referenceScope;session.names.add(key);try{referenceScope=target;t=formulaTokens(named.reference.replace(/^=/,''));p=0;const value=compare();if(p!==t.length)throw new Error('#ERROR!');return value;}finally{session.names.delete(key);t=old;p=position;referenceScope=oldScope;}};
  const num=(v)=>{if(isArrayError(v))throw new Error(v.arrayError);if(Array.isArray(v))throw new Error('#VALUE!');const n=v===''?0:Number(v); if(!Number.isFinite(n))throw new Error('#VALUE!');return n;};
  const atom=()=>{
   const x=t[p++]; if(x===undefined)throw new Error('#ERROR!');
   if(x.startsWith('#'))throw new Error(x);if(x.includes('['))return structuredReference(x,context,address,readReference);
   if(x==='+'||x==='-')return (x==='-'?-1:1)*num(atom());
   if(x==='('){const v=compare();if(t[p++]!==')')throw new Error('#ERROR!');return v;}
   if(x.startsWith('"'))return x.slice(1,-1).replaceAll('""','"');
   if(/^\d|^\./.test(x))return Number(x);
   if(t[p]==='!'){p++;const name=x.startsWith("'")?x.slice(1,-1).replaceAll("''","'"):x;const target=context.sheets?.find(s=>s.name.toUpperCase()===name.toUpperCase());if(!target)throw new Error('#REF!');const token=t[p++];if(token?.startsWith('#'))throw new Error(token);return /^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(token)?reference(token,target):readName(token,target);}
   if(x==='TRUE'||x==='FALSE')return x==='TRUE'?1:0;
   if(t[p]==='('){
    if(x.includes('.')&&!['WORKDAY.INTL','NETWORKDAYS.INTL'].includes(x))throw new Error('#ERROR!');
    if(x==='IF'||x==='IFERROR'){
     p++;const parts=[];let start=p,depth=0,closed=false;
     for(;p<t.length;p++){if(t[p]==='(')depth++;else if(t[p]===')'){if(depth===0){parts.push(t.slice(start,p));p++;closed=true;break;}depth--;}else if(t[p]===','&&depth===0){parts.push(t.slice(start,p));start=p+1;}}
     if(!closed||parts.length<2||parts.length>(x==='IFERROR'?2:3)||parts.some(part=>!part.length))throw new Error('#ERROR!');
     const evaluatePart=part=>{const old=t,position=p;t=part;p=0;try{const value=compare();if(p!==t.length)throw new Error('#ERROR!');return value;}finally{t=old;p=position;}};
     if(x==='IFERROR'){try{const result=evaluatePart(parts[0]);if(isArrayError(result))throw new Error(result.arrayError);if(typeof result==='number'&&!Number.isFinite(result))throw new Error('#NUM!');return result;}catch(error){if(!error?.message?.startsWith('#'))throw error;return evaluatePart(parts[1]);}}
     return num(evaluatePart(parts[0]))?evaluatePart(parts[1]):parts[2]?evaluatePart(parts[2]):0;
    }
    p++;const args=[],direct=[],blankArguments=[]; if(t[p]!==')'){do{const start=p;args.push(t[p]===','||t[p]===')'?undefined:compare());blankArguments.push(p===start+1&&/^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(t[start])&&(cells[t[start].replaceAll('$','')]?.value??'')===''&&args.at(-1)===''&&!state.owners.has(normalizeAddress(t[start])));direct.push(!/^(?:(?:'[^']*(?:''[^']*)*'|[A-Z_][A-Z_0-9.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(t.slice(start,p).join(''))&&!context.namedRanges?.some(n=>n.name.toUpperCase()===t[start]));}while(t[p]===','&&++p);}
    if(t[p++]!==')')throw new Error('#ERROR!');
    const flat=args.flat();if(x!=='SUBTOTAL'&&x!=='ARRAYTOTEXT'&&x!=='TEXTSPLIT'&&x!=='TRANSPOSE'){const error=flat.find(isArrayError);if(error)throw new Error(error.arrayError);}const numbers=args.flatMap((v,i)=>Array.isArray(v)?v.filter(n=>typeof n==='number'):typeof v==='number'?[v]:direct[i]&&v!==''&&Number.isFinite(Number(v))?[Number(v)]:[]);
    switch(x){
     case 'SUBTOTAL':{const code=num(args[0]),fn=code>100?code-100:code;if(!Number.isInteger(code)||fn<1||fn>11||args.length<2)throw new Error('#VALUE!');const values=args.slice(1).flatMap(v=>v?.subtotalValues?v.subtotalValues():Array.isArray(v)?v:[v]);const err=values.find(isArrayError);if(err)throw new Error(err.arrayError);const ns=values.filter(v=>typeof v==='number'),sum=ns.reduce((a,b)=>a+b,0);if(fn===1)return ns.length?sum/ns.length:arrayError('#DIV/0!');if(fn===2)return ns.length;if(fn===3)return values.filter(v=>v!=='').length;if(fn===4)return ns.length?Math.max(...ns):0;if(fn===5)return ns.length?Math.min(...ns):0;if(fn===6)return ns.reduce((a,b)=>a*b,ns.length?1:0);if(fn===9)return sum;const sample=fn===7||fn===10,denominator=ns.length-(sample?1:0);if(denominator<=0)throw new Error('#DIV/0!');const variance=ns.reduce((n,x)=>n+(x-sum/ns.length)**2,0)/denominator;return fn===7||fn===8?Math.sqrt(variance):variance;}
     case 'SUM':return numbers.reduce((a,b)=>a+b,0);
     case 'AVERAGE':if(!numbers.length)throw new Error('#DIV/0!');return numbers.reduce((a,b)=>a+b,0)/numbers.length;
     case 'MIN':return numbers.length?Math.min(...numbers):0;
     case 'MAX':return numbers.length?Math.max(...numbers):0;
     case 'COUNT':return numbers.length;
     case 'COUNTA':return flat.filter(v=>v!=='').length;
     case 'IF':if(args.length<2)throw new Error('#ERROR!');return num(args[0])?args[1]:(args[2]??0);
     case 'ROUND':{const places=Math.trunc(num(args[1]??0));if(Math.abs(places)>15)throw new Error('#NUM!');const value=num(args[0]),factor=10**places;return Math.sign(value)*Math.round((Math.abs(value)+Number.EPSILON)*factor)/factor;}
     case 'ABS':return Math.abs(num(args[0]));
     default:return extendedFunction(x,args,{...context,blankArguments});
    }
   }
   if(/^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(x))return reference(x);
   return readName(x,referenceScope);
   throw new Error('#ERROR!');
  };
  const power=()=>{let a=atom();if(t[p]==='^'){p++;a=num(a)**num(power());}if(t[p]==='%'){p++;a=num(a)/100;}return a;};
  const product=()=>{let a=power();while(t[p]==='*'||t[p]==='/'){const op=t[p++],b=num(power());if(op==='/'&&b===0)throw new Error('#DIV/0!');a=op==='*'?num(a)*b:num(a)/b;}return a;};
  const sum=()=>{let a=product();while(t[p]==='+'||t[p]==='-'){const op=t[p++],b=num(product());a=op==='+'?num(a)+b:num(a)-b;}return a;};
  const concat=()=>{let a=sum();while(t[p]==='&'){p++;const b=sum();if(isArrayError(a)||isArrayError(b))throw new Error((isArrayError(a)?a:b).arrayError);if(Array.isArray(a)||Array.isArray(b))throw new Error('#VALUE!');a=joinFormulaText([a,b]);}return a;};
  const compare=()=>{let a=concat();while(['=','==','<>','<','>','<=','>='].includes(t[p])){const op=t[p++],b=concat();if(isArrayError(a)||isArrayError(b))throw new Error((isArrayError(a)?a:b).arrayError);if(Array.isArray(a)||Array.isArray(b))throw new Error('#VALUE!');a=Number(op==='='||op==='=='?a===b:op==='<>'?a!==b:op==='<'?a<b:op==='>'?a>b:op==='<='?a<=b:a>=b);}return a;};
  let result=compare();if(p!==t.length)throw new Error('#ERROR!');
  if(Array.isArray(result)){
   const currentSheet=context.sheets?.find(s=>s.id===context.sheetId);if(currentSheet&&tableAt(currentSheet,address))throw new Error('#SPILL!');
   const array=asArray(result),start=parseAddress(address),end={row:start.row+array.rows-1,col:start.col+array.columns-1};
   if(end.row>=100000||end.col>=1000)throw new Error('#SPILL!');const entries=[];
   for(let r=0;r<array.rows;r++)for(let c=0;c<array.columns;c++){const key=columnName(start.col+c)+(start.row+r+1);if(key!==address&&((cells[key]?.value??'')!==''||state.owners.has(key)))throw new Error('#SPILL!');if(state.dependencies.get(address)?.has(key))throw new Error('#CYCLE!');const v=array[r*array.columns+c];if(typeof v==='string'&&v.length>32767)throw new Error('#VALUE!');entries.push([key,v]);}
   if(array.length>=1){if(state.totalSpillCells+array.length>200000)throw new Error('#LIMIT!');state.totalSpillCells+=array.length;state.spills.set(address,{array,rows:array.rows,columns:array.columns,range:address+':'+columnName(end.col)+(end.row+1)});for(const [key,v] of entries){if(key!==address)state.owners.set(key,address);if(isArrayError(v)){cache.set(key,v.arrayError);errors.add(key);}else{cache.set(key,v);errors.delete(key);}}}
   result=array[0];
  }
  if(isArrayError(result))throw new Error(result.arrayError);
  if(typeof result==='number'&&!Number.isFinite(result))throw new Error('#NUM!');if(typeof result==='string'&&result.length>32767)throw new Error('#VALUE!');errors.delete(address);cache.set(address,result);return result;
 }catch(error){errors.add(address);const result=error?.message?.startsWith('#')?error.message:'#ERROR!';cache.set(address,result);return result;}finally{workbook?.active.delete(globalKey);}
}
export function parseCSV(text, delimiter=',') {
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
 if(cell!==''||row.length||!rows.length){row.push(cell);rows.push(row);}return rows;
}
export const toCSV=(rows)=>rows.map(row=>row.map(value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(',')).join('\r\n');
/** @param {any} before @param {any} after @param {any} [context] @param {Map|null} [previousCache] */
export function assertSpillEdits(before,after,context={},previousCache=null){
 const old=previousCache&&spillCalculations.get(previousCache)?.cells===before?{cache:previousCache,values:previousCache}:evaluateSheet(before,context),changed=[];
 if(!spillCalculations.get(old.cache)?.spills.size)return;
 for(const [key] of old.values){const spill=getSpillInfo(old.cache,key);if(!spill||spill.isAnchor||(before[key]?.value??'')===(after[key]?.value??''))continue;
  if((before[spill.anchor]?.value??'')===(after[spill.anchor]?.value??'')&&before[spill.anchor]?.valueType===after[spill.anchor]?.valueType)throw new Error(`Cell ${key} is a spilled result. Edit anchor ${spill.anchor}.`);
  changed.push(key);
 }
 if(changed.length){const projected={...after};for(const key of changed)projected[key]={...projected[key],value:''};const next=evaluateSheet(projected,context);for(const key of changed)if((after[key]?.value??'')!==''&&getSpillInfo(next.cache,key))throw new Error(`Cell ${key} is still owned by the changed spill anchor. Resize or remove the array first.`);}
}
