import {readRichClipboard,plainPasteText} from '../../core/rich-dialogs.mjs';
import {ParagraphDialog,InsertTableDialog,PasteSpecialDialog} from './RichCommandDialogs';
import {CommandGroup} from './CommandGroup';
import {LinkedValueCommand} from '../OfficeCommands';
import {appendPageNumber} from '../../core/rich-page-parts.mjs';
import {WordField,PageBreak,HeaderFooterDialog} from './RichPageParts';
import {Ribbon} from './Ribbon';
import {RichLinkDialog,removeRichLink} from './RichLink';
import {QuickAccess} from './QuickAccess';
import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {EditorContent,useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import {TableKit} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import {Bold,Italic,Underline,List,ListOrdered,AlignLeft,AlignCenter,AlignRight,Table,ImagePlus,Undo2,Redo2,Quote,Minus,X,Plus,Strikethrough,Subscript,Superscript,Highlighter,RemoveFormatting,AlignJustify,IndentIncrease,IndentDecrease,Copy,Scissors,ClipboardPaste,Search,Save} from 'lucide-react';
import type {RichEditorProps,RichContent} from '../types';
import {pageGeometry,documentStatistics} from './rich-helpers.mjs';
import './rich-features.css';
import {SearchHighlights,useRichSearch,RichSearchDialog} from './RichSearch';
import {RichTableFormatting,setRichColumnWidth,runRichTableAction} from './RichTable';
import './rich-formatting.css';
import {ParagraphAppearanceControls} from './RichParagraph';
import {ParagraphFormatting,runRichFormatting,setParagraphSpacing,fontSizes} from './RichFormatting';

import {changeTextCaseTransaction} from '../../core/rich-text-case.mjs';
import {Tool,Divider} from './Toolbar';
import './editors.css';
import {TextStyle,fontFamilies} from './TextStyle';

export default function RichEditor({content,onChange,onStatus,onPickImage,mode,onSave}:RichEditorProps) {
  const live=useRef({content,onChange,onStatus}); live.current={content,onChange,onStatus};
  const emitted=useRef(JSON.stringify(content.doc));
  const [tag,setTag]=useState('');
  const [searchDialog,setSearchDialog]=useState<'find'|'replace'|null>(null);
  const [editingOpen,setEditingOpen]=useState(false),[clipboardMessage,setClipboardMessage]=useState('');
  const [availableFonts,setAvailableFonts]=useState<string[]>(fontFamilies);
  const [systemFonts,setSystemFonts]=useState(false);
  useEffect(()=>{let mounted=true;window.studio.fonts().then(result=>{if(mounted){setAvailableFonts(result.families);setSystemFonts(result.system);}}).catch(()=>{});return()=>{mounted=false;};},[]);

  const [zoom,setZoom]=useState(100),[outline,setOutline]=useState(false);
  const [linkOpen,setLinkOpen]=useState(false);
  const [storyKind,setStoryKind]=useState<'headers'|'footers'|null>(null);const storySnapshot=useRef('');
  const editStory=(kind:'headers'|'footers')=>{storySnapshot.current=JSON.stringify(live.current.content.headerFooter??{});setStoryKind(kind);};
  const [tableMessage,setTableMessage]=useState(''),[borderColor,setBorderColor]=useState('#808080'),[borderSize,setBorderSize]=useState(1);
  const [commandDialog,setCommandDialog]=useState<'paragraph'|'table'|'paste'|null>(null);
  const [,render]=useState(0);
  const editor=useEditor({
    extensions:[WordField,PageBreak,StarterKit.configure({link:{openOnClick:false}}),SearchHighlights,RichTableFormatting,TextStyle,ParagraphFormatting,TextAlign.configure({types:['heading','paragraph']}),TableKit.configure({table:{resizable:true}}),Image.configure({allowBase64:true})],
    content:content.doc,
    editorProps:{attributes:{class:'ed-rich-document','aria-label':mode==='slate'?'Note content':'Document content'}},
    onUpdate:({editor})=>{
      const doc=editor.getJSON(); emitted.current=JSON.stringify(doc);
      live.current.onChange({...live.current.content,doc});
      live.current.onStatus?.(`${documentStatistics(doc).words} words`);
    },
    onSelectionUpdate:()=>render(n=>n+1),
    onTransaction:()=>render(n=>n+1),
  });
  const search=useRichSearch(editor);
  useEffect(()=>{
    const next=JSON.stringify(content.doc);
    if(editor&&next!==emitted.current&&next!==JSON.stringify(editor.getJSON())) {
      editor.commands.setContent(content.doc,{emitUpdate:false});
    }
    emitted.current=next;
  },[content.doc,editor]);
  useEffect(()=>{onStatus?.(`${documentStatistics(content.doc).words} words`);},[onStatus,content.doc]);
  const addTag=()=>{
    const value=tag.trim().replace(/^#/,'');
    if(value&&!content.tags?.includes(value)) onChange({...content,tags:[...(content.tags??[]),value]});
    setTag('');
  };
  if(!editor) return <div className="ed-loading">Opening your page…</div>;
  const chain=()=>editor.chain().focus();
  const format=(command:Parameters<typeof runRichFormatting>[1])=>runRichFormatting(editor,command);
  const changeCase=(value:string)=>{try{const tr=changeTextCaseTransaction(editor.state,value);if(tr)editor.view.dispatch(tr);editor.commands.focus();setClipboardMessage('');}catch(error){setClipboardMessage(error instanceof Error?error.message:String(error));}};
  const tableCellAttrs=editor.getAttributes(editor.isActive('tableHeader')?'tableHeader':'tableCell');
  const tableBorder=(style:string)=>{runRichTableAction(editor,()=>chain().setCellAttribute('cellBorders',Object.fromEntries(['top','bottom','left','right'].map(side=>[side,{style,color:borderColor,size:style==='nil'?0:borderSize}]))).run());};
  const paragraphAttrs=editor.isActive('heading')?editor.getAttributes('heading'):editor.getAttributes('paragraph');
  const clipboard=async(action:'copy'|'cut'|'paste')=>{
    editor.commands.focus();setClipboardMessage('');
    try{if(action==='paste'){
      const before=JSON.stringify(editor.getJSON()),selection={from:editor.state.selection.from,to:editor.state.selection.to};
      const payload=await readRichClipboard(window.studio?.clipboardRead,navigator.clipboard);let value=payload.text;if(!value&&payload.html){const template=document.createElement('template');template.innerHTML=payload.html;value=plainPasteText(template.content);}
      if(editor.isDestroyed)return;
      if(before!==JSON.stringify(editor.getJSON())||selection.from!==editor.state.selection.from||selection.to!==editor.state.selection.to)throw new Error('The selection changed. Paste again at the current position.');
      editor.view.pasteText(value);setClipboardMessage('Pasted plain text.');
    }else{if(!document.execCommand(action))throw new Error('Clipboard access failed. Use the keyboard shortcut to try again.');setClipboardMessage(action==='copy'?'Copied selection.':'Cut selection.');}}
    catch(error){setClipboardMessage(error instanceof Error?error.message:String(error));}
  };
  const page=content.page??{size:'A4',orientation:'portrait',margins:'normal'};
  const countSelection=!editor.state.selection.empty&&!('node' in editor.state.selection);
  const geometry=pageGeometry(page),stats=documentStatistics(content.doc,countSelection?{selectionText:editor.state.doc.textBetween(editor.state.selection.from,editor.state.selection.to,'\n','\uFFFC')}:{});
  const updatePage=(update:Partial<NonNullable<RichContent['page']>>)=>onChange({...content,page:{...page,...update}});
  const headings:{label:string;level:number;pos:number}[]=[];
  editor.state.doc.descendants((node,pos)=>{if(node.type.name==='heading')headings.push({label:node.textContent||'Untitled heading',level:node.attrs.level,pos});});
  const layoutContent=<><div className="rich-source-group"><div className="rich-source-controls"><label className="ed-rich-control">Paper size<select aria-label="Paper size" value={page.size} onChange={e=>updatePage({size:e.target.value as 'A4'|'Letter'})}><option>A4</option><option>Letter</option></select></label><label className="ed-rich-control">Orientation<select aria-label="Page orientation" value={page.orientation} onChange={e=>updatePage({orientation:e.target.value as 'portrait'|'landscape'})}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label><label className="ed-rich-control">Margins<select aria-label="Page margins" value={page.margins} onChange={e=>updatePage({margins:e.target.value as 'normal'|'narrow'|'wide'})}><option value="normal">Normal · 1 inch</option><option value="narrow">Narrow · 0.5 inch</option><option value="wide">Wide · 1.5 inch</option></select></label><span className="ed-muted">{geometry.width} × {geometry.height} mm</span></div><small>Page Setup</small></div><div className="rich-source-group"><div className="rich-source-controls"><div className="rich-spacing"><label>Before<input aria-label="Space before paragraph" type="number" min="0" max="96" step="1" value={paragraphAttrs.spaceBefore??0} onChange={e=>setParagraphSpacing(editor,{spaceBefore:Number(e.target.value)})}/></label><label>After<input aria-label="Space after paragraph" type="number" min="0" max="96" step="1" value={paragraphAttrs.spaceAfter??0} onChange={e=>setParagraphSpacing(editor,{spaceAfter:Number(e.target.value)})}/></label><button className="ed-text-tool" onClick={()=>setCommandDialog('paragraph')}>Paragraph…</button></div></div><small>Paragraph</small></div></>;
  const tableDesign=<div className="rich-table-design"><div className="rich-source-group" role="group" aria-label="Table Styles"><div className="rich-source-controls"><label className="ed-rich-control">Cell fill<input type="color" aria-label="Cell fill" value={tableCellAttrs.backgroundColor??'#ffffff'} onChange={e=>chain().setCellAttribute('backgroundColor',e.target.value).run()}/></label><button className="ed-text-tool" onClick={()=>chain().setCellAttribute('backgroundColor',null).run()}>Clear cell fill</button></div><small>Table Styles</small></div><div className="rich-source-group" role="group" aria-label="Borders"><div className="rich-source-controls"><label className="ed-rich-control">Border color<input type="color" aria-label="Cell border color" value={borderColor} onChange={e=>setBorderColor(e.target.value)}/></label><label className="ed-rich-control">Border points<input type="number" aria-label="Cell border width" min="0.25" max="12" step="0.25" value={borderSize} onChange={e=>setBorderSize(Math.max(.25,Math.min(12,Number(e.target.value)||1)))}/></label><button className="ed-text-tool" onClick={()=>tableBorder('single')}>Solid borders</button><button className="ed-text-tool" onClick={()=>tableBorder('double')}>Double borders</button><button className="ed-text-tool" onClick={()=>tableBorder('dashed')}>Dashed borders</button><button className="ed-text-tool" onClick={()=>tableBorder('nil')}>No borders</button></div><small>Borders</small></div></div>;
  const tableLayout=<div className="rich-table-layout"><div className="rich-source-group" role="group" aria-label="Table"><div className="rich-source-controls"><details className="rich-table-properties"><summary>Properties</summary><label className="ed-rich-control">Table alignment<select aria-label="Table alignment" value={editor.getAttributes('table').tableAlign??'left'} onChange={e=>chain().updateAttributes('table',{tableAlign:e.target.value}).run()}><option>left</option><option>center</option><option>right</option></select></label></details></div><small>Table</small></div><div className="rich-source-group" role="group" aria-label="Rows & Columns"><div className="rich-source-controls"><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().addRowBefore().run())}>Row above</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().addRowAfter().run())}>Row below</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().deleteRow().run())}>Delete row</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().addColumnBefore().run())}>Column before</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().addColumnAfter().run())}>Column after</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().deleteColumn().run())}>Delete column</button><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().deleteTable().run())}>Delete table</button></div><small>Rows & Columns</small></div><div className="rich-source-group" role="group" aria-label="Merge"><div className="rich-source-controls"><button className="ed-text-tool" disabled={!editor.can().mergeCells()} onClick={()=>runRichTableAction(editor,()=>chain().mergeCells().run())}>Merge cells</button><button className="ed-text-tool" disabled={!editor.can().splitCell()} onClick={()=>runRichTableAction(editor,()=>chain().splitCell().run())}>Split cell</button></div><small>Merge</small></div><div className="rich-source-group" role="group" aria-label="Cell Size"><div className="rich-source-controls"><label className="ed-rich-control">Column width (px)<input type="number" aria-label="Table column width" min="25" max="1000" value={tableCellAttrs.colwidth?.[0]??100} onChange={e=>{try{setRichColumnWidth(editor,Number(e.target.value));setTableMessage('');}catch(error){setTableMessage(error instanceof Error?error.message:String(error));}}}/></label></div><small>Cell Size</small></div><div className="rich-source-group" role="group" aria-label="Alignment"><div className="rich-source-controls"><div className="rich-cell-alignment">{(['top','center','bottom'] as const).flatMap(vertical=>(['left','center','right'] as const).map(horizontal=><button key={vertical+horizontal} title={vertical+' '+horizontal} aria-label={'Align '+vertical+' '+horizontal} onClick={()=>runRichTableAction(editor,()=>chain().setCellAttribute('verticalAlign',vertical).setTextAlign(horizontal).run())}><span style={{alignItems:vertical==='top'?'flex-start':vertical==='bottom'?'flex-end':'center',justifyContent:horizontal==='left'?'flex-start':horizontal==='right'?'flex-end':'center'}}>{horizontal==='left'?<AlignLeft size={13}/>:horizontal==='right'?<AlignRight size={13}/>:<AlignCenter size={13}/>}</span></button>))}</div></div><small>Alignment</small></div><div className="rich-source-group" role="group" aria-label="Data"><div className="rich-source-controls"><button className="ed-text-tool" onClick={()=>runRichTableAction(editor,()=>chain().toggleHeaderRow().run())}>Header row</button></div><small>Data</small></div><span aria-live="polite">{tableMessage}</span></div>;
  const reviewContent=<><div className="ed-rich-statistics" aria-label="Document statistics"><span>{countSelection?'Selection':'Document'}</span><span>{stats.words} words</span><span>{stats.characters} characters</span><span>{stats.charactersWithoutSpaces} without spaces</span><span>{stats.paragraphs} paragraphs</span><span>{stats.readingMinutes} min read</span></div></>;
  return <div onKeyDownCapture={e=>{if((e.target as HTMLElement).closest('dialog'))return;if((e.ctrlKey||e.metaKey)&&!e.altKey&&['f','h','k'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();if(e.key.toLowerCase()==='k')setLinkOpen(true);else if(e.key.toLowerCase()==='h')setSearchDialog('replace');else{setEditingOpen(true);setOutline(false);requestAnimationFrame(()=>{(editor.view.dom.closest('.ed-rich')?.querySelector('.rich-navigation input') as HTMLInputElement|null)?.focus();});}}}} className={`ed-root ed-rich ${mode==='slate'?'ed-note':''}`}>
    <style>{`@media print { @page { size: ${page.size} ${page.orientation}; margin: ${geometry.margin}mm; } }`}</style>
    <QuickAccess>{onSave&&<Tool label="Save" onClick={onSave}><Save/></Tool>}<Tool label="Undo" disabled={!editor.can().undo()} onClick={()=>chain().undo().run()}><Undo2/></Tool><Tool label="Redo" disabled={!editor.can().redo()} onClick={()=>chain().redo().run()}><Redo2/></Tool></QuickAccess>
    <Ribbon label="Text formatting" labels={['Clipboard','Font','Paragraph','Styles','Editing','Pages','Tables','Illustrations','Links','Header & Footer']} focusTab="Insert" focusGroups={[5,6,7,8,9]} homeGroups={[0,1,2,3,4]} orderedTabs={['Edit','Home','Insert','Layout','Review','View']} extraTabs={[{name:'Edit',content:<><CommandGroup label="History"><button className="ed-text-tool" disabled={!editor.can().undo()} onClick={()=>chain().undo().run()}>Undo</button><button className="ed-text-tool" disabled={!editor.can().redo()} onClick={()=>chain().redo().run()}>Redo</button></CommandGroup><CommandGroup label="Clipboard"><button className="ed-text-tool" disabled={editor.state.selection.empty} onClick={()=>clipboard('cut')}>Cut</button><button className="ed-text-tool" disabled={editor.state.selection.empty} onClick={()=>clipboard('copy')}>Copy</button><button className="ed-text-tool" onClick={()=>clipboard('paste')}>Paste text</button><button className="ed-text-tool" onClick={()=>setCommandDialog('paste')}>Paste Special…</button></CommandGroup><CommandGroup label="Editing"><button className="ed-text-tool" onClick={()=>setSearchDialog('find')}>Find</button><button className="ed-text-tool" onClick={()=>setSearchDialog('replace')}>Replace</button><button className="ed-text-tool" onClick={()=>format('select-all')}>Select All</button></CommandGroup></>},{name:'Layout',content:layoutContent},{name:'Review',content:reviewContent}]} contextualTabs={editor.isActive('table')?[{name:'Table Design',content:tableDesign},{name:'Table Layout',content:tableLayout}]:[]} viewContent={<><label className="ed-rich-control">Zoom<select aria-label="Document zoom" value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[50,75,90,100,125,150,200].map(value=><option value={value} key={value}>{value}%</option>)}</select></label><button className="ed-text-tool" aria-pressed={outline} onClick={()=>setOutline(!outline)}>Document outline</button></>}>
      <div className="rich-clipboard"><button className="ed-text-tool rich-paste" onMouseDown={e=>e.preventDefault()} onClick={()=>clipboard('paste')}><ClipboardPaste/>Paste text</button><div><Tool label="Cut" disabled={editor.state.selection.empty} onClick={()=>clipboard('cut')}><Scissors/></Tool><Tool label="Copy" disabled={editor.state.selection.empty} onClick={()=>clipboard('copy')}><Copy/></Tool><button className="ed-text-tool" onClick={()=>setCommandDialog('paste')}>Paste Special…</button></div></div><Divider/>
      <div className="rich-font-controls"><div className="rich-font-row"><select aria-label="Font family" title={systemFonts?'Fonts installed on this computer':'Fallback fonts — system font list unavailable'} value={editor.getAttributes('textStyle').fontFamily??'Arial'} onChange={e=>chain().setMark('textStyle',{fontFamily:e.target.value}).run()}>{[...new Set([editor.getAttributes('textStyle').fontFamily??'Arial',...availableFonts])].map(font=><option key={font}>{font}</option>)}</select><select aria-label="Font size" value={editor.getAttributes('textStyle').fontSize??12} onChange={e=>chain().setMark('textStyle',{fontSize:Number(e.target.value)}).run()}>{[...new Set([...fontSizes,Number(editor.getAttributes('textStyle').fontSize)||12])].sort((a,b)=>a-b).map(size=><option key={size} value={size}>{size}</option>)}</select><Tool label="Grow font" onClick={()=>format('grow-font')}><span>A↑</span></Tool><Tool label="Shrink font" onClick={()=>format('shrink-font')}><span>A↓</span></Tool><select aria-label="Change case" title="Change case" value="" disabled={editor.state.selection.empty} onChange={e=>changeCase(e.target.value)}><option value="" disabled>Aa</option><option value="sentence">Sentence case</option><option value="lower">lowercase</option><option value="upper">UPPERCASE</option><option value="title">Capitalize Each Word</option><option value="toggle">tOGGLE cASE</option></select><Tool label="Clear formatting" onClick={()=>format('clear-formatting')}><RemoveFormatting/></Tool></div><div className="rich-font-row"><Tool label="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={()=>chain().toggleBold().run()}><Bold/></Tool><Tool label="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={()=>chain().toggleItalic().run()}><Italic/></Tool><Tool label="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={()=>chain().toggleUnderline().run()}><Underline/></Tool><Tool label="Strikethrough" active={editor.isActive('strike')} onClick={()=>format('strike')}><Strikethrough/></Tool><Tool label="Subscript" active={editor.getAttributes('textStyle').verticalAlign==='sub'} onClick={()=>format('subscript')}><Subscript/></Tool><Tool label="Superscript" active={editor.getAttributes('textStyle').verticalAlign==='super'} onClick={()=>format('superscript')}><Superscript/></Tool><div className="rich-highlight"><Tool label="Apply text highlight" onClick={()=>chain().setMark('textStyle',{backgroundColor:editor.getAttributes('textStyle').backgroundColor??'#ffff00'}).run()}><Highlighter/></Tool><input type="color" aria-label="Text highlight" value={editor.getAttributes('textStyle').backgroundColor??'#ffff00'} onChange={e=>chain().setMark('textStyle',{backgroundColor:e.target.value}).run()}/></div><Tool label="Remove highlight" onClick={()=>chain().setMark('textStyle',{backgroundColor:null}).run()}><span>H×</span></Tool><input type="color" aria-label="Text color" title="Text color" value={editor.getAttributes('textStyle').color??'#0a0a0a'} onChange={e=>chain().setMark('textStyle',{color:e.target.value}).run()}/></div></div><Divider/>
      <div className="rich-paragraph-controls"><div>
      <Tool label="Bullet list" active={editor.isActive('bulletList')} onClick={()=>chain().toggleBulletList().run()}><List/></Tool>
      <Tool label="Numbered list" active={editor.isActive('orderedList')} onClick={()=>chain().toggleOrderedList().run()}><ListOrdered/></Tool>
      <Tool label="Outdent list" disabled={!editor.can().liftListItem('listItem')} onClick={()=>format('outdent-list')}><IndentDecrease/></Tool>
      <Tool label="Indent list" disabled={!editor.can().sinkListItem('listItem')} onClick={()=>format('indent-list')}><IndentIncrease/></Tool>
      <Tool label="Block quote" active={editor.isActive('blockquote')} onClick={()=>chain().toggleBlockquote().run()}><Quote/></Tool><button className="ed-text-tool" onClick={()=>setCommandDialog('paragraph')}>Paragraph…</button>
      </div><div>
      <Tool label="Align left" active={editor.isActive({textAlign:'left'})} onClick={()=>chain().setTextAlign('left').run()}><AlignLeft/></Tool>
      <Tool label="Align center" active={editor.isActive({textAlign:'center'})} onClick={()=>chain().setTextAlign('center').run()}><AlignCenter/></Tool>
      <Tool label="Align right" active={editor.isActive({textAlign:'right'})} onClick={()=>chain().setTextAlign('right').run()}><AlignRight/></Tool>
      <Tool label="Justify" active={editor.isActive({textAlign:'justify'})} onClick={()=>format('justify')}><AlignJustify/></Tool>
      <select aria-label="Line spacing" value={paragraphAttrs.lineHeight??1.6} onChange={e=>setParagraphSpacing(editor,{lineHeight:Number(e.target.value)})}>{[1,1.15,1.5,1.6,2,2.5,3].map(value=><option key={value} value={value}>{value} lines</option>)}</select><ParagraphAppearanceControls editor={editor}/>
      </div></div><Divider/>
      <div className="rich-styles-controls">      <select aria-label="Paragraph style" value={editor.isActive('heading',{level:1})?'1':editor.isActive('heading',{level:2})?'2':editor.isActive('heading',{level:3})?'3':'0'} onChange={e=>{const level=Number(e.target.value);if(level) chain().setHeading({level:level as 1|2|3}).run();else chain().setParagraph().run();}}>
        <option value="0">Normal text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option>
      </select><div className="rich-style-gallery">{[0,1,2,3].map(level=><button key={level} className={`rich-style-sample style-${level}`} onMouseDown={e=>e.preventDefault()} onClick={()=>level?chain().setHeading({level:level as 1|2|3}).run():chain().setParagraph().run()} aria-label={level?`Apply Heading ${level}`:'Apply Normal style'}><svg className="rich-style-preview" viewBox="0 0 48 28" aria-hidden="true" focusable="false"><text x="24" y="21" textAnchor="middle" fill="currentColor" fontFamily="Georgia, serif" fontSize={level===1?22:level===2?20:17}>{level?'Aa':'AaBb'}</text></svg><small>{level?`Heading ${level}`:'Normal'}</small></button>)}</div></div><Divider/>
      <div className="rich-editing-controls"><button className="ed-text-tool" onClick={()=>{setEditingOpen(true);setOutline(false);requestAnimationFrame(()=>{(editor.view.dom.closest('.ed-rich')?.querySelector('.rich-navigation input') as HTMLInputElement|null)?.focus();});}}><Search size={15}/>Find</button><button className="ed-text-tool" onClick={()=>setSearchDialog('replace')}>Replace</button><select aria-label="Select text" value="" onChange={e=>{if(e.target.value==='all')format('select-all');}}><option value="" disabled>Select</option><option value="all">Select All</option></select></div><Divider/>
      <button className="ed-text-tool" onClick={()=>chain().insertContent({type:'pageBreak'}).run()}>Page Break</button><Divider/>
      <Tool label="Insert table" onClick={()=>setCommandDialog('table')}><Table/></Tool><Divider/>
      <Tool label="Insert image" onClick={async()=>{const src=await onPickImage();if(src) chain().setImage({src}).run();}}><ImagePlus/></Tool>
      <Tool label="Horizontal divider" onClick={()=>chain().setHorizontalRule().run()}><Minus/></Tool><Divider/><button className="ed-text-tool" onClick={()=>setLinkOpen(true)}>Link</button><button className="ed-text-tool" disabled={!editor.isActive('link')} onClick={()=>removeRichLink(editor)}>Remove link</button><LinkedValueCommand/>
      <Divider/>{(['headers','footers'] as const).map(kind=><details name="rich-header-footer-menu" onClick={e=>{if((e.target as HTMLElement).closest('button'))e.currentTarget.open=false;}} className="rich-hf-menu" key={kind}><summary>{kind==='headers'?'Header':'Footer'}</summary><div><button onClick={()=>editStory(kind)}>Edit {kind==='headers'?'Header':'Footer'}</button><button onClick={()=>{const hf={...content.headerFooter};delete hf[kind];onChange({...content,headerFooter:hf});}}>Remove {kind==='headers'?'Header':'Footer'}</button></div></details>)}<details name="rich-header-footer-menu" onClick={e=>{if((e.target as HTMLElement).closest('button'))e.currentTarget.open=false;}} className="rich-hf-menu"><summary>Page Number</summary><div><button onClick={()=>{onChange({...content,headerFooter:{...content.headerFooter,headers:{...content.headerFooter?.headers,default:appendPageNumber(content.headerFooter?.headers?.default,false,'right')}}});}}>Top of Page</button><button onClick={()=>onChange({...content,headerFooter:{...content.headerFooter,footers:{...content.headerFooter?.footers,default:appendPageNumber(content.headerFooter?.footers?.default)}}})}>Bottom of Page</button><button onClick={()=>onChange({...content,headerFooter:{...content.headerFooter,footers:{...content.headerFooter?.footers,default:appendPageNumber(content.headerFooter?.footers?.default,true)}}})}>Page X of Y</button><button onClick={()=>chain().insertContent({type:'wordField',attrs:{kind:'PAGE'}}).run()}>Current Position</button></div></details>
    </Ribbon>
    {commandDialog==='paragraph'&&<ParagraphDialog editor={editor} onClose={()=>setCommandDialog(null)}/>}
    {commandDialog==='table'&&<InsertTableDialog editor={editor} pageWidth={(geometry.width-geometry.margin*2)*96/25.4} onClose={()=>setCommandDialog(null)}/>}
    {commandDialog==='paste'&&<PasteSpecialDialog editor={editor} onClose={()=>setCommandDialog(null)}/>}
    {clipboardMessage&&<div className="rich-command-message" role="status">{clipboardMessage}</div>}
    {searchDialog&&<RichSearchDialog mode={searchDialog} onMode={setSearchDialog} onClose={()=>{setSearchDialog(null);editor.commands.focus();}}>{search.panel(searchDialog==='replace')}</RichSearchDialog>}
    {storyKind&&<HeaderFooterDialog kind={storyKind} value={content.headerFooter??{}} onClose={()=>setStoryKind(null)} onApply={value=>{if(JSON.stringify(live.current.content.headerFooter??{})!==storySnapshot.current)throw Error('Header/footer content changed. Reopen the editor.');onChange({...live.current.content,headerFooter:value});}}/>}
    {linkOpen&&<RichLinkDialog editor={editor} onClose={()=>setLinkOpen(false)}/>}
    {mode==='slate'&&<div className="ed-tags"><span>Tags</span>{(content.tags??[]).map(value=><span className="ed-tag" key={value}>#{value}<button aria-label={`Remove tag ${value}`} onClick={()=>onChange({...content,tags:content.tags?.filter(t=>t!==value)})}><X size={12}/></button></span>)}<form onSubmit={e=>{e.preventDefault();addTag();}}><input aria-label="New tag" placeholder="Add a tag" value={tag} onChange={e=>setTag(e.target.value)}/><button aria-label="Add tag" type="submit"><Plus size={14}/></button></form></div>}
    <div className="ed-rich-body">{(editingOpen||outline)&&<nav className="ed-rich-outline rich-navigation" aria-label="Navigation"><header><strong>Navigation</strong><button aria-label="Close Navigation" onClick={()=>{setEditingOpen(false);setOutline(false);}}>×</button></header><div className="rich-nav-tabs"><button aria-pressed={outline} onClick={()=>setOutline(true)}>Headings</button><button aria-pressed={!outline} onClick={()=>setOutline(false)}>Results</button></div>{outline?<div aria-label="Document outline">{headings.length?headings.map(heading=><button key={heading.pos} style={{paddingLeft:12+(heading.level-1)*12}} onClick={()=>chain().setTextSelection(heading.pos+1).scrollIntoView().run()}>{heading.label}</button>):<p>Add headings to navigate your document.</p>}</div>:<>{search.navigation}<button className="ed-text-tool" onClick={()=>setSearchDialog('find')}>Advanced Find</button></>}</nav>}<div className="ed-writing-space"><div className="ed-paper ed-configured-paper" style={{width:`${geometry.width}mm`,minHeight:`${geometry.height}mm`,padding:`${geometry.margin}mm`,zoom:zoom/100} as CSSProperties}><EditorContent editor={editor}/></div></div></div>
    <div className="ed-status"><span>{stats.words} words · {stats.characters} characters</span><span>{page.size} · {page.orientation}<span className="ed-status-dot"/>{zoom}%</span></div>
  </div>;
}











