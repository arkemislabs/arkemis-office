import GridPasteSpecial,{type PasteOptions} from './GridPasteSpecial';
import {captureGridClipboard,externalGridClipboard,pasteGridClipboard,gridClipboardText,gridClipboardHTML,ownsGridClipboard,assertGridTransferRange,checkGridRange} from '../../core/grid-clipboard.mjs';
import {fillGridRange,fillTarget} from '../../core/grid-fill.mjs';
import GridTableDialog from './GridTableDialog';
import {tableAt,tableBounds,tableCellStyle,assertTableHeaderEdits} from '../../core/grid-tables.mjs';
import GridNameManager from './GridNameManager';
import * as SSF from 'ssf';
import GridFormatDialog from './GridFormatDialog';
import {axisGeometry,visibleAxis,mergeRects,mergeAt,mergeSelection,unmergeSelection} from '../../core/grid-geometry.mjs';
import {cellStyleCSS,applyCellFormatting} from '../../core/grid-cell-format.mjs';
import {fallbackFonts} from '../../core/font-catalog.mjs';
import './grid-formatting.css';
import {renameWorkbookSheet,deleteWorkbookSheet,nextSheetName} from '../../core/grid-workbook-references.mjs';
import {QuickAccess} from './QuickAccess';
import {formatGridDate} from '../../core/grid-date-format.mjs';
import GridFunctionDialog from './GridFunctionDialog';
import {Ribbon} from './Ribbon';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Bold,AlignLeft,AlignCenter,AlignRight,Plus,Sigma,PaintBucket,Type,Percent,DollarSign,ChevronDown,Undo2,Redo2,Search,X} from 'lucide-react';
import type {Cell,GridContent,GridEditorProps,Sheet,PivotDefinition} from '../types';
import {evaluateCell,evaluateSheet,getSpillInfo,assertSpillEdits,columnName,parseAddress} from '../../core/formulas.mjs';
import {pasteCells,planPaste,selectionTSV,rowWindow,sumTargetRow,reconcileDraft} from '../../core/editor-helpers.mjs';
import {Tool,Divider} from './Toolbar';
import {sortRange,findCells,columnWindow,createHistory,insertAutoSum,sameWorkbookContent} from '../../core/grid-operations.mjs';
import {shiftSheet,shiftWorkbookSheet,fillRange} from '../../core/grid-structure.mjs';
import {createPivotSheet,refreshPivotSheet,assertPivotSourceStructureAllowed} from '../../core/pivots.mjs';
import PivotDialog from './PivotDialog';
import './editors.css';
import './grid-workflows.css';
type GridRange={r1:number;r2:number;c1:number;c2:number};
type GridClip=ReturnType<typeof captureGridClipboard>;
type Position={r:number;c:number};
type MergeRect={r1:number;r2:number;c1:number;c2:number;anchor:string;range:string};
type CellDraft={sheetId:string;address:string;original:string;value:string};
const ROW=30,COL=112;
const address=({r,c}:Position)=>`${columnName(c)}${r+1}`;

export default function GridEditor({content,onChange,onStatus,onSave}:GridEditorProps) {
  const sheet=content.sheets.find(s=>s.id===content.activeSheetId)??content.sheets[0];
  const live=useRef({content,sheet,onChange});live.current={content,sheet,onChange};
  const [dimension,setDimension]=useState<{axis:"row"|"column";value:number}|null>(null);
  const [formatOpen,setFormatOpen]=useState(false),[fonts,setFonts]=useState<string[]>(fallbackFonts);
  useEffect(()=>{let alive=true;window.studio.fonts().then(r=>{if(alive)setFonts(r.families);}).catch(()=>{});return()=>{alive=false;};},[]);
  const [selected,setSelected]=useState<Position>({r:0,c:0});
  const clipboardSelection=useRef(selected);clipboardSelection.current=selected;
  const [anchor,setAnchor]=useState<Position>({r:0,c:0});
  const [editing,setEditing]=useState(false);
  const draftVisibleRows=useRef<number[]|null>(null);
  const [editWhere,setEditWhere]=useState<'cell'|'formula'>('cell');
  const [draft,setDraft]=useState('');
  const [scroll,setScroll]=useState(0);
  const [scrollLeft,setScrollLeft]=useState(0);
  const [viewSize,setViewSize]=useState({width:1200,height:900});
  const [findOpen,setFindOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [findMessage,setFindMessage]=useState('');
  const [filterText,setFilterText]=useState(''),[filterColumn,setFilterColumn]=useState(0),[showFormulas,setShowFormulas]=useState(false),[gridlines,setGridlines]=useState(true),[deleteSheet,setDeleteSheet]=useState(false);
  const findInput=useRef<HTMLInputElement>(null);
  const history=useRef(createHistory(20));
  const draftBefore=useRef<GridContent|null>(null);
  const expectedContent=useRef(content);
  const [,refreshHistory]=useState(0);
  const [rename,setRename]=useState<string|null>(null);
  const [sheetName,setSheetName]=useState('');
  const [goTo,setGoTo]=useState('');
  const [pivotDialog,setPivotDialog]=useState<{initial:PivotDefinition;targetId?:string}|null>(null);
  const [pivotError,setPivotError]=useState('');
  const [tableDialog,setTableDialog]=useState<{name?:string}|null>(null);const [nameManagerOpen,setNameManagerOpen]=useState(false);const [functionOpen,setFunctionOpen]=useState(false),[formulaExpanded,setFormulaExpanded]=useState(false);const functionPrefix=useRef('');const functionOpening=useRef(false);const formulaInput=useRef<HTMLTextAreaElement>(null);
  const [calculationVersion,setCalculationVersion]=useState(0);
  const calculation=useMemo(()=>{const context={sheets:content.sheets,sheetId:sheet.id,namedRanges:content.namedRanges,dateSystem:content.dateSystem,nowSerial:25569+Date.now()/86400000};return {...evaluateSheet(sheet.cells,context),context};},[sheet.cells,content.sheets,content.namedRanges,sheet.id,content.dateSystem,calculationVersion]);
  const viewport=useRef<HTMLDivElement>(null);
  const editInput=useRef<HTMLInputElement>(null);
  const dragging=useRef(false);
  const copied=useRef<{clip:GridClip;text:string;token:string}|null>(null);
  const [pasteSpecial,setPasteSpecial]=useState<{clip:GridClip;sheet:Sheet;position:Position}|null>(null);
  const fillDrag=useRef<{source:GridRange;target:GridRange;sheet:Sheet;alternate:boolean}|null>(null);
  const [fillPreview,setFillPreview]=useState<GridRange|null>(null);
  const activeDraft=useRef<CellDraft|null>(null);
  const expectedSheet=useRef(sheet);
  const spillExtent=(Array.from(calculation.spills.entries()) as [string,{rows:number;columns:number}][]).reduce((extent,[key,spill])=>{const p=parseAddress(key);return {rows:Math.max(extent.rows,p.row+spill.rows),columns:Math.max(extent.columns,p.col+spill.columns)};},{rows:1,columns:1});
  const rows=Math.max(spillExtent.rows,sheet?.rows??200),columns=Math.max(spillExtent.columns,sheet?.columns??26);
  const matchedRows=useMemo(()=>filterText?Array.from({length:rows},(_,r)=>r).filter(r=>String(evaluateCell(sheet.cells,columnName(filterColumn)+(r+1),new Set(),calculation.cache,calculation.context)).toLowerCase().includes(filterText.toLowerCase())):null,[filterText,filterColumn,sheet.cells,rows,calculation]);
  const filteredRows=editing?draftVisibleRows.current:matchedRows;
  const rowOrder=filteredRows??null;
  const rowGeometry=useMemo(()=>{const overrides=rowOrder?Object.fromEntries(rowOrder.map((r,i)=>[i+1,sheet.xlsxLayout?.rowHeights?.[r+1]??22.5])):sheet.xlsxLayout?.rowHeights;return axisGeometry(rowOrder?.length??rows,overrides,ROW,4/3);},[rowOrder,rows,sheet.xlsxLayout?.rowHeights]);
  const colGeometry=useMemo(()=>axisGeometry(columns,sheet.xlsxLayout?.columnWidths,COL,7,5),[columns,sheet.xlsxLayout?.columnWidths]);
  const merges:MergeRect[]=useMemo(()=>mergeRects(sheet.xlsxLayout),[sheet.xlsxLayout]);
  const cell=sheet?.cells[address(selected)]??{value:''};
  const selectedSpill=getSpillInfo(calculation.cache,address(selected)),spillReadOnly=!!selectedSpill&&!selectedSpill.isAnchor;
  const range={r1:Math.min(selected.r,anchor.r),r2:Math.max(selected.r,anchor.r),c1:Math.min(selected.c,anchor.c),c2:Math.max(selected.c,anchor.c)};
  const publish=(next:GridContent,record=true)=>{
    const current=live.current;
    if(record)history.current.record(current.content,next);
    live.current={...current,content:next,sheet:next.sheets.find(s=>s.id===next.activeSheetId)??next.sheets[0]};
    expectedSheet.current=live.current.sheet;expectedContent.current=next;
    refreshHistory(n=>n+1);current.onChange(next);
  };
  const commit=()=>{
    if(draftBefore.current){history.current.record(draftBefore.current,live.current.content);draftBefore.current=null;refreshHistory(n=>n+1);}
    activeDraft.current=null;if(editing)setEditing(false);
  };
  const patchSheet=(transform:(sheet:Sheet)=>Sheet,record=true)=>{
    if(record)commit();
    const current=live.current;
    if(!current.sheet)return false;
    const proposed=transform(current.sheet);try{assertTableHeaderEdits(current.sheet,proposed);const changed=Object.entries(proposed.cells).filter(([key,value])=>value.value!==''&&value.value!==current.sheet.cells[key]?.value);for(const m of mergeRects(proposed.xlsxLayout))for(const [key,value] of changed){if(key===m.anchor)continue;const p=parseAddress(key);if(p.row>=m.r1&&p.row<=m.r2&&p.col>=m.c1&&p.col<=m.c2)throw Error(`Cell ${key} belongs to merged range ${m.range}. Edit ${m.anchor}.`);}assertSpillEdits(current.sheet.cells,proposed.cells,calculation.context,calculation.cache);}catch(error){onStatus?.((error as Error).message);return;}
    const next={...current.content,sheets:current.content.sheets.map(s=>s.id===current.sheet.id?proposed:s)};
    publish(next,record);return true;
  };
  const travel=(direction:'undo'|'redo')=>{commit();const current=live.current.content;const next=history.current[direction](current) as GridContent;if(next!==current)publish(next,false);setEditing(false);viewport.current?.focus();};
  const setEditValue=(value:string)=>{const table=tableAt(sheet,address(selected));if(table?.headerRow&&tableBounds(table.range).a.row===selected.r){onStatus?.('Use Insert > Edit table to rename column headers.');return;}
    if(spillReadOnly){onStatus?.(`Edit array anchor ${selectedSpill?.anchor}.`);return;}
    if(value.length>32767){onStatus?.('A cell cannot exceed 32,767 characters.');return;}
    const current=live.current.sheet;if(!current)return;
    if(!draftBefore.current)draftBefore.current=live.current.content;
    const key=address(selected),previous=reconcileDraft(activeDraft.current,expectedSheet.current,current);
    const session=previous?.address===key?previous:{sheetId:current.id,address:key,original:current.cells[key]?.value??'',value:''};
    activeDraft.current={...session,value};setDraft(value);
    patchSheet(s=>({...s,cells:{...s.cells,[key]:{...s.cells[key],value}}}),false);
  };
  const cancelEdit=()=>{
    const session=reconcileDraft(activeDraft.current,expectedSheet.current,live.current.sheet);
    activeDraft.current=null;draftBefore.current=null;
    if(session&&session.value!==session.original)patchSheet(s=>({...s,cells:{...s.cells,[session.address]:{...s.cells[session.address],value:session.original}}}),false);
    setDraft(live.current.sheet?.cells[address(selected)]?.value??'');setEditing(false);viewport.current?.focus();
  };
  const reveal=(position:Position)=>{
    const element=viewport.current;if(!element)return;
    const visual=filteredRows?Math.max(0,filteredRows.indexOf(position.r)):position.r;const top=rowGeometry.offsets[visual];
    if(top<element.scrollTop)element.scrollTop=top;
    if(top+ROW>element.scrollTop+element.clientHeight-ROW)element.scrollTop=top+2*ROW-element.clientHeight;
    const left=colGeometry.offsets[position.c];
    if(left<element.scrollLeft)element.scrollLeft=left;
    if(left+COL>element.scrollLeft+element.clientWidth-48)element.scrollLeft=left+COL+48-element.clientWidth;
  };
  const choose=(position:Position,extend=false)=>{const merged=mergeAt(live.current.sheet.xlsxLayout,position.r,position.c);if(merged)position={r:merged.r1,c:merged.c1};setSelected(position);if(!extend)setAnchor(position);reveal(position);};
  const move=(dr:number,dc:number,extend=false)=>{commit();const merged=mergeAt(live.current.sheet.xlsxLayout,selected.r,selected.c);const startRow=dr>0&&merged?merged.r2:selected.r,startCol=dc>0&&merged?merged.c2:selected.c;const r=filteredRows?.length?filteredRows[Math.max(0,Math.min(filteredRows.length-1,filteredRows.indexOf(selected.r)+dr))]:Math.max(0,Math.min(rows-1,startRow+dr));choose({r,c:Math.max(0,Math.min(columns-1,startCol+dc))},extend);viewport.current?.focus();};
  const format=(style:Partial<Cell>,borderPatch?:{style?:string;color?:string})=>patchSheet(s=>{
    if((range.r2-range.r1+1)*(range.c2-range.c1+1)>100000){onStatus?.('Select at most 100,000 cells to format at once.');return s;}
    const cells={...s.cells};
    const visible=filteredRows?new Set(filteredRows):null;for(let r=range.r1;r<=range.r2;r++)if(!visible||visible.has(r))for(let c=range.c1;c<=range.c2;c++){const key=address({r,c});cells[key]=applyCellFormatting(cells[key]??{value:''},style,borderPatch);}
    return {...s,cells};
  });
  useLayoutEffect(()=>{
    if(content!==expectedContent.current){
      if(!sameWorkbookContent(content,expectedContent.current)){history.current.reset();draftBefore.current=null;refreshHistory(n=>n+1);}
      expectedContent.current=content;
    }
    const session=reconcileDraft(activeDraft.current,expectedSheet.current,sheet);
    expectedSheet.current=sheet;
    if(activeDraft.current&&!session){activeDraft.current=null;setEditing(false);setDraft(sheet?.cells[address(selected)]?.value??'');}
  },[sheet,content]);
  useEffect(()=>{activeDraft.current=null;draftBefore.current=null;setSelected({r:0,c:0});setAnchor({r:0,c:0});setEditing(false);setScroll(0);setScrollLeft(0);setFilterText('');setDeleteSheet(false);if(viewport.current){viewport.current.scrollTop=0;viewport.current.scrollLeft=0;}},[sheet?.id]);
  useEffect(()=>{const node=viewport.current;if(!node)return;const observer=new ResizeObserver(()=>setViewSize({width:node.clientWidth,height:node.clientHeight}));observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(findOpen)findInput.current?.focus();},[findOpen]);
  useEffect(()=>{if(filteredRows?.length&&!filteredRows.includes(selected.r)){setSelected({r:filteredRows[0],c:selected.c});setAnchor({r:filteredRows[0],c:selected.c});}},[filteredRows,selected.r,selected.c]);
  useEffect(()=>{if(editing&&!functionOpen){if(editWhere==='cell')editInput.current?.focus();else formulaInput.current?.focus();}},[editing,editWhere,functionOpen]);
  useEffect(()=>{const stop=()=>{dragging.current=false;};window.addEventListener('pointerup',stop);return()=>window.removeEventListener('pointerup',stop);},[]);
  useEffect(()=>{onStatus?.(`${address(selected)}${address(anchor)!==address(selected)?` : ${address(anchor)}`:''} · ${Object.keys(sheet?.cells??{}).length} populated cells`);},[selected,anchor,sheet?.cells,onStatus]);
  if(!sheet)return <div className="ed-loading">No sheets in this workbook.</div>;
  const displayedRows=filteredRows?.length??rows;
  const freeze=sheet.xlsxLayout?.freeze;const frozenRows=filteredRows?0:Math.min(freeze?.ySplit??0,rows),frozenCols=Math.min(freeze?.xSplit??0,columns);
  const visibleRows=[...new Set([...visibleAxis(rowGeometry,scroll,viewSize.height),...visibleAxis(rowGeometry,0,Math.min(viewSize.height,rowGeometry.offsets[frozenRows])).filter((r:number)=>r<frozenRows)])];
  const visibleColumns=[...new Set([...visibleAxis(colGeometry,scrollLeft,viewSize.width),...visibleAxis(colGeometry,0,Math.min(viewSize.width,colGeometry.offsets[frozenCols])).filter((c:number)=>c<frozenCols)])];
  const visibleCells=new Map<string,{r:number;c:number;visualRow:number}>();for(const visualRow of visibleRows){const r=filteredRows?filteredRows[visualRow]:visualRow;for(const c of visibleColumns){const m=merges.find(m=>r>=m.r1&&r<=m.r2&&c>=m.c1&&c<=m.c2);const rr=m&&!filteredRows?m.r1:r,cc=m&&!filteredRows?m.c1:c;visibleCells.set(address({r:rr,c:cc}),{r:rr,c:cc,visualRow:m&&!filteredRows?rr:visualRow});}}

  const sort=(direction:'asc'|'desc')=>{commit();if(filterText){onStatus?.('Clear the filter before sorting a selection.');return;}if(merges.some(m=>m.r1<=range.r2&&m.r2>=range.r1&&m.c1<=range.c2&&m.c2>=range.c1)){onStatus?.('Unmerge the selected cells before sorting.');return;}try{patchSheet(s=>({...s,cells:sortRange(s.cells,range,direction,calculation.context)}));onStatus?.(`Sorted ${address({r:range.r1,c:range.c1})}:${address({r:range.r2,c:range.c2})} by its first column.`);}catch(error){onStatus?.(error instanceof Error?error.message:'Cannot sort this selection.');}};
  const findNext=()=>{commit();const matches=findCells(live.current.sheet.cells,query,calculation.context) as Position[];if(!matches.length){setFindMessage(query?'No matches':'Enter text or a formula');return;}const next=matches.find(p=>p.r>selected.r||(p.r===selected.r&&p.c>selected.c))??matches[0];choose(next);setFindMessage(`${matches.findIndex(p=>p===next)+1} of ${matches.length} matches · ${address(next)}`);};
  const startEditing=(value=cell.value,where:'cell'|'formula'='cell')=>{const table=tableAt(sheet,address(selected));if(table?.headerRow&&tableBounds(table.range).a.row===selected.r){onStatus?.('Use Insert > Edit table to rename column headers and update formulas.');return;}if(spillReadOnly){onStatus?.(`This cell is a spilled result. Edit ${selectedSpill?.anchor} to change the array.`);return;}draftVisibleRows.current=filteredRows;activeDraft.current={sheetId:sheet.id,address:address(selected),original:cell.value,value:cell.value};expectedSheet.current=sheet;if(value!==cell.value)setEditValue(value);else setDraft(value);setEditWhere(where);setEditing(true);};
  const openFunction=()=>{if(spillReadOnly){onStatus?.(`Edit array anchor ${selectedSpill?.anchor}.`);return;}functionPrefix.current=editing&&draft.startsWith('=')?draft:'';functionOpening.current=true;setFunctionOpen(true);};
  const assertNoSpills=(area:GridRange)=>{checkGridRange(area);for(let r=area.r1;r<=area.r2;r++)for(let c=area.c1;c<=area.c2;c++){const spill=getSpillInfo(calculation.cache,address({r,c}));if(spill)throw Error('This range contains an array result. Edit '+spill.anchor+' instead.');}};
  const captureCopy=()=>{commit();const current=live.current.sheet;assertNoSpills(range);const clip=captureGridClipboard(current,range,(key:string)=>evaluateCell(current.cells,key,new Set(),calculation.cache,calculation.context));const text=gridClipboardText(clip),token=crypto.randomUUID();return {clip,text,token,html:gridClipboardHTML(clip,token)};};
  const pasteClip=(clip:GridClip,position=selected,options:Partial<PasteOptions>={})=>{
    if(filterText)throw Error('Clear the filter before pasting a rectangle.');
    const height=options.transpose?clip.cells[0].length:clip.cells.length,width=options.transpose?clip.cells.length:clip.cells[0].length;
    assertNoSpills({r1:position.r,c1:position.c,r2:position.r+height-1,c2:position.c+width-1});
    const success=patchSheet(current=>pasteGridClipboard(current,clip,position,options));if(success){setAnchor(position);setSelected({r:position.r+height-1,c:position.c+width-1});}return success;
  };
  const resolveClipboard=(payload:{text:string;html:string})=>{if(copied.current&&ownsGridClipboard(payload,copied.current))return copied.current.clip;copied.current=null;return externalGridClipboard(payload.text);};
  const clipboard=async(action:'copy'|'paste'|'special')=>{
    commit();const snapshot=live.current.sheet,position=clipboardSelection.current;
    try{if(action==='copy'){const snapshot=captureCopy();await window.studio.clipboardWrite({text:snapshot.text,html:snapshot.html});copied.current={clip:snapshot.clip,text:snapshot.text,token:snapshot.token};onStatus?.('Copied cells and formatting.');}
    else{const payload=await window.studio.clipboardRead();if(live.current.sheet!==snapshot||clipboardSelection.current!==position)throw Error('The sheet or selection changed. Paste again at the current position.');const clip=resolveClipboard(payload);if(action==='special')setPasteSpecial({clip,sheet:snapshot,position:{...position}});else pasteClip(clip,position);}
    }catch(error){onStatus?.(error instanceof Error?error.message:'Clipboard access failed.');}
  };
  const cancelFill=()=>{fillDrag.current=null;setFillPreview(null);};
  const startFill=(event:React.PointerEvent)=>{event.preventDefault();event.stopPropagation();if(event.button!==0)return;commit();try{if(filterText)throw Error('Clear the filter before dragging the fill handle.');assertGridTransferRange(live.current.sheet,range,{source:true});assertNoSpills(range);dragging.current=false;fillDrag.current={source:{...range},target:{...range},sheet:live.current.sheet,alternate:event.ctrlKey||event.metaKey};setFillPreview({...range});viewport.current?.focus();}catch(error){onStatus?.((error as Error).message);}};
  useEffect(()=>{
    const indexAt=(offset:number,geometry:{offsets:Float64Array;count:number})=>{let lo=0,hi=geometry.count-1;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(geometry.offsets[mid+1]<=offset)lo=mid+1;else hi=mid;}return Math.max(0,lo);};
    const moveFill=(event:PointerEvent)=>{const drag=fillDrag.current,view=viewport.current;if(!drag||!view)return;event.preventDefault();const box=view.getBoundingClientRect();if(event.clientY>box.bottom-24)view.scrollTop+=ROW;else if(event.clientY<box.top+ROW+24)view.scrollTop-=ROW;if(event.clientX>box.right-24)view.scrollLeft+=COL;else if(event.clientX<box.left+72)view.scrollLeft-=COL;
      const x=event.clientX-box.left-48,y=event.clientY-box.top-ROW;
      const c=indexAt(Math.max(0,x+(x<colGeometry.offsets[frozenCols]?0:view.scrollLeft)),colGeometry),r=indexAt(Math.max(0,y+(y<rowGeometry.offsets[frozenRows]?0:view.scrollTop)),rowGeometry);
      drag.target=fillTarget(drag.source,{r,c});drag.alternate=event.ctrlKey||event.metaKey;setFillPreview({...drag.target});};
    const finishFill=()=>{const drag=fillDrag.current;if(!drag)return;cancelFill();try{if(live.current.sheet!==drag.sheet)throw Error('The sheet changed during the drag. Try again.');if(JSON.stringify(drag.source)===JSON.stringify(drag.target))return;assertNoSpills(drag.target);if(patchSheet(current=>fillGridRange(current,drag.source,drag.target,{alternate:drag.alternate}))){setAnchor({r:drag.target.r1,c:drag.target.c1});setSelected({r:drag.target.r2,c:drag.target.c2});onStatus?.('Filled selection. Undo reverses the entire fill.');}}catch(error){onStatus?.((error as Error).message);}};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&fillDrag.current){event.preventDefault();cancelFill();}};
    window.addEventListener('pointermove',moveFill,{passive:false});window.addEventListener('pointerup',finishFill);window.addEventListener('pointercancel',cancelFill);window.addEventListener('blur',cancelFill);window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('pointermove',moveFill);window.removeEventListener('pointerup',finishFill);window.removeEventListener('pointercancel',cancelFill);window.removeEventListener('blur',cancelFill);window.removeEventListener('keydown',key);};
  });
  const display=(key:string,data:Cell)=>{
    if(showFormulas&&data.value)return data.value;
    const result=evaluateCell(sheet.cells,key,new Set(),calculation.cache,calculation.context);
    if(data.numFmt&&data.numFmt!=='General'){try{return SSF.format(data.numFmt,result,{date1904:content.dateSystem===1904});}catch{/* Unsupported formatting must not hide the cell value. */}}
    if(typeof result==='number'){
      if(data.format==='date'||data.format==='time')return formatGridDate(result,data.format,content.dateSystem);
      if(data.format==='currency')return result.toLocaleString(undefined,{style:'currency',currency:'USD'});
      if(data.format==='percent')return `${(result*100).toLocaleString(undefined,{maximumFractionDigits:2})}%`;
    }
    return String(result??'');
  };
  const sumColumn=()=>{
    commit();
    const populated=Object.keys(sheet.cells).map(key=>parseAddress(key)).filter(p=>p&&p.col===selected.c&&sheet.cells[address({r:p.row,c:p.col})]?.value!=='').map(p=>p.row);
    if(range.r1===range.r2&&selected.r===0&&populated.length===0){onStatus?.('Enter numbers or select a range to sum.');return;}
    const end=range.r2>range.r1?range.r2:selected.r>0?selected.r-1:populated.reduce((max,row)=>Math.max(max,row),-1);
    const start=range.r2>range.r1?range.r1:0;
    let resultRow:number;try{resultRow=sumTargetRow(range.r1,range.r2,selected.r,populated);}catch(error){onStatus?.(error instanceof Error?error.message:'Cannot add a sum here.');return;}
    const target={r:resultRow,c:selected.c};
    const key=address(target),col=columnName(selected.c);
    try{patchSheet(s=>({...s,rows:Math.max(s.rows,target.r+1),cells:insertAutoSum(s.cells,key,`=SUM(${col}${start+1}:${col}${end+1})`)}));}
    catch(error){onStatus?.(error instanceof Error?error.message:'Cannot add a sum here.');return;}
    choose(target);
  };
  const structure=(axis:'row'|'column',delta:1|-1)=>{commit();try{assertPivotSourceStructureAllowed(live.current.content,live.current.sheet.id);publish(shiftWorkbookSheet(live.current.content,live.current.sheet.id,axis,axis==='row'?selected.r:selected.c,delta));setFilterText('');choose({r:Math.min(selected.r,live.current.sheet.rows-1),c:Math.min(selected.c,live.current.sheet.columns-1)});}catch(e){setPivotError((e as Error).message);onStatus?.((e as Error).message);}};
  const fill=(direction:'down'|'right')=>{if(filterText){onStatus?.('Clear the filter before filling a rectangle.');return;}try{patchSheet(s=>({...s,cells:fillRange(s.cells,range,direction)}));}catch(e){onStatus?.((e as Error).message);}};
  const duplicateSheet=()=>{if(content.sheets.length>=100){onStatus?.('A workbook supports up to 100 sheets.');return;}commit();const source=live.current.sheet,id=crypto.randomUUID();let name=source.name.slice(0,24)+' copy',n=2;while(content.sheets.some(s=>s.name===name))name=source.name.slice(0,20)+' copy '+n++;publish({...live.current.content,activeSheetId:id,sheets:[...live.current.content.sheets,{...structuredClone(source),id,name}]});};
  const openPivot=(configure=false)=>{
    commit();setPivotError('');const current=live.current;
    if(configure&&current.sheet.pivot){setPivotDialog({initial:current.sheet.pivot,targetId:current.sheet.id});return;}
    const source=current.sheet.pivot?current.content.sheets.find(s=>!s.pivot):current.sheet;
    if(!source){setPivotError('Add a regular sheet with source data before creating a pivot.');return;}
    const bounds=Object.entries(source.cells).reduce((bounds,[key,cell])=>{if(cell.value!==''){const p=parseAddress(key);bounds.row=Math.max(bounds.row,p.row);bounds.col=Math.max(bounds.col,p.col);}return bounds;},{row:1,col:0});
    const useSelection=source.id===current.sheet.id&&range.r2>range.r1;
    const sourceRange=useSelection?`${columnName(range.c1)}${range.r1+1}:${columnName(range.c2)}${range.r2+1}`:`A1:${columnName(bounds.col)}${bounds.row+1}`;
    setPivotDialog({initial:{sourceSheetId:source.id,sourceRange,rowFields:[0],columnField:null,measures:[{field:useSelection?range.c2-range.c1:bounds.col,aggregate:'SUM'}]}});
  };
  const refreshPivot=()=>{commit();try{publish(refreshPivotSheet(live.current.content,live.current.sheet.id) as GridContent);setPivotError('');onStatus?.('Pivot refreshed from its saved source range.');}catch(error){setPivotError((error as Error).message);}};
  const group=(title:string,children:React.ReactNode)=><div className="ribbon-group" role="group" aria-label={title}><div className="ribbon-commands">{children}</div><span className="ribbon-group-label">{title}</span></div>;
  return <div className={`ed-root ed-grid ${gridlines?'':'hide-gridlines'}`} onKeyDownCapture={e=>{
    if((e.target as HTMLElement).closest('.grid-pivot-dialog'))return;
    if(e.shiftKey&&e.key==='F3'){e.preventDefault();e.stopPropagation();openFunction();}
    if(e.key==='F9'){e.preventDefault();commit();setCalculationVersion(v=>v+1);}
    const command=e.ctrlKey||e.metaKey;
    if(command&&e.altKey&&e.key.toLowerCase()==='v'){e.preventDefault();e.stopPropagation();void clipboard('special');}
    if(command&&e.key==='1'){e.preventDefault();commit();setFormatOpen(true);}
    if(command&&e.key.toLowerCase()==='f'){e.preventDefault();e.stopPropagation();commit();setFindOpen(true);findInput.current?.focus();}
    if(command&&['z','y'].includes(e.key.toLowerCase())&&(e.target===viewport.current||activeDraft.current||e.target===editInput.current)){e.preventDefault();e.stopPropagation();travel(e.key.toLowerCase()==='y'||e.shiftKey?'redo':'undo');}
  }}>
    <QuickAccess>{onSave&&<button className="ed-text-tool" onClick={()=>{commit();onSave();}}>Save</button>}<Tool label="Undo (Ctrl+Z)" disabled={!history.current.canUndo&&!draftBefore.current} onClick={()=>travel('undo')}><Undo2/></Tool><Tool label="Redo (Ctrl+Y)" disabled={!history.current.canRedo} onClick={()=>travel('redo')}><Redo2/></Tool></QuickAccess>
    <Ribbon label="Cell formatting" labels={['Clipboard','Font','Alignment','Number','Formulas','Cells','Editing']} focusTab="Formulas" focusGroups={[4]} homeGroups={[0,1,2,3,5,6]} orderedTabs={['Edit','Home','Insert','Formulas','Data','View']} extraTabs={[
      {name:'Edit',content:<>{group('History',<><button className="ed-text-tool" disabled={!history.current.canUndo&&!draftBefore.current} onClick={()=>travel('undo')}>Undo</button><button className="ed-text-tool" disabled={!history.current.canRedo} onClick={()=>travel('redo')}>Redo</button></>)}{group('Clipboard',<><button className="ed-text-tool" onClick={()=>clipboard('copy')}>Copy cells</button><button className="ed-text-tool" onClick={()=>clipboard('paste')}>Paste cells</button><button className="ed-text-tool" onClick={()=>clipboard('special')}>Paste Special…</button></>)}{group('Editing',<><button className="ed-text-tool" onClick={()=>{commit();setFindOpen(true);requestAnimationFrame(()=>findInput.current?.focus());}}>Find</button><button className="ed-text-tool" onClick={()=>{commit();setAnchor({r:0,c:0});setSelected({r:rows-1,c:columns-1});viewport.current?.focus();}}>Select All cells</button></>)}</>},
      {name:'Insert',content:<>{group('Tables',<><button className="ed-text-tool" onClick={()=>{commit();setTableDialog({});}}>Create table</button><button className="ed-text-tool" disabled={!tableAt(sheet,address(selected))} onClick={()=>{commit();setTableDialog({name:tableAt(sheet,address(selected))?.name});}}>Edit table</button></>)}{group('Workbook',<button className="ed-text-tool" onClick={duplicateSheet}>Duplicate sheet</button>)}</>},
      {name:'Data',content:<>{group('Sort',<><button className="ed-text-tool" onClick={()=>sort('asc')}>Sort ascending</button><button className="ed-text-tool" onClick={()=>sort('desc')}>Sort descending</button></>)}{group('Filter view',<><select aria-label="Filter column" value={filterColumn} onChange={e=>setFilterColumn(Number(e.target.value))}>{Array.from({length:columns},(_,c)=><option key={c} value={c}>{columnName(c)}</option>)}</select><input aria-label="Filter contains" placeholder="Contains…" value={filterText} onChange={e=>{commit();setFilterText(e.target.value);setScroll(0);if(viewport.current)viewport.current.scrollTop=0;}}/><button className="ed-text-tool" onClick={()=>setFilterText('')}>Clear filter</button></>)}{group('Pivot tables',<><button className="ed-text-tool" onClick={()=>openPivot()}>Create pivot table</button><button className="ed-text-tool" disabled={!sheet.pivot} onClick={()=>openPivot(true)}>Configure pivot</button><button className="ed-text-tool" disabled={!sheet.pivot} onClick={refreshPivot}>Refresh pivot</button></>)}</>},
    ]} viewContent={group('Worksheet display',<><button className="ed-text-tool" aria-pressed={gridlines} onClick={()=>setGridlines(v=>!v)}>Gridlines</button><button className="ed-text-tool" onClick={()=>patchSheet(s=>({...s,xlsxLayout:{...s.xlsxLayout,freeze:{xSplit:selected.c,ySplit:selected.r}}}))}>Freeze panes</button><button className="ed-text-tool" onClick={()=>patchSheet(s=>({...s,xlsxLayout:{...s.xlsxLayout,freeze:undefined}}))}>Unfreeze panes</button></>)}>

<button className="ed-text-tool" onClick={()=>clipboard('paste')}>Paste cells</button><button className="ed-text-tool" onClick={()=>clipboard('copy')}>Copy cells</button><button className="ed-text-tool" onClick={()=>clipboard('special')}>Paste Special…</button><Divider/>
<div className="grid-font-controls">      <select aria-label="Cell font family" value={cell.fontFamily??'Calibri'} onChange={e=>format({fontFamily:e.target.value})}>{[...new Set([cell.fontFamily??'Calibri',...fonts])].map(name=><option key={name}>{name}</option>)}</select><input className="grid-font-size" aria-label="Cell font size" type="number" min={1} max={409} value={cell.fontSize??11} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=409)format({fontSize:n});}}/>
      <Tool label="Bold" active={cell.bold} onClick={()=>format({bold:!cell.bold})}><Bold/></Tool><Tool label="Italic" active={cell.italic} onClick={()=>format({italic:!cell.italic})}><em>I</em></Tool><Tool label="Underline" active={!!cell.underline&&cell.underline!=='none'} onClick={()=>format({underline:cell.underline&&cell.underline!=='none'?'none':'single'})}><u>U</u></Tool><button className="ed-text-tool" onClick={()=>{commit();setFormatOpen(true);}}>Format Cells</button>
      <label className="ed-color" title="Text color"><Type size={17}/><input aria-label="Cell text color" type="color" value={cell.color??'#202331'} onChange={e=>format({color:e.target.value})}/></label>
      <label className="ed-color" title="Cell background"><PaintBucket size={17}/><input aria-label="Cell background color" type="color" value={cell.background??'#ffffff'} onChange={e=>format({background:e.target.value})}/></label></div><Divider/>
<div className="grid-alignment-controls">
      <Tool label="Align left" active={cell.align==='left'} onClick={()=>format({align:'left'})}><AlignLeft/></Tool><Tool label="Align center" active={cell.align==='center'} onClick={()=>format({align:'center'})}><AlignCenter/></Tool><Tool label="Align right" active={cell.align==='right'} onClick={()=>format({align:'right'})}><AlignRight/></Tool><button className="ed-text-tool" aria-pressed={!!cell.wrap} onClick={()=>format({wrap:!cell.wrap})}>Wrap text</button><button className="ed-text-tool" onClick={()=>{try{if(filterText)throw Error('Clear the filter before merging cells');patchSheet(s=>mergeSelection(s,range));}catch(e){onStatus?.((e as Error).message);}}}>Merge cells</button><button className="ed-text-tool" onClick={()=>patchSheet(s=>unmergeSelection(s,range))}>Unmerge cells</button></div><Divider/>
<div className="grid-number-controls">
      <select aria-label="Number format" value={cell.format??'general'} onChange={e=>format({format:e.target.value as Cell['format'],numFmt:({general:'General',currency:'$#,##0.00',percent:'0.00%',date:'yyyy-mm-dd',time:'hh:mm:ss'} as Record<string,string>)[e.target.value]})}><option value="general">General</option><option value="currency">Currency ($)</option><option value="percent">Percentage</option><option value="date">Date (yyyy-mm-dd)</option><option value="time">Time (hh:mm:ss)</option></select>
      <Tool label="Currency" active={cell.format==='currency'} onClick={()=>format({format:'currency',numFmt:'$#,##0.00'})}><DollarSign/></Tool><Tool label="Percentage" active={cell.format==='percent'} onClick={()=>format({format:'percent',numFmt:'0.00%'})}><Percent/></Tool></div><Divider/>

      <button className="ed-text-tool" onClick={sumColumn}><Sigma size={17}/> Sum column</button><button className="ed-text-tool" onPointerDown={e=>e.preventDefault()} onClick={openFunction}>Insert Function</button><button className="ed-text-tool" onClick={()=>{commit();setNameManagerOpen(true);}}>Name Manager</button><button className="ed-text-tool" onClick={()=>{commit();setCalculationVersion(v=>v+1);}}>Calculate Now (F9)</button><button className="ed-text-tool" aria-pressed={showFormulas} onClick={()=>setShowFormulas(v=>!v)}>Show Formulas</button><Divider/>
<div className="grid-cell-controls"><button className="ed-text-tool" onClick={()=>structure('row',1)}>Insert row above</button><button className="ed-text-tool" onClick={()=>structure('column',1)}>Insert column before</button><button className="ed-text-tool" onClick={()=>structure('row',-1)}>Delete row</button><button className="ed-text-tool" onClick={()=>structure('column',-1)}>Delete column</button><button className="ed-text-tool" disabled={content.sheets.length===1} onClick={()=>setDeleteSheet(true)}>Delete sheet…</button><button className="ed-text-tool" onClick={()=>setDimension({axis:'row',value:sheet.xlsxLayout?.rowHeights?.[selected.r+1]??22.5})}>Row Height</button><button className="ed-text-tool" onClick={()=>setDimension({axis:'column',value:sheet.xlsxLayout?.columnWidths?.[selected.c+1]??15.29})}>Column Width</button><button className="ed-text-tool" onClick={()=>patchSheet(s=>{const cells={...s.cells};for(const [key,value] of Object.entries(cells)){const p=parseAddress(key);if(p.row>=range.r1&&p.row<=range.r2&&p.col>=range.c1&&p.col<=range.c2)cells[key]={value:value.value,valueType:value.valueType};}return {...s,cells};})}>Clear formats</button>
</div><Divider/>

      <button className="ed-text-tool" onClick={()=>fill('down')}>Fill down</button><button className="ed-text-tool" onClick={()=>fill('right')}>Fill right</button><button className="ed-text-tool" onClick={()=>format({value:''})}>Clear contents</button>
            <span className="ed-toolbar-spacer"/><span className="ed-muted">{rows} rows × {columns} columns</span>
    </Ribbon>
    {pasteSpecial&&<GridPasteSpecial internal={!pasteSpecial.clip.external} rows={pasteSpecial.clip.cells.length} columns={pasteSpecial.clip.cells[0].length} destination={address(pasteSpecial.position)} onClose={()=>setPasteSpecial(null)} onApply={options=>{try{if(live.current.sheet!==pasteSpecial.sheet)throw Error('The sheet changed. Reopen Paste Special.');if(pasteClip(pasteSpecial.clip,pasteSpecial.position,options)){setPasteSpecial(null);return;}return 'The selection could not be pasted. Check the sheet status for details.';}catch(error){return (error as Error).message;}}}/>}
    {dimension&&<div className="grid-pivot-backdrop"><form className="grid-pivot-dialog grid-format-dialog" role="dialog" aria-modal="true" aria-label={dimension.axis==='row'?'Row Height':'Column Width'} onSubmit={e=>{e.preventDefault();const axis=dimension.axis,value=dimension.value;if(!Number.isFinite(value)||value<=0||value>(axis==='row'?409:255))return;patchSheet(s=>{const key=axis==='row'?'rowHeights':'columnWidths',sizes={...s.xlsxLayout?.[key]};for(let n=axis==='row'?range.r1:range.c1;n<=(axis==='row'?range.r2:range.c2);n++)sizes[n+1]=value;return {...s,xlsxLayout:{...s.xlsxLayout,[key]:sizes}};});setDimension(null);}} onKeyDown={e=>{if(e.key==='Escape')setDimension(null);}}><h2>{dimension.axis==='row'?'Row Height':'Column Width'}</h2><label>{dimension.axis==='row'?'Row height (points)':'Column width (characters)'}<input autoFocus aria-label={dimension.axis==='row'?'Row height':'Column width'} type="number" min={1} max={dimension.axis==='row'?409:255} step="0.25" value={dimension.value} onChange={e=>setDimension({...dimension,value:Number(e.target.value)})}/></label><footer><button type="button" onClick={()=>setDimension(null)}>Cancel</button><button type="submit">Apply size</button></footer></form></div>}
    {formatOpen&&<GridFormatDialog cell={cell} onClose={()=>setFormatOpen(false)} onApply={(style,borderPatch)=>{try{if(style.numFmt)SSF.format(style.numFmt,123.45);format(style,borderPatch);setFormatOpen(false);}catch{onStatus?.('Enter a valid number format code.');}}}/>}
    {tableDialog&&<GridTableDialog content={content} sheetId={sheet.id} range={`${columnName(range.c1)}${range.r1+1}:${columnName(range.c2)}${range.r2+1}`} tableName={tableDialog.name} onChange={next=>publish(next)} onClose={()=>{setTableDialog(null);viewport.current?.focus();}}/>}
    {nameManagerOpen&&<GridNameManager content={content} onChange={next=>publish(next)} onClose={()=>{setNameManagerOpen(false);viewport.current?.focus();}}/>}
    {functionOpen&&<GridFunctionDialog onClose={()=>{functionOpening.current=false;setFunctionOpen(false);if(editing)formulaInput.current?.focus();else viewport.current?.focus();}} onConfirm={name=>{functionOpening.current=false;setFunctionOpen(false);startEditing(`${functionPrefix.current||'='}${name}(`,'formula');}}/>}
    {pivotDialog&&<PivotDialog content={content} initial={pivotDialog.initial} updating={!!pivotDialog.targetId} onClose={()=>{setPivotDialog(null);viewport.current?.focus();}} onApply={definition=>{commit();const next=pivotDialog.targetId?refreshPivotSheet(live.current.content,pivotDialog.targetId,definition):createPivotSheet(live.current.content,definition);publish(next as GridContent);setPivotDialog(null);setPivotError('');}}/>}
    {sheet.pivot&&<div className="grid-pivot-banner"><span>Pivot result · {content.sheets.find(s=>s.id===sheet.pivot?.sourceSheetId)?.name??'Missing source'}!{sheet.pivot.sourceRange} · Refresh replaces result cells. Office exports contain ordinary cells.</span></div>}
    {pivotError&&<div className="grid-pivot-banner" role="alert"><span>{pivotError}</span><button onClick={()=>setPivotError('')}>Dismiss</button></div>}
    {deleteSheet&&<div className="grid-find" role="group" aria-label="Confirm sheet deletion"><span>Delete “{sheet.name}” and its cells? You can undo this.</span><button onClick={()=>{commit();publish(deleteWorkbookSheet(live.current.content,sheet.id));setDeleteSheet(false);}}>Confirm delete sheet</button><button onClick={()=>setDeleteSheet(false)}>Cancel</button></div>}
    {filterText&&<div className="grid-find"><span>{displayedRows} matching rows · Filter {columnName(filterColumn)} contains “{filterText}” · Row numbers refer to original cells</span></div>}
    {findOpen&&<form className="grid-find" role="search" onSubmit={e=>{e.preventDefault();findNext();}}><Search size={16}/><input ref={findInput} aria-label="Find cell values or formulas" placeholder="Find values or formulas" value={query} onChange={e=>{setQuery(e.target.value);setFindMessage('');}} onKeyDown={e=>{if(e.key==='Escape'){setFindOpen(false);viewport.current?.focus();}}}/><button type="submit">Find next</button><span role="status">{findMessage}</span><button type="button" aria-label="Close find" onClick={()=>{setFindOpen(false);viewport.current?.focus();}}><X size={16}/></button></form>}
    <div className="ed-formula-bar source-formula-bar"><form onSubmit={e=>{e.preventDefault();let parsed;try{parsed=parseAddress((goTo||address(selected)).toUpperCase());}catch{onStatus?.('Enter a cell address such as A1.');return;}if(parsed){const position={r:parsed.row,c:parsed.col};if(position.r<rows&&position.c<columns&&position.r>=0&&position.c>=0){commit();choose(position);viewport.current?.focus();}}setGoTo('');}}><input aria-label="Go to cell" value={goTo||address(selected)} onChange={e=>setGoTo(e.target.value)} onFocus={e=>e.target.select()}/></form><div className="formula-actions"><button type="button" aria-label="Cancel formula edit" disabled={!editing} onPointerDown={e=>e.preventDefault()} onClick={cancelEdit}>×</button><button type="button" aria-label="Enter formula" disabled={!editing} onPointerDown={e=>e.preventDefault()} onClick={()=>{commit();viewport.current?.focus();}}>✓</button><button type="button" aria-label="Insert Function" title="Insert Function (Shift+F3)" onPointerDown={e=>e.preventDefault()} onClick={openFunction}>ƒx</button></div><textarea ref={formulaInput} rows={formulaExpanded?5:Math.min(5,Math.max(1,(editing?draft:cell.value).split('\n').length))} aria-label="Formula bar" readOnly={spillReadOnly||!!(tableAt(sheet,address(selected))?.headerRow&&tableBounds(tableAt(sheet,address(selected))!.range).a.row===selected.r)} title={spillReadOnly?`Spilled from ${selectedSpill?.anchor}`:undefined} value={spillReadOnly?(sheet.cells[selectedSpill!.anchor]?.value??''):editing?draft:cell.value} onFocus={()=>{if(!editing)startEditing(cell.value,'formula');}} onChange={e=>{setEditValue(e.target.value);setEditing(true);}} onBlur={()=>{if(!functionOpening.current)commit();}} onKeyDown={e=>{if(e.key==='Enter'&&!e.altKey){e.preventDefault();move(1,0);}if(e.key==='Escape'){cancelEdit();}}}/><button type="button" aria-label={formulaExpanded?'Collapse formula bar':'Expand formula bar'} aria-expanded={formulaExpanded} onPointerDown={e=>e.preventDefault()} onClick={()=>setFormulaExpanded(v=>!v)}><ChevronDown size={15}/></button></div>
    <div className="ed-sheet-viewport" ref={viewport} tabIndex={0} role="grid" aria-label={sheet.name} aria-rowcount={rows} aria-colcount={columns} onScroll={e=>{setScroll(e.currentTarget.scrollTop);setScrollLeft(e.currentTarget.scrollLeft);}} onCopy={e=>{if(editing)return;e.preventDefault();void clipboard('copy');}} onPaste={e=>{if(editing)return;e.preventDefault();void clipboard('paste');}} onKeyDown={e=>{
      if(e.target!==e.currentTarget)return;
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab','Enter'].includes(e.key)){e.preventDefault();const vectors:Record<string,number[]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Tab:[0,e.shiftKey?-1:1],Enter:[e.shiftKey?-1:1,0]};const [r,c]=vectors[e.key];move(r,c,e.shiftKey&&e.key.startsWith('Arrow'));}
      else if(e.key==='F2'){e.preventDefault();startEditing();}
      else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();format({value:''});}
      else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();startEditing(e.key);}
    }}>
      <div className="ed-sheet-canvas" style={{width:48+colGeometry.total,height:ROW+rowGeometry.total}}>
        <div className="ed-corner grid-fixed-corner" style={{left:scrollLeft,top:scroll}}/>
        {visibleColumns.map(c=><div className={`grid-column-heading ${c>=range.c1&&c<=range.c2?'is-selected':''}`} key={c} style={{left:48+colGeometry.offsets[c]+(c<frozenCols?scrollLeft:0),top:scroll,width:colGeometry.sizes[c],height:ROW,zIndex:c<frozenCols?9:8}}>{columnName(c)}</div>)}
        {visibleRows.map(visualRow=>{const r=filteredRows?filteredRows[visualRow]:visualRow;return <div className={`ed-row-head grid-row-heading ${r>=range.r1&&r<=range.r2?'is-selected':''}`} key={r} style={{left:scrollLeft,top:ROW+rowGeometry.offsets[visualRow]+(r<frozenRows?scroll:0),height:rowGeometry.sizes[visualRow],zIndex:r<frozenRows?9:7}}>{r+1}</div>;})}
        {!editing&&!filterText&&range.r2<rows&&range.c2<columns&&<button className="grid-fill-handle" aria-label="Fill handle" title="Drag to fill. Ctrl toggles copy and series. Esc cancels." style={{left:48+colGeometry.offsets[range.c2+1]+(range.c2<frozenCols?scrollLeft:0)-5,top:ROW+rowGeometry.offsets[range.r2+1]+(range.r2<frozenRows?scroll:0)-5}} onPointerDown={startFill} onKeyDown={e=>{if(e.key==='Escape')cancelFill();}}/>}
        {[...visibleCells.entries()].map(([key,{r,c,visualRow}])=>{
          const data=sheet.cells[key]??{value:''};const active=r===selected.r&&c===selected.c,inRange=r>=range.r1&&r<=range.r2&&c>=range.c1&&c<=range.c2;
          const merged=!filteredRows?merges.find(m=>m.anchor===key):undefined;const width=colGeometry.offsets[(merged?.c2??c)+1]-colGeometry.offsets[c],height=rowGeometry.offsets[(merged?.r2??visualRow)+1]-rowGeometry.offsets[visualRow];
          const frozenX=c<frozenCols,frozenY=r<frozenRows;
          return <div key={key} role="gridcell" aria-rowindex={r+1} aria-colindex={c+1} aria-rowspan={merged?merged.r2-merged.r1+1:undefined} aria-colspan={merged?merged.c2-merged.c1+1:undefined} aria-label={key} aria-readonly={!!getSpillInfo(calculation.cache,key)&&!getSpillInfo(calculation.cache,key)?.isAnchor} title={merged?`Merged ${merged.range}`:getSpillInfo(calculation.cache,key)?`Array ${getSpillInfo(calculation.cache,key)?.range} · edit ${getSpillInfo(calculation.cache,key)?.anchor}`:undefined} aria-selected={inRange} data-address={key} className={`ed-cell grid-positioned-cell ${active?'is-active':''} ${inRange?'in-range':''} ${fillPreview&&r>=fillPreview.r1&&r<=fillPreview.r2&&c>=fillPreview.c1&&c<=fillPreview.c2&&!inRange?'grid-fill-preview':''}`} style={{...cellStyleCSS(data) as React.CSSProperties,...tableCellStyle(sheet,key),...(data.color?{color:data.color}:{}),...(data.background?{background:data.background}:{}),position:'absolute',left:48+colGeometry.offsets[c]+(frozenX?scrollLeft:0),top:ROW+rowGeometry.offsets[visualRow]+(frozenY?scroll:0),width,height,zIndex:frozenX&&frozenY?6:frozenX||frozenY?5:active?3:merged?2:1,textAlign:data.align??(data.value.startsWith('=')||/^-?\d+(\.\d+)?$/.test(data.value)?'right':'left'),display:'flex',alignItems:data.verticalAlign==='top'?'flex-start':data.verticalAlign==='middle'?'center':'flex-end'}} onPointerDown={e=>{if(e.button!==0)return;commit();dragging.current=true;choose({r,c},e.shiftKey);viewport.current?.focus();}} onPointerEnter={()=>{if(dragging.current)setSelected({r,c});}} onDoubleClick={()=>startEditing(data.value)}>
            {active&&editing&&editWhere==='cell'?<input ref={editInput} aria-label={`Edit ${key}`} value={draft} onPointerDown={e=>e.stopPropagation()} onChange={e=>setEditValue(e.target.value)} onBlur={()=>{if(!functionOpening.current)commit();}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();move(e.key==='Enter'?(e.shiftKey?-1:1):0,e.key==='Tab'?(e.shiftKey?-1:1):0);}if(e.key==='Escape'){cancelEdit();}}}/>:<span className="grid-cell-value" style={{transform:data.rotation?`rotate(${-data.rotation}deg)`:undefined}}>{display(key,data)}</span>}
          </div>;
        })}
      </div>
    </div>
    {fillPreview&&<div className="grid-fill-status" role="status">Fill {address({r:fillPreview.r1,c:fillPreview.c1})} → {address({r:fillPreview.r2,c:fillPreview.c2})} · Esc to cancel</div>}
    <div className="ed-sheet-tabs"><button aria-label="Add sheet" className="ed-tool" onClick={()=>{commit();const id=crypto.randomUUID();publish({...live.current.content,activeSheetId:id,sheets:[...live.current.content.sheets,{id,name:nextSheetName(live.current.content.sheets),cells:{},rows:200,columns:26}]});}}><Plus size={17}/></button>{content.sheets.map(s=><div key={s.id} className={`ed-sheet-tab ${s.id===sheet.id?'is-active':''}`}>{rename===s.id?<form onSubmit={e=>{e.preventDefault();if(sheetName.trim()){commit();try{publish(renameWorkbookSheet(live.current.content,s.id,sheetName));}catch(error){onStatus?.((error as Error).message);}}setRename(null);}}><input autoFocus aria-label="Sheet name" value={sheetName} onChange={e=>setSheetName(e.target.value)} onBlur={()=>setRename(null)} onKeyDown={e=>{if(e.key==='Escape')setRename(null);}}/></form>:<><button onClick={()=>{commit();publish({...live.current.content,activeSheetId:s.id},false);}} onDoubleClick={()=>{setSheetName(s.name);setRename(s.id);}}>{s.name}</button><button aria-label={`Rename ${s.name}`} onClick={()=>{setSheetName(s.name);setRename(s.id);}}><ChevronDown size={12}/></button></>}</div>)}<span className="ed-toolbar-spacer"/><span className="ed-muted">{address(selected)}{range.r1!==range.r2||range.c1!==range.c2?` · ${(range.r2-range.r1+1)*(range.c2-range.c1+1)} cells selected`:''}</span></div>
  </div>;
}

import './grid-expansion.css';
