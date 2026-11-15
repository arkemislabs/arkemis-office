import {evaluateSheet} from './formulas.mjs';
export const commandCatalog=[
 {type:'format_slide_text',kinds:['prism'],fields:{slideId:'stable slide ID',elementId:'stable text element ID',from:'UTF-16 start offset',to:'UTF-16 exclusive end offset',expectedText:'exact selected text',formatting:'fontFamily, fontSize in points, bold, italic, underline, color #RRGGBB; preserves surrounding runs'}},
 {type:'slide_operation',kinds:['prism'],fields:{operation:'{type:duplicate|delete|hide|move|rename|notes,ids:[stable slide IDs],to?:insertion index,hidden?:boolean,name?:string,notes?:string}'}},
 {type:'transform_slide_elements',kinds:['prism'],fields:{slideId:'stable slide identifier',ids:'nonempty unique existing element IDs',transform:'{type:rotate,degrees?:absolute angle,by?:relative angle} or {type:flip,axis:horizontal|vertical}; true mirror also negates rotation; or {type:size-position,x?,y?,w?,h?,rot?,scaleW?,scaleH?,lockAspect?} with geometry in points and scaling in percent'}},
 {type:'order_slide_elements',kinds:['prism'],fields:{slideId:'stable slide identifier',ids:'nonempty unique existing element IDs',direction:'front, back, forward, backward; preserves relative selection order'}},
 {type:'pdf_ocr',kinds:['folio'],fields:{pageId:'stable page identifier; local English OCR adds searchable text without replacing the scanned image'}},
 {type:'format_rich_text',kinds:['quill','slate'],fields:{path:'exact text node child indexes from doc',from:'UTF-16 start offset',to:'UTF-16 exclusive end offset',expectedText:'exact selected text',formatting:'bold/italic/underline/strike/code booleans; fontFamily (safe name <=200 chars), fontSize (6–192 points), color/backgroundColor (#RRGGBB), verticalAlign (sub/super); null clears textStyle attributes'}},
 {type:'format_paragraph',kinds:['quill','slate'],fields:{path:'paragraph or heading child indexes from doc',expectedText:'concatenated descendant text with no added separators',formatting:'textAlign left/center/right/justify, lineHeight multiplier 0.8–3, spaceBefore/spaceAfter points 0–96; indentLeft/indentRight points 0–720; indentFirstLine points -720–720 (negative is hanging); paragraphShading #RRGGBB or auto; paragraphBorders {top/bottom/left/right/between:{style,width in points,color,space}}; null clears an attribute'}},
 {type:'pdf_replace_text',kinds:['folio'],fields:{pageId:'stable PDF page identifier',objectIndex:'index from text-objects inspection',expectedText:'exact original object text',text:'replacement supported by original font; one object, no paragraph reflow'}},
 {type:'pdf_design_form',kinds:['folio'],fields:{operation:'add text/checkbox/dropdown/radio field with name, pageId and top-left crop-relative rect in points; update field properties or delete by name; signed/XFA documents rejected'}},
 {type:'pdf_fill_forms',kinds:['folio'],fields:{updates:'field name to typed value; inspect /v1/documents/:id/forms first; signed/read-only fields rejected'}},
 {type:'pdf_operation',kinds:['folio'],fields:{operation:'select, rotate, move, delete, duplicate, add-overlay, update-overlay, delete-overlay, bookmark-add, bookmark-update, bookmark-move, bookmark-delete; stable page/overlay/bookmark IDs'}},
 {type:'rename',kinds:['quill','grid','prism','slate','folio'],fields:{title:'string (max 240)'}},
 {type:'set_cells',kinds:['grid'],fields:{sheetId:'sheet identifier',cells:'address to typed cell map'}},
 {type:'replace_text',kinds:['quill','slate'],fields:{path:'nonnegative integer child indexes from doc',from:'UTF-16 start offset',to:'UTF-16 end offset',expectedText:'exact previous text',text:'replacement text'}},
 {type:'replace_content',kinds:['quill','grid','prism','slate','folio'],fields:{content:'complete native editor content; validated before commit'}}
];
export function documentStructure(file){
 const result={documentId:file.id,kind:file.kind,revision:file.revision,title:file.title,content:structuredClone(file.content),textNodes:[]};
 if(file.kind==='quill'||file.kind==='slate'){
  const walk=(node,path)=>{if(node.type==='text')result.textNodes.push({path,text:node.text??'',length:(node.text??'').length,offsetUnit:'utf16'});node.content?.forEach((child,i)=>walk(child,[...path,i]));};walk(file.content.doc,[]);
 }
 if(file.kind==='grid')result.derivedSpills=file.content.sheets.map(sheet=>{const calculation=evaluateSheet(sheet.cells,{...file.content,sheetId:sheet.id});return {sheetId:sheet.id,arrays:[...calculation.spills].map(([anchor,spill])=>({anchor,range:spill.range,rows:spill.rows,columns:spill.columns,values:Array.from({length:spill.rows},(_,r)=>spill.array.slice(r*spill.columns,(r+1)*spill.columns).map(v=>v?.arrayError?{error:v.arrayError}:v))}))};});
 return result;
}
export function replaceText(content,command){
 if(!Array.isArray(command.path)||!command.path.length||command.path.length>60||command.path.some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('Invalid text node path');
 let node=content.doc;for(const index of command.path){node=node?.content?.[index];if(!node)throw new Error('Text node path no longer exists');}
 if(node.type!=='text'||typeof node.text!=='string')throw new Error('Path must identify a text node');
 const {from,to,text,expectedText}=command;
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to>node.text.length||typeof text!=='string'||text.length>1_000_000||typeof expectedText!=='string')throw new Error('Invalid text replacement');
 const splitsPair=index=>index>0&&index<node.text.length&&/[\uD800-\uDBFF]/.test(node.text[index-1])&&/[\uDC00-\uDFFF]/.test(node.text[index]);
 if(splitsPair(from)||splitsPair(to))throw new Error('Text offsets must not split a Unicode surrogate pair');
 if(node.text.slice(from,to)!==expectedText)throw new Error('Text conflict: inspect the current document before editing');
 node.text=node.text.slice(0,from)+text+node.text.slice(to);
 // Empty ProseMirror text nodes are invalid. Preserve the surrounding paragraph.
 if(!node.text){let parent=content.doc;for(const index of command.path.slice(0,-1))parent=parent.content[index];parent.content.splice(command.path.at(-1),1);}
}

