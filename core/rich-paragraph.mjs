// Adapted from WordCraft 3de6ff95, cmd/para/tabs_borders.rs and para.rs.
// See assets/third-party-licenses/wordcraft-paragraphs.txt.
export const paragraphBorderSides=['top','bottom','left','right','between'];
const styles=new Set(['nil','single','double','dotted','dashed','thick','triple','dotDash','wave','dashSmallGap','dotDotDash','doubleWave']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const ink=value=>value==='auto'||typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export function paragraphDecoration(attrs={}){
 const result={};
 if(attrs.paragraphShading!=null){if(!ink(attrs.paragraphShading))throw new Error('Paragraph shading must be #RRGGBB or auto.');result.paragraphShading=attrs.paragraphShading;}
 if(attrs.paragraphBorders!=null){
  if(!plain(attrs.paragraphBorders))throw new Error('Paragraph borders must be an object.');
  result.paragraphBorders={};
  for(const [side,b]of Object.entries(attrs.paragraphBorders)){
   if(!paragraphBorderSides.includes(side)||!plain(b)||Object.keys(b).some(k=>!['style','width','color','space'].includes(k))||!styles.has(b.style)||!number(b.width,0,12)||!Number.isInteger(b.width*8)||!ink(b.color)||!number(b.space,0,31)||!Number.isInteger(b.space))throw new Error('Invalid paragraph border: widths use eighth-points and spacing uses whole points.');
   result.paragraphBorders[side]={style:b.style,width:b.width,color:b.color,space:b.space};
  }
 }
 return result;
}
export function applyParagraphBorder(current,command={}){
 const existing=paragraphDecoration({paragraphBorders:current}).paragraphBorders??{};
 const line=(value,space)=>{
  if(!plain(value))throw new Error('Invalid border options.');
  const width=value.width??.5,color=value.color??'auto',style=value.style??'single';
  if(!number(width,0,12)||!ink(color)||!styles.has(style))throw new Error('Invalid border options.');
  return {style,width:Math.round(Math.max(.25,Math.min(6,width))*8)/8,color,space};
 };
 if(command.sides!==undefined){
  if(!plain(command.sides)||Object.keys(command.sides).some(k=>!paragraphBorderSides.includes(k)))throw new Error('Invalid border sides.');
  return Object.fromEntries(Object.entries(command.sides).filter(([,value])=>value!=null).map(([side,value])=>[side,line(value,['left','right'].includes(side)?4:1)]));
 }
 const kind=command.kind??'bottom';
 if(!['none','all','outside','inside','top','bottom','left','right','horizontalLine'].includes(kind))throw new Error('Unknown paragraph border preset.');
 const b=line(command,['left','right'].includes(kind)?4:1),next=structuredClone(existing);
 if(kind==='none')return {};
 if(kind==='horizontalLine')return {bottom:{...b,width:1.5}};
 if(kind==='all')return Object.fromEntries(paragraphBorderSides.map(side=>[side,{...b}]));
 if(kind==='outside'){for(const side of paragraphBorderSides.slice(0,4))next[side]={...b};return next;}
 if(kind==='inside'){next.between=b;return next;}
 if(next[kind]&&next[kind].style!=='nil'&&next[kind].width>0)delete next[kind];else next[kind]=b;
 return next;
}
export function paragraphDecorationStyle(attrs){
 const checked=paragraphDecoration(attrs),parts=[];
 if(checked.paragraphShading)parts.push('background-color:'+(checked.paragraphShading==='auto'?'transparent':checked.paragraphShading));
 for(const side of paragraphBorderSides.slice(0,4)){
  const b=checked.paragraphBorders?.[side];if(!b)continue;
  const css={single:'solid',thick:'solid',double:'double',triple:'double',dotDash:'dashed',dotDotDash:'dashed',dashSmallGap:'dashed',wave:'solid',doubleWave:'double',nil:'none'}[b.style]??b.style;
  parts.push(`border-${side}:${b.width}pt ${css} ${b.color==='auto'?'currentColor':b.color}`);
  if(b.style!=='nil')parts.push(`padding-${side}:${b.space}pt`);
 }
 return parts.join(';');
}
export function paragraphDecorationTransaction(state,change){
 const valid=new Set(['paragraphShading','paragraphBorders','border']);
 if(!plain(change)||!Object.keys(change).length||Object.keys(change).some(k=>!valid.has(k)))throw new Error('Invalid paragraph formatting.');
 paragraphDecoration(change);
 const positions=new Map(),{from,to,empty}=state.selection;
 if(empty){for(let depth=state.selection.$from.depth;depth>0;depth--){const node=state.selection.$from.node(depth);if(['paragraph','heading'].includes(node.type.name)){positions.set(state.selection.$from.before(depth),node);break;}}}
 else state.doc.nodesBetween(from,to,(node,pos)=>{if(['paragraph','heading'].includes(node.type.name)){if(to>pos+1&&(from<pos+node.nodeSize-1||node.content.size===0))positions.set(pos,node);return false;}});
 const tr=state.tr;
 for(const [pos,node]of positions){const attrs={...node.attrs};for(const key of ['paragraphShading','paragraphBorders'])if(key in change)attrs[key]=structuredClone(change[key]);if(change.border)attrs.paragraphBorders=applyParagraphBorder(attrs.paragraphBorders,change.border);tr.setNodeMarkup(pos,undefined,attrs);}
 return tr;
}
