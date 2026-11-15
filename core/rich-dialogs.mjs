import {cellFormatting,tableGrid} from './rich-table.mjs';
import {paragraphDecoration} from './rich-paragraph.mjs';
/** Native document operations used by the Word formatting dialogs. Units are points. */
export function paragraphLayout(attrs){
 const ranges={indentLeft:[0,720],indentRight:[0,720],indentFirstLine:[-720,720],spaceBefore:[0,96],spaceAfter:[0,96],lineHeight:[.8,3]};
 if(!attrs||typeof attrs!=='object'||Array.isArray(attrs))throw Error('Invalid paragraph layout.');
 for(const [key,value] of Object.entries(attrs)){
  if(key==='textAlign'){if(value!==null&&!['left','center','right','justify'].includes(value))throw Error('Invalid alignment.');continue;}
  if(!ranges[key])throw Error('Unsupported paragraph layout setting.');
  const [min,max]=ranges[key];if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max))throw Error(`${key} must be between ${min} and ${max}.`);
 }
 return {...attrs};
}
export function paragraphLayoutTransaction(state,change){
 paragraphLayout(change);const positions=new Map(),{from,to,empty,$from}=state.selection;
 if(empty){for(let d=$from.depth;d>0;d--){const node=$from.node(d);if(['paragraph','heading'].includes(node.type.name)){positions.set($from.before(d),node);break;}}}
 else state.doc.nodesBetween(from,to,(node,pos)=>{if(['paragraph','heading'].includes(node.type.name)){if(to>pos+1&&(from<pos+node.nodeSize-1||node.content.size===0))positions.set(pos,node);return false;}});
 const tr=state.tr;for(const [pos,node] of positions)tr.setNodeMarkup(pos,undefined,{...node.attrs,...change});return tr;
}
export function makeRichTable({rows,columns,width,header=false}){
 if(!Number.isInteger(rows)||rows<1||rows>30||!Number.isInteger(columns)||columns<1||columns>12)throw Error('Use 1–30 rows and 1–12 columns.');
 if(!Number.isFinite(width)||width<columns*25||width>1200)throw Error(`Table width must be between ${columns*25} and 1200 pixels.`);
 const base=Math.floor(width/columns),extra=Math.round(width)-base*columns;
 return {type:'table',attrs:{tableAlign:'left'},content:Array.from({length:rows},(_,r)=>({type:'tableRow',content:Array.from({length:columns},(_,c)=>({type:r===0&&header?'tableHeader':'tableCell',attrs:{colspan:1,rowspan:1,colwidth:[base+(c<extra?1:0)]},content:[{type:'paragraph'}]}))}))};
}
/** The HTML parser admits only schema nodes; this final pass removes remote resources
 * and unsupported URI schemes without ever inserting untrusted HTML in the live DOM. */
export function safePasteJSON(doc){
 let count=0;const visit=(node,depth=0)=>{
  if(depth>60||++count>100000)throw Error('Clipboard document is too complex.');
  if(node.type==='image')return null;
  const result={...node};if(node.attrs)result.attrs={...node.attrs};
  if(node.marks)result.marks=node.marks.filter(mark=>mark.type!=='link'||typeof mark.attrs?.href==='string'&&/^(https?:\/\/|mailto:|tel:)/i.test(mark.attrs.href)&&!/[\u0000-\u0020\u007f]/.test(mark.attrs.href)).map(mark=>structuredClone(mark));
  if(node.content)result.content=node.content.map(child=>visit(child,depth+1)).filter(Boolean);
  if(result.type==='table')tableGrid(result);
  if(['paragraph','heading'].includes(result.type))paragraphDecoration(result.attrs??{});
  return result;
 };
 return visit(doc);
}

/** Validate recognized clipboard attributes before ProseMirror/table repair sees them. */
export function pasteAttributes(tag,input){
 const attrs={},cell=['td','th'].includes(tag),paragraph=/^(p|h[1-6])$/.test(tag);
 for(const [name,value] of Object.entries(input)){
  if(name==='style'){if(!/url\s*\(|expression\s*\(|@import/i.test(value))attrs[name]=value;continue;}
  if(name==='href'&&tag==='a'){if(/^(https?:\/\/|mailto:|tel:)/i.test(value)&&!/[\u0000-\u0020\u007f]/.test(value))attrs[name]=value;continue;}
  if(cell&&['colspan','rowspan'].includes(name)){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isInteger(n)||n<1||n>(name==='colspan'?63:500))throw Error('Clipboard table has an invalid cell span.');attrs[name]=String(n);continue;}
  if(cell&&['colwidth','data-colwidth','width'].includes(name)){const parts=String(value).split(',');if(parts.length>63||parts.some(v=>!/^\d+$/.test(v)||Number(v)>2000))throw Error('Clipboard table has invalid column widths.');attrs.colwidth=parts.map(Number).join(',');continue;}
  if(cell&&name==='data-cell-fill'){attrs[name]=cellFormatting({backgroundColor:value}).backgroundColor;continue;}
  if(cell&&name==='data-cell-vertical'){attrs[name]=cellFormatting({verticalAlign:value}).verticalAlign;continue;}
  if(cell&&name==='data-cell-borders'){if(value.length>4096)throw Error('Clipboard border data is too large.');attrs[name]=JSON.stringify(cellFormatting({cellBorders:JSON.parse(value)}).cellBorders);continue;}
  if(paragraph&&['data-paragraphshading','data-paragraphborders'].includes(name)){if(value.length>4096)throw Error('Clipboard paragraph data is too large.');const key=name==='data-paragraphshading'?'paragraphShading':'paragraphBorders';attrs[name]=JSON.stringify(paragraphDecoration({[key]:JSON.parse(value)})[key]);continue;}
  if(tag==='table'&&name==='data-table-align'){if(!['left','center','right'].includes(value))throw Error('Clipboard table alignment is invalid.');attrs[name]=value;}
 }
 return attrs;
}
export function preparePasteFragment(fragment){
 fragment.querySelectorAll('script,style,iframe,object,embed,link,meta,base,img,svg,math,form,input,button').forEach(n=>n.remove());
 const nodes=[...fragment.querySelectorAll('*')];if(nodes.length>10000)throw Error('Clipboard HTML has too many elements.');
 for(const node of nodes){const accepted=pasteAttributes(node.tagName.toLowerCase(),Object.fromEntries([...node.attributes].map(a=>[a.name,a.value])));for(const attr of [...node.attributes])node.removeAttribute(attr.name);for(const [name,value]of Object.entries(accepted))node.setAttribute(name,value);}
 const tables=[...fragment.querySelectorAll('table')];if(tables.length>100)throw Error('Clipboard contains too many tables.');
 for(const table of tables){const rows=[...table.querySelectorAll('tr')].filter(row=>row.closest('table')===table);if(!rows.length||rows.length>500)throw Error('Clipboard table must have 1 to 500 rows.');
  const skeleton={type:'table',content:rows.map(row=>({type:'tableRow',content:[...row.children].filter(cell=>['TD','TH'].includes(cell.tagName)).map(cell=>({type:cell.tagName==='TH'?'tableHeader':'tableCell',attrs:{colspan:Number(cell.getAttribute('colspan')??1),rowspan:Number(cell.getAttribute('rowspan')??1),...(cell.hasAttribute('colwidth')?{colwidth:cell.getAttribute('colwidth').split(',').map(Number)}:{})}}))}))};tableGrid(skeleton);
 }
 return fragment;
}
/** Plain clipboard text keeps structural breaks without interpreting HTML as live DOM. */
export function plainPasteText(root){
 const blocks=new Set(['P','DIV','SECTION','ARTICLE','HEADER','FOOTER','H1','H2','H3','H4','H5','H6','LI','UL','OL','BLOCKQUOTE','PRE','TABLE','THEAD','TBODY','TFOOT','TR']);
 const walk=node=>{if(node.nodeType===3)return node.nodeValue??'';const tag=node.nodeName?.toUpperCase();if(['SCRIPT','STYLE','NOSCRIPT'].includes(tag))return '';if(tag==='BR')return '\n';let text='';for(const child of node.childNodes??[]){const value=walk(child);if(value&&blocks.has(child.nodeName?.toUpperCase())&&text&&!text.endsWith('\n'))text+='\n';text+=value;}if(['TD','TH'].includes(tag))return text+'\t';if(blocks.has(tag)&&text&&!text.endsWith('\n'))text+='\n';return text;};
 return walk(root).replace(/[\t ]+\n/g,'\n').replace(/^\n+|\n+$/g,'');
}
export async function readRichClipboard(nativeRead,browserClipboard){
 let payload;
 if(typeof nativeRead==='function')payload=await nativeRead();
 else if(browserClipboard?.read){let html='',text='';for(const item of await browserClipboard.read()){if(item.types.includes('text/html')&&!html)html=await(await item.getType('text/html')).text();if(item.types.includes('text/plain')&&!text)text=await(await item.getType('text/plain')).text();}payload={html,text};}
 else payload={html:'',text:await browserClipboard.readText()};
 if(!payload||typeof payload.html!=='string'||typeof payload.text!=='string')throw Error('Clipboard text could not be read.');
 if(payload.html.length+payload.text.length>2_000_000)throw Error('Clipboard text is too large. Paste a smaller selection.');
 if(!payload.html&&!payload.text)throw Error('The clipboard has no text or HTML. Copy text, then read the clipboard again.');
 return payload;
}
