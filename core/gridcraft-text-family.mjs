/*!
 * JavaScript translation/adaptation of GridCraft, commit
 * 146161b4b450a56e5e59a083ba0478582d1e602b:
 * crates/functions/src/criteria.rs: tokenize, lower_char, match_from, wildcard_find
 * crates/functions/src/text.rs: find_impl
 * https://github.com/storytold/gridcraft/tree/146161b4b450a56e5e59a083ba0478582d1e602b
 *
 * MIT License
 * Copyright (c) 2026 ArtCraft Team and the GridCraft contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Additional translation of crates/functions/src/text.rs at the pinned commit above.
// Scalar adapter: boolean results are numeric; arrays/date systems remain explicit gaps.
import {spreadsheetFind} from './gridcraft-text-search.mjs';
const fail=(code='#VALUE!')=>{throw new Error(code);};
const txt=v=>Array.isArray(v)?fail():String(v??'');
const num=v=>{if(Array.isArray(v))fail();const n=Number(v);return Number.isFinite(n)?n:fail();};
const chars=v=>Array.from(txt(v));
const capped=s=>Array.from(s).length>32767?fail():s;
const cnt=v=>{const n=num(v);return n<0?fail():Math.min(1e9,Math.trunc(n));};
const cp=[0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
export const translatedTextNames=new Set('LEFT LEFTB RIGHT RIGHTB MID MIDB LEN LENB LOWER UPPER PROPER TRIM CLEAN SUBSTITUTE REPLACE REPLACEB REPT FIND FINDB SEARCH SEARCHB EXACT CHAR CODE UNICHAR UNICODE CONCAT CONCATENATE TEXTJOIN T ASC DBCS JIS PHONETIC TEXTBEFORE TEXTAFTER VALUETOTEXT'.split(' '));
export function translatedTextFunction(name,a){
 const arity=(min,max=min)=>{if(a.length<min||a.length>max)fail();};
 switch(name){
 case 'LEFT':case 'LEFTB':case 'RIGHT':case 'RIGHTB':{arity(1,2);const s=chars(a[0]),n=cnt(a[1]??1);return (name.startsWith('LEFT')?s.slice(0,n):s.slice(s.length-Math.min(n,s.length))).join('');}
 case 'MID':case 'MIDB':{arity(3);if(num(a[1])<1)fail();const start=cnt(a[1])-1;return chars(a[0]).slice(start,start+cnt(a[2])).join('');}
 case 'LEN':case 'LENB':arity(1);return chars(a[0]).length;
 case 'LOWER':arity(1);return capped(txt(a[0]).toLowerCase());
 case 'UPPER':arity(1);return capped(txt(a[0]).toUpperCase());
 case 'PROPER':{arity(1);let prev=false;return capped(chars(a[0]).map(ch=>{const letter=/\p{Alphabetic}/u.test(ch);const out=letter?(prev?ch.toLowerCase():ch.toUpperCase()):ch;prev=letter;return out;}).join(''));}
 case 'TRIM':arity(1);return txt(a[0]).split(' ').filter(Boolean).join(' ');
 case 'CLEAN':arity(1);return chars(a[0]).filter(c=>c.codePointAt(0)>=32).join('');
 case 'SUBSTITUTE':{arity(3,4);const s=txt(a[0]),old=txt(a[1]),to=txt(a[2]);if(!old)return s;const inst=a.length===4?cnt(a[3]):0;if(a.length===4&&!inst)fail();const pieces=s.split(old);let out='';for(let i=0;i<pieces.length;i++){out=capped(out+(i?(!inst||i===inst?to:old):'')+pieces[i]);}return out;}
 case 'REPLACE':case 'REPLACEB':{arity(4);if(num(a[1])<1)fail();const s=chars(a[0]),start=Math.min(cnt(a[1])-1,s.length),end=start+cnt(a[2]);return capped(s.slice(0,start).join('')+txt(a[3])+s.slice(end).join(''));}
 case 'REPT':{arity(2);const s=txt(a[0]),n=cnt(a[1]);if(Array.from(s).length*n>32767)fail();return s.repeat(n);}
 case 'FIND':case 'FINDB':case 'SEARCH':case 'SEARCHB':arity(2,3);return spreadsheetFind(txt(a[0]),txt(a[1]),a.length===3?num(a[2]):1,name.startsWith('SEARCH'));
 case 'EXACT':arity(2);return Number(txt(a[0])===txt(a[1]));
 case 'CHAR':{arity(1);const n=Math.trunc(num(a[0]));if(n<1||n>255)fail();return String.fromCodePoint(n>=128&&n<160?cp[n-128]:n);}
 case 'CODE':{arity(1);const c=txt(a[0]).codePointAt(0);if(c===undefined)fail();return c<128||(c>=160&&c<256)?c:cp.includes(c)?128+cp.indexOf(c):63;}
 case 'UNICHAR':{arity(1);const n=Math.trunc(num(a[0]));if(n<1||n>1114111)fail();if(n>=55296&&n<=57343)fail('#N/A');return String.fromCodePoint(n);}
 case 'UNICODE':arity(1);return txt(a[0]).codePointAt(0)??fail();
 case 'CONCAT':case 'CONCATENATE':{arity(1,255);let out='';for(const v of name==='CONCAT'?a.flat():a){out=capped(out+txt(v));}return out;}
 case 'TEXTJOIN':{arity(3,255);const delims=(Array.isArray(a[0])?a[0]:[a[0]]).map(txt),ignore=num(a[1])!==0,items=a.slice(2).flat().map(txt).filter(v=>!ignore||v!=='');let out='';for(let i=0;i<items.length;i++)out=capped(out+(i&&delims.length?delims[(i-1)%delims.length]:'')+items[i]);return out;}
 case 'T':arity(1);return typeof a[0]==='string'?a[0]:'';
 case 'ASC':case 'DBCS':case 'JIS':case 'PHONETIC':arity(1);return txt(a[0]);
 case 'VALUETOTEXT':{arity(1,2);const mode=Math.trunc(num(a[1]??0));if(mode!==0&&mode!==1)fail();return capped(mode&&typeof a[0]==='string'?'"'+a[0].replaceAll('"','""')+'"':txt(a[0]));}
 case 'TEXTBEFORE':case 'TEXTAFTER':{
 arity(2,6);const s=chars(a[0]),inst=Math.trunc(num(a[2]??1)),mode=Math.trunc(num(a[3]??0));if(!inst||Math.abs(inst)>Math.max(1,s.length)||(mode!==0&&mode!==1))fail();
 const fold=c=>mode?Array.from(c.toLowerCase())[0]:c;
 const t=s.map(fold),ds=(Array.isArray(a[1])?a[1]:[a[1]]).map(chars).filter(d=>d.length).map(d=>d.map(fold));let hits=[];
 const lengthAt=(start,end)=>ds.filter(d=>end===null?d.every((c,k)=>t[start+k]===c):end>=d.length&&d.every((c,k)=>t[end-d.length+k]===c)).reduce((m,d)=>Math.max(m,d.length),0);
 if(!ds.length)hits=Array.from({length:s.length+1},(_,i)=>[i,i]);
 else if(inst<0){let j=t.length;while(j>0){const n=lengthAt(null,j);if(n){hits.push([j-n,j]);j-=n;}else j--;}hits.reverse();}
 else{let i=0;while(i<t.length){const n=lengthAt(i,null);if(n){hits.push([i,i+n]);i+=n;}else i++;}}
 if(num(a[4]??0)!==0){if(inst>0&&hits.at(-1)?.[0]!==s.length)hits.push([s.length,s.length]);if(inst<0&&hits[0]?.[0]!==0)hits.unshift([0,0]);}
 const hit=inst>0?hits[inst-1]:hits[hits.length+inst];if(!hit)return a.length===6?a[5]:fail('#N/A');return (name==='TEXTBEFORE'?s.slice(0,hit[0]):s.slice(hit[1])).join('');}
 default:fail('#NAME?');
 }
}
