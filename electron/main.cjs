const {app,BrowserWindow,ipcMain,dialog,session,protocol,net,Menu,clipboard,ClipboardItem,shell}=require('electron');
const path=require('node:path');const fs=require('node:fs/promises');const {pathToFileURL,fileURLToPath}=require('node:url');const {Worker}=require('node:worker_threads');
const {createStore,createFiles}=require('./store.cjs');
const {createRpcRouter}=require('./rpc-router.cjs');
const boot=performance.now();let store,files=null,lifecycle=null,testRpc=null,router=null,headless=null,readyMs=0,watcher,watchTimer,primary=null,hiddenHost=null,idleTimer,shuttingDown=false,quitApproved=false,quitting=false;
// The app root, for core modules that look for shipped files (a packaged main is one bundle, see package-suite.mjs).
globalThis.__arkemisAppRoot=path.join(__dirname,'..');
const productNames={studio:'Arkemis Office',quill:'Quill',grid:'Grid',prism:'Prism',slate:'Slate',folio:'PDF'};
const requestedProduct=process.argv.find(a=>a.startsWith('--product='))?.split('=')[1]??require('../package.json').studioProduct??'studio';
const product=Object.hasOwn(productNames,requestedProduct)?requestedProduct:'studio';
const vaultRoot=process.env.ARKEMIS_STUDIO_DATA?path.resolve(process.env.ARKEMIS_STUDIO_DATA):path.join(app.getPath('appData'),'Arkemis Studio');
// `--clear-trash` (an uninstaller or a reset runs the app once with it): the vault's trash of closed documents is deleted and the app exits.
if(process.argv.includes('--clear-trash')){try{require('node:fs').rmSync(path.join(vaultRoot,'documents','trash'),{recursive:true,force:true});}catch{}app.exit(0);}
// Test mode (docs/architecture.md section 17.5): windows never take focus, so bridge-driven tests run in parallel.
// Never in a packaged build, whatever the environment says (also decides ARKEMIS_STUDIO_DIST); the renderer's preload takes
// its testMode from this decision (--studio-test), not from the environment.
const testMode=!app.isPackaged&&process.env.ARKEMIS_STUDIO_TEST==='1';
// Test windows are inactive and usually covered by other windows: keep them painting, so ui.capture shows the current state
// (Windows' native occlusion tracking would otherwise pause the compositor and capturePage returns a stale frame).
if(testMode){app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');}
// --background (test mode only, tests/e2e): no window until documents.open asks for one; the app quits after a long idle time.
const background=testMode&&process.argv.includes('--background');
// Process metrics are diagnostics: only for tests and development vaults, never in a packaged everyday run.
const diagnostics=testMode||(!app.isPackaged&&Boolean(process.env.ARKEMIS_STUDIO_DATA));
const BACKGROUND_IDLE_MS=30*60*1000;
app.setName(productNames[product]);app.setAppUserModelId('ai.arkemis.'+product);
// macOS: the Dock shows this app's own logo (the bundle's icon is the suite's; Quill, Grid, Prism, Slate and PDF run from the same
// bundle). Windows takes the .ico from each window instead.
if(process.platform==='darwin'&&app.dock)app.whenReady().then(()=>{try{app.dock.setIcon(path.join(__dirname,'../assets/brand/products/'+(product==='studio'?'suite':product)+'-dock.png'));}catch{}});
app.setPath('userData',product==='studio'?vaultRoot:path.join(vaultRoot,'profiles',product));
protocol.registerSchemesAsPrivileged([{scheme:'studio',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const validDocumentId=id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id??'');
const requestedDocument=process.argv.find(arg=>arg.startsWith('--document='))?.slice(11);
const initialDocumentId=validDocumentId(requestedDocument)?requestedDocument:'';
/** Files named on the command line (Office: `winword.exe report.docx`): existing paths, not flags, not the app itself. */
const commandLinePaths=(args,cwd=process.cwd())=>{const own=new Set([process.execPath,app.isPackaged?'':path.resolve(app.getAppPath())].filter(Boolean).map(p=>path.resolve(p).toLowerCase()));return args.filter(a=>typeof a==='string'&&a&&!a.startsWith('-')).map(a=>path.resolve(cwd,a)).filter(p=>!own.has(p.toLowerCase())&&/\.[a-z0-9]{2,5}$/i.test(p));};
const initialPaths=commandLinePaths(process.argv.slice(1));
// macOS: a file opened from Finder (double-click, Open With, dropped on the Dock icon) arrives as open-file, never on the
// command line, so the bundle's document types (scripts/package-suite.mjs) opened the app with nothing in it. Every app runs
// from the one Arkemis Office bundle, so whichever process macOS hands the file to passes it to the file's own app; the
// launcher, started only to open files, shows no window of its own and quits. The app gets the file's path, as on Windows (--product=<app> "%1"), so it opens the file itself.
const KIND_OF_EXTENSION={docx:'quill',dotx:'quill',doc:'quill',rtf:'quill',odt:'quill',xlsx:'grid',xlsm:'grid',xls:'grid',csv:'grid',ods:'grid',pptx:'prism',ppsx:'prism',ppt:'prism',odp:'prism',one:'slate',pdf:'folio'};
const finderFiles=[];let finderReady=false,finderOpened=false;
function openFromFinder(p){
 finderOpened=true;
 const kind=KIND_OF_EXTENSION[path.extname(p).slice(1).toLowerCase()];
 if(!kind||kind===product)return openPathInWindow(p).catch(error=>showError(null,error));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 require('node:child_process').spawn(process.execPath,[...(!app.isPackaged?[app.getAppPath()]:[]),'--product='+kind,p],{detached:true,stdio:'ignore',env}).unref();
 return Promise.resolve();
}
app.on('open-file',(event,p)=>{event.preventDefault();if(typeof p!=='string'||!p)return;if(finderReady)void openFromFinder(p);else finderFiles.push(p);});
/** webContents.id -> {id, win, shown, wantShow, ready, closing, closeTimer, docs:Set, closeReady, asking, approved} */
const windows=new Map();
/** Presenter View (U:prism/presenter): a running Slide Show's window id -> its presenter BrowserWindow. */
const presenters=new Map();
/** Pushes the windows list to every window (View › Switch Windows); set once IPC is up. */
let windowsChanged=()=>{};
const broadcast=(channel,value)=>{for(const entry of windows.values())if(!entry.win.isDestroyed())entry.win.webContents.send(channel,value);};
const shownWindows=()=>[...windows.values()].filter(entry=>entry.shown&&!entry.win.isDestroyed());
function showWindow(entry){
 entry.wantShow=true;if(!entry.ready||entry.win.isDestroyed())return;
 if(entry.win.isMinimized())entry.win.restore();
 if(testMode)entry.win.showInactive();else{entry.win.show();entry.win.focus();}
 entry.shown=true;router?.setShown(entry.id,true);clearTimeout(idleTimer);
}
function touch(){if(!background)return;clearTimeout(idleTimer);idleTimer=setTimeout(async()=>{if(shownWindows().length)return touch();await shutdown();app.quit();},BACKGROUND_IDLE_MS);idleTimer.unref?.();}
/** The window that holds `doc` (live in RendererBridge, or opened for it). */
function windowFor(doc){const id=router?.owner(doc);if(id!==null&&id!==undefined&&windows.has(id))return windows.get(id);for(const entry of windows.values())if(!entry.win.isDestroyed()&&entry.docs.has(doc))return entry;return null;}
/** "Document1 - Quill": the window's document by its file name, as Office titles its windows. */
function windowTitle(entry){
 const doc=[...entry.docs].at(-1);const b=doc&&files?files.binding(doc):null;
 // View › New Window (Word): a document in two windows is "Report:1" and "Report:2".
 const same=doc?[...windows.values()].filter(e=>!e.win.isDestroyed()&&e.docs.has(doc)):[];
 const n=same.length>1?`:${same.indexOf(entry)+1}`:'';
 return b?`${b.name}${n} - ${productNames[product]}`:`${productNames[product]}${n}`;
}
const retitle=entry=>{if(entry&&!entry.win.isDestroyed()){const t=windowTitle(entry);if(entry.win.getTitle()!==t){entry.win.setTitle(t);windowsChanged();}}};
function createWindow({documentId='',show=true}={}){
 const win=new BrowserWindow({width:1400,height:940,minWidth:980,minHeight:680,backgroundColor:'#0e0e0f',frame:false,titleBarStyle:'hidden',show:false,title:productNames[product],icon:path.join(__dirname,product==='studio'?'../assets/brand/products/suite.ico':'../assets/brand/products/'+product+'.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),additionalArguments:['--studio-product='+product,'--studio-document='+(validDocumentId(documentId)?documentId:''),...(testMode?['--studio-test=1']:[])],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:true,backgroundThrottling:show&&!testMode}});
 if(testMode)win.setFocusable(false);
 if(process.platform==='darwin')win.setWindowButtonVisibility(false);
 const id=win.webContents.id,entry={id,win,shown:false,wantShow:show,ready:false,closing:false,closeTimer:null,docs:new Set(validDocumentId(documentId)?[documentId]:[]),closeReady:false,asking:false,approved:false};windows.set(id,entry);
 router?.attachWindow({id,send:message=>{if(!win.isDestroyed())win.webContents.send('studio:rpc',message);},shown:false});
 const sendWindowState=()=>{if(!win.isDestroyed())win.webContents.send('studio:window-state',{maximized:win.isMaximized(),focused:win.isFocused()});};for(const event of ['maximize','unmaximize','focus','blur'])win.on(event,sendWindowState);
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 // A file dropped on the window navigates to it: open it instead (Office opens dropped documents).
 win.webContents.on('will-navigate',(event,url)=>{if(url.startsWith('studio://app/'))return;event.preventDefault();if(url.startsWith('file:')){let p;try{p=fileURLToPath(url);}catch{return;}void openPathInWindow(p,{from:entry}).catch(error=>showError(entry,error));}});
 win.on('page-title-updated',event=>{event.preventDefault();retitle(entry);});
 win.webContents.on('before-input-event',(event,input)=>{if(legacyShortcut(entry,input))event.preventDefault();});
 // Test mode: a renderer's load failures, crashes and errors go to stdout (the E2E harness keeps the app log).
 if(testMode){const tag=`[window ${id}]`;win.webContents.on('did-fail-load',(_,code,desc,url)=>console.log(tag,'did-fail-load',code,desc,url));win.webContents.on('render-process-gone',(_,d)=>console.log(tag,'render-process-gone',d?.reason));win.webContents.on('preload-error',(_,p,e)=>console.log(tag,'preload-error',e?.message));win.webContents.on('console-message',(e)=>{const level=e?.level;if(level==='error'||level==='warning'||level===3||level===2)console.log(tag,'console',level,String(e?.message??'').slice(0,800),e?.sourceId??'',e?.lineNumber??'');});}
 win.once('ready-to-show',()=>{if(!readyMs)readyMs=performance.now()-boot;entry.ready=true;retitle(entry);if(entry.wantShow)showWindow(entry);windowsChanged();});
 win.on('close',event=>{
  if(entry.closing)return;event.preventDefault();
  if(entry.approved){finishClose(entry);return;}
  if(entry.asking)return;
  void requestClose(entry,'window').then(ok=>{if(ok)finishClose(entry);});
 });
 win.on('closed',()=>{clearTimeout(entry.closeTimer);{const pw=presenters.get(id);presenters.delete(id);if(pw&&!pw.isDestroyed())pw.destroy();}windows.delete(id);windowsChanged();router?.detachWindow(id);if(primary===entry)primary=null;if(hiddenHost===entry)hiddenHost=null;
  for(const doc of entry.docs)if(files&&!windowFor(doc))void files.closed(doc,{discard:false,keepModified:true}).catch(()=>{});
  // Hidden bridge windows never keep a normal launch alive once the person closed the last visible one.
  if(entry.shown&&!background&&!shownWindows().length)for(const other of windows.values())if(!other.win.isDestroyed()){other.approved=true;other.win.close();}
  if(background&&!shownWindows().length)touch();});
 win.loadURL('studio://app/index.html').catch(error=>{if(!win.isDestroyed())dialog.showErrorBox('Arkemis Studio could not open a window',error.message);});
 return entry;
}
// ---------------------------------------------------------------------------------------------
// Closing (docs/behaviour-fidelity.md): a window with unsaved changes asks "Do you want to save
// changes to …?" in the window (the registered Save Changes message box; Save runs Save As for a
// new document). The renderer answers studio:close-request; Cancel keeps the window and stops a quit.
let closeSeq=0;const closeWaiters=new Map();
function requestClose(entry,reason){
 if(!entry.ready||entry.win.isDestroyed())return Promise.resolve(true);
 if(!entry.closeReady){entry.asking=true;return legacyClose(entry).catch(error=>{showError(entry,error);return false;}).finally(()=>{entry.asking=false;});}
 entry.asking=true;
 if(reason==='quit'&&entry.wantShow)showWindow(entry);
 return new Promise(resolve=>{const id=++closeSeq;closeWaiters.set(id,{entry,resolve:ok=>{entry.asking=false;resolve(ok);}});entry.win.webContents.send('studio:close-request',{id,reason});});
}
function finishClose(entry){
 if(entry.win.isDestroyed())return;
 entry.win.webContents.send('studio:flush');clearTimeout(entry.closeTimer);
 entry.closeTimer=setTimeout(()=>{dialog.showMessageBox(entry.win,{type:'warning',message:'Studio is still saving. Keep this window open and try closing again.',buttons:['Keep working']});},15000);
}
/** Ask the window to write its working copies now (useWorkspace.flush); false when that failed. */
function flushWindow(entry){return new Promise(resolve=>{if(entry.win.isDestroyed())return resolve(true);const done=ok=>{clearTimeout(timer);resolve(ok);};const timer=setTimeout(()=>{if(entry.flushWaiter===done){entry.flushWaiter=null;resolve(false);}},15000);entry.flushWaiter=done;entry.win.webContents.send('studio:flush');});}
/**
 * The editors that predate the new shell (no RendererBridge, no close handler): main asks the
 * Save Changes question itself, with the system message box, for each document of the window that
 * has changes its file does not have, and saves through the same file service.
 */
async function legacyClose(entry){
 if(!files||product==='studio')return true;
 if(!await flushWindow(entry)){dialog.showMessageBox(entry.win,{type:'error',message:'Some changes could not be saved. Resolve the save error before closing.',buttons:['Keep working']});return false;}
 for(const doc of [...entry.docs]){
  if(!await files.modified(doc).catch(()=>false))continue;
  const b=files.binding(doc);const kind=b?.kind??product;const text=lifecycle.saveChangesText(kind,b?.name??'this document');
  const box={title:productNames[product],type:'warning',message:text.message,detail:text.detail||undefined,buttons:kind==='folio'?['Yes','No','Cancel']:['Save',"Don't Save",'Cancel'],defaultId:0,cancelId:2,noLink:true};
  const asked=askMessage(box);const response=asked.show?(await dialog.showMessageBox(entry.win,box)).response:asked.response;
  if(response===2)return false;
  if(response===0){if(!await mainSave(entry,doc,{}))return false;}
  else await files.closed(doc,{discard:true});
 }
 return true;
}
/** Save from main (the legacy editors' Ctrl+S, F12 and close prompt): the document's file, else the Save As dialog. */
async function mainSave(entry,doc,{saveAs=false}={}){
 const file=await store.get(doc);if(!file)return false;
 const b=files.binding(doc)??await files.adopt(doc);
 const kind=file.kind;let target=!saveAs&&b?.writable?b.path:null;let format=target?b.format:null;
 for(;;){
  if(!target){
   const filters=lifecycle.saveFilters(kind,{first:lifecycle.saveType(kind,b?.format)?.format});
   const result=await askSave(entry.win,{title:'Save As',defaultPath:path.join(b?.path?path.dirname(b.path):await defaultFolder(kind),lifecycle.suggestedFileName(kind,b?.name??file.title,filters[0]?.format)),filters:filtersOf(filters),properties:['showOverwriteConfirmation','createDirectory']});
   if(result.canceled||!result.filePath)return false;
   target=result.filePath;if(!lifecycle.extensionOf(target))target+='.'+filters[0].extensions[0];
   format=lifecycle.formatForPath(kind,target);lastFolder[kind]=path.dirname(target);
  }
  let back=false;
  for(const step of lifecycle.lossyPrompts(kind,format,{name:lifecycle.stemOf(target),sheets:Array.isArray(file.content?.sheets)?file.content.sheets.length:1,mode:saveAs||!b?.path?'saveAs':'save'})){
   const {ok,back:backId,...box}=step;const asked=askMessage({...box,noLink:true});const response=asked.show?(await dialog.showMessageBox(entry.win,{...box,noLink:true})).response:asked.response;
   if(response===ok)continue;if(response===backId){back=true;break;}return false;
  }
  if(back){target=null;continue;}
  break;
 }
 const type=lifecycle.saveType(kind,format);
 await files.write(doc,file,{path:target,format,bind:type.bind||lifecycle.samePath(target,b?.path),mode:saveAs?'saveAs':'save'});
 retitle(entry);return true;
}
/** The legacy editors' Office shortcuts, answered in main: Ctrl+S, F12 / Ctrl+Shift+S, Ctrl+O. */
function legacyShortcut(entry,input){
 if(entry.closeReady||!files||product==='studio'||input.type!=='keyDown')return false;
 const mod=process.platform==='darwin'?input.meta:input.control;const key=String(input.key||'').toLowerCase();
 const action=(mod&&!input.shift&&!input.alt&&key==='s')||(input.shift&&!mod&&key==='f12')?'save':(key==='f12'&&!mod&&!input.shift)||(mod&&input.shift&&key==='s')?'saveAs':(mod&&!input.shift&&key==='o')?'open':null;
 if(!action)return false;
 void (async()=>{
  if(action==='open'){const result=await askOpen(entry.win,{title:'Open',defaultPath:await defaultFolder(product),properties:['openFile'],filters:filtersOf(lifecycle.openFilters(product))});if(!result.canceled&&result.filePaths[0])await openPathInWindow(result.filePaths[0]);return;}
  const doc=[...entry.docs].at(-1);if(!doc)return;
  if(!await flushWindow(entry))throw new Error('Some changes could not be saved. Resolve the save error first.');
  await mainSave(entry,doc,{saveAs:action==='saveAs'});
 })().catch(error=>showError(entry,error));
 return true;
}
/** Quit (Office asks about each document in turn; Cancel stops quitting). */
async function quitFlow(){
 if(quitting)return;quitting=true;
 try{
  const list=[...windows.values()].filter(e=>!e.win.isDestroyed()).sort((a,b)=>Number(b.shown)-Number(a.shown));
  for(const entry of list){if(entry.win.isDestroyed())continue;const ok=await requestClose(entry,'quit');if(!ok)return;entry.approved=true;}
  quitApproved=true;
  for(const entry of list)if(!entry.win.isDestroyed())entry.win.close();
  if(!windows.size){await shutdown();app.quit();}
 }finally{quitting=false;}
}
/** documents.open: show the document in its own window (Office: one window per document), or open it in a hidden one (show:false). */
async function openDocumentWindow(documentId,{show,windowId}){
 let entry=windowId!==undefined?windows.get(windowId):windowFor(documentId);
 if(entry&&!entry.win.isDestroyed()){if(show)showWindow(entry);return {window:entry.id,shown:entry.wantShow};}
 if(files)await files.adopt(documentId).catch(()=>{});
 if(show){
  // The Start screen of an otherwise empty window takes the document, as Office's does.
  entry=[...windows.values()].find(e=>!e.win.isDestroyed()&&e.wantShow&&!e.docs.size&&e!==hiddenHost)??null;
  if(entry){entry.docs.add(documentId);entry.win.webContents.send('studio:open-document',documentId);retitle(entry);showWindow(entry);}
  else{entry=createWindow({documentId,show:true});if(!primary)primary=entry;}
 }else if(hiddenHost&&!hiddenHost.win.isDestroyed()&&!hiddenHost.shown){entry=hiddenHost;entry.docs.add(documentId);entry.win.webContents.send('studio:open-document',documentId);}
 else entry=hiddenHost=createWindow({documentId,show:false});
 return {window:entry.id,shown:entry.wantShow};
}
/** File › Open, a dropped file, a command-line path: the file's own window (an open file comes forward). */
async function openPathInWindow(p,{show=true}={}){
 const r=await files.open(p,{kind:product==='studio'?undefined:product});
 if(product==='studio'){await launchProduct(r.kind,r.doc);return {...r,file:undefined};}
 const opened=await openDocumentWindow(r.doc,{show});
 return {doc:r.doc,kind:r.kind,name:r.name,path:r.path,alreadyOpen:r.alreadyOpen,window:opened.window};
}
async function launchProduct(kind,documentId){const args=[...(!app.isPackaged?[app.getAppPath()]:[]),'--product='+kind,...(documentId?['--document='+documentId]:[])];const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=require('node:child_process').spawn(process.execPath,args,{detached:true,stdio:'ignore',env});child.unref();return true;}
function showError(entry,error){const message=error instanceof Error?error.message:String(error);if(scriptedDialogs){scripted.log.push({type:'error',message});return;}const win=entry&&!entry.win.isDestroyed()?entry.win:null;if(win)dialog.showMessageBox(win,{type:'error',title:productNames[product],message,buttons:['OK']});else dialog.showErrorBox(productNames[product],message);}
async function captureWindow(windowId,params={}){
 const entry=windows.get(windowId);if(!entry||entry.win.isDestroyed())throw Object.assign(new Error('The window is closed'),{code:'unavailable'});
 // Let the renderer paint what it has already rendered (two animation frames, bounded), so the capture is never a frame behind.
 await Promise.race([entry.win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))',false).catch(()=>false),new Promise(r=>setTimeout(r,400))]);
 let image=await entry.win.webContents.capturePage();const scale=Number(params.scale);
 if(Number.isFinite(scale)&&scale>0&&scale!==1&&scale<=4){const size=image.getSize();image=image.resize({width:Math.max(1,Math.round(size.width*scale)),quality:'best'});}
 const size=image.getSize();return {png:image.toPNG().toString('base64'),width:size.width,height:size.height,window:windowId};
}
// ---------------------------------------------------------------------------------------------
// System dialogs. ARKEMIS_STUDIO_TEST=1 in a development checkout only: a scripted queue answers them (the bridge's test.dialogs),
// every request is logged, and a real dialog is never shown. Production always shows the real one.
const scripted={queue:[],log:[]};
// Never in a packaged build, whatever the environment says: there the person always gets the real dialogs.
const scriptedDialogs=testMode&&!app.isPackaged;
const takeScript=type=>{const i=scripted.queue.findIndex(x=>x&&x.type===type);return i<0?null:scripted.queue.splice(i,1)[0];};
const plainOptions=o=>JSON.parse(JSON.stringify(o??{}));
async function askSave(win,options){
 if(scriptedDialogs){scripted.log.push({type:'save',options:plainOptions(options)});const s=takeScript('save');return !s||s.cancel?{canceled:true,filePath:''}:{canceled:false,filePath:s.path};}
 return win?dialog.showSaveDialog(win,options):dialog.showSaveDialog(options);
}
async function askOpen(win,options){
 if(scriptedDialogs){scripted.log.push({type:'open',options:plainOptions(options)});const s=takeScript('open');return !s||s.cancel?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[s.path]};}
 return win?dialog.showOpenDialog(win,options):dialog.showOpenDialog(options);
}
function askMessage(request){
 if(!scriptedDialogs)return {show:true};
 scripted.log.push({type:'message',options:plainOptions(request)});
 const s=takeScript('message');
 return {response:s?Number(s.response):Number.isInteger(request?.cancelId)?request.cancelId:Math.max(0,(request?.buttons?.length??1)-1)};
}
const lastFolder={};
async function defaultFolder(kind){if(lastFolder[kind])return lastFolder[kind];try{return app.getPath('documents');}catch{return app.getPath('home');}}
const filtersOf=list=>list.map(({name,extensions})=>({name,extensions}));
/** Electron PrinterInfo -> what File › Print lists. */
const printerList=list=>list.map(p=>({name:p.name,displayName:p.displayName||p.name,description:p.description||'',isDefault:!!(p.isDefault||p.options?.['printer-is-default']==='true'||p.options?.isDefault==='true'),status:p.status??0}));
const pageRanges=pages=>{if(!pages||pages==='all')return undefined;const out=[];for(const part of String(pages).split(',')){const m=/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);if(!m)throw Object.assign(new Error(`"${part.trim()}" is not a page range: use page numbers and ranges such as 1-3,5`),{code:'invalid_params',data:{path:'/pages'}});const from=Number(m[1]),to=Number(m[2]??m[1]);if(from<1||to<from)throw Object.assign(new Error(`${part.trim()} is not a valid range`),{code:'invalid_params',data:{path:'/pages'}});out.push({from:from-1,to:to-1});}return out;};
function printWindow(entry,opts){
 const settings={silent:true,printBackground:true,...(opts.printer?{deviceName:opts.printer}:{}),copies:opts.copies??1,collate:opts.collate!==false,landscape:opts.orientation==='landscape',color:opts.color!==false,...(opts.paper?{pageSize:opts.paper}:{}),...(opts.duplex?{duplexMode:opts.duplex}:{}),...(pageRanges(opts.pages)?{pageRanges:pageRanges(opts.pages)}:{})};
 if(scriptedDialogs){scripted.log.push({type:'print',options:plainOptions(settings)});return Promise.resolve({printed:true,printer:opts.printer??null,copies:settings.copies});}
 return new Promise((resolve,reject)=>entry.win.webContents.print(settings,(success,reason)=>{if(success)resolve({printed:true,printer:opts.printer??null,copies:settings.copies});else if(reason==='cancelled')resolve({printed:false,canceled:true});else reject(new Error(reason||'The document could not be printed'));}));
}
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;clearTimeout(watchTimer);clearTimeout(idleTimer);watcher?.close();router?.close();await headless?.flush().catch(()=>{});await files?.shutdown().catch(()=>{});
 if(testRpc){const current=testRpc;testRpc=null;await fs.rm(path.join(vaultRoot,'test-rpc.json'),{force:true}).catch(()=>{});await current.stop();}
}
if(!app.requestSingleInstanceLock({documentId:initialDocumentId,paths:initialPaths}))app.quit();else{
app.on('second-instance',(_,args,cwd,data)=>{
 if(args.includes('--background'))return;
 const documentId=validDocumentId(data?.documentId)?data.documentId:'';
 const paths=Array.isArray(data?.paths)&&data.paths.length?data.paths.filter(p=>typeof p==='string'):commandLinePaths(args.slice(1),cwd);
 if(paths.length&&files){for(const p of paths)void openPathInWindow(p).catch(error=>showError(null,error));return;}
 if(documentId){void openDocumentWindow(documentId,{show:true}).catch(error=>showError(null,error));return;}
 const entry=primary&&!primary.win.isDestroyed()?primary:shownWindows()[0];
 if(!entry){primary=createWindow({show:true});return;}
 showWindow(entry);
});
app.whenReady().then(async()=>{
 // Test mode only: ARKEMIS_STUDIO_DIST serves a development renderer bundle (tests/e2e/harness.mjs devRenderer) without touching dist/.
 const root=testMode&&process.env.ARKEMIS_STUDIO_DIST?path.resolve(process.env.ARKEMIS_STUDIO_DIST):path.resolve(__dirname,'../dist');
 protocol.handle('studio',request=>{const url=new URL(request.url);if(url.host!=='app')return new Response('Forbidden',{status:403});const requested=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!requested.startsWith(root+path.sep))return new Response('Forbidden',{status:403});return net.fetch(pathToFileURL(requested).href);});
 const documentsDirectory=path.join(vaultRoot,'documents');store=await createStore(documentsDirectory);
 const marker=path.join(vaultRoot,'initialized');try{await fs.access(marker);}catch{const {demoFiles}=await import('../core/model.mjs');if(product==='studio'&&!(await store.list()).length)for(const file of demoFiles())await store.save(file);await fs.writeFile(marker,'1');}
 const known=new Map((await store.list()).map(f=>[f.id,f.revision]));
 // Every permission is refused except the microphone and camera for this app's own windows (Slate's Record Audio and Record Video,
 // started from a click: src/shell/engine/mediaService.ts). Never the screen (no display-media handler is set, so getDisplayMedia fails), and
 // never in test mode, where recordings come from a synthetic stream.
 const ownContents=wc=>{for(const e of windows.values())if(!e.win.isDestroyed()&&e.win.webContents===wc)return true;return false;};
 session.defaultSession.setPermissionRequestHandler((wc,permission,cb,details)=>cb(permission==='media'&&!testMode&&ownContents(wc)&&String(details?.requestingUrl??'').startsWith('studio://app/')&&(details?.mediaTypes??[]).length>0&&(details.mediaTypes).every(t=>t==='audio'||t==='video')));
 session.defaultSession.setPermissionCheckHandler((wc,permission,origin)=>permission==='media'&&!testMode&&!!wc&&ownContents(wc)&&String(origin??'').startsWith('studio://app'));
 Menu.setApplicationMenu(null);
 watcher=require('node:fs').watch(documentsDirectory,(_,name)=>{if(!name||!(/\.(json|ark)$/.test(String(name))))return;clearTimeout(watchTimer);watchTimer=setTimeout(async()=>{try{const list=await store.list(),present=new Set(list.map(f=>f.id));for(const file of list){if(known.get(file.id)!==file.revision){known.set(file.id,file.revision);broadcast('studio:changed',file);router?.storeChanged(file);}}for(const id of known.keys())if(!present.has(id)){known.delete(id);broadcast('studio:removed',id);router?.storeRemoved(id);}}catch(error){store.warnings.push(error.message);}},250);});
 // Every document is a real file (electron/store.cjs createFiles); the vault keeps working copies for recovery only.
 lifecycle=await import('../core/common/commands/file.mjs');
 const resolveLinks=async file=>{const {evaluateCell}=await import('../core/formulas.mjs');const out=[];for(const link of file.links??[]){const source=await store.get(link.sourceId).catch(()=>null);const sheet=source?.content.sheets?.find(s=>s.id===link.sheetId);out.push({...link,value:sheet?evaluateCell(sheet.cells,link.address,new Set(),new Map(),{...source.content,sheetId:sheet.id}):'Source unavailable'});}return out;};
 // The renderer bundle says which shell it runs (scripts/build.mjs, harness devRenderer: host.json). A new-host renderer edits
 // schema-2 documents: File > New makes them and an older document is converted when it opens (manifest-ready apps always).
 let newHost=false;try{newHost=JSON.parse(await fs.readFile(path.join(root,'host.json'),'utf8')).newHost===true;}catch{}
 files=await createFiles({store,root:vaultRoot,product,worker,resolveLinks,newHost,beforeSave:file=>file.kind==='folio'?validatePdfSourceForSave(file.content):undefined});
 const recovered=new Set();
 const bindingFor=doc=>{const b=files.binding(doc);return b?{...b,recovered:recovered.has(doc)}:null;};
 files.subscribe(b=>{if(!b)return;broadcast('studio:file-binding',{...b,recovered:recovered.has(b.doc)});for(const entry of windows.values())if(entry.docs.has(b.doc))retitle(entry);});
 // A sender is trusted only as the main frame of one of this app's windows, loaded from studio://app/.
 const trusted=event=>{const entry=windows.get(event.sender.id);if(!entry||entry.win.isDestroyed()||event.sender!==entry.win.webContents||event.senderFrame!==entry.win.webContents.mainFrame||!event.senderFrame.url.startsWith('studio://app/'))return null;return entry;};
 const verify=event=>{const entry=trusted(event);if(!entry)throw new Error('Untrusted IPC sender');return entry;};
 const handle=(channel,fn)=>ipcMain.handle(channel,async(event,...args)=>{const entry=verify(event);return fn.call(entry,...args);});
 // The file service's errors keep their kernel code across IPC (the message carries it as JSON; the preload restores it).
 const handleFile=(channel,fn)=>ipcMain.handle(channel,async(event,...args)=>{const entry=verify(event);try{return await fn.call(entry,...args);}catch(error){const code=typeof error?.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'failed';throw new Error(JSON.stringify({code,message:error?.message??String(error),...(error?.data!==undefined?{data:error.data}:{})}));}});
 ipcMain.on('studio:flushed',(event,result)=>{const entry=trusted(event);if(!entry)return;if(entry.flushWaiter){const w=entry.flushWaiter;entry.flushWaiter=null;w(result===true);return;}clearTimeout(entry.closeTimer);if(result===true){entry.closing=true;entry.win.close();}else{entry.approved=false;dialog.showMessageBox(entry.win,{type:'error',message:'Some changes could not be saved. Resolve the save error before closing.',buttons:['Keep working']});}});
 // The window's synchronous check (File service `known`): is this path one the person chose, an open file or a recent one?
 ipcMain.on('studio:file-known',(event,p)=>{const entry=trusted(event);event.returnValue=!!entry&&typeof p==='string'&&files.isKnownPath(p);});
 ipcMain.on('studio:close-ready',(event,ready)=>{const entry=trusted(event);if(entry)entry.closeReady=ready===true;});
 ipcMain.on('studio:close-reply',(event,reply)=>{const entry=trusted(event);if(!entry||!reply||typeof reply!=='object')return;const waiter=closeWaiters.get(reply.id);if(!waiter||waiter.entry!==entry)return;closeWaiters.delete(reply.id);waiter.resolve(reply.ok===true);});
 // The renderer's synchronous binding lookup (title bar, AutoSave state); pushes follow on studio:file-binding.
 ipcMain.on('studio:file-binding',(event,doc)=>{const entry=trusted(event);event.returnValue=entry&&validDocumentId(doc)?bindingFor(doc):null;});
 // The automation layer (docs/bridge-protocol.md section 2): replies and notifications from RendererBridge (only routed in test mode).
 ipcMain.on('studio:rpc-reply',(event,message)=>{const entry=trusted(event);if(entry)router?.onReply(entry.id,message);});
 ipcMain.on('studio:rpc-notify',(event,message)=>{const entry=trusted(event);if(!entry)return;router?.onNotify(entry.id,message);if(message?.type==='documents'&&Array.isArray(message.docs)){for(const d of message.docs)if(validDocumentId(d?.doc)){if(!entry.docs.has(d.doc)&&files)void files.adopt(d.doc).catch(()=>{});entry.docs.add(d.doc);}retitle(entry);}});
 handle('studio:window-state',function(){return {maximized:this.win.isMaximized(),focused:this.win.isFocused()};});
 // ---- Presenter View (U:prism/presenter, deckcraft show/presenter.rs): a second window beside a running Slide
 // Show with the current slide, the next slide, the notes, a timer and the slide count; Next and Previous there
 // drive the show window. The show window pushes the presentation and where the show is (studio:presenter-push);
 // the presenter sends its buttons back (studio:presenter-command). It only ever shows this app's own slides:
 // nothing on any screen is captured. In test mode the window is never shown or focused.
 handle('studio:presenter-open',function(){
  const opener=this,have=presenters.get(opener.id);
  if(have&&!have.isDestroyed()){if(!testMode)have.show();return {open:true,window:have.webContents.id};}
  const win=new BrowserWindow({width:1180,height:720,minWidth:760,minHeight:480,backgroundColor:'#0e0e0f',show:false,title:'Presenter View',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),additionalArguments:['--studio-product='+product,'--studio-presenter='+opener.id,...(testMode?['--studio-test=1']:[])],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  if(testMode)win.setFocusable(false);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.once('ready-to-show',()=>{if(!testMode)win.show();});
  win.on('closed',()=>{if(presenters.get(opener.id)===win)presenters.delete(opener.id);if(!opener.win.isDestroyed())opener.win.webContents.send('studio:presenter-command',{kind:'closed'});});
  presenters.set(opener.id,win);
  win.loadURL('studio://app/index.html').catch(()=>{if(!win.isDestroyed())win.destroy();});
  return {open:true,window:win.webContents.id};
 });
 handle('studio:presenter-close',function(){const win=presenters.get(this.id);presenters.delete(this.id);if(win&&!win.isDestroyed())win.destroy();return {open:false};});
 ipcMain.on('studio:presenter-push',(event,msg)=>{const entry=trusted(event);const win=entry&&presenters.get(entry.id);if(win&&!win.isDestroyed()&&msg&&typeof msg==='object')win.webContents.send('studio:presenter-state',msg);});
 ipcMain.on('studio:presenter-command',(event,cmd)=>{
  if(!cmd||typeof cmd!=='object'||typeof cmd.kind!=='string'||!/^[a-zA-Z]{1,24}$/.test(cmd.kind))return;
  for(const [openerId,win] of presenters){
   if(win.isDestroyed()||win.webContents!==event.sender)continue;
   const opener=windows.get(openerId);
   if(opener&&!opener.win.isDestroyed()){const info=cmd.info&&typeof cmd.info==='object'?{count:String(cmd.info.count??'').slice(0,80),notes:String(cmd.info.notes??'').slice(0,4000),next:Number.isInteger(cmd.info.next)?cmd.info.next:null}:null;opener.win.webContents.send('studio:presenter-command',{kind:cmd.kind,...(Number.isInteger(cmd.index)?{index:cmd.index}:{}),...(info?{info}:{})});}
  }
 });
 handle('studio:window-control',function(action){const win=this.win;if(action==='close')win.close();else if(action==='minimize')win.minimize();else if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();else throw new Error('Unknown window control');});
 // ---- View › Window (U:quill/view): New Window on the same document (edits mirrored, one undo
 // history), Arrange All, View Side by Side with Synchronous Scrolling and Reset Window Position,
 // Switch Windows. Only this app's own windows are ever moved or sized; Full Screen (Focus) is the
 // window's own and never taken in test mode, where windows stay inactive.
 const winState={pair:null,sync:true};
 const appWindows=()=>[...windows.values()].filter(e=>!e.win.isDestroyed()&&e.ready!==undefined&&e.wantShow);
 const winTitle=e=>e.win.isDestroyed()?'':e.win.getTitle().replace(/ - [^-]+$/,'');
 const pairOf=e=>winState.pair&&(winState.pair[0]===e.id||winState.pair[1]===e.id)?winState.pair:null;
 const stateFor=e=>({alwaysOnTop:!!e.onTop,docked:!!e.docked,windows:appWindows().map(x=>({id:x.id,title:winTitle(x),doc:[...x.docs].at(-1)??null,self:x===e,hidden:!!x.userHidden})),sideBySide:!!pairOf(e),syncScroll:!!pairOf(e)&&winState.sync,partner:pairOf(e)?pairOf(e).find(id=>id!==e.id):null});
 const sendWinState=()=>{if(winState.pair&&!winState.pair.every(id=>windows.has(id)&&!windows.get(id).win.isDestroyed()))winState.pair=null;for(const e of windows.values())if(!e.win.isDestroyed())e.win.webContents.send('studio:windows-state',stateFor(e));};
 const workArea=e=>{const {screen}=require('electron');return screen.getDisplayMatching(e.win.getBounds()).workArea;};
 const place=(e,b)=>{if(e.win.isDestroyed())return;if(e.win.isMaximized())e.win.unmaximize();if(e.win.isFullScreen())e.win.setFullScreen(false);e.win.setBounds({x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)});};
 const sideBySide=()=>{const [a,b]=winState.pair.map(id=>windows.get(id));const wa=workArea(a);const w=wa.width/2;place(a,{x:wa.x,y:wa.y,width:w,height:wa.height});place(b,{x:wa.x+w,y:wa.y,width:wa.width-w,height:wa.height});};
 windowsChanged=sendWinState;
 handle('studio:windows-state',function(){return stateFor(this);});
 handle('studio:windows-open',async function(doc,opts){
  if(!validDocumentId(doc)||!this.docs.has(doc))throw new Error('This window does not hold that document');
  const b=this.win.getBounds();
  const entry=createWindow({documentId:doc,show:true});
  // Word cascades the new window a little down and right of the one it came from.
  if(!entry.win.isDestroyed())entry.win.setBounds({x:b.x+30,y:b.y+30,width:b.width,height:b.height});
  for(const e of windows.values())if(e.docs.has(doc))retitle(e);
  entry.win.once('ready-to-show',()=>{for(const e of windows.values())if(e.docs.has(doc))retitle(e);if(opts&&opts.docked===true)dockWindow(entry,true);sendWinState();});
  entry.win.once('closed',()=>{for(const e of windows.values())if(e.docs.has(doc))retitle(e);sendWinState();});
  sendWinState();
  return {window:entry.id,doc};
 });
 handle('studio:windows-focus',function(id){
  const e=windows.get(Number(id));if(!e||e.win.isDestroyed())throw new Error('That window is closed');
  if(e.win.isMinimized())e.win.restore();
  if(testMode)e.win.showInactive();else{e.win.show();e.win.focus();}
  sendWinState();return {window:e.id};
 });
 handle('studio:windows-arrange',function(req){
  const mode=String(req?.mode??'');const list=appWindows();const visible=list.filter(e=>!e.userHidden);
  if(mode==='tiled'||mode==='horizontal'||mode==='vertical'||mode==='cascade'){
   // Arrange Windows (U:grid/view): the visible windows, this one first; only this workbook's when asked.
   const doc=[...this.docs].at(-1);
   const set=visible.filter(e=>!req?.activeWorkbook||e.docs.has(doc));
   const ordered=[this,...set.filter(e=>e!==this)].filter((e,i,a)=>a.indexOf(e)===i&&!e.userHidden);
   const wa=workArea(this);const n=ordered.length;
   if(mode==='horizontal')ordered.forEach((e,i)=>place(e,{x:wa.x,y:wa.y+i*wa.height/n,width:wa.width,height:wa.height/n}));
   else if(mode==='vertical')ordered.forEach((e,i)=>place(e,{x:wa.x+i*wa.width/n,y:wa.y,width:wa.width/n,height:wa.height}));
   else if(mode==='cascade')ordered.forEach((e,i)=>place(e,{x:wa.x+i*32,y:wa.y+i*32,width:Math.max(480,wa.width*0.7),height:Math.max(360,wa.height*0.7)}));
   else{const cols=Math.ceil(Math.sqrt(n));const rows=Math.ceil(n/cols);ordered.forEach((e,i)=>place(e,{x:wa.x+(i%cols)*wa.width/cols,y:wa.y+Math.floor(i/cols)*wa.height/rows,width:wa.width/cols,height:wa.height/rows}));}
  }else if(mode==='hide'){
   // View > Hide: the window goes out of sight, the workbook stays open; another visible window must remain.
   const target=windows.get(Number(req?.with));
   if(!target||target.win.isDestroyed()||target.userHidden)throw new Error('That window cannot be hidden');
   if(!visible.some(e=>e!==target))throw new Error('Open another window before hiding this one');
   target.userHidden=true;if(pairOf(target))winState.pair=null;target.win.hide();
   const next=visible.find(e=>e!==target);if(next&&!next.win.isDestroyed()){if(testMode)next.win.showInactive();else{next.win.show();next.win.focus();}}
  }else if(mode==='unhide'){
   const target=windows.get(Number(req?.with));
   if(!target||target.win.isDestroyed()||!target.userHidden)throw new Error('That window is not hidden');
   target.userHidden=false;if(testMode)target.win.showInactive();else{target.win.show();target.win.focus();}
  }else if(mode==='all'){
   if(!visible.length)return stateFor(this);
   const wa=workArea(this);const h=wa.height/visible.length;
   visible.forEach((e,i)=>place(e,{x:wa.x,y:wa.y+i*h,width:wa.width,height:h}));
  }else if(mode==='sideBySide'){
   const others=visible.filter(e=>e!==this);
   const other=req?.with!==undefined&&req?.with!==null?others.find(e=>e.id===Number(req.with)):others.at(-1);
   if(!other)throw new Error('Open another document to view side by side');
   winState.pair=[this.id,other.id];winState.sync=true;sideBySide();
  }else if(mode==='off'){winState.pair=null;}
  else if(mode==='reset'){if(!pairOf(this))throw new Error('Not viewing side by side');sideBySide();}
  else if(mode==='syncScroll'){if(!pairOf(this))throw new Error('Not viewing side by side');winState.sync=req?.value!==false;}
  else throw new Error('Unknown arrangement');
  sendWinState();return stateFor(this);
 });
 // View > Always on Top and Dock to Desktop (U:slate/view): the window's own, never taken in test mode (the flag is kept, the operating system is not asked).
 const dockWindow=(e,on)=>{
  if(e.win.isDestroyed()||Boolean(e.docked)===on)return;
  if(on){
   e.undocked=e.win.getBounds();e.docked=true;
   if(!testMode){const wa=workArea(e);place(e,{x:wa.x+Math.round(wa.width*0.7),y:wa.y,width:Math.round(wa.width*0.3),height:wa.height});e.win.setAlwaysOnTop(true);}
  }else{
   e.docked=false;
   if(!testMode){if(e.undocked)place(e,e.undocked);e.win.setAlwaysOnTop(!!e.onTop);}
  }
 };
 handle('studio:windows-pin',function(on){this.onTop=on===true;if(!testMode&&!this.win.isDestroyed()&&!this.docked)this.win.setAlwaysOnTop(this.onTop);sendWinState();return {alwaysOnTop:this.onTop};});
 handle('studio:windows-dock',function(on){dockWindow(this,on===true);sendWinState();return {docked:!!this.docked};});
 handle('studio:windows-fullscreen',function(on){if(!testMode&&!this.win.isDestroyed())this.win.setFullScreen(on===true);return {fullScreen:!testMode&&on===true};});
 // A committed change (or undo/redo) in one window of a document goes to its other windows.
 ipcMain.on('studio:doc-sync',(event,msg)=>{const entry=trusted(event);if(!entry||!msg||typeof msg!=='object'||!validDocumentId(msg.doc)||!entry.docs.has(msg.doc))return;for(const e of windows.values())if(e!==entry&&!e.win.isDestroyed()&&e.docs.has(msg.doc))e.win.webContents.send('studio:doc-sync',msg);});
 // Synchronous Scrolling: the scroll position of one of the two side-by-side windows goes to the other.
 ipcMain.on('studio:scroll-sync',(event,msg)=>{const entry=trusted(event);const pair=entry&&pairOf(entry);if(!pair||!winState.sync||!msg||!Number.isFinite(msg.top))return;const other=windows.get(pair.find(id=>id!==entry.id));if(other&&!other.win.isDestroyed())other.win.webContents.send('studio:scroll-sync',{top:Math.max(0,Math.min(1,msg.top)),left:Number.isFinite(msg.left)?Math.max(0,Math.min(1,msg.left)):0});});
 handle('studio:launch-product',async(kind,documentId)=>{if(!Object.hasOwn(productNames,kind)||kind==='studio')throw new Error('Unknown application');if(documentId!==undefined){if(!validDocumentId(documentId))throw new Error('Invalid document');const file=await store.get(documentId);if(file?.kind!==kind)throw new Error('Document does not belong to this application');}return launchProduct(kind,documentId);});
 // The vault is not a library: a window lists the documents it holds (the launcher still lists them all).
 handle('studio:list',async function(){const list=await store.list();return product==='studio'?list:list.filter(f=>this.docs.has(f.id));});
 // Home > Cell Styles > Merge Styles: the workbooks the app holds (open or not) and the cell styles of one of them. Only those styles leave the store.
 handle('studio:peer-workbooks',async function(){const list=await store.list();return list.filter(f=>f&&f.kind==='grid').map(f=>({id:f.id,title:String(f.title??'Workbook'),current:this.docs.has(f.id)}));});
 handle('studio:peer-styles',async function(id){if(!validDocumentId(id))throw new Error('Invalid document');const f=await store.get(id);if(!f||f.kind!=='grid')return [];const styles=Array.isArray(f.content?.cellStyles)?f.content.cellStyles:[];return JSON.parse(JSON.stringify(styles.slice(0,500)));});
 handle('studio:fonts',()=>require('../core/installed-fonts.cjs').installedFonts());
 const clipboardPayload=value=>{
  const limit=2*1024*1024;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'text')||!Object.hasOwn(value,'html'))throw new Error('Clipboard data must contain only text and html.');
  for(const key of ['text','html'])if(typeof value[key]!=='string'||value[key].length>limit||Buffer.byteLength(value[key],'utf8')>limit)throw new Error('Clipboard text and HTML must each be strings under 2 MB.');
  return {text:value.text,html:value.html};
 };
 // Test mode keeps the clipboard in memory: a bridge flow that copies or pastes never reads or overwrites the person's real clipboard.
 const testClipboard={text:'',html:'',picture:null};
 // Text, HTML and a copied picture (electron/clipboard-read.cjs): a screenshot or "Copy image" used to read as an empty clipboard.
 const {readClipboardData,withPicture}=require('./clipboard-read.cjs');
 handle('studio:clipboard-read',async()=>{
  if(testMode)return withPicture({text:testClipboard.text,html:testClipboard.html},testClipboard.picture);
  return readClipboardData(clipboard);
 });
 handle('studio:clipboard-write',async value=>{const data=clipboardPayload(value);if(testMode){testClipboard.text=data.text;testClipboard.html=data.html;testClipboard.picture=null;return;}await clipboard.write([new ClipboardItem({'text/plain':data.text,'text/html':data.html})]);});
 handle('studio:pdf-combine',async function(content){const {validatePdfContent}=await import('../core/pdf-model.mjs');validatePdfContent(content);const selected=await askOpen(this.win,{title:content.pages.length?'Add PDFs after the current document':'Choose PDFs to combine',properties:['openFile','multiSelections'],filters:[{name:'Adobe PDF Files (*.pdf)',extensions:['pdf']}]});if(selected.canceled)return null;if(!selected.filePaths.length||selected.filePaths.length>100)throw new Error('Choose between one and 100 PDF files');return worker({operation:'combine_pdf',content,paths:selected.filePaths});});
 handle('studio:pdf-signatures',content=>worker({operation:'inspect_pdf_signatures',content}));
 handle('studio:pdf-ocr',(content,pageId)=>ocrPdfPage(content,pageId));
 handle('studio:ocr-image',(png,width,height)=>{if(typeof png!=='string'||png.length>34e6)throw new Error('OCR requires a PNG image of at most 25 MB.');const w=Number(width),h=Number(height);if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>20000||h>20000||w*h>100e6)throw new Error('OCR needs the image size in pixels (at most 20,000 a side, 100 megapixels).');return worker({operation:'ocr_image',raster:{pngBase64:png,width:w,height:h}});});
 handle('studio:pdf-text',(content,pageId)=>worker({operation:'inspect_pdf_text',content,pageId}));
 handle('studio:pdf-replace-text',(content,edit)=>worker({operation:'replace_pdf_text',content,edit}));
 handle('studio:pdf-forms',content=>worker({operation:'inspect_pdf_forms',content}));
 handle('studio:pdf-design-form',(content,edit)=>worker({operation:'design_pdf_form',content,edit}));
 handle('studio:pdf-fill',(content,updates)=>worker({operation:'fill_pdf_forms',content,updates}));
 // The working copy (AutoRecover snapshot), written about a second after each edit: never the document's file.
 handle('studio:save',async function(file){if(file?.kind==='folio')await validatePdfSourceForSave(file.content);const isNew=!this.docs.has(file?.id);const saved=await store.save(file);known.set(saved.id,saved.revision);router?.storeChanged(saved);if(isNew&&product!=='studio'&&saved.kind===product){this.docs.add(saved.id);await files.adopt(saved.id).catch(()=>{});retitle(this);}return saved;});
 handle('studio:remove',(id,revision)=>store.remove(id,revision));
 // Other Sound… (Transitions › Sound): the person picks a sound in the system Open dialog; its name and bytes come back.
 handle('studio:pick-media',async function(req){const video=req?.video===true;const result=await askOpen(this.win,{title:video?'Video':'Audio',properties:['openFile'],filters:video?[{name:'Videos',extensions:['mp4','m4v','mov','webm','mkv','avi','wmv','ogv']},{name:'All Files (*.*)',extensions:['*']}]:[{name:'Audio',extensions:['wav','mp3','m4a','aac','ogg','flac','wma','mp4']},{name:'All Files (*.*)',extensions:['*']}]});if(result.canceled||!result.filePaths[0])return null;const filename=result.filePaths[0],stat=await fs.stat(filename);if(stat.size>200_000_000)throw new Error('Choose a file under 200 MB');const bytes=await fs.readFile(filename);return {name:path.basename(filename),data:bytes.toString('base64')};});
 handle('studio:pick-sound',async function(){const result=await askOpen(this.win,{title:'Sound',properties:['openFile'],filters:[{name:'Sounds',extensions:['wav','mp3','m4a','aac','ogg','flac','wma']},{name:'All Files (*.*)',extensions:['*']}]});if(result.canceled||!result.filePaths[0])return null;const filename=result.filePaths[0],stat=await fs.stat(filename);if(stat.size>20_000_000)throw new Error('Choose a sound under 20 MB');const bytes=await fs.readFile(filename);return {name:path.basename(filename),data:bytes.toString('base64')};});
 handle('studio:image',async function(){const result=await askOpen(this.win,{properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg']}]});if(result.canceled)return null;const filename=result.filePaths[0],stat=await fs.stat(filename);if(stat.size>5_000_000)throw new Error('Choose an image under 5 MB');const bytes=await fs.readFile(filename);const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpg=bytes[0]===255&&bytes[1]===216;if(!png&&!jpg)throw new Error('Choose a valid PNG or JPEG');return `data:image/${png?'png':'jpeg'};base64,${bytes.toString('base64')}`;});
 // Browse… for a document to read (Review › Compare's revised document): the person picks it in the system Open dialog; only its bytes come back.
 handle('studio:pick-document',async function(req){const kind=product==='studio'||req?.all===true?null:product;const recipients=req?.purpose==='recipients',template=req?.purpose==='template';const result=await askOpen(this.win,{title:recipients?'Select Data Source':template?'Attach Template':'Browse',properties:['openFile'],filters:template?[{name:'Word templates and documents (*.dotx, *.dotm, *.docx)',extensions:['dotx','dotm','docx']},{name:'All Files (*.*)',extensions:['*']}]:recipients?[{name:'Recipient lists (*.csv, *.tsv, *.txt, *.xlsx, *.xlsm, *.ods)',extensions:['csv','tsv','txt','xlsx','xlsm','ods']},{name:'All Files (*.*)',extensions:['*']}]:kind?filtersOf(lifecycle.openFilters(kind)):[{name:'All Files (*.*)',extensions:['*']}]});if(result.canceled||!result.filePaths[0])return null;const filename=result.filePaths[0];if(req?.pathOnly===true)return {name:path.basename(filename),format:path.extname(filename).slice(1).toLowerCase(),path:filename};const stat=await fs.stat(filename);if(stat.size>30_000_000)throw new Error('Choose a document under 30 MB');const bytes=await fs.readFile(filename);return {name:path.basename(filename),format:path.extname(filename).slice(1).toLowerCase(),data:bytes.toString('base64')};});
 // Open (the Start screen's "Open file"): the system Open dialog; the document is that file from now on.
 handle('studio:import',async function(){
  const kind=product==='studio'?null:product;
  const result=await askOpen(this.win,{title:'Open',defaultPath:await defaultFolder(kind??'studio'),properties:['openFile'],filters:kind?filtersOf(lifecycle.openFilters(kind)):[{name:'All Files (*.*)',extensions:['*']}]});
  if(result.canceled||!result.filePaths[0])return null;
  const opened=await files.open(result.filePaths[0],{kind:kind??undefined});lastFolder[kind??'studio']=path.dirname(result.filePaths[0]);
  if(opened.alreadyOpen){const other=windowFor(opened.doc);if(other&&other!==this){showWindow(other);return null;}}
  this.docs.add(opened.doc);retitle(this);
  return opened.file??await store.get(opened.doc);
 });
 // Export a copy in another format (the Start screen's Save As list): the system Save dialog; the document stays its own file.
 handle('studio:export',async function(file,format){const {validateFile}=await import('../core/model.mjs');validateFile(file);const {exportExtensions}=await import('../core/file-formats.mjs');const allowed=exportExtensions(file.kind);if(!allowed.includes(format))throw new Error('Unsupported format');const type=lifecycle.saveType(file.kind,format);const b=files.binding(file.id);const result=await askSave(this.win,{title:'Save a Copy',defaultPath:path.join(b?.path?path.dirname(b.path):await defaultFolder(file.kind),lifecycle.suggestedFileName(file.kind,b?.name??file.title,format)),filters:type?[{name:`${type.label} (${type.exts.map(e=>'*.'+e).join(';')})`,extensions:type.exts}]:[{name:'.'+format,extensions:[format]}]});if(result.canceled)return null;
  if(type){await files.write(file.id,file,{path:result.filePath,format,bind:false,mode:'copy'});return result.filePath;}
  return worker({operation:'export',file:{...file,resolvedLinks:await resolveLinks(file)},format,path:result.filePath});});
 handle('studio:open-external',async function(url){const u=new URL(String(url));if(!['http:','https:','mailto:'].includes(u.protocol))throw new Error('Only web and mail addresses can be opened');await shell.openExternal(u.href);});
 handle('studio:capture-window',async function(){const image=await this.win.webContents.capturePage();return 'data:image/png;base64,'+image.toPNG().toString('base64');});
 handle('studio:print',function(){const win=this.win;if(scriptedDialogs){scripted.log.push({type:'print',options:{silent:false}});return Promise.resolve();}return new Promise((resolve,reject)=>win.webContents.print({silent:false,printBackground:true},(success,reason)=>{if(!success&&reason!=='cancelled')reject(new Error(reason));else resolve();}));});
 if(diagnostics)handle('studio:metrics',()=>({startupMs:Math.round(readyMs),processes:app.getAppMetrics().map(m=>({type:m.type,cpu:m.cpu.percentCPUUsage,workingSetKB:m.memory.workingSetSize,privateKB:m.memory.privateBytes})),versions:{electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node},warnings:store.warnings.splice(0)}));

 // ---- The file service for the renderer (window.studio.files, core/kernel/host.d.mts FileService) ----
 const ownDoc=(entry,doc)=>{if(!validDocumentId(doc))throw Object.assign(new Error('Invalid document'),{code:'invalid_params'});return doc;};
 handleFile('studio:file-adopt',async function(doc){ownDoc(this,doc);this.docs.add(doc);const b=await files.adopt(doc);retitle(this);return {...b,recovered:recovered.has(doc)};});
 handleFile('studio:file-pick-save',async function(req){
  const kind=String(req?.kind??product);const name=String(req?.name??'');const format=String(req?.format??'');
  const b=req?.doc&&validDocumentId(req.doc)?files.binding(req.doc):null;
  const folder=b?.path?path.dirname(b.path):await defaultFolder(kind);
  const title=req?.mode==='copy'?'Save a Copy':'Save As';
  const filters=lifecycle.saveFilters(kind,{first:lifecycle.saveType(kind,format)?.format});
  const result=await askSave(this.win,{title,defaultPath:path.join(folder,lifecycle.suggestedFileName(kind,name,filters[0]?.format)),filters:filtersOf(filters),properties:['showOverwriteConfirmation','createDirectory']});
  if(result.canceled||!result.filePath)return null;
  let picked=result.filePath;
  // Windows adds the chosen type's extension; when a name comes back without one, the first (chosen) type's is added.
  if(!lifecycle.extensionOf(picked))picked+='.'+filters[0].extensions[0];
  lastFolder[kind]=path.dirname(picked);
  chosen.add(picked);dialogChose(picked);
  return {path:picked,format:lifecycle.formatForPath(kind,picked)};
 });
 // Other files a command works on (form data, extracted pages): a request may name its own title and file types; bytes are only read from and
 // written to paths the person chose in these dialogs.
 const dataFilters=list=>Array.isArray(list)&&list.length&&list.length<=20?list.map(f=>({name:String(f?.name??'Files').slice(0,80),extensions:(Array.isArray(f?.extensions)?f.extensions:[]).map(e=>String(e).replace(/[^A-Za-z0-9]/g,'')).filter(Boolean).slice(0,20)})).filter(f=>f.extensions.length):null;
 const chosen=new Set();
 // Paths the system dialogs returned this session. A window may write to one of these or to the document's own file, and open one of
 // these or a file that is open or recent; any other path a window names is refused (security audit M2).
 const dialogPaths=new Set();
 const pathKey=p=>{const r=path.resolve(String(p));return process.platform==='win32'||process.platform==='darwin'?r.toLowerCase():r;};
 const dialogChose=p=>{if(typeof p==='string'&&p){dialogPaths.add(pathKey(p));files.trust(p);}return p;};
 const forbidden=message=>Object.assign(new Error(message),{code:'forbidden'});
 handleFile('studio:file-pick-open',async function(req){const kind=product==='studio'?String(req?.kind??'quill'):product;const own=dataFilters(req?.filters);const multiple=own&&req?.multiple===true;const result=await askOpen(this.win,{title:own&&typeof req?.title==='string'?req.title.slice(0,120):'Open',defaultPath:await defaultFolder(kind),properties:multiple?['openFile','multiSelections']:['openFile'],filters:own??filtersOf(lifecycle.openFilters(kind))});if(result.canceled||!result.filePaths[0])return null;lastFolder[kind]=path.dirname(result.filePaths[0]);for(const f of result.filePaths)dialogChose(f);if(own)for(const f of result.filePaths)chosen.add(f);return multiple?result.filePaths:result.filePaths[0];});
 handleFile('studio:file-pick-data-save',async function(req){const kind=product==='studio'?String(req?.kind??'quill'):product;const own=dataFilters(req?.filters);if(!own)throw Object.assign(new Error('Name the file types'),{code:'invalid_params'});const name=path.basename(String(req?.name??'Untitled')).replace(/[\/:*?"<>|\x00-\x1f]/g,'_');const result=await askSave(this.win,{title:typeof req?.title==='string'?req.title.slice(0,120):'Save As',defaultPath:path.join(await defaultFolder(kind),name),filters:own,properties:['showOverwriteConfirmation','createDirectory']});if(result.canceled||!result.filePath)return null;let picked=result.filePath;if(!path.extname(picked))picked+='.'+own[0].extensions[0];lastFolder[kind]=path.dirname(picked);chosen.add(picked);dialogChose(picked);return {path:picked,format:path.extname(picked).slice(1).toLowerCase()};});
 handleFile('studio:file-read',async function(p,opts){const target=String(p??'');if(!chosen.has(target))throw Object.assign(new Error('Only a file chosen in the Open dialog can be read'),{code:'forbidden'});const max=Math.min(Number(opts?.maxBytes)||30_000_000,100_000_000);const stat=await fs.stat(target);if(stat.size>max)throw Object.assign(new Error('The file is too large'),{code:'too_large'});return {name:path.basename(target),base64:(await fs.readFile(target)).toString('base64')};});
 handleFile('studio:file-write-bytes',async function(doc,req){ownDoc(this,doc);const target=String(req?.path??'');if(!chosen.has(target))throw Object.assign(new Error('Only a file chosen in the Save dialog can be written'),{code:'forbidden'});const bytes=Buffer.from(String(req?.base64??''),'base64');if(bytes.length>100_000_000)throw Object.assign(new Error('The data is too large'),{code:'too_large'});const temp=`${target}.${process.pid}.tmp`;await fs.writeFile(temp,bytes);await fs.rename(temp,target);return {path:target};});
 // A folder the person chose in the system folder dialog (electron/folder-files.cjs): files written into it (a set of exported images, separate
 // PDFs) go through studio:folder-write, which writes only inside a folder picked this session and only a plain file name.
 const folderFiles=require('./folder-files.cjs');
 const folderWriter=folderFiles.createFolderWriter(new Set());
 handleFile('studio:folder-pick',async function(req){const kind=product==='studio'?String(req?.kind??'quill'):product;const result=await askOpen(this.win,{title:typeof req?.title==='string'?req.title.slice(0,120):'Choose a folder',defaultPath:await defaultFolder(kind),buttonLabel:'Choose',properties:['openDirectory','createDirectory']});if(result.canceled||!result.filePaths[0])return null;const folder=folderWriter.allow(result.filePaths[0]);lastFolder[kind]=folder;return {folder,name:path.basename(folder)};});
 handleFile('studio:folder-pdfs',async function(req){return folderFiles.listPdfs(folderWriter.chosen,req?.folder,req?.recursive===true);});
// A font file of the operating system (electron/system-fonts.cjs): the window embeds one into the PDFs it writes for scripts the standard faces lack.
handleFile('studio:system-font',async function(file){return require('./system-fonts.cjs').readSystemFont(file);});
 handleFile('studio:folder-write',async function(doc,req){ownDoc(this,doc);return folderWriter.write(req?.folder,req?.name,Buffer.from(String(req?.base64??''),'base64'));});
 handleFile('studio:file-message-box',function(req){if(!req||typeof req.message!=='string'||!Array.isArray(req.buttons)||!req.buttons.length)throw Object.assign(new Error('A message box needs a message and buttons'),{code:'invalid_params'});return askMessage(req);});
 handleFile('studio:file-write',async function(doc,file,opts){ownDoc(this,doc);const target=String(opts?.path??''),own=files.binding(doc)?.path;if(target&&!dialogPaths.has(pathKey(target))&&!(own&&pathKey(own)===pathKey(target)))throw forbidden('Only a file chosen in the Save As dialog, or the document\'s own file, can be written');const r=await files.write(doc,file,{path:opts?.path,format:opts?.format,bind:opts?.bind===true,mode:opts?.mode});if(opts?.bind){recovered.delete(doc);this.docs.add(doc);retitle(this);}return r;});
 handleFile('studio:file-open',async function(p){const target=String(p??'');if(target&&!dialogPaths.has(pathKey(target))&&!files.isKnownPath(target))throw forbidden('Only a file chosen in the Open dialog, an open file or a recent file can be opened');return openPathInWindow(target,{from:this});});
 handleFile('studio:file-create',async function(kind,opts){const k=String(kind??product);const made=await files.create(k,{title:typeof opts?.title==='string'?opts.title:undefined,content:opts?.content&&typeof opts.content==='object'?opts.content:undefined});if(opts?.show!==false)await openDocumentWindow(made.doc,{show:true});return {doc:made.doc,name:made.name};});
 // Slate notebooks are folders (electron/notebook-folders.cjs): the system folder dialogs and the folder IO the foundation's
 // core/slate/lib/notebook-folder.mjs needs, restricted to folders this session picked or a vault notebook lives in.
 const notebooks=require('./notebook-folders.cjs').createNotebookFolders({store,recentFile:path.join(vaultRoot,'notebooks.json'),defaultFolder:()=>defaultFolder('slate'),
  askFolder:async({mode,title,defaultPath,win})=>{if(mode==='new'){const r=await askSave(win,{title,defaultPath,buttonLabel:'Create',properties:['createDirectory','showOverwriteConfirmation']});if(r.canceled||!r.filePath)return null;lastFolder.slate=path.dirname(r.filePath);return r.filePath;}const r=await askOpen(win,{title,defaultPath,buttonLabel:'Open',properties:['openDirectory']});if(r.canceled||!r.filePaths[0])return null;lastFolder.slate=path.dirname(r.filePaths[0]);return r.filePaths[0];}});
 handleFile('studio:notebook-pick',async function(mode,name){return notebooks.pick(String(mode??''),typeof name==='string'?name:undefined,this.win);});
 const NOTEBOOK_FS=new Set(['readText','writeText','list','mkdir','rename','remove']);
 handleFile('studio:notebook-fs',async function(op,...args){if(!NOTEBOOK_FS.has(op))throw Object.assign(new Error('Unknown notebook folder operation'),{code:'invalid_params'});return (await notebooks.fs[op](...args))??null;});
 handleFile('studio:notebook-create',async function(mode,opts){const r=await notebooks.create(String(mode??''),{path:typeof opts?.path==='string'?opts.path:null,name:typeof opts?.name==='string'?opts.name:null,win:this.win});if(r&&opts?.show!==false)await openDocumentWindow(r.doc,{show:true});return r;});
 handleFile('studio:notebook-recent',()=>notebooks.recent());
 handleFile('studio:file-autosave',(doc,on)=>files.setAutosave(ownDoc(null,doc),on===true));
 handleFile('studio:file-rename',function(doc,name){ownDoc(this,doc);if(!this.docs.has(doc))throw forbidden('That document is not open in this window');return files.rename(doc,String(name??''));});
 handleFile('studio:file-recent',kind=>files.recent(typeof kind==='string'?kind:product==='studio'?undefined:product));
 handleFile('studio:file-pin',(p,on)=>files.pin(String(p??''),on===true));
 handleFile('studio:file-forget',p=>files.forget(String(p??'')));
 handleFile('studio:file-clear-recent',kind=>files.clearRecent(typeof kind==='string'?kind:undefined));
 handleFile('studio:file-closed',async function(doc,opts){ownDoc(this,doc);recovered.delete(doc);await files.closed(doc,{discard:opts?.discard===true});this.docs.delete(doc);retitle(this);
  // Office: closing a document closes its window while other windows are open; the last one stays on the Start screen.
  if(!this.docs.size&&shownWindows().length>1&&!this.asking){const entry=this;setTimeout(()=>{if(!entry.win.isDestroyed()&&!entry.docs.size){entry.approved=true;entry.win.close();}},50);}
  return {closed:true};});
 handleFile('studio:file-close-all',async function(){for(const entry of [...windows.values()]){if(entry.win.isDestroyed()||!entry.wantShow)continue;const ok=await requestClose(entry,'window');if(!ok)return {closed:false,canceled:true};entry.approved=true;entry.win.close();}return {closed:true};});
 handleFile('studio:file-unsaved',kind=>files.unsaved(typeof kind==='string'?kind:product==='studio'?undefined:product));
 handleFile('studio:file-recover',async function(doc){const r=await files.recover(ownDoc(this,doc));if(r.modified)recovered.add(doc);const opened=await openDocumentWindow(doc,{show:true});return {...r,window:opened.window};});
 handleFile('studio:file-discard-unsaved',doc=>files.discardUnsaved(ownDoc(null,doc)));
 handleFile('studio:file-printers',async function(){try{return printerList(await this.win.webContents.getPrintersAsync());}catch{return [];}});
 handleFile('studio:file-print',async function(doc,opts){ownDoc(this,doc);return printWindow(this,opts&&typeof opts==='object'?opts:{});});

 // The automation layer (docs/architecture.md section 15): the headless host and the rpc router drive documents and the editors' UI the
 // way their own controls do. Only the end-to-end test harness uses it: it runs in test mode (a development checkout started with
 // ARKEMIS_STUDIO_TEST=1), over a loopback transport whose port and token go to the test's own data folder. A normal run opens no port.
 if(testMode){
 const {createHeadlessHost}=await import('./headless-host.mjs');
 headless=await createHeadlessHost({store,product,appVersion:app.getVersion(),worker,files,newHost,beforeSave:file=>file.kind==='folio'?validatePdfSourceForSave(file.content):undefined});
 // Test-only bridge methods (ARKEMIS_STUDIO_TEST=1): script the system dialogs, close a window, quit, read window titles.
 const testHooks=scriptedDialogs?{
  'test.dialogs':params=>{if(params?.clear)scripted.queue.length=0;if(params?.clearLog)scripted.log.length=0;if(Array.isArray(params?.script))scripted.queue.push(...params.script.filter(x=>x&&typeof x==='object'));return {log:[...scripted.log],pending:[...scripted.queue]};},
  'test.window.close':params=>{const entry=typeof params?.doc==='string'?windowFor(params.doc):windows.get(params?.window);if(!entry||entry.win.isDestroyed())throw Object.assign(new Error('No such window'),{code:'not_found'});entry.win.close();return {requested:true,window:entry.id};},
  'test.window.bounds':params=>{const entry=typeof params?.doc==='string'?windowFor(params.doc):windows.get(params?.window);if(!entry||entry.win.isDestroyed())throw Object.assign(new Error('No such window'),{code:'not_found'});const b=params?.bounds;if(b&&typeof b==='object'){const n=['x','y','width','height'].map(k=>Number(b[k]));if(n.some(v=>!Number.isFinite(v)))throw Object.assign(new Error('bounds need four numbers'),{code:'invalid_params'});entry.win.setBounds({x:Math.round(n[0]),y:Math.round(n[1]),width:Math.round(n[2]),height:Math.round(n[3])});}return {...entry.win.getContentBounds(),zoom:entry.win.webContents.getZoomFactor()};},
  'test.app.quit':()=>{setTimeout(()=>app.quit(),10);return {quitting:true};},
  // Put a picture on the in-memory clipboard, as copying an image in another program does (the person's real clipboard is never touched).
  'test.clipboard.picture':params=>{const picture=params?.picture;if(typeof picture!=='string'||!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(picture))throw Object.assign(new Error('A picture data URL is required.'),{code:'invalid_params'});testClipboard.text='';testClipboard.html='';testClipboard.picture=picture;return {ok:true};},
  'test.state':()=>({windows:[...windows.values()].filter(e=>!e.win.isDestroyed()).map(e=>({window:e.id,title:e.win.getTitle(),docs:[...e.docs],shown:e.shown,closeReady:e.closeReady,asking:e.asking})),bindings:Object.fromEntries([...new Set([...windows.values()].flatMap(e=>[...e.docs]))].map(d=>[d,files.binding(d)])),crashed:files.crashed}),
 }:undefined;
 // A destructive or irreversible request asks for approval: the scripted queue answers ({type:'approval', allow}); with nothing
 // scripted the router keeps its two-step nonce protocol.
 const confirmApproval=async req=>{scripted.log.push({type:'approval',options:plainOptions(req)});const s=takeScript('approval');return s?s.allow===true:null;};
 router=createRpcRouter({headless,openDocument:openDocumentWindow,capture:captureWindow,testHooks,confirm:confirmApproval,grantPaths:paths=>{for(const p of paths)dialogChose(p);}});
 const routed={call:(method,params)=>{touch();return router.call(method,params);},subscribe:listener=>router.subscribe(listener)};
 const {startTestRpcServer}=require('./test-rpc-server.cjs');
 testRpc=await startTestRpcServer({router:routed});
 await fs.writeFile(path.join(vaultRoot,'test-rpc.json'),JSON.stringify({version:1,product,port:testRpc.port,token:testRpc.token,pid:process.pid}),{mode:0o600});
 }
 if(background){touch();return;}
 // Document Recovery: after a crash, the documents that were open with unsaved work come back in their windows.
 const comeback=files.crashed&&product!=='studio'?(await files.unsaved(product)).filter(d=>d.reason==='crash').slice(0,10):[];
 for(const d of comeback){const r=await files.recover(d.doc).catch(()=>null);if(r?.modified)recovered.add(d.doc);if(r)await openDocumentWindow(d.doc,{show:true});}
 for(const p of initialPaths)await openPathInWindow(p).catch(error=>showError(null,error));
 finderReady=true;for(const p of finderFiles.splice(0))await openFromFinder(p);
 if(product==='studio'&&finderOpened&&!windows.size&&!initialDocumentId){quitApproved=true;await shutdown();app.quit();return;}
 if(initialDocumentId)await openDocumentWindow(initialDocumentId,{show:true}).catch(error=>showError(null,error));
 if(!windows.size)primary=createWindow({show:true});
}).catch(error=>{dialog.showErrorBox('Arkemis Studio could not start',error.message);app.exit(1);});
app.on('before-quit',event=>{if(quitApproved||shuttingDown||background&&!shownWindows().length)return;event.preventDefault();void quitFlow();});
app.on('window-all-closed',async()=>{if(background&&!shuttingDown){touch();return;}quitApproved=true;await shutdown();app.quit();});
}
function worker(data){return new Promise((resolve,reject)=>{const thread=new Worker(path.join(__dirname,'../runtime/format-worker.cjs'),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:384}});const timer=setTimeout(()=>{thread.terminate();reject(new Error('File conversion took too long. Try a smaller document.'));},90000);thread.once('message',message=>{clearTimeout(timer);thread.terminate();message.ok?resolve(message.result):reject(new Error(message.error));});thread.once('error',error=>{clearTimeout(timer);reject(error);});thread.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('File conversion stopped unexpectedly'));});});}
let pdfInspectionBusy=false;
const validatedPdfSources=new Set();
async function validatePdfSourceForSave(content){
 const {validatePdfContent}=await import('../core/pdf-model.mjs');validatePdfContent(content);if(!content.pages.length)return;
 const key=require('node:crypto').createHash('sha256').update(content.sourceBase64).update(JSON.stringify(content.pages.map(p=>[p.sourceIndex,p.width,p.height,p.sourceRotation]))).digest('hex');
 if(validatedPdfSources.has(key))return;
 await worker({operation:'validate_pdf',content});if(validatedPdfSources.size>=32)validatedPdfSources.delete(validatedPdfSources.values().next().value);validatedPdfSources.add(key);
}
async function renderOriginalPdfPage(content,pageId){return runPdfInspector('arkemisPdfRaster',content,{pageId});}
async function runPdfInspector(functionName,content,options={}){
 if(!['arkemisPdfStructure','arkemisPdfRaster'].includes(functionName))throw new Error('Unsupported PDF operation');
 if(pdfInspectionBusy)throw new Error('PDF inspection is already running. Try again shortly.');
 pdfInspectionBusy=true;let view,timer;
 try{
  view=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view.webContents.on('will-navigate',event=>event.preventDefault());
  const work=(async()=>{await view.loadURL('studio://app/pdf-automation.html');return view.webContents.executeJavaScript('window.'+functionName+'('+JSON.stringify(content)+','+JSON.stringify(options)+')');})();
  return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF text inspection exceeded 30 seconds.')),30000);})]);
 }finally{clearTimeout(timer);if(view&&!view.isDestroyed())view.destroy();pdfInspectionBusy=false;}
}



async function ocrPdfPage(content,pageId){await validatePdfSourceForSave(content);const raster=await renderOriginalPdfPage(content,pageId);return worker({operation:'ocr_pdf_page',content,pageId,raster});}
