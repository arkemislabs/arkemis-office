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
// Source-to-JS port, PdfCraft 3109bb2359759e24ef490e1cdbdba00722b20972:
// https://github.com/storytold/pdfcraft/blob/3109bb2359759e24ef490e1cdbdba00722b20972/crates/cos/src/page_labels.rs
// https://github.com/storytold/pdfcraft/blob/3109bb2359759e24ef490e1cdbdba00722b20972/crates/organize/src/labels.rs
// Pure numbering, LabelStyle/LabelRange formatting and check_spans only.
// Does NOT parse/write PDF object trees. JS boundaries reject unsafe numbers;
// BigInt is accepted for u64 numeral helpers. PDF style names: D,R,r,A,a,null.
export const MAX_PDF_LABEL_BYTES=1024;
const MAX_RANGES=200000,U32=4294967295,U64=18446744073709551615n;
const encoder=new TextEncoder(),styles=['D','R','r','A','a',null];
function invalid(reason){throw new RangeError(`Page labels could not be processed: ${reason}`);}
function integer(n,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(n)||n<0||n>max)invalid('invalid nonnegative integer');return n;}
function u64(n){if(typeof n==='number'){integer(n);n=BigInt(n);}if(typeof n!=='bigint'||n<0n||n>U64)invalid('number exceeds unsigned 64-bit range');return n;}
function budget(max){integer(max);return Math.min(max,MAX_PDF_LABEL_BYTES);}
export function romanPdfLabel(value,maxBytes=MAX_PDF_LABEL_BYTES){
 let n=u64(value),out='';const max=budget(maxBytes);
 for(const [amount,part] of [[1000n,'m'],[900n,'cm'],[500n,'d'],[400n,'cd'],[100n,'c'],[90n,'xc'],[50n,'l'],[40n,'xl'],[10n,'x'],[9n,'ix'],[5n,'v'],[4n,'iv'],[1n,'i']]){
  const count=n/amount;if(count*BigInt(part.length)>BigInt(max-out.length))return null;
  out+=part.repeat(Number(count));n%=amount;
 }return out;
}
export function alphaPdfLabel(value,maxBytes=MAX_PDF_LABEL_BYTES){
 const original=u64(value),n=(original<1n?1n:original)-1n,count=n/26n+1n;
 if(count>BigInt(budget(maxBytes)))return null;
 return String.fromCharCode(97+Number(n%26n)).repeat(Number(count));
}
export function formatPdfLabel(style,n,maxBytes=MAX_PDF_LABEL_BYTES){
 if(!styles.includes(style))invalid('unknown numbering style');integer(n,U32);const max=budget(maxBytes);
 let value=style===null?'':style==='D'?String(n):style.toLowerCase()==='r'?romanPdfLabel(n,max):alphaPdfLabel(n,max);
 if(value===null||value.length>max)invalid('a label exceeds its UTF-8 byte budget');
 if(style==='R'||style==='A')value=value.toUpperCase();return value;
}
export function previewPdfLabel(style,n){
 if(!styles.includes(style))invalid('unknown numbering style');integer(n,U32);
 try{return formatPdfLabel(style,n);}catch{return String(n);}
}
function rangeNumber(range,page){
 if(range.style===null)return range.first;
 if(page<range.start)invalid('page precedes numbering range');
 const value=range.first+page-range.start;integer(value,U32);return value;
}
function rangeLabel(range,page){
 const size=encoder.encode(range.prefix).length;if(size>MAX_PDF_LABEL_BYTES)invalid('a prefix exceeds 1024 UTF-8 bytes');
 return range.prefix+formatPdfLabel(range.style,rangeNumber(range,page),MAX_PDF_LABEL_BYTES-size);
}
function checkedRange(range){
 if(!range||!styles.includes(range.style)||typeof range.prefix!=='string')invalid('invalid label range');
 integer(range.start);integer(range.first,U32);if(!range.first)invalid('first number must be positive');
 rangeLabel(range,range.start);return {...range};
}
function romanLength(n){const digits=[0,1,2,3,2,1,2,3,4,2];return Math.floor(n/1000)+digits[Math.floor(n/100)%10]+digits[Math.floor(n/10)%10]+digits[n%10];}
export function longestRomanLength(lo,hi){
 integer(lo,U32);integer(hi,U32);if(lo>hi)invalid('reversed numeral span');
 const first=Math.floor(lo/1000),last=Math.floor(hi/1000);let max=0;
 if(first===last){for(let n=lo;n<=hi;n++)max=Math.max(max,romanLength(n));return max;}
 for(let n=lo;n<=first*1000+999;n++)max=Math.max(max,romanLength(n));
 for(let n=last*1000;n<=hi;n++)max=Math.max(max,romanLength(n));
 return Math.max(max,last-first>=2?last-1+12:0);
}
/** Strict edit validation, bounded by ranges and at most 2,000 Roman candidates per span. */
export function validatePdfLabelRanges(ranges,pageCount){
 integer(pageCount);if(!Array.isArray(ranges)||ranges.length>=MAX_RANGES)invalid('too many label ranges');
 let prefixBytes=0;
 const sorted=ranges.map(range=>{const checked=checkedRange(range);prefixBytes+=encoder.encode(checked.prefix).length;if(prefixBytes>4*1024*1024)invalid('decoded prefixes exceed 4 MiB in total');return checked;}).sort((a,b)=>a.start-b.start);
 for(let i=0;i<sorted.length;i++){
  const r=sorted[i];if(i&&sorted[i-1].start===r.start)invalid('range start pages must be unique');
  if(r.start>=pageCount||r.style===null)continue;
  const end=Math.min(pageCount-1,sorted[i+1]?sorted[i+1].start-1:pageCount-1),hi=r.first+end-r.start;
  // Same error ordering as upstream: length before u32 overflow.
  const upper=Math.min(U32,hi),length=r.style==='D'?String(upper).length:r.style.toLowerCase()==='a'?Math.floor((upper-1)/26)+1:longestRomanLength(r.first,upper);
  if(length>MAX_PDF_LABEL_BYTES-encoder.encode(r.prefix).length)invalid('a label exceeds 1024 UTF-8 bytes');
  if(hi>U32)invalid('a page number overflows');
 }
 return sorted;
}
/** Single-label query; caller supplies sorted unique ranges (validate once before repeated queries). */
export function labelAt(ranges,page,pageCount){
 integer(pageCount);integer(page);if(page>=pageCount)invalid('no such page');
 if(!Array.isArray(ranges)||ranges.length>=MAX_RANGES)invalid('invalid ranges');
 let lo=0,hi=ranges.length;
 while(lo<hi){const middle=Math.floor((lo+hi)/2);if(ranges[middle].start<=page)lo=middle+1;else hi=middle;}
 const value=lo?rangeLabel(checkedRange(ranges[lo-1]),page):'';
 return value||String(page+1);
}

/** Port of organize/labels.rs::number_pages; preserves labels after the edited interval. */
export function numberPdfPages(ranges,pageCount,from,to,style,prefix,first=1){
 integer(from);integer(to);integer(first,U32);if(from>to||to>=pageCount)invalid('numbering range is outside the document');
 const old=validatePdfLabelRanges(ranges,pageCount),defaultRange={start:0,style:'D',prefix:'',first:1};
 if(!old.length||old[0].start>0)old.unshift(defaultRange);
 const next=old.filter(r=>r.start<from);next.push({start:from,style,prefix,first:Math.max(1,first)});
 if(to+1<pageCount){const previous=old.findLast(r=>r.start<=to+1);next.push({...previous,start:to+1,first:rangeNumber(previous,to+1)});next.push(...old.filter(r=>r.start>to+1));}
 const merged=[];
 for(const r of next){const last=merged.at(-1);if(!last||last.style!==r.style||last.prefix!==r.prefix||last.first+r.start-last.start!==r.first)merged.push(r);}
 if(merged.length===1&&merged[0].start===0&&merged[0].style==='D'&&merged[0].prefix===''&&merged[0].first===1)return [];
 return validatePdfLabelRanges(merged,pageCount);
}
/** Port of drop_deleted_pages: ranges follow their first remaining page, numbering closes gaps. */
export function dropDeletedPdfLabelPages(ranges,deleted,newPageCount){
 const removed=[...new Set(deleted)].sort((a,b)=>a-b);for(const p of removed)integer(p);
 const next=[];for(const r of ranges){const start=Math.max(0,r.start-removed.filter(p=>p<r.start).length),value={...r,start};if(next.at(-1)?.start===start)next[next.length-1]=value;else next.push(value);}
 return validatePdfLabelRanges(next,newPageCount);
}
