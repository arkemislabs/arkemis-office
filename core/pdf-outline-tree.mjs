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
// Source-to-JS adaptation of https://github.com/storytold/pdfcraft/blob/3109bb2359759e24ef490e1cdbdba00722b20972/crates/organize/src/outline.rs
// Bounded Arkemis model adapter: stable IDs replace source child-index edit paths.

import {PDFName,PDFRef,PDFDict,PDFArray,PDFNumber,PDFString,PDFHexString} from 'pdf-lib';
import {validatePdfBookmarks} from './pdf-bookmarks.mjs';
const N=PDFName.of,fail=reason=>{throw new Error(`Bookmarks: ${reason}`);};
function reader(document,models){
 const ctx=document.context,sourcePages=document.getPages(),sources=new Map(),seen=new Set();let count=0,nameWork=0;
 const resolve=raw=>{const refs=new Set();while(raw instanceof PDFRef){const id=raw.toString();if(refs.has(id)||refs.size>=32)fail('reference cycle or excessive depth');refs.add(id);raw=ctx.lookup(raw);}return raw;};
 const text=raw=>{const value=resolve(raw);return value instanceof PDFString||value instanceof PDFHexString?value.decodeText():value instanceof PDFName?value.decodeText():null;};
 let names;
 const named=name=>{
  if(!names){names=new Map();const catalogNames=resolve(document.catalog.get(N('Names'))),tree=catalogNames instanceof PDFDict?catalogNames.get(N('Dests')):undefined,visited=new Set();
   const walk=(raw,depth)=>{if(++nameWork>200000||depth>32)fail('destination name tree exceeds limits');const d=resolve(raw);if(!(d instanceof PDFDict))return;if(visited.has(d))return;visited.add(d);const pairs=resolve(d.get(N('Names')));if(pairs instanceof PDFArray){nameWork+=pairs.size();if(nameWork>200000)fail('destination name tree exceeds limits');for(let i=0;i+1<pairs.size();i+=2){const k=text(pairs.get(i));if(k!==null&&!names.has(k))names.set(k,pairs.get(i+1));}}const kids=resolve(d.get(N('Kids')));if(kids instanceof PDFArray)for(let i=0;i<kids.size();i++)walk(kids.get(i),depth+1);};walk(tree,0);
  }
  if(names.has(name))return names.get(name);const old=resolve(document.catalog.get(N('Dests')));return old instanceof PDFDict?old.get(N(name)):undefined;
 };
 const target=(raw,depth=0)=>{if(depth>8)return null;const value=resolve(raw);if(value instanceof PDFDict)return target(value.get(N('D')),depth+1);if(value instanceof PDFArray){const page=value.get(0),sourceIndex=page instanceof PDFRef?sourcePages.findIndex(p=>p.ref.toString()===page.toString()):page instanceof PDFNumber?page.asNumber():-1;return Number.isInteger(sourceIndex)&&sourceIndex>=0&&sourceIndex<sourcePages.length?sourceIndex:null;}const name=text(value);return name!==null?target(named(name),depth+1):null;};
 const children=(first,path,depth)=>{if(depth>32)fail('hierarchy is too deep');const out=[];let raw=first;while(raw){const d=resolve(raw);if(!(d instanceof PDFDict))fail('malformed bookmark item');if(seen.has(d))fail('cycle or repeated bookmark');seen.add(d);if(++count>2000)fail('at most 2000 bookmarks are supported');const key=[...path,out.length].join('.');sources.set(key,d);const action=resolve(d.get(N('A'))),dest=d.get(N('Dest'))??(action instanceof PDFDict&&text(action.get(N('S')))==='GoTo'?action.get(N('D')):undefined),countValue=resolve(d.get(N('Count'))),targetIndex=target(dest),pageId=targetIndex===null?null:(models.find(p=>p.sourceIndex===targetIndex&&!p.duplicateOf)??models.find(p=>p.sourceIndex===targetIndex))?.id??null;out.push({id:`outline:${key}`,sourceKey:key,title:text(d.get(N('Title')))??'',pageId,...(targetIndex!==null&&pageId===null?{retarget:true}:{}),open:countValue instanceof PDFNumber?countValue.asNumber()>=0:true,children:children(d.get(N('First')),[...path,out.length],depth+1)});raw=d.get(N('Next'));}return out;};
 const root=resolve(document.catalog.get(N('Outlines'))),bookmarks=root instanceof PDFDict?children(root.get(N('First')),[],0):[];
 validatePdfBookmarks(bookmarks,models.map(p=>p.id));return {bookmarks,sources,root};
}
export function readPdfBookmarks(document,models){return reader(document,models).bookmarks;}
export function writePdfBookmarks(document,bookmarks,models){
 validatePdfBookmarks(bookmarks,models.map(p=>p.id));const {sources,root:oldRoot}=reader(document,models),ctx=document.context;
 // Validate source identity before any PDF objects are changed.
 const check=nodes=>{for(const node of nodes){if(node.sourceKey!==undefined&&!sources.has(node.sourceKey))fail('source bookmark no longer exists');check(node.children);}};check(bookmarks);
 if(!bookmarks.length){document.catalog.delete(N('Outlines'));return;}
 const root=oldRoot instanceof PDFDict?oldRoot.clone(ctx):ctx.obj({Type:'Outlines'}),rootRef=ctx.register(root);
 const build=(nodes,parent)=>{
  const entries=nodes.map(node=>{const original=node.sourceKey===undefined?undefined:sources.get(node.sourceKey),dict=original?original.clone(ctx):ctx.obj({});for(const name of ['First','Last','Next','Prev','Parent','Count'])dict.delete(N(name));dict.set(N('Title'),PDFHexString.fromText(node.title));dict.set(N('Parent'),parent);
   if(!original||node.retarget){dict.delete(N('A'));dict.delete(N('Dest'));if(node.pageId!==null){const index=models.findIndex(p=>p.id===node.pageId);dict.set(N('Dest'),ctx.obj([document.getPage(index).ref,N('Fit')]));}}
   return {node,dict,ref:ctx.register(dict)};});let visible=0;
  for(let i=0;i<entries.length;i++){const {node,dict,ref}=entries[i];if(i)dict.set(N('Prev'),entries[i-1].ref);if(i+1<entries.length)dict.set(N('Next'),entries[i+1].ref);const child=build(node.children,ref);if(child.first){dict.set(N('First'),child.first);dict.set(N('Last'),child.last);dict.set(N('Count'),PDFNumber.of(node.open?child.visible:-child.visible));}visible+=1+(node.open?child.visible:0);}
  return {first:entries[0]?.ref,last:entries.at(-1)?.ref,visible};
 };
 const tree=build(bookmarks,rootRef);root.set(N('First'),tree.first);root.set(N('Last'),tree.last);root.set(N('Count'),PDFNumber.of(tree.visible));document.catalog.set(N('Outlines'),rootRef);
}
