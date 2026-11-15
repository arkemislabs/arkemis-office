/*
MIT License

Copyright (c) 2026 ArtCraft Team and the PdfCraft contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Source-to-JavaScript adaptation of PdfCraft, pinned 3109bb2359759e24ef490e1cdbdba00722b20972.
// https://github.com/storytold/pdfcraft/blob/3109bb2359759e24ef490e1cdbdba00722b20972/crates/print/src/range.rs
// Organization parse/format: crates/ui-egui/src/panels/page_selection_ui.rs at the same revision.
// Adaptations: typed JS boundary errors; 16 KiB input and 1M expansion bounds also apply to print.
// All outputs are ZERO-BASED CURRENT PAGE POSITIONS, never sourceIndex values or page IDs.
const MAX_INPUT_BYTES=16_384, MAX_EXPANSION=1_000_000;
export class PdfPageSelectionError extends Error {
 constructor(code,message){super(message);this.name='PdfPageSelectionError';this.code=code;}
}
const fail=(code,message)=>{throw new PdfPageSelectionError(code,message);};
function validCount(count){if(!Number.isSafeInteger(count)||count<0)fail('INVALID_INPUT','Page count must be a nonnegative safe integer.');}
function validText(text){if(typeof text!=='string')fail('INVALID_INPUT','Page range must be text.');if(new TextEncoder().encode(text).length>MAX_INPUT_BYTES)fail('LIMIT_EXCEEDED','Page range is too long.');}
function options(value={}){
 const {labels=[],subset='all',reverse=false}=value;
 if(!Array.isArray(labels)||labels.some(label=>typeof label!=='string')||!['all','odd','even'].includes(subset)||typeof reverse!=='boolean')fail('INVALID_INPUT','Invalid page selection options.');
 return {labels,subset,reverse};
}
function number(token,count){
 const value=token.trim();
 if(!/^\+?[0-9]+$/.test(value))fail('NOT_A_PAGE',`Not a page: ${value.slice(0,80)}`);
 const n=Number(value);
 if(!Number.isSafeInteger(n)||n<1||n>count)fail('OUT_OF_RANGE',`Page ${value.slice(0,80)} is outside 1-${count}.`);
 return n-1;
}
function expand(out,from,to,budget){
 const size=Math.abs(to-from)+1;
 if(size>budget.left)fail('LIMIT_EXCEEDED','Page selection expands to too many entries.');
 budget.left-=size;
 const step=from<=to?1:-1;
 for(let i=0;i<size;i++)out.push(from+i*step);
}
function narrow(pages,subset,reverse){
 const out=subset==='all'?pages:pages.filter(p=>p%2===(subset==='odd'?0:1));
 if(reverse)out.reverse();
 if(!out.length)fail('NO_PAGES','No pages match this selection.');
 return out;
}
/** Print/export ordering: repeats and descending ranges retained; blank means all. */
export function selectPdfPages(count,range=null,settings={}){
 validCount(count);const {labels,subset,reverse}=options(settings);
 if(labels.length>count)fail('INVALID_INPUT','Page labels exceed the document page count.');
 if(range!==null)validText(range);
 const labelIndex=new Map();for(let i=0;i<labels.length;i++)if(!labelIndex.has(labels[i]))labelIndex.set(labels[i],i);
 const pageOf=token=>{const t=token.trim();return labelIndex.has(t)?labelIndex.get(t):number(t,count);};
 const end=()=>{if(!count)fail('NO_PAGES','The document has no pages.');return count-1;};
 const out=[],budget={left:MAX_EXPANSION};
 if(range===null||!range.trim()){
  if(count)expand(out,0,count-1,budget);
 }else for(const part of range.split(/[,;]/).map(p=>p.trim()).filter(Boolean)){
  if(labelIndex.has(part)){expand(out,pageOf(part),pageOf(part),budget);continue;}
  let resolved=false;
  // Try every hyphen only when one complete endpoint is a hyphenated label.
  for(let at=part.indexOf('-');at>=0;at=part.indexOf('-',at+1)){
   const first=part.slice(0,at).trim(),last=part.slice(at+1).trim();
   if(![first,last].some(t=>t.includes('-')&&labelIndex.has(t)))continue;
   let from,to;
   try{from=first?pageOf(first):0;to=last?pageOf(last):end();}catch(error){if(error instanceof PdfPageSelectionError)continue;throw error;}
   expand(out,from,to,budget);resolved=true;break;
  }
  if(resolved)continue;
  const at=part.indexOf('-');
  if(at<0){const p=pageOf(part);expand(out,p,p,budget);}
  else {const first=part.slice(0,at).trim(),last=part.slice(at+1).trim();expand(out,first?pageOf(first):0,last?pageOf(last):end(),budget);}
 }
 return narrow(out,subset,reverse);
}
/** Explicit current positions: labels never remap them. Input is not mutated. */
export function selectListedPdfPages(count,pages,settings={}){
 validCount(count);const {subset,reverse}=options(settings);
 if(!Array.isArray(pages))fail('INVALID_INPUT','Selected pages must be an array.');
 if(pages.length>MAX_EXPANSION)fail('LIMIT_EXCEEDED','Too many selected pages.');
 for(const p of pages)if(!Number.isSafeInteger(p)||p<0||p>=count)fail('OUT_OF_RANGE','A selected page is outside the document.');
 return narrow([...pages],subset,reverse);
}
/** Organize Pages: strict physical numbers; blank clears; output sorted/unique. */
export function parsePdfPageSelection(text,count){
 validCount(count);validText(text);if(!text.trim())return [];
 const expanded=[],budget={left:MAX_EXPANSION};
 for(const part of text.split(/[,;]/).map(p=>p.trim())){
  const at=part.indexOf('-');
  const a=number(at<0?part:part.slice(0,at),count),b=at<0?a:number(part.slice(at+1),count);
  expand(expanded,Math.min(a,b),Math.max(a,b),budget);
 }
 return [...new Set(expanded)].sort((a,b)=>a-b);
}
/** Compact organization display; arbitrary order/duplicates are normalized. */
export function formatPdfPageSelection(pages){
 if(!Array.isArray(pages)||pages.some(p=>!Number.isSafeInteger(p)||p<0||p>=Number.MAX_SAFE_INTEGER))fail('INVALID_INPUT','Invalid page positions.');
 if(pages.length>MAX_EXPANSION)fail('LIMIT_EXCEEDED','Too many selected pages.');
 const sorted=[...new Set(pages)].sort((a,b)=>a-b),parts=[];
 for(let i=0;i<sorted.length;i++){
  const first=sorted[i];let last=first;
  while(i+1<sorted.length&&sorted[i+1]===last+1)last=sorted[++i];
  parts.push(first===last?String(first+1):`${first+1}-${last+1}`);
 }
 return parts.join(', ');
}
