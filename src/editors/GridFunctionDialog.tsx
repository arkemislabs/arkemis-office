import {useMemo,useState} from 'react';
import {gridFormulaCatalog} from '../../core/grid-formula-catalog.mjs';
import './pivots.css';
// Flow translated from GridCraft ui-egui/src/dialogs/insert_function.rs:
// search names/descriptions, select a result, inspect signature, begin =NAME( editing.
export default function GridFunctionDialog({onConfirm,onClose}:{onConfirm:(name:string)=>void;onClose:()=>void}){
 const [search,setSearch]=useState(''),[index,setIndex]=useState(0);
 const hits=useMemo(()=>gridFormulaCatalog.filter(f=>(f.name+' '+f.description).toLowerCase().includes(search.toLowerCase())).slice(0,300),[search]);const selected=hits[Math.min(index,hits.length-1)];
 return <div className="grid-pivot-backdrop"><form className="grid-pivot-dialog grid-function-dialog" role="dialog" aria-modal="true" aria-label="Insert Function" onSubmit={e=>{e.preventDefault();if(selected)onConfirm(selected.name);}} onKeyDown={e=>{
  if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setIndex(i=>Math.max(0,Math.min(hits.length-1,i+(e.key==='ArrowDown'?1:-1))));}
  if(e.key==='Tab'){const controls=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select')],first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}><h2>Insert Function</h2><label>Search:<input autoFocus aria-label="Search functions" placeholder="e.g. lookup, average, date" value={search} onChange={e=>{setSearch(e.target.value);setIndex(0);}}/></label>
 <div className="grid-function-list" role="listbox" aria-label="Functions">{hits.map((f,i)=><button type="button" role="option" aria-selected={f===selected} key={f.name} onClick={()=>setIndex(i)} onDoubleClick={()=>onConfirm(f.name)}><strong>{f.name}</strong><span>{f.family}</span></button>)}</div>
 {selected?<div className="grid-function-description"><strong>{selected.signature}</strong><p>{selected.description}</p></div>:<p>No matching functions</p>}<footer><button type="submit" disabled={!selected}>OK</button><button type="button" onClick={onClose}>Cancel</button></footer></form></div>;
}
