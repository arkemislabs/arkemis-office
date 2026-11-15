import {Extension,type Editor} from '@tiptap/core';
import {TableMap} from '@tiptap/pm/tables';
import {closeHistory} from '@tiptap/pm/history';
import {cellStyle,tableGrid} from '../../core/rich-table.mjs';
const color=(value:string)=>/^#[0-9a-f]{6}$/i.test(value)?value:null;
const safeStyle=(attrs:Record<string,unknown>)=>{try{return cellStyle(attrs);}catch{return '';}};
export function runRichTableAction(editor:Editor,action:()=>unknown){editor.view.dispatch(closeHistory(editor.state.tr));try{return action();}finally{if(!editor.isDestroyed)editor.view.dispatch(closeHistory(editor.state.tr));}}
export const RichTableFormatting=Extension.create({name:'richTableFormatting',addGlobalAttributes(){return[
 {types:['tableCell','tableHeader'],attributes:{
  backgroundColor:{default:null,parseHTML:(e:HTMLElement)=>color(e.getAttribute('data-cell-fill')??''),renderHTML:(a:Record<string,unknown>)=>a.backgroundColor?{'data-cell-fill':a.backgroundColor,style:safeStyle({backgroundColor:a.backgroundColor})}:{}},
  verticalAlign:{default:null,parseHTML:(e:HTMLElement)=>['top','center','bottom'].includes(e.getAttribute('data-cell-vertical')??'')?e.getAttribute('data-cell-vertical'):null,renderHTML:(a:Record<string,unknown>)=>a.verticalAlign?{'data-cell-vertical':a.verticalAlign,style:safeStyle({verticalAlign:a.verticalAlign})}:{}},
  cellBorders:{default:null,parseHTML:(e:HTMLElement)=>{try{const a=JSON.parse(e.getAttribute('data-cell-borders')??'null');if(a)cellStyle({cellBorders:a});return a;}catch{return null;}},renderHTML:(a:Record<string,unknown>)=>a.cellBorders?{'data-cell-borders':JSON.stringify(a.cellBorders),style:safeStyle({cellBorders:a.cellBorders})}:{}},
 }},
 {types:['table'],attributes:{tableAlign:{default:'left',parseHTML:(e:HTMLElement)=>e.getAttribute('data-table-align')??'left',renderHTML:(a:Record<string,unknown>)=>({'data-table-align':a.tableAlign,style:a.tableAlign==='center'?'margin-left:auto;margin-right:auto':a.tableAlign==='right'?'margin-left:auto;margin-right:0':'margin-left:0;margin-right:auto'})}}},
 ];}});
export function setRichColumnWidth(editor:Editor,width:number){
 if(!Number.isFinite(width)||width<25||width>1000)throw new Error('Column width must be 25 to 1000 pixels');
 const {$from}=editor.state.selection;let tableDepth=-1,cellDepth=-1;for(let d=$from.depth;d>0;d--){const name=$from.node(d).type.name;if(['tableCell','tableHeader'].includes(name))cellDepth=d;if(name==='table'){tableDepth=d;break;}}
 if(tableDepth<0||cellDepth<0)return false;const table=$from.node(tableDepth),start=$from.start(tableDepth),map=TableMap.get(table),selected=map.findCell($from.before(cellDepth)-start),layout=tableGrid(table.toJSON()),widths=layout.widths.map((w:number|null)=>w??100);for(let col=selected.left;col<selected.right;col++)widths[col]=width;
 const tr=editor.state.tr;table.forEach((row,rowOffset)=>row.forEach((cell,cellOffset)=>{const relative=rowOffset+1+cellOffset,rect=map.findCell(relative);tr.setNodeMarkup(start+relative,undefined,{...cell.attrs,colwidth:widths.slice(rect.left,rect.right)});}));editor.view.dispatch(tr);return true;
}
