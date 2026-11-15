import {useEffect,useRef,useState} from 'react';
import type {Editor} from '@tiptap/core';
import {closeHistory} from '@tiptap/pm/history';
import {linkSelection,linkTransaction} from '../../core/rich-links.mjs';
export function removeRichLink(editor:Editor){const tr=linkTransaction(editor.state,{...linkSelection(editor.state),remove:true});editor.view.dispatch(closeHistory(tr));editor.view.dispatch(closeHistory(editor.state.tr));editor.commands.focus();}
export function RichLinkDialog({editor,onClose}:{editor:Editor;onClose:()=>void}){
 const [snapshot]=useState(()=>({range:linkSelection(editor.state),doc:editor.state.doc})),[href,setHref]=useState(snapshot.range.href),[label,setLabel]=useState(snapshot.range.expectedText),[error,setError]=useState('');
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();dialog.current?.querySelector<HTMLInputElement>('[aria-label="Link URL"]')?.focus();},[]);
 const close=()=>{onClose();requestAnimationFrame(()=>{if(!editor.isDestroyed)editor.commands.focus();});};
 return <dialog ref={dialog} className="rich-link-dialog" aria-label={snapshot.range.href?'Edit Hyperlink':'Insert Hyperlink'} onCancel={e=>{e.preventDefault();close();}}><h2>{snapshot.range.href?'Edit Hyperlink':'Insert Hyperlink'}</h2><form onSubmit={e=>{e.preventDefault();try{if(editor.state.doc!==snapshot.doc)throw new Error('The document changed. Close and reopen the link dialog.');const tr=linkTransaction(editor.state,{...snapshot.range,href,text:label});editor.view.dispatch(closeHistory(tr));editor.view.dispatch(closeHistory(editor.state.tr));close();}catch(e){setError(e instanceof Error?e.message:String(e));}}}>
  <label>Text to display<input aria-label="Link text" maxLength={100000} value={label} readOnly={snapshot.range.from!==snapshot.range.to} placeholder="Uses the address if left empty" onChange={e=>setLabel(e.target.value)}/></label>
  <label>Address<input aria-label="Link URL" maxLength={4096} value={href} placeholder="https://example.com" onChange={e=>setHref(e.target.value)}/></label>
  {snapshot.range.from!==snapshot.range.to&&<p>Selected text keeps its formatting. Edit the address here.</p>}{error&&<p role="alert">{error}</p>}
  <footer>{snapshot.range.href&&<button type="button" onClick={()=>{try{if(editor.state.doc!==snapshot.doc)throw new Error('The document changed. Close and reopen the link dialog.');removeRichLink(editor);close();}catch(e){setError(e instanceof Error?e.message:String(e));}}}>Remove link</button>}<button type="button" onClick={close}>Cancel</button><button type="submit">Apply link</button></footer>
 </form></dialog>;
}
