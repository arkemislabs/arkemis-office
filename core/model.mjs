import {paragraphLayout} from './rich-dialogs.mjs';
import {validateTables} from './grid-tables.mjs';
import {paragraphDecoration} from './rich-paragraph.mjs';
import {assertMergedEdits} from './grid-geometry.mjs';
import {validatePrismElement,formatTextRange} from './prism-content.mjs';
import {validateCellStyle} from './grid-cell-format.mjs';
import {validateNamedRanges} from './grid-workbook-references.mjs';
import {validateXlsxLayout} from './grid-xlsx-layout.mjs';
import {validatePdfContent,applyPdfOperation} from './pdf-model.mjs';
import { parseAddress,assertSpillEdits } from './formulas.mjs';
import {replaceText} from './automation.mjs';
import {formatRichText,formatParagraph} from './rich-commands.mjs';
import {validatePivotDefinition} from './pivots.mjs';
import {layerElements} from './prism-helpers.mjs';
import {editSlides} from './prism-slides.mjs';
import {transformElements} from './prism-transform.mjs';
import {apps as foundations} from './generated/apps.mjs';
const kinds=new Set(['quill','grid','prism','slate','folio']);
export const uid=()=>globalThis.crypto.randomUUID();
export function createFile(kind,title,options={}) {
 if(!kinds.has(kind))throw new Error('Invalid kind');
 if(options.schema===2)return createFileV2(kind,title);
 const now=new Date().toISOString(),id=uid(),sheetId=uid(),slideId=uid();
 const content=kind==='folio'?{sourceBase64:'',sourceName:'',pages:[],activePageId:''}:kind==='grid'?{sheets:[{id:sheetId,name:'Sheet 1',cells:{},rows:200,columns:26}],activeSheetId:sheetId}:kind==='prism'?{slides:[{id:slideId,background:'#ffffff',elements:[{id:uid(),type:'text',x:80,y:100,w:800,h:120,text:'A new perspective',fontSize:54,color:'#202331',bold:true},{id:uid(),type:'text',x:84,y:250,w:720,h:90,text:'Your story starts here.',fontSize:24,color:'#747b8e'}],notes:''}],activeSlideId:slideId}:{doc:{type:'doc',content:[{type:'paragraph'}]},...(kind==='slate'?{tags:[]}: {})};
 return {id,schema:1,kind,title:title||({quill:'Untitled document',grid:'Untitled workbook',prism:'Untitled presentation',slate:'Untitled note',folio:'Untitled PDF'}[kind]),createdAt:now,updatedAt:now,revision:0,starred:false,content,links:[]};
}
export function validateFile(file){
 if(file&&typeof file==='object'&&file.schema===2)return validateFileV2(file);
 if(!file||typeof file!=='object'||file.schema!==1)throw new Error('Unsupported document schema');
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(file.id))throw new Error('Invalid document id');
 if(!kinds.has(file.kind))throw new Error('Invalid document kind');
 if(typeof file.title!=='string'||file.title.length>240)throw new Error('Invalid title');
 if(!Number.isSafeInteger(file.revision)||file.revision<0)throw new Error('Invalid revision');
 if(JSON.stringify(file).length>30_000_000)throw new Error('Document exceeds 30 MB limit');
 if(!file.content||typeof file.content!=='object')throw new Error('Missing document content');
 const c=file.content;
 if(file.kind==='folio'){validatePdfContent(c);}else if(file.kind==='grid'){
  if(c.dateSystem!==undefined&&c.dateSystem!==1900&&c.dateSystem!==1904)throw new Error('Invalid workbook date system');
  if(!Array.isArray(c.sheets)||!c.sheets.length||c.sheets.length>100)throw new Error('Invalid sheets');
  const ids=new Set();for(const s of c.sheets){if(typeof s.id!=='string'||ids.has(s.id)||typeof s.name!=='string'||!s.cells||typeof s.cells!=='object'||!Number.isInteger(s.rows)||s.rows<1||s.rows>100000||!Number.isInteger(s.columns)||s.columns<1||s.columns>1000)throw new Error('Invalid sheet');ids.add(s.id);
   for(const [address,cell] of Object.entries(s.cells)){const {row,col}=parseAddress(address);if(row>=100000||col>=1000||!cell||typeof cell.value!=='string'||cell.value.length>32767)throw new Error('Invalid cell');validateCellStyle(cell);}
   validateXlsxLayout(s.xlsxLayout);if(s.pivot!==undefined)validatePivotDefinition(s.pivot);
  }if(!ids.has(c.activeSheetId))throw new Error('Invalid active sheet');validateNamedRanges(c);validateTables(c);
 }else if(file.kind==='prism'){
  if(!Array.isArray(c.slides)||c.slides.length>500)throw new Error('Invalid slides');
  const ids=new Set();for(const s of c.slides){if(typeof s.id!=='string'||ids.has(s.id)||!Array.isArray(s.elements)||s.elements.length>500||typeof s.background!=='string'||(s.hidden!==undefined&&typeof s.hidden!=='boolean')||(s.name!==undefined&&(typeof s.name!=='string'||s.name.length>240)))throw new Error('Invalid slide');ids.add(s.id);
   for(const e of s.elements)if(!['text','shape','image'].includes(e.type)||!['x','y','w','h'].every(k=>Number.isFinite(e[k]))||e.w<=0||e.h<=0||(e.rotation!==undefined&&!Number.isFinite(e.rotation))||['flipH','flipV'].some(k=>e[k]!==undefined&&typeof e[k]!=='boolean'))throw new Error('Invalid slide element');for(const e of s.elements)validatePrismElement(e);
  }if(c.slides.length?!ids.has(c.activeSlideId):c.activeSlideId!=='')throw new Error('Invalid active slide');
 }else {
  if(c.doc?.type!=='doc')throw new Error('Invalid rich document');
  let count=0;const nodes=new Set(['doc','text','paragraph','heading','bulletList','orderedList','listItem','blockquote','hardBreak','horizontalRule','codeBlock','table','tableRow','tableCell','tableHeader','image','pageBreak','wordField']);
  function check(node,depth=0){if(!node||typeof node!=='object'||!nodes.has(node.type)||depth>60||++count>100000)throw new Error('Invalid rich document node');
   if(node.type==='wordField'&&!['PAGE','NUMPAGES'].includes(node.attrs?.kind))throw new Error('Invalid page field');
   if(node.text!==undefined&&typeof node.text!=='string')throw new Error('Invalid rich text');if(node.type==='paragraph'||node.type==='heading'){paragraphDecoration(node.attrs??{});paragraphLayout(Object.fromEntries(Object.entries(node.attrs??{}).filter(([key])=>['indentLeft','indentRight','indentFirstLine','lineHeight','spaceBefore','spaceAfter','textAlign'].includes(key))));}
   if(node.content!==undefined){if(!Array.isArray(node.content))throw new Error('Invalid rich document children');for(const child of node.content)check(child,depth+1);}
   if(node.marks!==undefined&&(!Array.isArray(node.marks)||node.marks.some(m=>!m||typeof m.type!=='string')))throw new Error('Invalid rich text marks');
  }check(c.doc);
  if(c.headerFooter!==undefined){
   const hf=c.headerFooter;if(!hf||typeof hf!=='object'||Array.isArray(hf)||Object.keys(hf).some(k=>!['differentFirstPage','evenAndOdd','headers','footers'].includes(k)))throw new Error('Invalid header/footer settings');
   for(const key of ['differentFirstPage','evenAndOdd'])if(hf[key]!==undefined&&typeof hf[key]!=='boolean')throw new Error('Invalid header/footer setting');
   for(const key of ['headers','footers'])if(hf[key]!==undefined){const parts=hf[key];if(!parts||typeof parts!=='object'||Array.isArray(parts)||Object.keys(parts).some(k=>!['default','first','even'].includes(k)))throw new Error('Invalid header/footer parts');for(const part of Object.values(parts)){if(part?.type!=='doc')throw new Error('Invalid header/footer document');check(part);}}
  }
  if(c.tags!==undefined&&(!Array.isArray(c.tags)||c.tags.some(t=>typeof t!=='string')))throw new Error('Invalid note tags');
  if(c.page!==undefined&&(!c.page||!['A4','Letter'].includes(c.page.size)||!['portrait','landscape'].includes(c.page.orientation)||!['normal','narrow','wide'].includes(c.page.margins)))throw new Error('Invalid page layout');
  for(const key of ['notebook','section'])if(c[key]!==undefined&&(typeof c[key]!=='string'||c[key].length>100))throw new Error('Invalid notebook or section');
 }
 if(!Array.isArray(file.links)||file.links.length>200)throw new Error('Invalid links');
 for(const link of file.links){if(typeof link.sourceId!=='string'||typeof link.sheetId!=='string'||typeof link.label!=='string')throw new Error('Invalid link');parseAddress(link.address);}
 return file;
}
export function applyCommand(file,command){
 if(file&&typeof file==='object'&&file.schema===2)return applyCommandV2(file,command);
 validateFile(file);if(command.baseRevision!==file.revision)throw new Error('Revision conflict: reload the document');
 const next=structuredClone(file);
 if(command.type==='rename')next.title=command.title;
 else if(command.type==='replace_content')next.content=structuredClone(command.content);
 else if(command.type==='pdf_operation'&&next.kind==='folio')next.content=applyPdfOperation(next.content,command.operation);
 else if(command.type==='replace_text'&&['quill','slate'].includes(next.kind))replaceText(next.content,command);
 else if(command.type==='format_rich_text'&&['quill','slate'].includes(next.kind))next.content=formatRichText(next.content,command);
 else if(command.type==='format_paragraph'&&['quill','slate'].includes(next.kind))next.content=formatParagraph(next.content,command);
 else if(command.type==='format_slide_text'&&next.kind==='prism'){
  const slide=next.content.slides.find(s=>s.id===command.slideId),index=slide?.elements.findIndex(e=>e.id===command.elementId)??-1;
  if(!slide||index<0)throw new Error('Slide text element not found');const element=slide.elements[index];
  if(element.type!=='text')throw new Error('Text formatting requires a text element');
  const text=element.text??'',{from,to}=command;
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>text.length)throw new Error('Invalid slide text range');
  const splitsSurrogate=i=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])&&/[\uDC00-\uDFFF]/.test(text[i]);
  if(splitsSurrogate(from)||splitsSurrogate(to))throw new Error('Text range splits a Unicode character');
  if(typeof command.expectedText!=='string'||text.slice(from,to)!==command.expectedText)throw new Error('Text conflict: reload the document');
  slide.elements[index]=formatTextRange(element,from,to,command.formatting);
 }
 else if(command.type==='slide_operation'&&next.kind==='prism')next.content=editSlides(next.content,command.operation);
 else if(command.type==='transform_slide_elements'&&next.kind==='prism'){
  const slide=next.content.slides.find(s=>s.id===command.slideId);if(!slide)throw new Error('Slide not found');
  slide.elements=transformElements(slide.elements,command.ids,command.transform);
 }
 else if(command.type==='order_slide_elements'&&next.kind==='prism'){
  const slide=next.content.slides.find(s=>s.id===command.slideId);
  if(!slide)throw new Error('Slide not found');
  if(!Array.isArray(command.ids)||!command.ids.length||command.ids.length>500||new Set(command.ids).size!==command.ids.length||command.ids.some(id=>typeof id!=='string'||!slide.elements.some(e=>e.id===id)))throw new Error('Invalid slide element selection');
  slide.elements=layerElements(slide.elements,command.ids,command.direction);
 }
 else if(command.type==='set_cells'&&next.kind==='grid'){
  const sheet=next.content.sheets.find(s=>s.id===command.sheetId);if(!sheet)throw new Error('Sheet not found');const beforeCells=sheet.cells;sheet.cells={...beforeCells};
  for(const [address,cell] of Object.entries(command.cells??{})){const {row,col}=parseAddress(address);sheet.cells[address.replaceAll('$','').toUpperCase()]=cell;sheet.rows=Math.max(sheet.rows,row+1);sheet.columns=Math.max(sheet.columns,col+1);}
  validateFile(next);assertMergedEdits(beforeCells,sheet.cells,sheet.xlsxLayout);assertSpillEdits(beforeCells,sheet.cells,{dateSystem:next.content.dateSystem,sheets:next.content.sheets,sheetId:sheet.id,namedRanges:next.content.namedRanges});
 }else throw new Error('Unsupported command');
 next.revision++;next.updatedAt=new Date().toISOString();return validateFile(next);
}
export function textOf(node){return node?.text??(node?.content??[]).map(textOf).join(['doc','bulletList','orderedList','listItem','table','tableRow'].includes(node?.type)?'\n':'');}
export function demoFiles(){
 const doc=createFile('quill','A little room for big ideas');
 doc.content.doc={type:'doc',content:[{type:'heading',attrs:{level:1},content:[{type:'text',text:'A little room for big ideas.'}]},{type:'paragraph',content:[{type:'text',text:'A place to think clearly, make something useful, and keep your work yours.'}]},{type:'heading',attrs:{level:2},content:[{type:'text',text:'Make yourself at home'}]},{type:'paragraph',content:[{type:'text',text:'Write with Quill. Work things out in Grid. Tell a story with Prism. Catch a thought in Slate. Everything saves on this computer, with no account to get in the way.'}]},{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Good tools leave more room for the work.'}]}]},{type:'paragraph',content:[{type:'text',text:'This is an editable welcome document. Select some text to try formatting, or create something new from the library.'}]}]};doc.starred=true;
 const grid=createFile('grid','A simple project budget');const s=grid.content.sheets[0];
 const rows=[['Item','Planned','Actual'],['Design','1200','1050'],['Production','2400','2180'],['Launch','800','650'],['Total','=SUM(B2:B4)','=SUM(C2:C4)'],['Remaining','','=B5-C5']];
 rows.forEach((r,ri)=>r.forEach((value,ci)=>s.cells[String.fromCharCode(65+ci)+(ri+1)]={value,bold:ri===0||ri===4,background:ri===0?'#eae8fc':undefined}));
 const slides=createFile('prism','Good things start with a thought');slides.content.slides[0].elements[0].text='Small beginnings.\nBig possibilities.';slides.content.slides[0].background='#edeafa';slides.content.slides[0].elements[1].text='Arkemis Studio / A space for your next idea';
 const note=createFile('slate','Ideas for a quieter workspace');note.content.tags=['Ideas','Personal'];note.content.doc={type:'doc',content:[{type:'heading',attrs:{level:1},content:[{type:'text',text:'A quieter workspace'}]},{type:'bulletList',content:['Keep the tools. Lose the distractions.','Make important things easy to find.','Build a little breathing room into the day.'].map(text=>({type:'listItem',content:[{type:'paragraph',content:[{type:'text',text}]}]}))}]};
 return [doc,grid,slides,note];
}


// Schema 2 (docs/architecture.md section 18): an app's foundation (core/<app>/schema.mjs, indexed in
// core/generated/apps.mjs) owns the content model. Its schema module exports createContent(title),
// validateContent(content) and optionally applyLegacyCommand(content, command) for the /v1 bridge
// command types; engine edits go through the kernel Session instead. Schema 1 is unchanged above.
const titles={quill:'Untitled document',grid:'Untitled workbook',prism:'Untitled presentation',slate:'Untitled note',folio:'Untitled PDF'};
function schemaModule(kind){
 const schema=foundations?.[kind]?.schema;
 if(!schema||typeof schema.validateContent!=='function')throw new Error('Unsupported document schema');
 return schema;
}
function createFileV2(kind,title){
 const schema=schemaModule(kind);
 if(typeof schema.createContent!=='function')throw new Error('Unsupported document schema');
 const now=new Date().toISOString();
 return validateFileV2({id:uid(),schema:2,kind,title:title||titles[kind],createdAt:now,updatedAt:now,revision:0,starred:false,content:schema.createContent(title||titles[kind]),links:[]});
}
function validateFileV2(file){
 if(!kinds.has(file.kind))throw new Error('Invalid document kind');
 const schema=schemaModule(file.kind);
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(file.id))throw new Error('Invalid document id');
 if(typeof file.title!=='string'||file.title.length>240)throw new Error('Invalid title');
 if(!Number.isSafeInteger(file.revision)||file.revision<0)throw new Error('Invalid revision');
 if(JSON.stringify(file).length>30_000_000)throw new Error('Document exceeds 30 MB limit');
 if(!file.content||typeof file.content!=='object')throw new Error('Missing document content');
 schema.validateContent(file.content);
 if(!Array.isArray(file.links)||file.links.length>200)throw new Error('Invalid links');
 for(const link of file.links){if(typeof link.sourceId!=='string'||typeof link.sheetId!=='string'||typeof link.label!=='string')throw new Error('Invalid link');parseAddress(link.address);}
 return file;
}
function applyCommandV2(file,command){
 validateFileV2(file);if(command.baseRevision!==file.revision)throw new Error('Revision conflict: reload the document');
 const next=structuredClone(file);
 if(command.type==='rename')next.title=command.title;
 else if(command.type==='replace_content')next.content=structuredClone(command.content);
 else{const schema=schemaModule(next.kind);if(typeof schema.applyLegacyCommand!=='function')throw new Error('Unsupported command');next.content=schema.applyLegacyCommand(next.content,command);}
 next.revision++;next.updatedAt=new Date().toISOString();return validateFileV2(next);
}
