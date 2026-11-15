import {useEffect,useRef,useState} from 'react';
import type {Editor} from '@tiptap/core';
import {PaintBucket,PanelBottom} from 'lucide-react';
import {setParagraphAppearance} from './RichFormatting';
import {Tool} from './Toolbar';

export function ParagraphAppearanceControls({editor}:{editor:Editor}){
 const [open,setOpen]=useState(false),[error,setError]=useState('');
 const [color,setColor]=useState('#000000'),[width,setWidth]=useState(.5),[style,setStyle]=useState('single');
 const [shading,setShading]=useState('#fff2cc'),[sides,setSides]=useState({top:true,bottom:true,left:true,right:true});
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
 const apply=(change:Record<string,unknown>)=>{try{setParagraphAppearance(editor,change);setError('');return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}};
 const border=(kind:string)=>apply({border:{kind,color,width,style}});
 return <><div className="rich-paragraph-paint">
  <Tool label="Apply paragraph shading" onClick={()=>apply({paragraphShading:shading})}><PaintBucket/></Tool>
  <input type="color" aria-label="Paragraph shading color" title="Paragraph shading color" value={shading} onChange={e=>{setShading(e.target.value);apply({paragraphShading:e.target.value});}}/>
  <select aria-label="Paragraph shading" title="Paragraph shading" value="" onChange={e=>{if(e.target.value==='none')apply({paragraphShading:'auto'});}}><option value="" disabled>▾</option><option value="none">No Color</option></select>
 </div><div className="rich-paragraph-border">
  <Tool label="Bottom paragraph border" onClick={()=>border('bottom')}><PanelBottom/></Tool>
  <select aria-label="Paragraph borders" title="Paragraph borders" value="" onChange={e=>{if(e.target.value==='options')setOpen(true);else border(e.target.value);}}><option value="" disabled>▾</option>{[['bottom','Bottom Border'],['top','Top Border'],['left','Left Border'],['right','Right Border'],['none','No Border'],['outside','Outside Borders'],['horizontalLine','Horizontal Line'],['options','Borders and Shading…']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
 </div>{error&&!open&&<span role="alert">{error}</span>}
 {open&&<dialog ref={dialog} className="rich-border-dialog" aria-label="Borders and Shading" onCancel={e=>{e.preventDefault();setOpen(false);editor.commands.focus();}}>
  <h2>Borders and Shading</h2><form onSubmit={e=>{e.preventDefault();const selected=Object.fromEntries(Object.entries(sides).filter(([,on])=>on).map(([side])=>[side,{style,width,color}]));if(apply({border:{sides:selected}}))setOpen(false);}}>
   <fieldset><legend>Paragraph border</legend><label>Style<select aria-label="Paragraph border style" value={style} onChange={e=>setStyle(e.target.value)}><option value="single">Solid</option><option value="double">Double</option><option value="dotted">Dotted</option><option value="dashed">Dashed</option></select></label><label>Color<input type="color" aria-label="Paragraph border color" value={color} onChange={e=>setColor(e.target.value)}/></label><label>Width (pt)<input type="number" aria-label="Paragraph border width" min="0.25" max="6" step="0.25" value={width} onChange={e=>setWidth(e.target.valueAsNumber)}/></label></fieldset>
   <fieldset><legend>Apply to sides</legend>{(['top','bottom','left','right'] as const).map(side=><label key={side}><input type="checkbox" checked={sides[side]} onChange={e=>setSides(previous=>({...previous,[side]:e.target.checked}))}/>{side}</label>)}</fieldset>
   {error&&<p role="alert">{error}</p>}<footer><button type="button" onClick={()=>{setOpen(false);editor.commands.focus();}}>Cancel</button><button type="submit">Apply paragraph borders</button></footer>
  </form>
 </dialog>}</>;
}
