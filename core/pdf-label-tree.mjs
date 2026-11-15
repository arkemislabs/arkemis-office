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
// Translated organize/labels.rs read_label_node/checked_ranges/set_page_label_ranges.
// Source: https://github.com/storytold/pdfcraft/blob/3109bb2359759e24ef490e1cdbdba00722b20972/crates/organize/src/labels.rs
// PDF object hosting uses pdf-lib; writes retain the existing catalog and unrelated objects.
import {PDFName,PDFRef,PDFDict,PDFArray,PDFNumber,PDFString,PDFHexString} from 'pdf-lib';
import {validatePdfLabelRanges} from './pdf-page-labels.mjs';
const key=PDFName.of,encoder=new TextEncoder();
const fail=reason=>{throw new Error(`Page labels could not be processed: ${reason}`);};
export function readPdfLabelRanges(document){
 const context=document.context,root=document.catalog.get(key('PageLabels'));if(!root)return [];
 const entries=[],seen=new Set();let work=200000,prefixBudget=4<<20;
 const spend=n=>{work-=n;if(work<0)fail('number tree has too many entries');};
 const resolve=value=>{const refs=new Set();while(value instanceof PDFRef){const id=value.toString();if(refs.has(id)||refs.size>=32)fail('number tree reference cycle or excessive depth');refs.add(id);value=context.lookup(value);}return value;};
 const walk=(raw,depth)=>{
  spend(1);if(depth>32)fail('number tree is too deep');
  if(raw instanceof PDFRef){const id=raw.toString();if(seen.has(id))fail('number tree repeats a node or contains a cycle');seen.add(id);}
  const node=resolve(raw);if(!(node instanceof PDFDict))return;
  const nums=resolve(node.get(key('Nums')));
  if(nums instanceof PDFArray){spend(Math.ceil(nums.size()/2));for(let i=0;i+1<nums.size();i+=2){
   const startObject=nums.get(i),start=startObject instanceof PDFNumber?startObject.asNumber():-1;if(!Number.isSafeInteger(start)||start<0)continue;
   const spec=resolve(nums.get(i+1));if(!(spec instanceof PDFDict))continue;
   const rawPrefix=resolve(spec.get(key('P')));let prefix='';
   if(rawPrefix instanceof PDFString||rawPrefix instanceof PDFHexString){if(rawPrefix.asBytes().length>2050)fail('raw prefix exceeds 2050 bytes');prefix=rawPrefix.decodeText();}
   const bytes=encoder.encode(prefix).length;if(bytes>1024)fail('decoded prefix exceeds 1024 UTF-8 bytes');prefixBudget-=bytes;if(prefixBudget<0)fail('decoded prefixes exceed 4 MiB');
   const rawStyle=resolve(spec.get(key('S'))),name=rawStyle instanceof PDFName?rawStyle.decodeText():null,style=['D','R','r','A','a'].includes(name)?name:null;
   const rawFirst=resolve(spec.get(key('St')));let first=rawFirst instanceof PDFNumber?rawFirst.asNumber():1;
   first=Number.isInteger(first)?Math.max(1,first):1;if(style===null)first=Math.min(4294967295,first);if(!Number.isSafeInteger(first)||first>4294967295)fail('first number exceeds supported integer range');
   entries.push({start,style,prefix,first});
  }}
  const kids=resolve(node.get(key('Kids')));if(kids instanceof PDFArray){spend(kids.size());if(kids.size()&&depth===32)fail('number tree is too deep');for(let i=0;i<kids.size();i++)walk(kids.get(i),depth+1);}
 };
 walk(root,0);const unique=new Map();for(const range of entries.sort((a,b)=>a.start-b.start))unique.set(range.start,range);return [...unique.values()];
}
export function writePdfLabelRanges(document,ranges){
 const sorted=validatePdfLabelRanges(ranges,document.getPageCount());
 if(!sorted.length){document.catalog.delete(key('PageLabels'));return;}
 const nums=[];for(const r of sorted){const spec=document.context.obj({});if(r.style)spec.set(key('S'),key(r.style));if(r.prefix)spec.set(key('P'),PDFHexString.fromText(r.prefix));if(r.first!==1)spec.set(key('St'),PDFNumber.of(r.first));nums.push(PDFNumber.of(r.start),document.context.register(spec));}
 document.catalog.set(key('PageLabels'),document.context.register(document.context.obj({Nums:nums})));
}
