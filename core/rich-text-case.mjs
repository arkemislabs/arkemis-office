// JavaScript translation of WordCraft convert_chars/convert_title_char/convert_sentence_char.
// Source: storytold/wordcraft 3de6ff95af86c19d67030cd96dba15cd6a45a25e,
// crates/engine/src/cmd/format.rs. MIT notice: assets/third-party-licenses/wordcraft-case.txt.
// The ProseMirror transaction adapter below is original Arkemis code.
import {TextSelection} from '@tiptap/pm/state';
const modes=new Set(['sentence','lower','upper','title','toggle']);
const alphabetic=c=>!!c&&/\p{Alphabetic}/u.test(c);
export function convertCaseCharacters(text,mode,paragraphStart=true,turkic=[]){
 if(typeof text!=='string'||!modes.has(mode))throw new Error('Invalid change case request');
 if(text.length>1000000)throw new Error('Selection is too large to change case');
 const chars=Array.from(text);let up=mode==='title'||paragraphStart;
 const upper=(c,i)=>turkic[i]&&c==='i'?'İ':c.toUpperCase();
 const lower=(c,i)=>c==='Σ'&&alphabetic(chars[i-1])&&!alphabetic(chars[i+1])?'ς':turkic[i]&&c==='I'?'ı':turkic[i]&&c==='İ'?'i':c.toLowerCase();
 return chars.map((c,i)=>{
  if(mode==='upper')return upper(c,i);if(mode==='lower')return lower(c,i);
  if(mode==='toggle')return /\p{Uppercase}/u.test(c)?lower(c,i):upper(c,i);
  let result;if(up&&alphabetic(c)){up=false;result=upper(c,i);}else result=lower(c,i);
  if(mode==='title'){if(/\p{White_Space}/u.test(c))up=true;}
  else if(c==='!'||c==='?'||(c==='.'&&!(/^[0-9]$/.test(chars[i-1]??'')&&/^[0-9]$/.test(chars[i+1]??''))))up=true;
  return result;
 });
}
function boundary(text,n){return !(n>0&&n<text.length&&/[\uD800-\uDBFF]/.test(text[n-1])&&/[\uDC00-\uDFFF]/.test(text[n]));}
export function changeTextCaseTransaction(state,mode){
 if(!modes.has(mode))throw new Error('Invalid change case request');
 const {from,to,empty}=state.selection;if(empty)return null;
 if(to-from>1000000)throw new Error('Selection is too large to change case');
 const changes=[];
 state.doc.nodesBetween(from,to,(block,pos)=>{
  if(!block.isTextblock)return;
  const parts=[];let text='';
  block.forEach((node,offset)=>{
   const start=pos+1+offset,end=start+node.nodeSize;
   if(end<=from||start>=to)return;
   if(!node.isText){text+=node.type.name==='hardBreak'?'\n':'\uFFFC';parts.push(null);return;}
   const a=Math.max(0,from-start),b=Math.min(node.text.length,to-start);
   if(!boundary(node.text,a)||!boundary(node.text,b))throw new Error('Selection splits a Unicode character');
   const selected=node.text.slice(a,b);text+=selected;parts.push({from:start+a,to:start+b,text:selected,marks:node.marks});
  });
  const converted=convertCaseCharacters(text,mode,from<=pos+1);let index=0;
  for(const part of parts){if(!part){index++;continue;}const length=Array.from(part.text).length,replacement=converted.slice(index,index+length).join('');index+=length;if(replacement!==part.text)changes.push({...part,replacement});}
  return false;
 });
 if(!changes.length)return null;
 const tr=state.tr;for(const part of changes.reverse())tr.replaceWith(part.from,part.to,state.schema.text(part.replacement,part.marks));
 tr.setSelection(TextSelection.create(tr.doc,tr.mapping.map(from,-1),tr.mapping.map(to,1)));
 return tr.scrollIntoView();
}
