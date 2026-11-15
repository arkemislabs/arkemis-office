import './common/lib/pdf-guard.mjs';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFHexString,PDFTextField,PDFCheckBox,PDFDropdown,PDFRadioGroup,PDFOptionList,PDFSignature,StandardFonts,rgb} from 'pdf-lib';
import {formFontSet, needsUnicode} from './folio/lib/unicode-text.mjs';
import {createPdfContent,validatePdfSource} from './pdf-document.mjs';
import {PDF_MAX_BYTES,pdfBytes,validatePdfContent} from './pdf-model.mjs';

const fail=message=>{throw new Error(message);};
function signedDocument(document){
 if(document.catalog.has(PDFName.of('Perms')))return true;
 return document.context.enumerateIndirectObjects().some(([,object])=>object instanceof PDFDict&&(object.has(PDFName.of('ByteRange'))||object.get(PDFName.of('Type'))===PDFName.of('Sig')))||document.getForm().getFields().some(field=>field instanceof PDFSignature&&field.acroField.dict.has(PDFName.of('V')));
}
function acroForm(document){return document.catalog.lookupMaybe(PDFName.of('AcroForm'),PDFDict);}
function rejectXfa(document){if(acroForm(document)?.has(PDFName.of('XFA')))fail('XFA forms are not supported. The original PDF is preserved.');}
function assertMergeSafe(document){
 const allowed=new Set(['Type','Pages','Version']);
 const unsupported=document.catalog.keys().find(key=>!allowed.has(key.decodeText()));
 if(unsupported)fail(`Cannot combine PDFs with ${unsupported.decodeText()} data without losing document semantics. The original files are preserved.`);
 for(const page of document.getPages()){
  if((page.node.Annots()?.size()??0)>0)fail('Cannot combine PDFs with existing annotations or form widgets yet. The original files are preserved.');
  if(['AA','B','StructParents','PresSteps','VP','Metadata','PieceInfo','SeparationInfo','AF'].some(key=>page.node.has(PDFName.of(key))))fail('Cannot combine PDFs with document-linked page semantics. The original files are preserved.');
 }
 for(const [,object] of document.context.enumerateIndirectObjects())if(object instanceof PDFDict&&(object.has(PDFName.of('ByteRange'))||object.get(PDFName.of('Type'))===PDFName.of('Sig')||object.get(PDFName.of('FT'))===PDFName.of('Sig')))fail('Cannot combine PDFs with digital signatures. The original files are preserved.');
}

/** Combine plain PDFs in input order. Catalog-level semantics are never silently discarded. */
export async function combinePdfs(inputs){
 if(!Array.isArray(inputs)||inputs.length<2||inputs.length>101)fail('Choose between two and 101 PDFs to combine.');
 if(inputs.some(input=>!(input instanceof Uint8Array)))fail('Each PDF input must be a byte array.');
 if(inputs.reduce((sum,input)=>sum+input.length,0)>PDF_MAX_BYTES)fail('Combined PDF inputs must total at most 10 MB.');
 const sources=[];let pages=0;
 for(const input of inputs){
  if(!new TextDecoder().decode(input.subarray(0,1024)).includes('%PDF-'))fail('A selected file is not a PDF.');
  const document=await PDFDocument.load(input,{updateMetadata:false});pages+=document.getPageCount();
  if(!document.getPageCount()||pages>1000)fail('Combined PDF must contain between 1 and 1000 pages.');
  assertMergeSafe(document);sources.push(document);
 }
 const combined=await PDFDocument.create();
 for(const source of sources)for(const page of await combined.copyPages(source,source.getPageIndices()))combined.addPage(page);
 combined.setProducer('Arkemis Folio');const bytes=await combined.save();
 if(bytes.length>PDF_MAX_BYTES)fail('Combined PDF output exceeds the 10 MB limit.');
 return createPdfContent(bytes,'Combined.pdf');
}

async function loadFormDocument(content){
 validatePdfContent(content);
 if(!content.pages.length)fail('Open a PDF before inspecting or filling form fields.');
 await validatePdfSource(content);
 // Fill the original source so native fields and independently editable Folio
 // overlays/rotations remain separate. Export applies those page edits later.
 const document=await PDFDocument.load(pdfBytes(content.sourceBase64),{updateMetadata:false});rejectXfa(document);
 return document;
}
function choiceOptions(field){return field.acroField.getOptions().map(({value,display})=>({value:value.decodeText(),label:(display??value).decodeText()}));}
function fieldMetadata(field,restricted){
 const type=field instanceof PDFTextField?'text':field instanceof PDFCheckBox?'checkbox':field instanceof PDFDropdown?'dropdown':field instanceof PDFRadioGroup?'radio':field instanceof PDFOptionList?'optionlist':field instanceof PDFSignature?'signature':'unsupported';
 const readOnly=restricted||field.isReadOnly()||type==='signature'||type==='unsupported';
 const result={name:field.getName(),type,value:'',readOnly,required:field.isRequired(),fillable:!readOnly};
 if(type==='text'){result.value=field.getText()??'';result.maxLength=field.getMaxLength()??null;result.multiline=field.isMultiline();}
 else if(type==='checkbox')result.value=field.isChecked();
 else if(type==='radio'){result.value=field.getSelected()??'';result.options=field.getOptions();}
 else if(type==='dropdown'||type==='optionlist'){
  const options=choiceOptions(field),selected=field.getSelected().map(value=>options.find(option=>option.value===value)?.label??value);
  result.options=options.map(option=>option.label);result.multiSelect=field.isMultiselect();result.value=type==='optionlist'||result.multiSelect?selected:selected[0]??'';if(type==='dropdown')result.editable=field.isEditable();
  if(new Set(result.options).size!==result.options.length||new Set(options.map(option=>option.value)).size!==options.length){result.readOnly=true;result.fillable=false;result.reason='Choice labels or export values are ambiguous; this field is read-only.';}
 }
 return result;
}
function fieldsOf(document){
 if(!acroForm(document))return [];
 const fields=document.getForm().getFields();if(fields.length>2000)fail('PDF form exceeds the 2000 field limit.');
 if(fields.reduce((count,field)=>count+field.acroField.getWidgets().length,0)>10000)fail('PDF form exceeds the 10,000 widget limit.');
 const names=new Set();for(const field of fields){const name=field.getName();if(!name||name.length>500||names.has(name))fail('PDF contains empty, duplicate or excessively long form field names.');names.add(name);}
 return fields;
}
/** Read native AcroForm values. Signature/unsupported fields are exposed as nonfillable. */
export async function inspectPdfForms(content){
 const document=await loadFormDocument(content),fields=fieldsOf(document);if(!fields.length)return [];
 const restricted=signedDocument(document);return fields.map(field=>{const metadata=fieldMetadata(field,restricted),widgets=field.acroField.getWidgets();if(widgets.length>1000)fail('A form field has too many widgets to inspect.');const supported=['text','checkbox','dropdown','radio'].includes(metadata.type);return {...metadata,designable:!restricted&&supported,...(restricted?{reason:'This PDF is signed or certified. Form design is unavailable.'}:!supported?{reason:'This field type cannot be designed with this tool.'}:{}),fontSize:Number(field.acroField.getDefaultAppearance()?.match(/([\d.]+)\s+Tf\b/)?.[1]??0),widgets:widgets.flatMap(widget=>{const ref=document.context.getObjectRef(widget.dict),source=document.getPages().findIndex(p=>p.ref===widget.P()||p.node.Annots()?.asArray().some(r=>r===ref));const model=content.pages.find(p=>p.sourceIndex===source&&!p.duplicateOf)??content.pages.find(p=>p.sourceIndex===source);if(!model)return [];const crop=document.getPage(source).getCropBox(),rect=widget.getRectangle();return [{pageId:model.id,x:rect.x-crop.x,y:crop.y+crop.height-rect.y-rect.height,width:rect.width,height:rect.height}];})};});
}

// PdfCraft source adaptation: 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT),
// crates/forms/src/author/{lifecycle,edit,tree}.rs: finite minimum rectangles,
// hierarchical-name collisions, terminal field lifecycle and flag updates.
// PDF objects/appearance generation are hosted by pdf-lib, not Rust/WASM.
// Full notice: assets/third-party-licenses/artcraft-reference.txt.
export async function designPdfForm(content,operation){
 if(!operation||!['add','update','delete'].includes(operation.type))fail('Choose a valid form design action.');
 const document=await loadFormDocument(content);if(signedDocument(document))fail('Form design would invalidate this signed or certified PDF. The original is preserved.');
 if(content.pages.length!==document.getPageCount()||content.pages.some((page,index)=>page.sourceIndex!==index))fail('Export and reopen the PDF after page structure changes before designing form fields. The current pages and source are preserved.');
 const fields=fieldsOf(document),form=document.getForm();let field;
 const properties=operation.type==='add'?Object.fromEntries(['required','readOnly','multiline','fontSize'].filter(k=>operation[k]!==undefined).map(k=>[k,operation[k]])):operation.properties??{};
 if(!properties||typeof properties!=='object'||Array.isArray(properties)||Object.keys(properties).some(k=>!['required','readOnly','multiline','fontSize'].includes(k)))fail('Unknown form field property.');
 for(const key of ['required','readOnly','multiline'])if(properties[key]!==undefined&&typeof properties[key]!=='boolean')fail('Form field flags must be true or false.');
 if(properties.fontSize!==undefined&&(!Number.isFinite(properties.fontSize)||properties.fontSize<0||properties.fontSize>144))fail('Font size must be between 0 (automatic) and 144 points.');
 if(operation.type==='add'){
  if(fields.length>=2000)fail('PDF form exceeds the 2000 field limit.');
  const {name,fieldType,pageId,rect}=operation;if(typeof name!=='string'||!name.trim()||name!==name.trim()||name.length>200||name.split('.').some(p=>!p.trim())||/[\x00-\x1f]/.test(name))fail('Use a nonempty field name with no empty sections or control characters.');
  if(fields.some(f=>f.getName()===name||f.getName().startsWith(name+'.')||name.startsWith(f.getName()+'.')))fail('A field with this name or a conflicting parent name already exists.');
  if(!['text','checkbox','dropdown','radio'].includes(fieldType))fail('This form field type cannot be created.');
  const model=content.pages.find(p=>p.id===pageId);if(!model)fail('The selected page does not exist.');if(content.pages.filter(p=>p.sourceIndex===model.sourceIndex).length!==1)fail('Form design on duplicated source pages is unavailable. Export and reopen the PDF first.');
  if(!rect||!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.x<0||rect.y<0||rect.width<4||rect.height<4||rect.x+rect.width>model.width||rect.y+rect.height>model.height)fail('The field must fit inside the page bounds and be at least 4 points wide and high.');
  const options=operation.options;if(['dropdown','radio'].includes(fieldType)&&(!Array.isArray(options)||options.length<(fieldType==='radio'?2:1)||options.length>100||new Set(options).size!==options.length||options.some(o=>typeof o!=='string'||!o.trim()||o.length>200||/[\r\n]/.test(o))))fail('Provide distinct, nonempty options (at least two for radio buttons).');
  if(fieldType==='radio'&&(options.length>20||rect.height/options.length<12))fail('Allow at least 12 points of height per radio option, with at most 20 options.');
  const source=document.getPage(model.sourceIndex),crop=source.getCropBox(),standard=await document.embedFont(StandardFonts.Helvetica),set=await formFontSet(document,standard,options??[]),font=set.font;if(font===standard)for(const option of options??[])try{font.encodeText(option);}catch{fail('Options must use characters supported by the standard PDF font.');}if(set.uni)for(const option of options??[])if(needsUnicode(option)&&!set.uni.canDraw(option))fail('Options must use characters supported by the standard PDF font or an installed system font.');
  const widget=(r)=>({x:crop.x+r.x+.5,y:crop.y+crop.height-r.y-r.height+.5,width:r.width-1,height:r.height-1,borderWidth:1,borderColor:rgb(.4,.4,.4),backgroundColor:rgb(1,1,1),textColor:rgb(.1,.1,.1),font});
  if(fieldType==='text'){field=form.createTextField(name);field.addToPage(source,widget(rect));}
  else if(fieldType==='checkbox'){field=form.createCheckBox(name);field.addToPage(source,widget(rect));}
  else if(fieldType==='dropdown'){field=form.createDropdown(name);field.addOptions(options);field.addToPage(source,widget(rect));}
  else{field=form.createRadioGroup(name);const row=rect.height/options.length,size=Math.min(20,row,rect.width);for(let i=0;i<options.length;i++)field.addOptionToPage(options[i],source,widget({x:rect.x,y:rect.y+i*row,width:size,height:size}));}
 }else{
  field=fields.find(f=>f.getName()===operation.name);if(!field)fail('This form field no longer exists. Refresh the fields.');
  if(!['text','checkbox','dropdown','radio'].includes(fieldMetadata(field,false).type))fail('This field type cannot be designed with this tool.');
 }
 if(operation.type==='delete'){
  // Remove actual widget references from page annotations. pdf-lib 1.17's
  // removeField mistakenly attempts to remove appearance-stream references.
  const widgets=field.acroField.getWidgets(),refs=new Set([field.ref,...widgets.map(w=>document.context.getObjectRef(w.dict)).filter(Boolean)]);
  for(const page of document.getPages())for(const ref of refs)page.node.removeAnnot(ref);
  const calculationOrder=form.acroForm.dict.lookupMaybe(PDFName.of('CO'),PDFArray);if(calculationOrder)for(let i=calculationOrder.size()-1;i>=0;i--)if(calculationOrder.get(i)===field.ref)calculationOrder.remove(i);
  form.acroForm.removeField(field.acroField);for(const ref of refs)document.context.delete(ref);
 }else{
  if(properties.multiline!==undefined&&!(field instanceof PDFTextField))fail('Multiline applies only to text fields.');
  if(properties.fontSize!==undefined&&!(field instanceof PDFTextField||field instanceof PDFDropdown))fail('Font size applies only to text and dropdown fields.');
  if(properties.required!==undefined)properties.required?field.enableRequired():field.disableRequired();
  if(properties.readOnly!==undefined)properties.readOnly?field.enableReadOnly():field.disableReadOnly();
  if(properties.multiline!==undefined)properties.multiline?field.enableMultiline():field.disableMultiline();
  if(properties.fontSize!==undefined)field.setFontSize(properties.fontSize);
  if(operation.type==='add'||properties.fontSize!==undefined||properties.multiline!==undefined){const font=await document.embedFont(StandardFonts.Helvetica);try{field.defaultUpdateAppearances(font);}catch{fail('The current field value cannot be displayed with the standard PDF font. Its original appearance is preserved.');}}
 }
 const bytes=await document.save({updateFieldAppearances:false});if(bytes.length>PDF_MAX_BYTES)fail('Designed PDF output exceeds the 10 MB limit.');const result=await createPdfContent(bytes,content.sourceName);return validatePdfContent({...structuredClone(content),sourceBase64:result.sourceBase64});
}
function validateUpdate(field,metadata,value,font,uni=null){
 const name=metadata.name;
 if(metadata.readOnly)fail(`Form field “${name}” is read-only or cannot be filled (${metadata.type}).`);
 const text=(value,multiline=false)=>{if(typeof value!=='string'||value.length>10000)fail(`Form field “${name}” requires text of at most 10,000 characters.`);const shown=multiline?value.replace(/[\r\n]/g,''):value;if(uni&&needsUnicode(shown)){if(!uni.canDraw(shown))fail(`Form field “${name}” contains characters that neither the standard PDF appearance font nor any installed system font can draw.`);}else try{font.encodeText(shown);}catch{fail(`Form field “${name}” contains characters unsupported by the standard PDF appearance font.`);}};
 if(metadata.type==='text'){
  text(value,metadata.multiline);if(metadata.maxLength!==null&&value.length>metadata.maxLength)fail(`Form field “${name}” exceeds its maximum text length of ${metadata.maxLength}.`);
  if(!metadata.multiline&&/[\r\n]/.test(value))fail(`Form field “${name}” is a single-line text field.`);
 }else if(metadata.type==='checkbox'){if(typeof value!=='boolean')fail(`Checkbox field “${name}” requires true or false.`);}
 else if(metadata.type==='radio'){text(value);if(value!==''&&!metadata.options.includes(value))fail(`Unknown option for form field “${name}”.`);}
 else{
  const arrayRequired=metadata.type==='optionlist'||metadata.multiSelect;
  if(arrayRequired?!Array.isArray(value):typeof value!=='string')fail(`Form field “${name}” requires ${arrayRequired?'an array of selected options':'one selected option'}.`);
  const selected=Array.isArray(value)?value:value===''?[]:[value];
  if(!metadata.multiSelect&&selected.length>1)fail(`Form field “${name}” accepts only one option.`);
  if(new Set(selected).size!==selected.length)fail(`Duplicate options for form field “${name}”.`);
  for(const option of selected){text(option);if(!metadata.options.includes(option)&&!(metadata.type==='dropdown'&&metadata.editable))fail(`Unknown option for form field “${name}”.`);}
 }
}
/** Validate the complete update set before changing any field; never flatten native fields. */
export async function fillPdfForms(content,updates){
 if(!updates||typeof updates!=='object'||Array.isArray(updates)||![Object.prototype,null].includes(Object.getPrototypeOf(updates)))fail('Form updates must map field names to typed values.');
 const entries=Object.entries(updates);if(!entries.length||entries.length>2000)fail('Provide between 1 and 2000 form field updates.');
 const document=await loadFormDocument(content),fields=fieldsOf(document);
 if(signedDocument(document))fail('Filling a signed or certified PDF would invalidate its digital signatures. The original is preserved.');
 const byName=new Map(fields.map(field=>[field.getName(),field])),standard=await document.embedFont(StandardFonts.Helvetica),set=await formFontSet(document,standard,entries.map(([,value])=>typeof value==='string'?value:Array.isArray(value)?value.join(' '):'')),font=set.font;
 const changes=entries.map(([name,value])=>{const field=byName.get(name);if(!field)fail(`Form field “${name}” does not exist.`);const metadata=fieldMetadata(field,false);validateUpdate(field,metadata,value,font,set.uni);return {field,metadata,value};});
 for(const {field,metadata,value} of changes){
  if(metadata.type==='text')field.setText(value);
  else if(metadata.type==='checkbox')value?field.check():field.uncheck();
  else if(value===''||Array.isArray(value)&&!value.length)field.clear();
  else field.select(value);
 }
 // Update only changed fields, retaining appearance streams of unrelated fields.
 for(const {field} of changes)field.defaultUpdateAppearances(font);
 // pdf-lib uses display labels in /V when selecting choices. Appearances need
 // those labels, but native form data must retain the distinct export values.
 for(const {field,metadata,value} of changes)if(metadata.type==='dropdown'||metadata.type==='optionlist'){
  const labels=Array.isArray(value)?value:value===''?[]:[value],options=choiceOptions(field),values=labels.map(label=>PDFHexString.fromText(options.find(option=>option.label===label)?.value??label));
  if(values.length)field.acroField.dict.set(PDFName.of('V'),values.length===1?values[0]:document.context.obj(values));
 }
 const bytes=await document.save({updateFieldAppearances:false});
 if(bytes.length>PDF_MAX_BYTES)fail('Filled PDF output exceeds the 10 MB limit.');
 const result=await createPdfContent(bytes,content.sourceName);
 return validatePdfContent({...structuredClone(content),sourceBase64:result.sourceBase64});
}

