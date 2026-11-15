import {createContext,useContext,useEffect,useRef,useState} from 'react';
import {FilePlus2,FolderOpen,Save,SaveAll,Printer,X,ArrowLeft,Link2} from 'lucide-react';
import {exportExtensions,extensionLabel} from '../core/file-formats.mjs';
import type {Kind} from './types';
import './office-file.css';

export type OfficeCommands={busy:boolean;fileActionCompleted:number;newFile?:()=>void;open:()=>void;save:()=>void;saveAs:()=>void;print:()=>void;close:()=>void;linkValue?:()=>void};
export const OfficeCommandsContext=createContext<OfficeCommands|null>(null);
export const useOfficeCommands=()=>useContext(OfficeCommandsContext);

export function FileCommands({onBack}:{onBack?:()=>void}){
 const commands=useOfficeCommands();
 if(!commands)return null;
 return <div className="office-file-commands" role="group" aria-label="File commands">
  {onBack&&<button className="ed-text-tool" onClick={onBack}><ArrowLeft size={16}/>Back</button>}
  {commands.newFile&&<button className="ed-text-tool" disabled={commands.busy} onClick={commands.newFile}><FilePlus2 size={18}/>New</button>}
  <button className="ed-text-tool" disabled={commands.busy} onClick={commands.open}><FolderOpen size={18}/>Open</button>
  <span className="office-file-divider"/>
  <button className="ed-text-tool" disabled={commands.busy} onClick={commands.save}><Save size={18}/>Save</button>
  <button className="ed-text-tool" disabled={commands.busy} onClick={commands.saveAs}><SaveAll size={18}/>Save As</button>
  <span className="office-file-divider"/>
  <button className="ed-text-tool" disabled={commands.busy} onClick={commands.print}><Printer size={18}/>Print</button>
  <button className="ed-text-tool" disabled={commands.busy} onClick={commands.close}><X size={18}/>Close</button>
 </div>;
}

export function LinkedValueCommand(){const commands=useOfficeCommands();return commands?.linkValue?<button className="ed-text-tool" onClick={commands.linkValue}><Link2 size={16}/>Link value</button>:null;}

export function SaveAsDialog({kind,busy,hasLinks,onSave,onClose}:{kind:Kind;busy:boolean;hasLinks:boolean;onSave:(format:string)=>void;onClose:()=>void}){
 const formats=exportExtensions(kind) as string[];
 const [format,setFormat]=useState(formats[0]);
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.querySelector<HTMLSelectElement>('select')?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><section ref={ref} className="modal office-save-as" role="dialog" aria-modal="true" aria-labelledby="save-as-title" onKeyDown={e=>{
  if(e.key==='Escape'){e.stopPropagation();if(!busy)onClose();}
  if(e.key==='Tab'){const items=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)')??[]);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}>
  <button className="modal-close icon-button" disabled={busy} aria-label="Close dialog" onClick={onClose}><X size={20}/></button>
  <h2 id="save-as-title">Save As</h2><p>Choose a file type, then choose a name and location.</p>
  <form onSubmit={e=>{e.preventDefault();onSave(format);}}><label className="office-save-format">File type<select aria-label="File type" disabled={busy} value={format} onChange={e=>setFormat(e.target.value)}>{formats.map(ext=><option key={ext} value={ext}>{extensionLabel(ext)}</option>)}</select></label>
  {hasLinks&&<p className="hint">Linked values are saved as a snapshot.</p>}
  <div className="dialog-actions"><button type="button" className="quiet-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={busy}>Save As…</button></div></form>
 </section></div>;
}

