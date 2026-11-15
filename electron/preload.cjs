const {contextBridge,ipcRenderer}=require('electron');
let rpcHandler=null;
// The document file service (core/kernel/host.d.mts FileService): main owns bindings, system dialogs
// and the format worker; this keeps a synchronous binding cache for the title bar and command state.
const bindings=new Map();const bindingListeners=new Set();let messageBoxHandler=null,pageHandler=null,closeHandler=null;
ipcRenderer.on('studio:file-binding',(_,b)=>{if(!b||typeof b.doc!=='string')return;bindings.set(b.doc,b);for(const l of [...bindingListeners]){try{l(b);}catch{}}});
const restore=error=>{const text=String(error?.message??'');const at=text.indexOf('{"code"');if(at>=0){try{const e=JSON.parse(text.slice(at));return Object.assign(new Error(e.message),{code:e.code,...(e.data!==undefined?{data:e.data}:{})});}catch{}}return error;};
const call=(channel,...args)=>ipcRenderer.invoke(channel,...args).catch(error=>{throw restore(error);});
const remember=b=>{if(b&&typeof b.doc==='string'){bindings.set(b.doc,b);for(const l of [...bindingListeners]){try{l(b);}catch{}}}return b;};
const files={
 binding:doc=>{if(typeof doc!=='string')return null;if(!bindings.has(doc)){const b=ipcRenderer.sendSync('studio:file-binding',doc);if(!b)return null;bindings.set(doc,b);}return bindings.get(doc)??null;},
 onBinding:listener=>{bindingListeners.add(listener);return()=>bindingListeners.delete(listener);},
 adopt:doc=>call('studio:file-adopt',doc).then(remember),
 write:(doc,file,opts)=>call('studio:file-write',doc,file,opts).then(r=>{if(r?.binding)remember(r.binding);return r;}),
 open:(path,opts)=>call('studio:file-open',path,opts),
 create:(kind,opts)=>call('studio:file-create',kind,opts),
 setAutosave:(doc,on)=>call('studio:file-autosave',doc,on).then(remember),
 rename:(doc,name)=>call('studio:file-rename',doc,name).then(remember),
 recent:kind=>call('studio:file-recent',kind),
 pin:(path,on)=>call('studio:file-pin',path,on),
 forget:path=>call('studio:file-forget',path),
 clearRecent:kind=>call('studio:file-clear-recent',kind),
 closed:(doc,opts)=>call('studio:file-closed',doc,opts),
 closeAll:()=>call('studio:file-close-all'),
 unsaved:kind=>call('studio:file-unsaved',kind),
 recover:(doc,opts)=>call('studio:file-recover',doc,opts),
 discardUnsaved:doc=>call('studio:file-discard-unsaved',doc),
 printers:()=>call('studio:file-printers'),
 print:(doc,opts)=>call('studio:file-print',doc,opts),
 pickSave:req=>call('studio:file-pick-save',req),
 pickOpen:req=>call('studio:file-pick-open',req),
 // Synchronous: is this path one the person chose in a dialog, an open file or a recent file? (a bridge `file.open` of any other path asks first)
 known:p=>ipcRenderer.sendSync('studio:file-known',String(p??'')),
 pickDataSave:req=>call('studio:file-pick-data-save',req),
 readFile:(p,opts)=>call('studio:file-read',p,opts),
 writeFile:(doc,req)=>call('studio:file-write-bytes',doc,req),
 pickFolder:req=>call('studio:folder-pick',req),
 writeInFolder:(doc,req)=>call('studio:folder-write',doc,req),
 // The PDFs in a folder the person chose (Combine files > Add folder): names, sizes, times and bytes, bounded in number and size.
 readFolderPdfs:req=>call('studio:folder-pdfs',req),
 // A system font file by path (only the operating system's font folders): for the Unicode text the PDF app writes.
 readSystemFont:p=>call('studio:system-font',p),
 // Main answers first (test mode scripts it); otherwise the window shows its own message box.
 messageBox:async req=>{const r=await call('studio:file-message-box',req);if(!r?.show)return Number(r?.response??0);if(typeof messageBoxHandler!=='function')return Number.isInteger(req?.cancelId)?req.cancelId:0;return Number(await messageBoxHandler(req));},
 onMessageBox:handler=>{messageBoxHandler=typeof handler==='function'?handler:null;return()=>{if(messageBoxHandler===handler)messageBoxHandler=null;};},
 show:(page,doc)=>{if(typeof pageHandler==='function')pageHandler(String(page),doc??null);},
 onShow:handler=>{pageHandler=typeof handler==='function'?handler:null;return()=>{if(pageHandler===handler)pageHandler=null;};},
 /** The window's close button, Alt+F4 or quitting: the handler asks about unsaved changes; false keeps the window. */
 onCloseRequest:handler=>{closeHandler=typeof handler==='function'?handler:null;ipcRenderer.send('studio:close-ready',!!closeHandler);return()=>{if(closeHandler===handler){closeHandler=null;ipcRenderer.send('studio:close-ready',false);}};},
};
ipcRenderer.on('studio:close-request',async(_,request)=>{let ok=true;if(closeHandler){try{ok=(await closeHandler({reason:request?.reason==='quit'?'quit':'window'}))!==false;}catch{ok=false;}}ipcRenderer.send('studio:close-reply',{id:request?.id,ok});});
const toJson=value=>value===undefined?null:JSON.parse(JSON.stringify(value));
const errorJson=error=>{const codes=['invalid_params','invalid_address','not_found','conflict','disabled','unavailable','approval_required','approval_invalid','failed','too_large','timeout'];const code=codes.includes(error?.code)?error.code:'failed';let data;try{data=error?.data===undefined?undefined:toJson(error.data);}catch{data=undefined;}return {code,message:typeof error?.message==='string'&&error.message?error.message:'The request failed',...(data!==undefined?{data}:{})};};
// View › Window (U:quill/view): the open windows (pushed by main, kept for the ribbon's synchronous
// state), New Window, Arrange All, View Side by Side, Switch Windows, and the two channels that keep
// windows in step: a document's committed changes (studio:doc-sync) and Synchronous Scrolling.
let windowsState={windows:[],sideBySide:false,syncScroll:false,partner:null};const windowsListeners=new Set();
const setWindowsState=st=>{if(!st||typeof st!=='object')return;windowsState=st;for(const l of [...windowsListeners]){try{l(st);}catch{}}};
ipcRenderer.on('studio:windows-state',(_,st)=>setWindowsState(st));
ipcRenderer.invoke('studio:windows-state').then(setWindowsState,()=>{});
const listen=(channel,cb)=>{const l=(_,m)=>{try{cb(m);}catch{}};ipcRenderer.on(channel,l);return()=>ipcRenderer.removeListener(channel,l);};
const windowsApi={
 state:()=>windowsState,
 list:()=>call('studio:windows-state').then(st=>{setWindowsState(st);return st.windows;}),
 open:req=>call('studio:windows-open',req?.doc,{docked:req?.docked===true}),
 pin:on=>call('studio:windows-pin',on===true),
 dock:on=>call('studio:windows-dock',on===true),
 focus:id=>call('studio:windows-focus',id),
 arrange:req=>call('studio:windows-arrange',req).then(st=>{setWindowsState(st);return st;}),
 fullScreen:on=>call('studio:windows-fullscreen',on===true),
 onState:cb=>{windowsListeners.add(cb);return()=>windowsListeners.delete(cb);},
 sync:msg=>ipcRenderer.send('studio:doc-sync',msg),
 onSync:cb=>listen('studio:doc-sync',cb),
 scroll:pos=>ipcRenderer.send('studio:scroll-sync',pos),
 onScroll:cb=>listen('studio:scroll-sync',cb),
};
// Presenter View (U:prism/presenter): the show window opens it and pushes the presentation and where the show is;
// the presenter window (started with --studio-presenter) receives that and sends its buttons back.
const presenterApi={
 open:()=>call('studio:presenter-open'),
 close:()=>call('studio:presenter-close'),
 push:msg=>ipcRenderer.send('studio:presenter-push',msg),
 onState:cb=>listen('studio:presenter-state',cb),
 command:cmd=>ipcRenderer.send('studio:presenter-command',cmd),
 onCommand:cb=>listen('studio:presenter-command',cb),
};
contextBridge.exposeInMainWorld('studio',{
 windows:windowsApi,
 presenter:presenterApi,
 presenterOf:process.argv.find(arg=>arg.startsWith('--studio-presenter='))?.slice(19)||null,
 initialDocumentId:process.argv.find(arg=>arg.startsWith('--studio-document='))?.slice(18)||null,
 launchProduct:(kind,documentId)=>ipcRenderer.invoke('studio:launch-product',kind,documentId),
 onOpenDocument:callback=>{const listener=(_,id)=>callback(id);ipcRenderer.on('studio:open-document',listener);return()=>ipcRenderer.removeListener('studio:open-document',listener);},
 product:process.argv.find(a=>a.startsWith('--studio-product='))?.split('=')[1]??'studio',
 windowControl:action=>ipcRenderer.invoke('studio:window-control',action),windowState:()=>ipcRenderer.invoke('studio:window-state'),
 onWindowState:callback=>{const listener=(_,state)=>callback(state);ipcRenderer.on('studio:window-state',listener);return()=>ipcRenderer.removeListener('studio:window-state',listener);},
 peerStyles:{list:()=>ipcRenderer.invoke('studio:peer-workbooks'),get:id=>ipcRenderer.invoke('studio:peer-styles',id)},
 list:()=>ipcRenderer.invoke('studio:list'),save:file=>ipcRenderer.invoke('studio:save',file),remove:(id,revision)=>ipcRenderer.invoke('studio:remove',id,revision),
 importFile:()=>ipcRenderer.invoke('studio:import'),exportFile:(file,format)=>ipcRenderer.invoke('studio:export',file,format),
 profileName:()=>String(process.env.USERNAME||process.env.USER||'').trim()||null,testMode:process.argv.includes('--studio-test=1'),pickImage:()=>ipcRenderer.invoke('studio:image'),pickSound:()=>ipcRenderer.invoke('studio:pick-sound'),pickMedia:req=>ipcRenderer.invoke('studio:pick-media',req),pickDocument:opts=>ipcRenderer.invoke('studio:pick-document',opts),openExternal:url=>ipcRenderer.invoke('studio:open-external',url),captureWindow:()=>ipcRenderer.invoke('studio:capture-window'),print:()=>ipcRenderer.invoke('studio:print'),
 clipboardRead:()=>ipcRenderer.invoke('studio:clipboard-read'),clipboardWrite:data=>ipcRenderer.invoke('studio:clipboard-write',data),
 fonts:()=>ipcRenderer.invoke('studio:fonts'),metrics:()=>ipcRenderer.invoke('studio:metrics'),
 pdfSignatures:content=>ipcRenderer.invoke('studio:pdf-signatures',content),
 pdfOcr:(content,pageId)=>ipcRenderer.invoke('studio:pdf-ocr',content,pageId),ocrImage:(png,width,height)=>ipcRenderer.invoke('studio:ocr-image',png,width,height),
 pdfTextObjects:(content,pageId)=>ipcRenderer.invoke('studio:pdf-text',content,pageId),pdfReplaceText:(content,edit)=>ipcRenderer.invoke('studio:pdf-replace-text',content,edit),
 pdfCombine:content=>ipcRenderer.invoke('studio:pdf-combine',content),pdfForms:content=>ipcRenderer.invoke('studio:pdf-forms',content),pdfDesignForm:(content,edit)=>ipcRenderer.invoke('studio:pdf-design-form',content,edit),pdfFillForms:(content,updates)=>ipcRenderer.invoke('studio:pdf-fill',content,updates),
 onChanged:callback=>{const listener=(_,file)=>callback(file);ipcRenderer.on('studio:changed',listener);return()=>ipcRenderer.removeListener('studio:changed',listener);},
 onRemoved:callback=>{const listener=(_,id)=>callback(id);ipcRenderer.on('studio:removed',listener);return()=>ipcRenderer.removeListener('studio:removed',listener);},
 // The automation layer (docs/bridge-protocol.md section 2, test mode only): main routes requests for documents live in this
 // window here; the preload replies so the renderer never handles correlation ids or the IPC channel.
 onRpc:handler=>{if(typeof handler!=='function')throw new TypeError('onRpc needs a handler');rpcHandler=handler;const listener=async(_,request)=>{if(rpcHandler!==handler||!request||typeof request!=='object')return;const id=typeof request.id==='string'?request.id:null;try{const result=await handler({id,method:String(request.method),params:request.params&&typeof request.params==='object'?request.params:{},origin:'bridge'});if(id!==null)ipcRenderer.send('studio:rpc-reply',{id,ok:true,result:toJson(result)});}catch(error){if(id!==null)ipcRenderer.send('studio:rpc-reply',{id,ok:false,error:errorJson(error)});}};ipcRenderer.on('studio:rpc',listener);return()=>{ipcRenderer.removeListener('studio:rpc',listener);if(rpcHandler===handler)rpcHandler=null;};},
 rpcNotify:message=>{if(!message||typeof message!=='object'||!['hello','documents','event','bye'].includes(message.type))throw new TypeError('Unknown bridge notification');ipcRenderer.send('studio:rpc-notify',toJson(message));},
 files,
 // Slate notebooks as folders (electron/notebook-folders.cjs): the folder dialogs, the folder IO core/slate/lib/notebook-folder.mjs
 // needs (only inside a folder this session picked or a vault notebook's), New/Open Notebook and the recent notebooks.
 notebookFolder:{
  pick:(mode,suggestedName)=>call('studio:notebook-pick',mode,suggestedName),
  readText:p=>call('studio:notebook-fs','readText',p),writeText:(p,text)=>call('studio:notebook-fs','writeText',p,text),
  list:p=>call('studio:notebook-fs','list',p),mkdir:p=>call('studio:notebook-fs','mkdir',p),
  rename:(from,to)=>call('studio:notebook-fs','rename',from,to),remove:p=>call('studio:notebook-fs','remove',p),
  create:(mode,opts)=>call('studio:notebook-create',mode,opts),recent:()=>call('studio:notebook-recent'),
 },
 onFlush:callback=>{const listener=()=>Promise.resolve().then(callback).then(()=>ipcRenderer.send('studio:flushed',true),()=>ipcRenderer.send('studio:flushed',false));ipcRenderer.on('studio:flush',listener);return()=>ipcRenderer.removeListener('studio:flush',listener);},
});
