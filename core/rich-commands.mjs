import {fontFamilyCSS} from './font-catalog.mjs';
import {paragraphDecoration} from './rich-paragraph.mjs';
const fail=message=>{throw new Error(message);};
const markKeys=new Set(['bold','italic','underline','strike','code']);
const styleKeys=new Set(['fontFamily','fontSize','color','backgroundColor','verticalAlign']);
const paragraphKeys=new Set(['textAlign','lineHeight','spaceBefore','spaceAfter','paragraphShading','paragraphBorders','indentLeft','indentRight','indentFirstLine']);
function formatting(value,paragraph=false){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||!Object.keys(value).length)fail('Formatting must be a nonempty plain object.');
 if(paragraph)paragraphDecoration(value);
 for(const [key,item] of Object.entries(value)){
  if(paragraph?!paragraphKeys.has(key):!markKeys.has(key)&&!styleKeys.has(key))fail(`Unsupported formatting property: ${key}`);
  if(markKeys.has(key)){if(typeof item!=='boolean')fail(`${key} must be true or false.`);continue;}
  if(item===null)continue;
  if(key==='fontFamily'&&(typeof item!=='string'||!fontFamilyCSS(item)))fail('Invalid font family.');
  if(['color','backgroundColor'].includes(key)&&(typeof item!=='string'||!/^#[0-9a-f]{6}$/i.test(item)))fail('Colors must use #RRGGBB.');
  if(key==='verticalAlign'&&!['sub','super'].includes(item))fail('Vertical alignment must be sub, super or null.');
  if(key==='textAlign'&&!['left','center','right','justify'].includes(item))fail('Invalid paragraph alignment.');
  const range={fontSize:[6,192],lineHeight:[.8,3],spaceBefore:[0,96],spaceAfter:[0,96],indentLeft:[0,720],indentRight:[0,720],indentFirstLine:[-720,720]}[key];
  if(range&&(typeof item!=='number'||!Number.isFinite(item)||item<range[0]||item>range[1]))fail(`Invalid ${key}: expected a number between ${range[0]} and ${range[1]}.`);
 }
 return value;
}
function locate(content,path){
 if(!Array.isArray(path)||!path.length||path.length>60||path.some(index=>!Number.isSafeInteger(index)||index<0))fail('Invalid rich text node path.');
 let node=content.doc,parent;
 for(const index of path){parent=node;node=node?.content?.[index];if(!node)fail('Rich text node path no longer exists.');}
 return {node,parent,index:path.at(-1)};
}
const plainText=node=>node.text??(node.content??[]).map(plainText).join('');

/** Format one direct text-node range, preserving everything outside it. */
export function formatRichText(content,command){
 const values=formatting(command.formatting),{node}=locate(content,command.path),{from,to,expectedText}=command;
 if(node.type!=='text'||typeof node.text!=='string')fail('Path must identify a text node.');
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>node.text.length||typeof expectedText!=='string')fail('Invalid formatting range.');
 const splitsPair=index=>index>0&&index<node.text.length&&/[\uD800-\uDBFF]/.test(node.text[index-1])&&/[\uDC00-\uDFFF]/.test(node.text[index]);
 if(splitsPair(from)||splitsPair(to))fail('Formatting offsets must not split a Unicode surrogate pair.');
 if(node.text.slice(from,to)!==expectedText)fail('Text conflict: inspect the current document before formatting.');
 const result=structuredClone(content),target=locate(result,command.path),selected={...target.node,text:expectedText};
 let marks=structuredClone(selected.marks??[]);
 for(const [key,value] of Object.entries(values))if(markKeys.has(key)){marks=marks.filter(mark=>mark.type!==key);if(value)marks.push({type:key});}
 if(Object.keys(values).some(key=>styleKeys.has(key))){
  const attrs=Object.assign({},...marks.filter(mark=>mark.type==='textStyle').map(mark=>mark.attrs??{}));
  for(const [key,value] of Object.entries(values))if(styleKeys.has(key)){if(value===null)delete attrs[key];else attrs[key]=key==='fontFamily'?value.trim():value;}
  marks=marks.filter(mark=>mark.type!=='textStyle');if(Object.keys(attrs).length)marks.push({type:'textStyle',attrs});
 }
 if(marks.length)selected.marks=marks;else delete selected.marks;
 const pieces=[];if(from)pieces.push({...target.node,text:node.text.slice(0,from)});pieces.push(selected);if(to<node.text.length)pieces.push({...target.node,text:node.text.slice(to)});
 target.parent.content.splice(target.index,1,...pieces);return result;
}
/** expectedText is concatenated descendant text, without inserted separators. */
export function formatParagraph(content,command){
 const values=formatting(command.formatting,true),{node}=locate(content,command.path);
 if(!['paragraph','heading'].includes(node.type))fail('Path must identify a paragraph or heading.');
 if(typeof command.expectedText!=='string'||plainText(node)!==command.expectedText)fail('Text conflict: inspect the current paragraph before formatting.');
 const result=structuredClone(content),target=locate(result,command.path).node,attrs={...target.attrs};
 for(const [key,value] of Object.entries(values)){if(value===null)delete attrs[key];else attrs[key]=structuredClone(value);}
 if(Object.keys(attrs).length)target.attrs=attrs;else delete target.attrs;return result;
}

