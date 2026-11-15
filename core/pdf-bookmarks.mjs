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

const fail=message=>{throw new Error(`Bookmarks: ${message}`);};
export function validatePdfBookmarks(bookmarks,pageIds){
 if(!Array.isArray(bookmarks))fail('expected a bookmark list');const ids=new Set(),sources=new Set(),seen=new Set(),pages=new Set(pageIds);let count=0,bytes=0;
 const visit=(nodes,depth)=>{if(depth>32)fail('hierarchy is too deep');for(const node of nodes){if(!node||seen.has(node))fail('cycle or repeated bookmark');seen.add(node);if(++count>2000)fail('at most 2000 bookmarks are supported');
  if(typeof node.id!=='string'||!node.id||node.id.length>120||ids.has(node.id))fail('invalid or duplicate ID');ids.add(node.id);
  if(typeof node.title!=='string'||node.title.length>4096)fail('title is too long');bytes+=new TextEncoder().encode(node.title).length;if(bytes>1024*1024)fail('titles exceed 1 MiB');
  if(typeof node.open!=='boolean'||!Array.isArray(node.children)||!(node.pageId===null||pages.has(node.pageId)))fail('invalid bookmark target or children');
  if(node.sourceKey!==undefined){if(typeof node.sourceKey!=='string'||!/^\d+(\.\d+)*$/.test(node.sourceKey)||node.sourceKey.length>200||sources.has(node.sourceKey))fail('invalid or duplicate source identity');sources.add(node.sourceKey);}
  if(node.retarget!==undefined&&node.retarget!==true)fail('invalid destination change flag');visit(node.children,depth+1);
 }};visit(bookmarks,0);return bookmarks;
}
export function applyPdfBookmarkOperation(bookmarks,operation,pageIds){
 validatePdfBookmarks(bookmarks,pageIds);const next=structuredClone(bookmarks);
 const find=(nodes,id,parent=null)=>{for(let i=0;i<nodes.length;i++){if(nodes[i].id===id)return {node:nodes[i],siblings:nodes,index:i,parent};const found=find(nodes[i].children,id,nodes[i]);if(found)return found;}return null;};
 const title=value=>{if(typeof value!=='string'||!value.trim()||value.length>4096)fail('title must not be empty and must fit within 4096 characters');return value;};
 const parentList=id=>{if(id==null)return next;const parent=find(next,id);if(!parent)fail('parent bookmark does not exist');return parent.node.children;};
 if(operation.type==='bookmark-add'){
  const siblings=parentList(operation.parentId),node={id:operation.newBookmarkId??globalThis.crypto.randomUUID(),title:title(operation.title),open:true,pageId:operation.targetPageId??null,retarget:true,children:[]};
  const at=operation.toIndex??siblings.length;if(!Number.isInteger(at)||at<0||at>siblings.length)fail('invalid bookmark position');siblings.splice(at,0,node);
 }else{
  const found=find(next,operation.bookmarkId);if(!found)fail('bookmark does not exist');const {node,siblings,index}=found;
  if(operation.type==='bookmark-delete')siblings.splice(index,1);
  else if(operation.type==='bookmark-update'){
   const patch=operation.patch??{};if(Object.keys(patch).some(key=>!['title','open','pageId'].includes(key)))fail('unsupported bookmark property');
   if(Object.hasOwn(patch,'title'))node.title=title(patch.title);if(Object.hasOwn(patch,'open'))node.open=patch.open;if(Object.hasOwn(patch,'pageId')){node.pageId=patch.pageId;node.retarget=true;}
  }else if(operation.type==='bookmark-move'){
   if(operation.parentId===node.id||find(node.children,operation.parentId))fail('cannot move a bookmark into itself or its descendant');
   const destination=parentList(operation.parentId),at=operation.toIndex;
   if(!Number.isInteger(at)||at<0||at>destination.length-(destination===siblings?1:0))fail('invalid bookmark position');
   siblings.splice(index,1);destination.splice(at,0,node);
  }else fail('unsupported operation');
 }
 return validatePdfBookmarks(next,pageIds);
}
export function clearDeletedBookmarkTargets(bookmarks,pageId){return bookmarks.map(node=>({...node,...(node.pageId===pageId?{pageId:null,retarget:true}:{}),children:clearDeletedBookmarkTargets(node.children,pageId)}));}
