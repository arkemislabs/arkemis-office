import {dynamicArrayNames,dynamicArrayFunction} from './gridcraft-dynamic-arrays.mjs';
import {dateFunctionNames,dateFunction} from './gridcraft-date-functions.mjs';
import {numericTextNames,numericTextFunction} from './gridcraft-text-numeric.mjs';
import {translatedTextNames,translatedTextFunction} from './gridcraft-text-family.mjs';
import {spreadsheetFind} from './gridcraft-text-search.mjs';
const fail=(code='#VALUE!')=>{throw new Error(code);};
const numeric=v=>{if(Array.isArray(v))return fail();const n=Number(v);return Number.isFinite(n)?n:fail();};
const text=v=>Array.isArray(v)?fail():String(v??'');
const list=v=>Array.isArray(v)?v:[v];
const count=v=>{const n=Math.trunc(numeric(v));return n>=0?n:fail();};
export function joinFormulaText(values,separator=''){const strings=values.map(text);if(strings.reduce((n,s)=>n+s.length,Math.max(0,strings.length-1)*separator.length)>32767)fail();return strings.join(separator);}
export function matches(value,criterion){
 const match=/^(<=|>=|<>|=|<|>)(.*)$/.exec(String(criterion));
 const operator=match?.[1]??'=',operand=match?match[2]:criterion;
 const isNumber=String(operand).trim()!==''&&Number.isFinite(Number(operand));
 if(isNumber){if(value!==''&&typeof value!=='number')return operator==='<>';const a=value===''?0:value,b=Number(operand);return operator==='='?a===b:operator==='<>'?a!==b:operator==='<'?a<b:operator==='>'?a>b:operator==='<='?a<=b:a>=b;}
 const a=String(value).toLocaleLowerCase('en-US'),b=String(operand).toLocaleLowerCase('en-US');
 if(operator==='='||operator==='<>'){
  const pattern=[];for(let i=0;i<b.length;i++){const ch=b[i];if(ch==='~'&&i+1<b.length)pattern.push({literal:b[++i]});else if(ch==='*'){if(pattern.at(-1)!=='*')pattern.push('*');}else if(ch==='?')pattern.push('?');else pattern.push({literal:ch});}
  let i=0,j=0,star=-1,retry=0,steps=0;
  while(i<a.length){if(++steps>200000)fail('#LIMIT!');if(j<pattern.length&&(pattern[j]==='?'||pattern[j].literal===a[i])){i++;j++;}else if(pattern[j]==='*'){star=j++;retry=i;}else if(star>=0){j=star+1;i=++retry;}else break;}
  while(pattern[j]==='*')j++;const equal=i===a.length&&j===pattern.length;return operator==='='?equal:!equal;
 }
 return operator==='<'?a<b:operator==='>'?a>b:operator==='<='?a<=b:a>=b;
}
export function extendedFunction(name,args,context={}){
 if(dynamicArrayNames.has(name))return dynamicArrayFunction(name,args,context);
 if(dateFunctionNames.has(name))return dateFunction(name,args,context);
 if(numericTextNames.has(name))return numericTextFunction(name,args,context);
 if(translatedTextNames.has(name))return translatedTextFunction(name,args);
 const arity=(min,max=min)=>{if(args.length<min||args.length>max)fail();};
 if(['SUMIF','AVERAGEIF','COUNTIF','SUMIFS','AVERAGEIFS','COUNTIFS'].includes(name)){
  let values,ranges,criteria;
  if(name.endsWith('IFS')){
   const offset=name==='COUNTIFS'?0:1;arity(offset+2,255);if((args.length-offset)%2)fail();
   ranges=[];criteria=[];for(let i=offset;i<args.length;i+=2){ranges.push(list(args[i]));if(Array.isArray(args[i+1]))fail();criteria.push(args[i+1]);}values=offset?list(args[0]):ranges[0];
  }else{arity(2,name==='COUNTIF'?2:3);ranges=[list(args[0])];criteria=[args[1]];if(Array.isArray(args[1]))fail();values=list(args[2]??args[0]);}
  if(ranges.some(r=>r.length!==values.length))fail();
  let total=0,matched=0,numbers=0;for(let i=0;i<values.length;i++){if(!ranges.every((r,j)=>matches(r[i],criteria[j])))continue;matched++;if(typeof values[i]==='number'){total+=values[i];numbers++;}}
  if(name.startsWith('COUNT'))return matched;if(name.startsWith('AVERAGE'))return numbers?total/numbers:fail('#DIV/0!');return total;
 }
 switch(name){
  case 'FIND':case 'SEARCH':arity(2,3);return spreadsheetFind(text(args[0]),text(args[1]),args.length===3?numeric(args[2]):1,name==='SEARCH');
  case 'AND':case 'OR':{arity(1,255);const values=args.flat().filter(v=>v!==''&&typeof v!=='string');if(!values.length)fail();return Number(name==='AND'?values.every(v=>numeric(v)!==0):values.some(v=>numeric(v)!==0));}
  case 'NOT':arity(1);return Number(!numeric(args[0]));
  case 'LEN':arity(1);return text(args[0]).length;
  case 'LOWER':arity(1);return text(args[0]).toLowerCase();
  case 'UPPER':arity(1);return text(args[0]).toUpperCase();
  case 'TRIM':arity(1);return text(args[0]).replace(/^ +| +$/g,'').replace(/ +/g,' ');
  case 'LEFT':case 'RIGHT':{arity(1,2);const s=text(args[0]),n=count(args[1]??1);return name==='LEFT'?s.slice(0,n):n?s.slice(-n):'';}
  case 'MID':{arity(3);const start=count(args[1]);if(start<1)fail();return text(args[0]).slice(start-1,start-1+count(args[2]));}
  case 'CONCAT':case 'CONCATENATE':arity(1,255);return joinFormulaText(args.flat());
  case 'SUBSTITUTE':{arity(3,4);const source=text(args[0]),old=text(args[1]),replacement=text(args[2]);if(!old)return source;const occurrence=args.length===4?count(args[3]):0;if(args.length===4&&!occurrence)fail();const pieces=source.split(old),replacements=occurrence?Number(occurrence<pieces.length):pieces.length-1;if(source.length+replacements*(replacement.length-old.length)>32767)fail();return pieces.reduce((a,b,i)=>i?a+(!occurrence||i===occurrence?replacement:old)+b:b,'');}
  case 'INT':arity(1);return Math.floor(numeric(args[0]));
  case 'MOD':{arity(2);const a=numeric(args[0]),b=numeric(args[1]);if(!b)fail('#DIV/0!');return a-b*Math.floor(a/b);}
  case 'SQRT':{arity(1);const n=numeric(args[0]);return n<0?fail('#NUM!'):Math.sqrt(n);}
  case 'POWER':arity(2);return numeric(args[0])**numeric(args[1]);
  case 'ROUNDUP':case 'ROUNDDOWN':{arity(2);const n=numeric(args[0]),places=Math.trunc(numeric(args[1]));if(Math.abs(places)>15)fail('#NUM!');const factor=10**places,rounded=(name==='ROUNDUP'?Math.ceil:Math.floor)(Math.abs(n)*factor);return Math.sign(n)*rounded/factor;}
  default:fail('#NAME?');
 }
}
