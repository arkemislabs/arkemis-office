import {useEffect,useRef,useState} from 'react';
import type {SlideElement} from '../types';
import {sizePositionElements} from '../../core/prism-size-position.mjs';
import './prism-size-dialog.css';
type Spec={x?:number;y?:number;w?:number;h?:number;rot?:number;scaleW?:number;scaleH?:number;lockAspect?:boolean};
const factors={in:72,cm:72/2.54,pt:1};
const shown=(n:number)=>String(Math.round(n*1000000)/1000000);
export default function PrismSizeDialog({element,count,onApply,onClose}:{element:SlideElement;count:number;onApply:(spec:Spec)=>void;onClose:()=>void}){
 const [unit,setUnit]=useState<keyof typeof factors>('in'),[spec,setSpec]=useState<Spec>({}),[error,setError]=useState('');const ref=useRef<HTMLFormElement>(null);
 const [values,setValues]=useState<Record<string,string>>({x:shown(element.x/72),y:shown(element.y/72),w:shown(element.w/72),h:shown(element.h/72),rot:shown(element.rotation??0),scaleW:'100',scaleH:'100'});
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
 const renderValues=(next:SlideElement,nextUnit=unit)=>({x:shown(next.x/factors[nextUnit]),y:shown(next.y/factors[nextUnit]),w:shown(next.w/factors[nextUnit]),h:shown(next.h/factors[nextUnit]),rot:shown(next.rotation??0),scaleW:shown(next.w/element.w*100),scaleH:shown(next.h/element.h*100)});
 const change=(key:string,value:string)=>{
  setValues(v=>({...v,[key]:value}));if(value.trim()===''||!Number.isFinite(Number(value))){setError('Enter a number for every field.');return;}
  const next={...spec,[key]:Number(value)*(['x','y','w','h'].includes(key)?factors[unit]:1)};
  if(spec.lockAspect){if(['w','scaleW'].includes(key)){delete next.h;delete next.scaleH;}if(['h','scaleH'].includes(key)){delete next.w;delete next.scaleW;}}
  if(key==='w')delete next.scaleW;if(key==='h')delete next.scaleH;if(key==='scaleW')delete next.w;if(key==='scaleH')delete next.h;
  try{const preview=sizePositionElements([element],[element.id],next)[0];setSpec(next);setValues({...renderValues(preview),[key]:value});setError('');}catch(e){setError((e as Error).message);}
 };
 const field=(key:string,label:string,min?:number,max?:number)=><label>{label}<input aria-label={label} type="number" step="any" min={min} max={max} value={values[key]} onChange={e=>change(key,e.target.value)}/></label>;
 return <div className="modal-backdrop"><form ref={ref} className="modal prism-size-dialog" role="dialog" aria-modal="true" aria-labelledby="prism-size-heading" onSubmit={e=>{e.preventDefault();if(error)return;try{onApply(spec);}catch(e){setError((e as Error).message);}}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='Tab'){const all=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select'));const first=all[0],last=all.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}}>
  <header><h2 id="prism-size-heading">Size and Position</h2><button type="button" aria-label="Close Size and Position" onClick={onClose}>×</button></header>
  <div className="prism-size-meta"><span>{count===1?'Selected object':`${count} selected objects`}</span><label>Units<select aria-label="Size units" value={unit} onChange={e=>{const value=e.target.value as keyof typeof factors;setUnit(value);setValues(renderValues(sizePositionElements([element],[element.id],spec)[0],value));setError('');}}><option value="in">Inches</option><option value="cm">Centimeters</option><option value="pt">Points</option></select></label></div>
  <fieldset><legend>Size</legend><div className="prism-size-grid">{field('h','Height',.01/factors[unit],15840/factors[unit])}{field('w','Width',.01/factors[unit],15840/factors[unit])}{field('rot','Rotation (degrees)')}{field('scaleH','Scale height (%)',.01,10000)}{field('scaleW','Scale width (%)',.01,10000)}</div><label className="prism-size-lock"><input type="checkbox" checked={!!spec.lockAspect} onChange={e=>{const next:Spec={...spec,lockAspect:e.target.checked};setSpec(next);setValues(renderValues(sizePositionElements([element],[element.id],next)[0]));setError('');}}/>Lock aspect ratio</label></fieldset>
  <fieldset><legend>Position</legend><p>Measured from the top-left corner of the slide.</p><div className="prism-size-grid">{field('x','Horizontal position',-100000/factors[unit],100000/factors[unit])}{field('y','Vertical position',-100000/factors[unit],100000/factors[unit])}</div></fieldset>
  {count>1&&<p>Changed settings apply to every selected object. Locked proportions use each object’s own aspect ratio.</p>}{error&&<p role="alert">{error}</p>}
  <footer className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!!error}>Apply</button></footer>
 </form></div>;
}
