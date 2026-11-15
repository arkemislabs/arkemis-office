// Source-to-JavaScript adaptation: DeckCraft cmd/slide.rs duplicate/delete/hide.
// Revision f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT notice in
// assets/third-party-licenses/artcraft-reference.txt. Multi-move is local extension.
export function slideshowIndices(slides){return slides.flatMap((s,i)=>s.hidden?[]:[i]);}
export function presentationSlideIndex(index,slides){if(index===null)return null;const visible=slideshowIndices(slides);return visible.find(i=>i>=index)??visible.at(-1)??null;}
export function stepPresentation(index,delta,slides){const visible=slideshowIndices(slides);if(!visible.length)return null;const at=Math.max(0,visible.indexOf(index));return visible[Math.max(0,Math.min(visible.length-1,at+delta))];}
export function editSlides(content,operation,newId=()=>crypto.randomUUID()){
 const ids=operation.ids??[content.activeSlideId],selected=new Set(ids);
 if(!Array.isArray(ids)||!ids.length||selected.size!==ids.length||ids.some(id=>!content.slides.some(s=>s.id===id)))throw Error('Invalid slide selection');
 const chosen=content.slides.filter(s=>selected.has(s.id)),first=content.slides.findIndex(s=>selected.has(s.id));let slides=content.slides,activeSlideId=content.activeSlideId;
 switch(operation.type){
 case 'duplicate':{
  if(slides.length+chosen.length>500)throw Error('A presentation supports up to 500 slides');
  const copies=chosen.map(s=>({...structuredClone(s),id:newId(),elements:s.elements.map(e=>({...structuredClone(e),id:newId()}))}));
  const last=slides.findLastIndex(s=>selected.has(s.id));slides=[...slides.slice(0,last+1),...copies,...slides.slice(last+1)];activeSlideId=copies.at(-1).id;break;
 }
 case 'delete':slides=slides.filter(s=>!selected.has(s.id));activeSlideId=slides[Math.min(first,slides.length-1)]?.id??'';break;
 case 'hide':{
  if(operation.hidden!==undefined&&typeof operation.hidden!=='boolean')throw Error('Invalid hidden state');
  const hidden=operation.hidden??!chosen.every(s=>s.hidden);slides=slides.map(s=>selected.has(s.id)?{...s,hidden}:s);break;
 }
 case 'move':{
  if(!Number.isSafeInteger(operation.to)||operation.to<0)throw Error('Invalid slide position');
  const rest=slides.filter(s=>!selected.has(s.id)),to=Math.min(operation.to,rest.length);slides=[...rest.slice(0,to),...chosen,...rest.slice(to)];break;
 }
 case 'rename':case 'notes':{
  const key=operation.type==='rename'?'name':'notes',value=operation[key];
  if(typeof value!=='string'||value.length>(key==='name'?240:100000))throw Error('Invalid slide text');
  slides=slides.map(s=>selected.has(s.id)?{...s,[key]:value}:s);break;
 }
 default:throw Error('Unknown slide operation');
 }
 return {...content,slides,activeSlideId};
}
