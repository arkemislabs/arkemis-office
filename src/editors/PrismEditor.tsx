import PrismSizeDialog from './PrismSizeDialog';
import {sizePositionElements} from '../../core/prism-size-position.mjs';
import {CommandGroup} from './CommandGroup';
import {LinkedValueCommand} from '../OfficeCommands';
import {QuickAccess} from './QuickAccess';
import {Ribbon} from './Ribbon';

import {useEffect,useLayoutEffect,useRef,useState} from 'react';

import {Plus,Trash2,Copy,ChevronUp,ChevronDown,Type,Square,ImagePlus,Play,AlignLeft,AlignCenter,AlignRight,Bold,Italic,Underline,X,ChevronLeft,ChevronRight,PanelRight} from 'lucide-react';

import type {PrismEditorProps,PrismContent,Slide,SlideElement} from '../types';

import {moveItem,slideDimension,presentationIndex} from '../../core/editor-helpers.mjs';

import {Tool,Divider} from './Toolbar';

import './editors.css';

import './prism-expansion.css';

import {arrangeElements,nudgeElements,layerElements,resizeImage,samePresentationContent,duplicateElements} from '../../core/prism-helpers.mjs';

import {editSlides,slideshowIndices,presentationSlideIndex,stepPresentation} from '../../core/prism-slides.mjs';

import {transformElements,elementTransformCSS,resizeTransformedElement} from '../../core/prism-transform.mjs';

import {fallbackFonts,fontFamilyCSS} from '../../core/font-catalog.mjs';
import {textRuns,formatTextRange,replaceTextPreservingRuns,shapeGeometries,shapePath} from '../../core/prism-content.mjs';

const W=960,H=540;

const themes=[{name:'Porcelain',background:'#ffffff',color:'#202331',fill:'#635bdb'},{name:'Midnight',background:'#172238',color:'#f5f6fa',fill:'#8a82f5'},{name:'Orchard',background:'#eef4ee',color:'#203c2e',fill:'#48916b'},{name:'Clay',background:'#faf0ea',color:'#532f29',fill:'#c66a51'}];

const newSlide=():Slide=>({id:crypto.randomUUID(),background:'#ffffff',elements:[],notes:''});

const newId=()=>crypto.randomUUID();



function ShapeView({element}:{element:SlideElement}) {
 const geometry=element.geometry??(element.radius?'roundRect':'rect'),path=shapePath(geometry),line=geometry.includes('Connector')||geometry==='line',stroke=element.stroke??'#202331',width=element.strokeWidth??0;
 const marker=(end:string|undefined,id:string)=>end&&end!=='none'?<marker id={id} viewBox="0 0 10 10" refX={end==='arrow'?9:10} refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">{end==='oval'?<ellipse cx="5" cy="5" rx="5" ry="4" fill={stroke}/>:<path d={end==='diamond'?'M0 5L5 0L10 5L5 10Z':end==='stealth'?'M0 0L10 5L0 10L3 5Z':end==='arrow'?'M0 0L10 5L0 10':'M0 0L10 5L0 10Z'} fill={end==='arrow'?'none':stroke} stroke={stroke}/>}</marker>:null;
 const head=`head-${element.id}`,tail=`tail-${element.id}`,attrs={fill:line?'none':element.fill??'#635bdb',stroke:width?stroke:'none',strokeWidth:width,vectorEffect:'non-scaling-stroke' as const,strokeDasharray:element.dash&&element.dash!=='solid'?'5 4':undefined,markerStart:element.headArrow&&element.headArrow!=='none'?`url(#${head})`:undefined,markerEnd:element.tailArrow&&element.tailArrow!=='none'?`url(#${tail})`:undefined};
 return <svg className="prism-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs>{marker(element.headArrow,head)}{marker(element.tailArrow,tail)}</defs>{geometry==='ellipse'?<ellipse cx="50" cy="50" rx="50" ry="50" {...attrs}/>:path?<path d={path} {...attrs}/>:<rect width="100" height="100" rx={geometry==='roundRect'?Math.min(25,(element.radius??12)*100/element.w):0} {...attrs}/>}</svg>;
}
function ElementView({element}:{element:SlideElement}) {

  if(element.type==='image')return <img src={element.src} alt="" draggable={false}/>;

  if(element.type==='shape')return <ShapeView element={element}/>;

  return <>{element.geometry&&<ShapeView element={element}/>}<div className="ed-slide-text" style={{position:'relative',color:element.color??'#202331',fontFamily:fontFamilyCSS(element.fontFamily)||'Aptos',fontSize:element.fontSize??32,fontWeight:element.bold?700:400,fontStyle:element.italic?'italic':'normal',textDecoration:element.underline?'underline':'none',textAlign:element.align??'left'}}>{textRuns(element).map((run:NonNullable<SlideElement['runs']>[number],i:number)=><span key={i} style={{fontFamily:fontFamilyCSS(run.fontFamily??element.fontFamily)||undefined,fontSize:run.fontSize??element.fontSize,fontWeight:(run.bold??element.bold)?700:400,fontStyle:(run.italic??element.italic)?'italic':'normal',textDecoration:(run.underline??element.underline)?'underline':'none',color:run.color??element.color}}>{run.text}</span>)}</div></>;

}

function SlideView({slide}:{slide:Slide}) {

  return <div className="ed-slide-contents" style={{background:slide.background}}>{slide.elements.map(element=><div key={element.id} className="ed-slide-object" style={{left:element.x,top:element.y,width:element.w,height:element.h,transform:elementTransformCSS(element)}}><ElementView element={element}/></div>)}</div>;

}



export default function PrismEditor({content,onChange,onStatus,onPickImage,onSave}:PrismEditorProps) {

  const slide=content.slides.find(s=>s.id===content.activeSlideId)??content.slides[0];

  const live=useRef({content,onChange,slide});live.current={content,onChange,slide};

  const [slideSelection,setSlideSelection]=useState<string[]>([]);const slideAnchor=useRef(0);

  const [selection,setSelection]=useState<string[]>([]); const [availableFonts,setAvailableFonts]=useState<string[]>(fallbackFonts); useEffect(()=>{let active=true;window.studio.fonts().then(r=>{if(active)setAvailableFonts(r.families);}).catch(()=>{});return()=>{active=false;};},[]);

  const selected=selection[selection.length-1]??null;

  const setSelected=(id:string|null)=>setSelection(id?[id]:[]);

  const [notesVisible,setNotesVisible]=useState(true);

  const history=useRef<{past:PrismContent[];future:PrismContent[]}>({past:[],future:[]});

  const expectedContent=useRef(content);

  const [,refreshHistory]=useState(0);

  const commit=(next:PrismContent)=>{const current=live.current;if(JSON.stringify(current.content)===JSON.stringify(next))return;history.current.past.push(current.content);if(history.current.past.length>100)history.current.past.shift();history.current.future=[];live.current={...current,content:next,slide:next.slides.find(s=>s.id===next.activeSlideId)??next.slides[0]};expectedContent.current=next;current.onChange(next);refreshHistory(n=>n+1);};

  const restore=(redo=false)=>{const source=redo?history.current.future:history.current.past;const next=source.pop();if(!next)return;(redo?history.current.past:history.current.future).push(live.current.content);live.current={...live.current,content:next,slide:next.slides.find(s=>s.id===next.activeSlideId)??next.slides[0]};expectedContent.current=next;onChange(next);setSelected(null);setEditing(null);refreshHistory(n=>n+1);};

  const [editing,setEditing]=useState<string|null>(null);
  const [,refreshTextSelection]=useState(0); const textSelection=useRef<{id:string;start:number;end:number}|null>(null);

  const [preview,setPreview]=useState<SlideElement[]|null>(null);

  const [present,setPresent]=useState<number|null>(null);

  const [stageWidth,setStageWidth]=useState(760);

  const [inspector,setInspector]=useState(true);
  const [sizeDialog,setSizeDialog]=useState<{element:SlideElement;ids:string[];base:string;slideId:string}|null>(null);
  const openSizeDialog=()=>{const e=live.current.slide?.elements.find(e=>e.id===selected);if(e)setSizeDialog({element:structuredClone(e),ids:[...selection],base:JSON.stringify(live.current.content),slideId:live.current.slide.id});};

  const root=useRef<HTMLDivElement>(null);

  const presentation=useRef<HTMLDivElement>(null);

  const playableSlides=slideshowIndices(content.slides);const visiblePresentation=presentationSlideIndex(present,content.slides);

  const isPresenting=visiblePresentation!==null;

  const stageArea=useRef<HTMLDivElement>(null);

  const stage=useRef<HTMLDivElement>(null);

  const textEdit=useRef<HTMLTextAreaElement>(null);

  const drag=useRef<{id:string;startX:number;startY:number;original:SlideElement;resize:boolean;latest:SlideElement;ids:string[];originals:SlideElement[];latestElements:SlideElement[]}|null>(null);

  useLayoutEffect(()=>{

    if(content===expectedContent.current)return;

    if(!samePresentationContent(content,expectedContent.current)){

      history.current={past:[],future:[]};

      drag.current=null;setPreview(null);setEditing(null);setSelected(null);

      refreshHistory(n=>n+1);

    }

    expectedContent.current=content;

  },[content]);

  const scale=stageWidth/W;

  const element=slide?.elements.find(item=>item.id===selected);
  const textStyle=(()=>{if(!element)return {};const range=textSelection.current?.id===element.id?textSelection.current:null;let offset=0;for(const run of textRuns(element)){if(!range||offset+run.text.length>range.start)return {...element,...run};offset+=run.text.length;}return element;})();

  const index=content.slides.findIndex(s=>s.id===slide?.id);

  const updateSlide=(transform:(slide:Slide)=>Slide)=>{const current=live.current;if(!current.slide)return;commit({...current.content,slides:current.content.slides.map(s=>s.id===current.slide.id?transform(s):s)});};

  const updateElement=(patch:Partial<SlideElement>)=>{if(selected)updateSlide(s=>({...s,elements:s.elements.map(item=>{if(item.id!==selected)return item;let next={...item,...patch};if(item.type==='text'){if(patch.text!==undefined)next=replaceTextPreservingRuns(item,patch.text);else if(['fontFamily','fontSize','bold','italic','underline','color'].some(k=>k in patch)){const range=textSelection.current?.id===selected?textSelection.current:null,start=range&&range.end>range.start?range.start:0,end=range&&range.end>range.start?range.end:(item.text??'').length;next=formatTextRange(item,Math.min(start,(item.text??'').length),Math.min(end,(item.text??'').length),patch);if(start===0&&end===(item.text??'').length)next={...next,...patch};}}return next;})}));};

  const removeElement=()=>{if(selection.length){updateSlide(s=>({...s,elements:s.elements.filter(item=>!selection.includes(item.id))}));setSelected(null);setEditing(null);}};

  const duplicateObjects=()=>{const copies:SlideElement[]=duplicateElements(slide.elements,selection,newId);if(copies.length){updateSlide(s=>({...s,elements:[...s.elements,...copies]}));setSelection(copies.map(item=>item.id));}};

  const arrange=(action:string)=>updateSlide(s=>({...s,elements:arrangeElements(s.elements,selection,action)}));

  const transformSelection=(action:{type:string;by?:number;degrees?:number;axis?:string})=>updateSlide(s=>({...s,elements:transformElements(s.elements,selection,action)}));

  const layer=(direction:string)=>updateSlide(s=>({...s,elements:layerElements(s.elements,selection,direction)}));

  const applyTheme=(name:string,all=false)=>{const theme=themes.find(t=>t.name===name);if(!theme)return;const apply=(s:Slide)=>({...s,background:theme.background,elements:s.elements.map(item=>({...item,...(item.type==='text'?{color:theme.color,runs:textRuns(item).map((run:NonNullable<SlideElement['runs']>[number])=>({...run,color:theme.color}))}:item.type==='shape'?{fill:theme.fill}:{})}))});if(all)commit({...content,slides:content.slides.map(apply)});else updateSlide(apply);};

  useEffect(()=>{const target=stageArea.current;if(!target)return;const measure=()=>setStageWidth(Math.min(1080,Math.max(280,target.clientWidth-64)));measure();const observer=new ResizeObserver(measure);observer.observe(target);return()=>observer.disconnect();},[Boolean(slide)]);

  useEffect(()=>{setSelected(null);setEditing(null);setPreview(null);drag.current=null;},[slide?.id]);

  useEffect(()=>{if(editing){textEdit.current?.focus();textEdit.current?.select();}},[editing]);

  useEffect(()=>{onStatus?.(`Slide ${index+1} of ${content.slides.length} · ${slide?.elements.length??0} objects`);},[index,content.slides.length,slide?.elements.length,onStatus]);

  useEffect(()=>{if(present!==visiblePresentation)setPresent(visiblePresentation);},[present,visiblePresentation]);

  useEffect(()=>{

    if(!isPresenting)return;

    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;

    const dialog=presentation.current;if(!dialog)return;

    const siblings=Array.from(root.current?.children??[]).filter((node):node is HTMLElement=>node instanceof HTMLElement&&node!==dialog);

    const inertStates=siblings.map(node=>node.inert);siblings.forEach(node=>{node.inert=true;});

    const focusable=()=>Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));

    const keepFocus=(event:FocusEvent)=>{if(event.target instanceof Node&&!dialog.contains(event.target))(focusable()[0]??dialog).focus();};

    (focusable()[0]??dialog).focus();document.addEventListener('focusin',keepFocus);

    return()=>{document.removeEventListener('focusin',keepFocus);siblings.forEach((node,i)=>{node.inert=inertStates[i];});if(previous?.isConnected)previous.focus();};

  },[isPresenting]);

  useEffect(()=>{

    const dialog=presentation.current;

    if(!isPresenting||!dialog)return;

    const focused=document.activeElement;

    if(!dialog.contains(focused)||(focused instanceof HTMLButtonElement&&focused.disabled))dialog.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();

  },[visiblePresentation,content.slides.length,isPresenting]);

  useEffect(()=>{

    const handle=(event:KeyboardEvent)=>{

      if(isPresenting){if(event.key==='Escape'){setPresent(null);event.preventDefault();}if(['ArrowRight','ArrowDown','PageDown'].includes(event.key)||(event.key===' '&&!(event.target instanceof HTMLButtonElement))){event.preventDefault();setPresent(n=>stepPresentation(n??0,1,content.slides));}if(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)){event.preventDefault();setPresent(n=>stepPresentation(n??0,-1,content.slides));}return;}

      if(event.defaultPrevented||sizeDialog)return;

      if(!(event.target instanceof Node)||!root.current?.contains(event.target))return;

      if(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some(dialog=>!root.current?.contains(dialog)&&dialog.getClientRects().length>0))return;

      const target=event.target as HTMLElement;if(target.closest('input,textarea,select,[contenteditable=true]'))return;

      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();restore(event.shiftKey);return;}

      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();restore(true);return;}

      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelection(slide.elements.map(e=>e.id));return;}

      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();duplicateObjects();return;}

      if(event.key==='Escape'){setSelected(null);setEditing(null);}

      if((event.key==='Delete'||event.key==='Backspace')&&selected){event.preventDefault();removeElement();}

      if(element&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const amount=event.shiftKey?10:1;updateSlide(s=>({...s,elements:nudgeElements(s.elements,selection,event.key==='ArrowRight'?amount:event.key==='ArrowLeft'?-amount:0,event.key==='ArrowDown'?amount:event.key==='ArrowUp'?-amount:0)}));}

    };window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);

  },[isPresenting,content.slides.length,selected,element,selection,content,sizeDialog]);

  const addElement=(type:SlideElement['type'],src?:string)=>{

    if(!slide)return;

    const item:SlideElement={id:newId(),type,x:100,y:100,w:type==='text'?500:260,h:type==='text'?100:180,...(type==='text'?{text:'Your text here',fontSize:36,color:themes.find(t=>t.background===slide.background)?.color??'#202331'}:type==='shape'?{fill:themes.find(t=>t.background===slide.background)?.fill??'#635bdb',radius:8}:{src})};

    updateSlide(s=>({...s,elements:[...s.elements,item]}));setSelected(item.id);if(type==='text')setEditing(item.id);

  };

  const addSlide=()=>{const next={...newSlide(),background:slide?.background??'#ffffff'};commit({...content,slides:[...content.slides.slice(0,index+1),next,...content.slides.slice(index+1)],activeSlideId:next.id});};

  const slideTargets=slideSelection.filter(id=>content.slides.some(s=>s.id===id));const selectedSlides=slideTargets.length?slideTargets:[slide?.id].filter(Boolean);

  const slideAction=(operation:Record<string,unknown>)=>{const next=editSlides(live.current.content,{...operation,ids:selectedSlides});commit(next);setSlideSelection(operation.type==='duplicate'?next.slides.filter((s:Slide)=>!content.slides.some(previous=>previous.id===s.id)).map((s:Slide)=>s.id):operation.type==='hide'?selectedSlides:[next.activeSlideId].filter(Boolean));};

  const duplicate=()=>slideAction({type:'duplicate'});

  const deleteSlide=()=>slideAction({type:'delete'});

  const startDrag=(event:React.PointerEvent,object:SlideElement,resize=false)=>{

    if(editing===object.id&&!resize)return;

    event.preventDefault();event.stopPropagation();(event.currentTarget as HTMLElement).focus({preventScroll:true});if(event.shiftKey&&!resize){setSelection(selection.includes(object.id)?selection.filter(id=>id!==object.id):[...selection,object.id]);return;}if(!selection.includes(object.id))setSelected(object.id);setEditing(null);event.currentTarget.setPointerCapture(event.pointerId);

    drag.current={id:object.id,startX:event.clientX,startY:event.clientY,original:object,resize,latest:object,ids:selection.includes(object.id)?selection:[object.id],originals:slide.elements,latestElements:slide.elements};

  };

  const dragMove=(event:React.PointerEvent)=>{

    const state=drag.current;if(!state)return;

    const dx=(event.clientX-state.startX)/scale,dy=(event.clientY-state.startY)/scale;

    const object=state.resize?resizeTransformedElement(state.original,dx,dy,state.original.type==='image'):state.original;

    state.latest=object;state.latestElements=state.resize?state.originals.map(item=>item.id===state.id?object:item):nudgeElements(state.originals,state.ids,dx,dy);setPreview(state.latestElements);

  };

  const finishDrag=()=>{const state=drag.current;if(state){updateSlide(s=>({...s,elements:state.latestElements}));drag.current=null;setPreview(null);}};

  if(!slide)return <div className="ed-loading" ref={root}><button onClick={addSlide}>Create a slide</button><button onClick={()=>restore()} disabled={!history.current.past.length}>Undo</button></div>;

  const currentTheme=themes.find(t=>t.background===slide.background)?.name??'Custom';

  return <div className="ed-root ed-prism" ref={root}>

    <QuickAccess><button className="ed-text-tool" onClick={()=>onSave?.()} disabled={!onSave}>Save</button><button className="ed-text-tool" disabled={!history.current.past.length} onClick={()=>restore()}>Undo</button><button className="ed-text-tool" disabled={!history.current.future.length} onClick={()=>restore(true)}>Redo</button></QuickAccess>
    <Ribbon contextualTabs={element?[{name:element.type==='image'?'Picture Format':'Shape Format',content:<div className="prism-ribbon-controls"><span>{selection.length} selected</span><button className="ed-text-tool" disabled={!selected} onClick={openSizeDialog}>Size and Position</button>{[['left','Align left'],['center','Center horizontally'],['right','Align right'],['top','Align top'],['middle','Center vertically'],['bottom','Align bottom'],['distribute-x','Distribute horizontally'],['distribute-y','Distribute vertically']].map(([action,label])=><button key={action} className="ed-text-tool" disabled={selection.length<(action.startsWith('distribute')?3:1)} onClick={()=>arrange(action)}>{label}</button>)}<button className="ed-text-tool" disabled={!selected} onClick={()=>layer('front')}>Bring to front</button><button className="ed-text-tool" disabled={!selected} onClick={()=>layer('back')}>Send to back</button><button className="ed-text-tool" disabled={!selected} onClick={()=>layer('forward')}>Bring forward</button><button className="ed-text-tool" disabled={!selected} onClick={()=>layer('backward')}>Send backward</button><button className="ed-text-tool" disabled={!selected} onClick={()=>transformSelection({type:'rotate',by:-90})}>Rotate left</button><button className="ed-text-tool" disabled={!selected} onClick={()=>transformSelection({type:'rotate',by:90})}>Rotate right</button><button className="ed-text-tool" disabled={!selected} onClick={()=>transformSelection({type:'flip',axis:'horizontal'})}>Flip horizontal</button><button className="ed-text-tool" disabled={!selected} onClick={()=>transformSelection({type:'flip',axis:'vertical'})}>Flip vertical</button><button className="ed-text-tool" disabled={!selected} onClick={duplicateObjects}>Duplicate objects</button><button className="ed-text-tool" disabled={!selected} onClick={removeElement}>Delete objects</button></div>}]:[]} orderedTabs={['Edit','Home','Insert','Design','Slide Show','View']} extraTabs={[
      {name:'Edit',content:<><CommandGroup label="History"><button className="ed-text-tool" disabled={!history.current.past.length} onClick={()=>restore()}>Undo</button><button className="ed-text-tool" disabled={!history.current.future.length} onClick={()=>restore(true)}>Redo</button></CommandGroup><CommandGroup label="Selection"><button className="ed-text-tool" disabled={!slide.elements.length} onClick={()=>setSelection(slide.elements.map(item=>item.id))}>Select All objects</button><button className="ed-text-tool" disabled={!selection.length} onClick={()=>setSelected(null)}>Deselect objects</button><button className="ed-text-tool" disabled={!selection.length} onClick={duplicateObjects}>Duplicate objects</button><button className="ed-text-tool" disabled={!selection.length} onClick={removeElement}>Delete objects</button></CommandGroup></>},

      {name:'Design',content:<div className="prism-ribbon-controls"><div className="prism-theme-gallery">{themes.map(theme=><button key={theme.name} className="prism-theme" aria-pressed={currentTheme===theme.name} onClick={()=>applyTheme(theme.name)}><span style={{background:theme.background,color:theme.color,borderColor:theme.fill}}>Aa</span>{theme.name}</button>)}</div><label>Background <input aria-label="Design background" type="color" value={slide.background} onChange={e=>updateSlide(s=>({...s,background:e.target.value}))}/></label><button className="ed-text-tool" disabled={currentTheme==='Custom'} onClick={()=>applyTheme(currentTheme,true)}>Apply theme to all slides</button></div>},


      {name:'Slide Show',content:<div className="prism-ribbon-controls"><button className="ed-present-button" disabled={!playableSlides.length} onClick={()=>{setEditing(null);setPresent(0);}}><Play size={15}/> From beginning</button><button className="ed-text-tool" disabled={!playableSlides.length} onClick={()=>{setEditing(null);setPresent(index);}}>From current slide</button><button className="ed-text-tool" aria-pressed={selectedSlides.every(id=>content.slides.find(s=>s.id===id)?.hidden)} onClick={()=>slideAction({type:'hide'})}>Hide selected slides</button><span>Arrow keys to navigate · Esc to exit</span></div>}

    ]} viewContent={<div className="prism-ribbon-controls"><button className="ed-text-tool" aria-pressed={inspector} onClick={()=>setInspector(v=>!v)}>Inspector</button><button className="ed-text-tool" aria-pressed={notesVisible} onClick={()=>setNotesVisible(v=>!v)}>Speaker notes</button></div>} label="Slide tools" labels={['Slides','Font','Paragraph','Images','Illustrations','Links','Text']} homeGroups={[0,1,2]} focusTab="Insert" focusGroups={[3,4,5,6]}>

      <button className="ed-text-tool" onClick={addSlide}><Plus size={17}/> New slide</button><button className="ed-text-tool" onClick={duplicate}>Duplicate slide</button><button className="ed-text-tool" onClick={deleteSlide}>Delete slide</button><Divider/>
      <select aria-label="Slide font family" disabled={element?.type!=='text'} value={textStyle.fontFamily??'Aptos'} onChange={event=>updateElement({fontFamily:event.target.value})}>{[...new Set([textStyle.fontFamily??'Aptos',...availableFonts])].map(font=><option key={font}>{font}</option>)}</select><input aria-label="Slide font size" type="number" min={8} max={180} disabled={element?.type!=='text'} value={textStyle.fontSize??32} onChange={event=>{if(event.target.value!==''&&Number.isFinite(event.target.valueAsNumber))updateElement({fontSize:Math.max(8,Math.min(180,event.target.valueAsNumber))});}}/><Tool label="Bold text" disabled={element?.type!=='text'} active={textStyle.bold} onClick={()=>updateElement({bold:!textStyle.bold})}><Bold/></Tool><Tool label="Italic text" disabled={element?.type!=='text'} active={textStyle.italic} onClick={()=>updateElement({italic:!textStyle.italic})}><Italic/></Tool><Tool label="Underline text" disabled={element?.type!=='text'} active={textStyle.underline} onClick={()=>updateElement({underline:!textStyle.underline})}><Underline/></Tool><Divider/>
      <Tool label="Left align text" disabled={element?.type!=='text'} onClick={()=>updateElement({align:'left'})}><AlignLeft/></Tool><Tool label="Center text" disabled={element?.type!=='text'} onClick={()=>updateElement({align:'center'})}><AlignCenter/></Tool><Tool label="Right align text" disabled={element?.type!=='text'} onClick={()=>updateElement({align:'right'})}><AlignRight/></Tool><Divider/>
      <button className="ed-text-tool" onClick={async()=>{const src=await onPickImage();if(src)addElement('image',src);}}><ImagePlus size={17}/> Image</button><Divider/>
      <button className="ed-text-tool" onClick={()=>addElement('shape')}><Square size={16}/> Shape</button><Divider/>
      <LinkedValueCommand/><Divider/><button className="ed-text-tool" onClick={()=>addElement('text')}><Type size={16}/> Text</button>

    </Ribbon>

    <div className="ed-prism-body">

      <aside className="ed-slide-strip" aria-label="Slides">

        {content.slides.map((item,i)=><button className={`ed-slide-thumb ${item.id===slide.id?'is-active':''} ${item.hidden?'is-hidden':''}`} key={item.id} aria-pressed={selectedSlides.includes(item.id)} aria-label={`Slide ${i+1}`} title={item.name||`Slide ${i+1}`} onClick={event=>{let ids:string[];if(event.shiftKey){ids=content.slides.slice(Math.min(slideAnchor.current,i),Math.max(slideAnchor.current,i)+1).map(s=>s.id);}else if(event.ctrlKey||event.metaKey){ids=selectedSlides.includes(item.id)?selectedSlides.filter(id=>id!==item.id):[...selectedSlides,item.id];slideAnchor.current=i;}else{ids=[item.id];slideAnchor.current=i;}setSlideSelection(ids);onChange({...content,activeSlideId:item.id});}}><span>{i+1}{item.hidden?' · Hidden':''}</span><div className="ed-mini-slide"><SlideView slide={item}/></div></button>)}

        <button className="ed-slide-add" onClick={addSlide}><Plus size={17}/> Add slide</button>

        <div className="ed-slide-actions"><Tool label="Move slide up" disabled={index===0} onClick={()=>slideAction({type:'move',to:Math.max(0,index-1)})}><ChevronUp/></Tool><Tool label="Move slide down" disabled={index===content.slides.length-1} onClick={()=>slideAction({type:'move',to:index+1})}><ChevronDown/></Tool><Tool label="Duplicate slide" onClick={duplicate}><Copy/></Tool><Tool label="Delete slide" onClick={deleteSlide}><Trash2/></Tool></div>

      </aside>

      <div className="ed-stage-column"><div className="ed-stage-area" ref={stageArea} onPointerDown={e=>{if(e.target===e.currentTarget){setSelected(null);setEditing(null);}}}><div className="ed-stage-wrap" style={{width:stageWidth,height:stageWidth*H/W}}><div className="ed-slide-stage" ref={stage} style={{width:W,height:H,transform:`scale(${scale})`,background:slide.background}} onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} onPointerDown={e=>{if(e.target===e.currentTarget){setSelected(null);setEditing(null);}}}>

        {slide.elements.map(original=>{const object=preview?.find(item=>item.id===original.id)??original;const active=selection.includes(object.id);return <div key={object.id} tabIndex={0} role="group" aria-label={object.type==='text'?`Text: ${object.text}`:`${object.type} object`} className={`ed-slide-object ${active?'is-selected':''}`} style={{left:object.x,top:object.y,width:object.w,height:object.h,transform:elementTransformCSS(object)}} onPointerDown={e=>startDrag(e,object)} onDoubleClick={()=>{if(object.type==='text'){setSelected(object.id);setEditing(object.id);}}} onFocus={()=>{if(!selection.includes(object.id))setSelected(object.id);}}>

          {editing===object.id&&object.type==='text'?<textarea ref={textEdit} className="ed-slide-text-edit" aria-label="Slide text" onSelect={e=>{const t=e.currentTarget;textSelection.current={id:object.id,start:t.selectionStart,end:t.selectionEnd};refreshTextSelection(n=>n+1);}} value={object.text??''} style={{fontFamily:fontFamilyCSS(object.fontFamily)||'Aptos',fontSize:object.fontSize??32,color:object.color,fontWeight:object.bold?700:400,textAlign:object.align}} onPointerDown={e=>e.stopPropagation()} onChange={e=>updateElement({text:e.target.value})} onBlur={()=>setEditing(null)} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setEditing(null);}}}/>:<ElementView element={object}/>}

          {active&&<button className="ed-resize-handle" aria-label="Resize object" onPointerDown={e=>startDrag(e,object,true)}/>}

        </div>;})}

      </div></div><div className="ed-stage-caption">{selected?'Drag to move · Drag the corner to resize':'Click an object to edit · Double click text to write'}</div></div>

      {notesVisible&&<label className="ed-speaker-notes"><span>Speaker notes</span><textarea aria-label="Speaker notes" placeholder="Add notes for this slide…" value={slide.notes} onChange={e=>updateSlide(s=>({...s,notes:e.target.value}))}/></label>}</div>

      {inspector&&<aside className="ed-inspector"><div className="ed-inspector-title">{element?'Object':'Slide'}<span>{element?.type??`${index+1} / ${content.slides.length}`}</span></div>

        {!element?<><label className="ed-field">Slide name<input aria-label="Slide name" value={slide.name??''} maxLength={240} onChange={event=>updateSlide(s=>({...s,name:event.target.value}))}/></label><label className="ed-field">Background<input aria-label="Slide background" type="color" value={slide.background} onChange={e=>updateSlide(s=>({...s,background:e.target.value}))}/></label><p className="ed-inspector-hint">Select an object on the slide to change its position, size, and appearance.</p></>:<>

          <div className="ed-inspector-section">Position & size</div><label className="ed-field">Rotation<input aria-label="Object rotation" type="number" value={element.rotation??0} onChange={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))transformSelection({type:'rotate',degrees:e.target.valueAsNumber});}}/></label><div className="ed-inspector-grid">{(['x','y','w','h'] as const).map(key=><label key={key} className="ed-field">{({x:'X',y:'Y',w:'Width',h:'Height'})[key]}<input type="number" aria-label={`Object ${key}`} value={Math.round(element[key])} min={key==='w'||key==='h'?24:0} max={key==='x'||key==='w'?W:H} onChange={e=>{const value=Number(e.target.value);if(!Number.isFinite(value))return;updateElement({[key]:slideDimension(element,key,value,W,H)});}}/></label>)}</div>

          {element.type==='text'&&<><div className="ed-inspector-section">Text</div><p className="ed-inspector-hint">Select characters in Content to format a range. Without a range, formatting applies to the whole text box.</p><label className="ed-field">Font family<select aria-label="Object font family" value={textStyle.fontFamily??'Aptos'} onChange={e=>updateElement({fontFamily:e.target.value})}>{[...new Set([textStyle.fontFamily??'Aptos',...availableFonts])].map(font=><option key={font}>{font}</option>)}</select></label><label className="ed-field">Content<textarea aria-label="Text content" onSelect={e=>{const t=e.currentTarget;textSelection.current={id:element.id,start:t.selectionStart,end:t.selectionEnd};refreshTextSelection(n=>n+1);}} value={element.text??''} onChange={e=>updateElement({text:e.target.value})}/></label><div className="ed-inspector-grid"><label className="ed-field">Font size<input aria-label="Font size" type="number" min="8" max="180" value={textStyle.fontSize??32} onChange={e=>updateElement({fontSize:Math.max(8,Math.min(180,Number(e.target.value)))})}/></label><label className="ed-field">Color<input aria-label="Text color" type="color" value={textStyle.color??'#202331'} onChange={e=>updateElement({color:e.target.value})}/></label></div><div className="ed-object-tools"><Tool label="Object bold text" active={textStyle.bold} onClick={()=>updateElement({bold:!textStyle.bold})}><Bold/></Tool><Tool label="Object left align text" active={element.align==='left'} onClick={()=>updateElement({align:'left'})}><AlignLeft/></Tool><Tool label="Object center text" active={element.align==='center'} onClick={()=>updateElement({align:'center'})}><AlignCenter/></Tool><Tool label="Object right align text" active={element.align==='right'} onClick={()=>updateElement({align:'right'})}><AlignRight/></Tool></div></>}

          {element.type==='shape'&&<><div className="ed-inspector-section">Appearance</div><label className="ed-field">Geometry<select aria-label="Shape geometry" value={element.geometry??(element.radius?'roundRect':'rect')} onChange={e=>updateElement({geometry:e.target.value,...(e.target.value.includes('Connector')||e.target.value==='line'?{strokeWidth:element.strokeWidth||2,stroke:element.stroke??'#202331',fill:'transparent'}:{})})}>{shapeGeometries.map((name:string)=><option key={name}>{name}</option>)}</select></label><label className="ed-field">Outline<input aria-label="Shape outline" type="color" value={element.stroke??'#202331'} onChange={e=>updateElement({stroke:e.target.value,strokeWidth:element.strokeWidth||1})}/></label><label className="ed-field">Outline width<input aria-label="Shape outline width" type="number" min="0" max="100" value={element.strokeWidth??0} onChange={e=>updateElement({strokeWidth:Math.max(0,Math.min(100,Number(e.target.value)))})}/></label><label className="ed-field">End arrow<select aria-label="Shape end arrow" value={element.tailArrow??'none'} onChange={e=>updateElement({tailArrow:e.target.value})}>{['none','triangle','arrow','diamond','oval'].map(name=><option key={name}>{name}</option>)}</select></label><label className="ed-field">Fill<input aria-label="Shape fill" type="color" value={element.fill==='transparent'?'#ffffff':element.fill??'#635bdb'} onChange={e=>updateElement({fill:e.target.value})}/></label><label className="ed-field">Corner radius<input aria-label="Shape corner radius" type="number" min="0" max="100" value={element.radius??0} onChange={e=>updateElement({radius:Math.max(0,Number(e.target.value))})}/></label></>}

          <div className="ed-inspector-section">Arrange</div><div className="ed-object-tools"><button className="ed-text-tool" onClick={()=>layer('front')}>Bring to front</button><button className="ed-text-tool" onClick={duplicateObjects}><Copy size={15}/></button><button className="ed-text-tool ed-danger" onClick={removeElement}><Trash2 size={15}/> Delete</button></div>

        </>}

      </aside>}

    </div>

    <div className="ed-status"><span>Slide {index+1} of {content.slides.length}</span><span>{Math.round(scale*100)}%<span className="ed-status-dot"/>16:9</span></div>

    {sizeDialog&&<PrismSizeDialog element={sizeDialog.element} count={sizeDialog.ids.length} onClose={()=>setSizeDialog(null)} onApply={spec=>{const current=live.current.content;if(JSON.stringify(current)!==sizeDialog.base)throw new Error('The presentation changed. Close this dialog and reopen Size and Position.');const next={...current,slides:current.slides.map(s=>s.id===sizeDialog.slideId?{...s,elements:sizePositionElements(s.elements,sizeDialog.ids,spec)}:s)};commit(next);setSizeDialog(null);}}/>}
    {visiblePresentation!==null&&<div ref={presentation} tabIndex={-1} className="ed-presentation" role="dialog" aria-label="Presentation" aria-modal="true" onKeyDown={e=>{if(e.key!=='Tab')return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));if(!buttons.length){e.preventDefault();e.currentTarget.focus();return;}const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===e.currentTarget)){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===e.currentTarget)){e.preventDefault();first.focus();}}} onClick={()=>setPresent(n=>stepPresentation(n??0,1,content.slides))}><div className="ed-presentation-slide"><svg viewBox="0 0 960 540"><foreignObject width="960" height="540"><SlideView slide={content.slides[visiblePresentation]}/></foreignObject></svg></div><div className="ed-presentation-controls" onClick={e=>e.stopPropagation()}><button aria-label="Previous slide" disabled={visiblePresentation===playableSlides[0]} onClick={()=>setPresent(n=>stepPresentation(n??0,-1,content.slides))}><ChevronLeft/></button><span>{visiblePresentation+1} / {content.slides.length}</span><button aria-label="Next slide" disabled={visiblePresentation===playableSlides.at(-1)} onClick={()=>setPresent(n=>stepPresentation(n??0,1,content.slides))}><ChevronRight/></button><button aria-label="Exit presentation" onClick={()=>setPresent(null)}><X/></button><span className="ed-presentation-help">Esc to exit</span></div></div>}

  </div>;

}

