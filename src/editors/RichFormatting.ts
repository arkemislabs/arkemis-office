import {Extension,type Editor} from '@tiptap/core';
import {closeHistory} from '@tiptap/pm/history';
import {paragraphDecoration,paragraphDecorationStyle,paragraphDecorationTransaction} from '../../core/rich-paragraph.mjs';
type DecorationKey='paragraphShading'|'paragraphBorders';
const decorationHTML=(attrs:Record<string,unknown>,key:DecorationKey)=>{try{const value=paragraphDecoration(attrs)[key];return value!=null?{['data-'+key.toLowerCase()]:JSON.stringify(value),style:paragraphDecorationStyle({[key]:value})}:{};}catch{return {};}};
const decorationParse=(element:HTMLElement,key:DecorationKey)=>{try{return paragraphDecoration({[key]:JSON.parse(element.getAttribute('data-'+key.toLowerCase())??'null')})[key]??null;}catch{return null;}};
export const fontSizes=[6,8,9,10,11,12,14,16,18,20,24,28,32,36,48,54,72,96,120,144,192];
export function nextFontSize(value:number,direction:1|-1){return direction===1?(fontSizes.find(size=>size>value)??192):([...fontSizes].reverse().find(size=>size<value)??6);}
const finite=(value:unknown,min:number,max:number)=>value!==null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):null;
export const ParagraphFormatting=Extension.create({
 name:'paragraphFormatting',
 addGlobalAttributes(){return [{types:['paragraph','heading'],attributes:{
  paragraphShading:{default:null,parseHTML:element=>decorationParse(element,'paragraphShading'),renderHTML:attrs=>decorationHTML(attrs,'paragraphShading')},
  paragraphBorders:{default:null,parseHTML:element=>decorationParse(element,'paragraphBorders'),renderHTML:attrs=>decorationHTML(attrs,'paragraphBorders')},
  ...Object.fromEntries([['indentLeft','marginLeft'],['indentRight','marginRight'],['indentFirstLine','textIndent']].map(([key,css])=>[key,{default:null,parseHTML:(element:HTMLElement)=>{const value=element.style[css as 'marginLeft'];return value.endsWith('pt')?finite(parseFloat(value),key==='indentFirstLine'?-720:0,720):null;},renderHTML:(attrs:Record<string,unknown>)=>finite(attrs[key],key==='indentFirstLine'?-720:0,720)!==null?{style:({indentLeft:'margin-left',indentRight:'margin-right',indentFirstLine:'text-indent'} as Record<string,string>)[key]+':'+attrs[key]+'pt'}:{}}])),
  lineHeight:{default:null,parseHTML:element=>finite(element.style.lineHeight,.8,3),renderHTML:attrs=>finite(attrs.lineHeight,.8,3)!==null?{style:`line-height:${attrs.lineHeight}`} :{}},
  spaceBefore:{default:null,parseHTML:element=>element.style.marginTop.endsWith('pt')?finite(parseFloat(element.style.marginTop),0,96):null,renderHTML:attrs=>finite(attrs.spaceBefore,0,96)!==null?{style:`margin-top:${attrs.spaceBefore}pt`}:{}},
  spaceAfter:{default:null,parseHTML:element=>element.style.marginBottom.endsWith('pt')?finite(parseFloat(element.style.marginBottom),0,96):null,renderHTML:attrs=>finite(attrs.spaceAfter,0,96)!==null?{style:`margin-bottom:${attrs.spaceAfter}pt`}:{}},
 }}];},
});
export type RichFormattingCommand='strike'|'subscript'|'superscript'|'grow-font'|'shrink-font'|'clear-formatting'|'justify'|'indent-list'|'outdent-list'|'select-all';
export function runRichFormatting(editor:Editor,command:RichFormattingCommand){
 const chain=editor.chain().focus();
 switch(command){
  case 'strike':return chain.toggleStrike().run();
  case 'subscript':case 'superscript':{const value=command==='subscript'?'sub':'super';return chain.setMark('textStyle',{verticalAlign:editor.getAttributes('textStyle').verticalAlign===value?null:value}).run();}
  case 'grow-font':case 'shrink-font':return chain.setMark('textStyle',{fontSize:nextFontSize(Number(editor.getAttributes('textStyle').fontSize)||12,command==='grow-font'?1:-1)}).run();
  case 'clear-formatting':return chain.unsetAllMarks().clearNodes().updateAttributes('paragraph',{lineHeight:null,spaceBefore:null,spaceAfter:null,textAlign:null,paragraphShading:null,paragraphBorders:null,indentLeft:null,indentRight:null,indentFirstLine:null}).run();
  case 'justify':return chain.setTextAlign('justify').run();
  case 'indent-list':return chain.sinkListItem('listItem').run();
  case 'outdent-list':return chain.liftListItem('listItem').run();
  case 'select-all':return chain.selectAll().run();
 }
}
export function setParagraphAppearance(editor:Editor,change:Record<string,unknown>){
 const transaction=paragraphDecorationTransaction(editor.state,change);
 editor.view.dispatch(closeHistory(transaction));
 editor.view.dispatch(closeHistory(editor.state.tr));
 editor.commands.focus();return true;
}
export function setParagraphSpacing(editor:Editor,attrs:{lineHeight?:number|null;spaceBefore?:number|null;spaceAfter?:number|null}){
 for(const [key,value]of Object.entries(attrs)){if(value!==null&&finite(value,key==='lineHeight'?.8:0,key==='lineHeight'?3:96)===null)return false;}
 return editor.chain().focus().updateAttributes('paragraph',attrs).updateAttributes('heading',attrs).run();
}

