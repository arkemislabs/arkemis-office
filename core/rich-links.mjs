// External-link insertion behavior adapted from WordCraft cmd/insert/links.rs,
// commit 3de6ff95af86c19d67030cd96dba15cd6a45a25e. See wordcraft-paragraphs.txt.
import {getMarkRange} from '@tiptap/core';
import {TextSelection} from '@tiptap/pm/state';
export function normalizeRichLink(value){
 if(typeof value!=='string'||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Enter a link of at most 4096 characters without control characters.');
 let url;try{url=new URL(value.trim());}catch{throw new Error('Enter a complete web, email or telephone link.');}
 if(!['https:','http:','mailto:','tel:'].includes(url.protocol)||!url.pathname&&['mailto:','tel:'].includes(url.protocol))throw new Error('Use an https, http, mailto or tel link.');
 return url.href;
}
export function linkSelection(state){
 const mark=state.schema.marks.link,{from,to,empty,$from}=state.selection;
 const range=empty&&mark?getMarkRange($from,mark):null;
 const start=range?.from??from,end=range?.to??to;
 const existing=mark?state.doc.resolve(start).nodeAfter?.marks.find(m=>m.type===mark):null;
 return {from:start,to:end,expectedText:state.doc.textBetween(start,end,'\n','\ufffc'),href:existing?.attrs.href??''};
}
export function linkTransaction(state,edit){
 const {from,to,expectedText}=edit,mark=state.schema.marks.link;
 if(!mark||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>state.doc.content.size||typeof expectedText!=='string'||state.doc.textBetween(from,to,'\n','\ufffc')!==expectedText)throw new Error('The selected text changed. Reopen the link dialog.');
 const tr=state.tr;
 if(edit.remove)return tr.removeMark(from,to,mark).setStoredMarks((state.storedMarks??[]).filter(m=>m.type!==mark));
 const href=normalizeRichLink(edit.href);
 if(from!==to)return tr.addMark(from,to,mark.create({href}));
 const label=edit.text||href;
 if(typeof label!=='string'||label.length>100000||/[\r\n]/.test(label))throw new Error('Link text must be a single line of at most 100000 characters.');
 const marks=(state.storedMarks??state.selection.$from.marks()).filter(m=>m.type!==mark);
 tr.insert(from,state.schema.text(label,[...marks,mark.create({href})]));
 return tr.setSelection(TextSelection.create(tr.doc,from+label.length)).setStoredMarks([]);
}
