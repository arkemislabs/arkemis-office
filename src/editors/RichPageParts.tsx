import {storyEditorState} from '../../core/rich-page-parts.mjs';
import {Node,mergeAttributes} from '@tiptap/core';
import {EditorContent,useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import {TableKit} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import {useEffect,useRef,useState} from 'react';
import type {HeaderFooter,RichNode} from '../types';
import {TextStyle} from './TextStyle';
import {ParagraphFormatting} from './RichFormatting';
import {RichTableFormatting} from './RichTable';
import './rich-page-parts.css';

export const WordField=Node.create({name:'wordField',group:'inline',inline:true,atom:true,addAttributes(){return {kind:{default:'PAGE',parseHTML:element=>element.getAttribute('data-word-field')==='NUMPAGES'?'NUMPAGES':'PAGE'}};},parseHTML(){return [{tag:'span[data-word-field]'}];},renderHTML({node,HTMLAttributes}){return ['span',mergeAttributes(HTMLAttributes,{'data-word-field':node.attrs.kind,class:'rich-page-field',contenteditable:'false'}),node.attrs.kind==='NUMPAGES'?'[Total pages]':'[Page number]'];}});
export const PageBreak=Node.create({name:'pageBreak',priority:1000,group:'inline',inline:true,atom:true,selectable:true,parseHTML(){return [{tag:'span[data-page-break]'}];},renderHTML(){return ['span',{'data-page-break':'true',class:'rich-page-break',contenteditable:'false'},'Page break'];},addKeyboardShortcuts(){return {'Mod-Enter':()=>this.editor.commands.insertContent({type:'pageBreak'})};}});
export const emptyStory=():RichNode=>({type:'doc',content:[{type:'paragraph'}]});


export function HeaderFooterDialog({kind,value,onApply,onClose}:{kind:'headers'|'footers';value:HeaderFooter;onApply:(value:HeaderFooter)=>void;onClose:()=>void}){
 const [draft,setDraft]=useState<HeaderFooter>(()=>structuredClone(value));const [slot,setSlot]=useState<'default'|'first'|'even'>('default');const [error,setError]=useState('');const dialog=useRef<HTMLDialogElement>(null);const latest=useRef({draft,slot});latest.current={draft,slot};
 const editor=useEditor({extensions:[StarterKit.configure({link:{openOnClick:false}}),TextStyle,ParagraphFormatting,RichTableFormatting,TextAlign.configure({types:['paragraph','heading']}),TableKit,Image.configure({allowBase64:true}),WordField,PageBreak],content:value[kind]?.default??emptyStory(),editorProps:{attributes:{class:'rich-story-editor','aria-label':kind==='headers'?'Header content':'Footer content'}},onUpdate:({editor})=>{const current=latest.current;setDraft({...current.draft,[kind]:{...current.draft[kind],[current.slot]:editor.getJSON()}});}});
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const changeSlot=(next:'default'|'first'|'even')=>{setSlot(next);if(editor)editor.view.updateState(storyEditorState(editor.state,draft[kind]?.[next]??emptyStory()));};
 return <dialog ref={dialog} className="rich-story-dialog" aria-label={kind==='headers'?'Edit Header':'Edit Footer'} onCancel={e=>{e.preventDefault();onClose();}}><h2>{kind==='headers'?'Header':'Footer'}</h2><div className="rich-story-options"><label>Page variant<select aria-label="Header/footer page variant" value={slot} onChange={e=>changeSlot(e.target.value as typeof slot)}><option value="default">Default pages</option><option value="first">First page</option><option value="even">Even pages</option></select></label><label><input type="checkbox" checked={!!draft.differentFirstPage} onChange={e=>setDraft({...draft,differentFirstPage:e.target.checked})}/>Different First Page</label><label><input type="checkbox" checked={!!draft.evenAndOdd} onChange={e=>setDraft({...draft,evenAndOdd:e.target.checked})}/>Different Odd & Even Pages</label></div><div className="rich-story-tools"><button onClick={()=>editor?.chain().focus().toggleBold().run()}>Bold</button><button onClick={()=>editor?.chain().focus().toggleItalic().run()}>Italic</button>{(['left','center','right'] as const).map(align=><button key={align} onClick={()=>editor?.chain().focus().setTextAlign(align).run()}>{align}</button>)}<button onClick={()=>editor?.chain().focus().insertContent({type:'wordField',attrs:{kind:'PAGE'}}).run()}>Page Number</button><button onClick={()=>editor?.chain().focus().insertContent({type:'wordField',attrs:{kind:'NUMPAGES'}}).run()}>Total Pages</button><button onClick={()=>editor?.commands.undo()}>Undo</button><button onClick={()=>editor?.commands.redo()}>Redo</button></div><EditorContent editor={editor}/><p>Fields update when the .docx is paginated in a word processor. This view does not calculate page numbers.</p>{error&&<p role="alert">{error}</p>}<footer><button onClick={onClose}>Cancel</button><button onClick={()=>{if(!editor)return;try{onApply({...draft,[kind]:{...draft[kind],[slot]:editor.getJSON()}});onClose();}catch(e){setError(String(e));}}}>Apply {kind==='headers'?'Header':'Footer'}</button></footer></dialog>;
}
