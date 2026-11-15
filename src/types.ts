import type {PdfContent,PdfSourceTextObject,PdfTextReplacement,PdfSignatureInspection,PdfFormDesignOperation,PdfFormField} from './editors/pdf-types';
export type Kind = 'quill' | 'grid' | 'prism' | 'slate' | 'folio';
/** The app ids the kernel and the generated registry use (same set as Kind). */
export type AppId = Kind;
/** A doc-relative address (docs/architecture.md section 14): '/body/b:7hq2c0xa/t:4-9', '/sh:k3f/B7', '@a12'. */
export type Address = string;
export interface RpcRequest {id:string|null; method:string; params:Record<string,unknown>; origin:'bridge'}
export interface LiveDoc {doc:string; kind:Kind; title:string; version:number; dirty:boolean; storeRevision:number}
export type RpcNotify =
 | {type:'hello'; protocol:2; methods:string[]}
 | {type:'documents'; docs:LiveDoc[]; active:string|null}
 | {type:'event'; event:{type:string; doc?:string; version?:number; [key:string]:unknown}}
 | {type:'bye'};
export type RichNode = {type:string; text?:string; attrs?:Record<string,any>; marks?:{type:string;attrs?:Record<string,any>}[]; content?:RichNode[]};
export type Cell = {value:string; valueType?:'text'|'number'; fontFamily?:string;fontSize?:number;italic?:boolean;underline?:'none'|'single'|'double'|'singleAccounting'|'doubleAccounting';strike?:boolean;wrap?:boolean;verticalAlign?:'top'|'middle'|'bottom'|'justify'|'distributed';rotation?:number;indent?:number;numFmt?:string;borders?:Record<string,{style:string;color:string}>; bold?:boolean; color?:string; background?:string; format?:'general'|'currency'|'percent'|'date'|'time'; align?:'left'|'center'|'right'};
export type PivotDefinition = {sourceSheetId:string;sourceRange:string;rowFields:number[];columnField:number|null;measures:{field:number;aggregate:'SUM'|'COUNT'|'AVG'|'MIN'|'MAX'}[]};
export type XlsxLayout = {rowHeights?:Record<string,number>;columnWidths?:Record<string,number>;merges?:string[];freeze?:{xSplit:number;ySplit:number;topLeftCell?:string;activeCell?:string}};
export type GridTable={name:string;range:string;headerRow:boolean;totalsRow:boolean;columns:{name:string;filterButton?:boolean;totalsRowFunction?:string;totalsRowLabel?:string;totalsRowFormula?:string;calculatedColumnFormula?:string}[];style?:{theme?:string|null;showRowStripes?:boolean;showColumnStripes?:boolean;showFirstColumn?:boolean;showLastColumn?:boolean};autoFilterXml?:string;autoFilterEnabled?:boolean};
export type Sheet = {id:string; name:string; cells:Record<string,Cell>; rows:number; columns:number;xlsxLayout?:XlsxLayout;tables?:GridTable[];pivot?:PivotDefinition};
export type SlideElement = {id:string; type:'text'|'shape'|'image'; x:number; y:number; w:number; h:number; text?:string; src?:string; fill?:string; color?:string; fontSize?:number; fontFamily?:string; bold?:boolean; align?:'left'|'center'|'right'; radius?:number; rotation?:number; flipH?:boolean; flipV?:boolean; italic?:boolean; underline?:boolean; runs?:{text:string;fontFamily?:string;fontSize?:number;bold?:boolean;italic?:boolean;underline?:boolean;color?:string}[]; geometry?:string; stroke?:string; strokeWidth?:number; dash?:string; headArrow?:string; tailArrow?:string; groupPath?:string[]};
export type Slide = {id:string; background:string; elements:SlideElement[]; notes:string; hidden?:boolean; name?:string};
export type HeaderFooter = {differentFirstPage?:boolean;evenAndOdd?:boolean;headers?:Partial<Record<'default'|'first'|'even',RichNode>>;footers?:Partial<Record<'default'|'first'|'even',RichNode>>};
export type RichContent = {doc:RichNode;headerFooter?:HeaderFooter; tags?:string[]; notebook?:string; section?:string; page?:{size:'A4'|'Letter';orientation:'portrait'|'landscape';margins:'normal'|'narrow'|'wide'}};
export type GridContent = {namedRanges?:{name:string;sheetId?:string;reference:string}[];dateSystem?:1900|1904; sheets:Sheet[]; activeSheetId:string};
export type PrismContent = {slides:Slide[]; activeSlideId:string};
export type FabricLink = {id:string; sourceId:string; sheetId:string; address:string; label:string};
export type StudioFile = {id:string; schema:1; kind:Kind; title:string; createdAt:string; updatedAt:string; revision:number; starred:boolean; content:RichContent|GridContent|PrismContent|PdfContent; links:FabricLink[]};
export type EditorProps<C> = {content:C; onChange:(content:C)=>void; onStatus?:(status:string)=>void; onPickImage:()=>Promise<string|null>;onSave?:()=>void|Promise<void>};
export type RichEditorProps = EditorProps<RichContent> & {mode:'quill'|'slate';onSave?:()=>void|Promise<void>};
export type GridEditorProps = EditorProps<GridContent>;
export type PrismEditorProps = EditorProps<PrismContent>;
/** A document's tie to its real file (core/kernel/host.d.mts FileBinding), as the preload caches it. */
export interface FileBinding {doc:string; kind?:Kind; path:string|null; format:string|null; name:string; autosave:boolean; savedHere:boolean; untitled?:boolean; writable?:boolean; recovered?:boolean}
export interface RecentFile {path:string; name:string; folder?:string; kind:Kind; pinned:boolean; missing?:boolean; openedAt?:string|null}
export interface UnsavedDocument {doc:string; kind:Kind; name:string; path:string|null; updatedAt:string; reason:'library'|'closed'|'crash'}
export interface PrinterInfo {name:string; displayName:string; description:string; isDefault:boolean; status:number}
export interface MessageBoxRequest {doc?:string|null; title?:string; type?:'none'|'info'|'warning'|'error'|'question'; message:string; detail?:string; buttons:string[]; defaultId?:number; cancelId?:number}
/** window.studio.files: the document file service (main owns bindings, the system dialogs and the format worker). */
export interface StudioFiles {
 binding(doc:string):FileBinding|null;
 onBinding(listener:(binding:FileBinding)=>void):()=>void;
 adopt(doc:string):Promise<FileBinding>;
 write(doc:string,file:object,opts:{path:string;format:string;bind:boolean;mode:'save'|'saveAs'|'copy'}):Promise<{path:string;format:string;revision?:number;binding?:FileBinding}>;
 open(path:string,opts?:{kind?:Kind;show?:boolean}):Promise<{doc:string;kind:Kind;name:string;path:string;alreadyOpen:boolean}>;
 create(kind:Kind,opts?:{show?:boolean;title?:string;content?:object}):Promise<{doc:string;name:string}>;
 setAutosave(doc:string,on:boolean):Promise<FileBinding>;
 rename(doc:string,name:string):Promise<FileBinding>;
 recent(kind?:Kind):Promise<RecentFile[]>;
 pin(path:string,on:boolean):Promise<RecentFile[]>;
 forget(path:string):Promise<RecentFile[]>;
 clearRecent(kind?:Kind):Promise<RecentFile[]>;
 closed(doc:string,opts:{discard:boolean}):Promise<{closed:boolean}>;
 closeAll():Promise<{closed:boolean;canceled?:boolean}>;
 unsaved(kind?:Kind):Promise<UnsavedDocument[]>;
 recover(doc:string,opts?:{show?:boolean}):Promise<{doc:string;name:string;modified:boolean}>;
 discardUnsaved(doc:string):Promise<{discarded:boolean}>;
 printers():Promise<PrinterInfo[]>;
 print(doc:string,opts:object):Promise<{printed:boolean;canceled?:boolean}>;
 pickSave(req:{doc:string;kind:string;mode:string;name:string;format:string}):Promise<{path:string;format:string}|null>;
 pickOpen(req:{kind:string;doc?:string|null;title?:string;filters?:{name:string;extensions:string[]}[];multiple?:boolean}):Promise<string|string[]|null>;
 pickDataSave(req:{kind:string;doc?:string|null;title?:string;name:string;filters:{name:string;extensions:string[]}[]}):Promise<{path:string;format:string}|null>;
 readFile(path:string,opts?:{maxBytes?:number}):Promise<{name:string;base64:string}>;
 writeFile(doc:string,req:{path:string;base64:string}):Promise<{path:string}>;
 pickFolder(req:{kind:string;title?:string}):Promise<{folder:string;name:string}|null>;
 writeInFolder(doc:string,req:{folder:string;name:string;base64:string}):Promise<{name:string;path:string}>;
 readFolderPdfs?(req:{folder:string;recursive?:boolean}):Promise<{name:string;files:{name:string;size:number;modified:number;base64:string}[];more:boolean}>;
 readSystemFont?(path:string):Promise<Uint8Array|null>;
 messageBox(req:MessageBoxRequest):Promise<number>;
 onMessageBox(handler:(req:MessageBoxRequest)=>Promise<number>|number):()=>void;
 show(page:string,doc?:string|null):void;
 onShow(handler:(page:string,doc:string|null)=>void):()=>void;
 /** The window's close button, Alt+F4 or quitting asks the handler; false keeps the window open. */
 onCloseRequest(handler:(request:{reason:'window'|'quit'})=>Promise<boolean>|boolean):()=>void;
}
/** window.studio.notebookFolder: Slate notebooks as folders (electron/notebook-folders.cjs; core/kernel/host.d.mts NotebookService). */
export interface StudioNotebookFolder {
 pick(mode:'new'|'open',suggestedName?:string):Promise<string|null>;
 readText(path:string):Promise<string>;
 writeText(path:string,text:string):Promise<void>;
 list(path:string):Promise<{name:string;dir:boolean}[]>;
 mkdir(path:string):Promise<void>;
 rename(from:string,to:string):Promise<void>;
 remove(path:string):Promise<void>;
 create(mode:'new'|'open',opts?:{path?:string;name?:string;show?:boolean}):Promise<{doc:string;path:string;name:string;alreadyOpen:boolean;warnings:string[]}|null>;
 recent():Promise<{path:string;name:string;folder:string;kind:'slate';missing:boolean;openedAt:string|null}[]>;
}
export interface StudioAPI {
 readonly files:StudioFiles;
 readonly notebookFolder?:StudioNotebookFolder;
 windowControl(action:'close'|'minimize'|'maximize'):Promise<void>;
 windowState():Promise<{maximized:boolean;focused:boolean}>;
 onWindowState(callback:(state:{maximized:boolean;focused:boolean})=>void):()=>void;
 pdfSignatures(content:PdfContent):Promise<PdfSignatureInspection[]>;
 pdfOcr(content:PdfContent,pageId:string):Promise<{content:PdfContent;result:{text:string;confidence:number;words:any[];language:string}}>;
 ocrImage(png:string,width:number,height:number):Promise<{text:string;confidence:number}>;
 pdfTextObjects(content:PdfContent,pageId:string):Promise<PdfSourceTextObject[]>;
 pdfReplaceText(content:PdfContent,edit:PdfTextReplacement):Promise<PdfContent>;
 readonly initialDocumentId:string|null;
 /** Presenter View: the id of the show window this window presents for (null in every other window), and the channel between the two. */
 readonly presenterOf?:string|null;
 readonly presenter?:{open():Promise<{open:boolean;window:number}>;close():Promise<{open:boolean}>;push(msg:unknown):void;onState(cb:(msg:any)=>void):()=>void;command(cmd:{kind:string;index?:number;info?:{count:string;notes:string;next:number|null}}):void;onCommand(cb:(cmd:{kind:string;index?:number;info?:{count:string;notes:string;next:number|null}})=>void):()=>void};
 launchProduct(kind:Kind,documentId?:string):Promise<boolean>;
 onOpenDocument(callback:(id:string)=>void):()=>void;
 readonly product:Kind|'studio';
 list():Promise<StudioFile[]>; save(file:StudioFile):Promise<StudioFile>; remove(id:string,revision:number):Promise<void>;
 fonts():Promise<{families:string[];system:boolean}>;
 pdfCombine(content:PdfContent):Promise<PdfContent|null>;
 pdfForms(content:PdfContent):Promise<PdfFormField[]>;
 pdfDesignForm(content:PdfContent,operation:PdfFormDesignOperation):Promise<PdfContent>;
 pdfFillForms(content:PdfContent,updates:Record<string,string|boolean|string[]>):Promise<PdfContent>;
 importFile():Promise<StudioFile|null>; exportFile(file:StudioFile,format:string):Promise<string|null>;
 profileName?():string|null; testMode?:boolean; pickImage():Promise<string|null>; pickSound?():Promise<{name:string;data:string}|null>; pickMedia?(req?:{video?:boolean}):Promise<{name:string;data:string}|null>; pickDocument?(req?:{purpose?:'recipients'|'template';all?:boolean;pathOnly?:boolean}):Promise<{name:string;format:string;data:string;path?:string}|null>;openExternal?(url:string):Promise<void>;captureWindow?():Promise<string>; print():Promise<void>;
 clipboardRead():Promise<{text:string;html:string}>; clipboardWrite(data:{text:string;html:string}):Promise<void>;
 metrics():Promise<any>;
 /** Bridge v2 (docs/bridge-protocol.md §2.1): the last registered handler answers studio:rpc requests; the preload replies. */
 onRpc(handler:(request:RpcRequest)=>unknown|Promise<unknown>):()=>void;
 /** Tell main which documents are live, forward session events, say hello/bye. */
 rpcNotify(message:RpcNotify):void;
 onChanged(callback:(file:StudioFile)=>void):()=>void;
 onRemoved(callback:(id:string)=>void):()=>void;
 onFlush(callback:()=>Promise<void>):()=>void;
}
declare global {interface Window {studio:StudioAPI}}
