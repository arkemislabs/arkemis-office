// The vault: working copies of open documents (AutoRecover snapshots, revision-checked JSON) and,
// in createFiles below, every document's tie to its real file on disk. The vault is never a save
// target: File › Save writes the document's own file through the format worker.
const fs=require('node:fs/promises');const path=require('node:path');
const validId=id=>{if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('Invalid document id');return id;};
async function createStore(directory){
 const {validateFile,applyCommand}=await import('../core/model.mjs');await fs.mkdir(directory,{recursive:true});
 let queue=Promise.resolve();const warnings=[];const saveHooks=new Set();
 const lockPath=path.join(directory,'.write-lock');
 async function locked(fn){
  const deadline=Date.now()+15000;let lock;
  while(!lock){try{lock=await fs.open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));}
   catch(error){if(error.code!=='EEXIST')throw error;
    // Only reclaim a lock whose recorded process no longer exists. A live
    // process is never timed out, even during a slow disk write.
    let reclaim;
    try{reclaim=await fs.open(lockPath+'.reclaim','wx');await reclaim.writeFile(JSON.stringify({pid:process.pid}));const stat=await fs.stat(lockPath);let owner;
     try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{}
     let dead=false;if(Number.isSafeInteger(owner?.pid)){try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}}
     else dead=Date.now()-stat.mtimeMs>15000;
     if(dead)await fs.unlink(lockPath);
    }catch(e){if(e.code==='EEXIST'){
      try{const gate=lockPath+'.reclaim',stat=await fs.stat(gate);let owner;try{owner=JSON.parse(await fs.readFile(gate,'utf8'));}catch{}
       let dead=false;if(Number.isSafeInteger(owner?.pid)){try{process.kill(owner.pid,0);}catch(error){dead=error.code==='ESRCH';}}else dead=Date.now()-stat.mtimeMs>15000;
       if(dead)await fs.unlink(gate);
      }catch(error){if(error.code!=='ENOENT')throw error;}
     }else if(e.code!=='ENOENT')throw e;}finally{if(reclaim){await reclaim.close();await fs.unlink(lockPath+'.reclaim').catch(()=>{});}}
    if(Date.now()>deadline)throw new Error('Another Arkemis app is using the workspace. Try saving again.');
    await new Promise(resolve=>setTimeout(resolve,25));
   }
  }
  try{return await fn();}finally{await lock.close();await fs.unlink(lockPath);}
 }
 const serial=fn=>{const result=queue.then(()=>locked(fn));queue=result.catch(()=>{});return result;};
 // The trash (security audit M5): a closed document's last working copy, kept for TRASH_DAYS so an accidental close can be undone, then deleted.
 // A password-protected PDF is never put there (its working copy is the decrypted file and holds its file key): it is deleted outright.
 const trashDir=path.join(directory,'trash');
 const TRASH_DAYS=30;
 const isProtected=file=>file?.kind==='folio'&&!!(file.content?.security||file.content?.locked);
 /** A OneNote notebook with protected sections, as a save writes it (core/slate/lib/protect.mjs sealForDisk): every protected section locked and
  *  encrypted, none of its pages or its key in the file. null when the notebook has nothing to seal. */
 async function sealedNotebook(file){
  if(file?.kind!=='slate'||!file.content)return null;
  const {hasProtected,sealForDisk}=await import('../core/slate/lib/protect.mjs');
  if(!hasProtected(file.content))return null;
  return {...file,content:await sealForDisk(file.content)};
 }
 const trashedAt=async(name,full)=>{const m=/-(\d{12,})\.json$/.exec(name);if(m)return Number(m[1]);try{return (await fs.stat(full)).mtimeMs;}catch{return 0;}};
 /** Delete trash older than 30 days, and any protected PDF an earlier version left there. Returns how many files went. */
 async function purgeTrash(now=Date.now()){
  let names;try{names=await fs.readdir(trashDir);}catch{return 0;}
  let removed=0;
  for(const name of names){
   const full=path.join(trashDir,name);
   try{
    let drop=now-await trashedAt(name,full)>TRASH_DAYS*86400000;
    if(!drop&&/\.json$/.test(name)){const stat=await fs.stat(full);if(stat.size<100_000_000){const text=await fs.readFile(full,'utf8');drop=/"kind":"folio"/.test(text)&&(/"security":\{/.test(text)||/"locked":\{/.test(text));}}
    if(!drop&&/\.json$/.test(name)&&/"kind":"slate"/.test(await fs.readFile(full,'utf8'))){
     // A notebook an earlier version trashed with an unlocked section in it: sealed in place, as a save would have written it.
     const text=await fs.readFile(full,'utf8'),sealed=await sealedNotebook(JSON.parse(text)),out=sealed&&JSON.stringify(sealed);
     if(out&&out!==text)await fs.writeFile(full,out,'utf8');
    }
    if(drop){await fs.rm(full,{force:true});removed++;}
   }catch{}
  }
  return removed;
 }
 void purgeTrash().catch(()=>{});
 const location=id=>path.join(directory,validId(id)+'.json');
 async function readAt(target,id){
  try{return validateFile(JSON.parse(await fs.readFile(target,'utf8')));}catch(e){
   if(e.code==='ENOENT')return null;
   try{const backup=validateFile(JSON.parse(await fs.readFile(target+'.bak','utf8')));warnings.push(`Recovered ${backup.title} from its previous save.`);await fs.copyFile(target,target+'.damaged');await fs.copyFile(target+'.bak',target);return backup;}catch{throw new Error(`Cannot read document ${id}. Its files have been preserved.`);}
  }
 }
 async function read(id){
  const target=location(id),current=await readAt(target,id);if(current)return current;
  // Existing private workspace files remain readable. New writes use standard
  // JSON storage, never a custom user-facing document format.
  const legacy=path.join(directory,validId(id)+'.ark'),file=await readAt(legacy,id);if(!file)return null;
  await fs.rename(legacy,target);
  try{await fs.rename(legacy+'.bak',target+'.bak');}catch(error){if(error.code!=='ENOENT')throw error;}
  return file;
 }
 async function write(file){
  validateFile(file);const target=location(file.id),temp=target+'.tmp';
  const handle=await fs.open(temp,'w');try{await handle.writeFile(JSON.stringify(file),'utf8');await handle.sync();}finally{await handle.close();}
  try{await fs.copyFile(target,target+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.rename(temp,target);return file;
 }
 return {
  warnings,
  get:id=>serial(()=>read(id)),
  list:()=>serial(async()=>{const entries=await fs.readdir(directory),files=[];const ids=new Set(entries.filter(n=>/\.(json|ark)$/.test(n)).map(n=>n.replace(/\.(json|ark)$/, '')));for(const id of ids){try{const file=await read(id);if(file)files.push(file);}catch(e){warnings.push(e.message);}}return files.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}),
  save:file=>serial(async()=>{validateFile(file);const current=await read(file.id);if((current?.revision??0)!==file.revision)throw new Error('Revision conflict: another editor saved this document. Reload before saving.');const saved=await write({...file,revision:file.revision+1,updatedAt:new Date().toISOString()});for(const hook of [...saveHooks]){try{await hook(current,saved);}catch{}}return saved;}),
  /** Called after every save with (previous, saved): the file service tells a conversion from an edit. */
  afterSave(hook){saveHooks.add(hook);return()=>saveHooks.delete(hook);},
  command:(id,command)=>serial(async()=>{const current=await read(id);if(!current)throw new Error('Document not found');return write(applyCommand(current,command));}),
  remove:(id,revision)=>serial(async()=>{const current=await read(id);if(!current)return;if(current.revision!==revision)throw new Error('Revision conflict');const target=location(id);if(isProtected(current)){await fs.rm(target,{force:true});await fs.rm(target+'.bak',{force:true});return;}await fs.mkdir(trashDir,{recursive:true});const kept=path.join(trashDir,id+'-'+Date.now()+'.json');const sealed=await sealedNotebook(current);if(sealed){await fs.writeFile(kept,JSON.stringify(sealed),'utf8');await fs.rm(target,{force:true});}else await fs.rename(target,kept);await fs.rm(target+'.bak',{force:true});}),
  purgeTrash:now=>serial(()=>purgeTrash(now)),
  /** Empty the trash (an uninstall or reset of the app). */
  clearTrash:()=>serial(()=>fs.rm(trashDir,{recursive:true,force:true})),
 };
}

// ---------------------------------------------------------------------------------------------
// Document files (docs/behaviour-fidelity.md "File > Save"): every document is a real file, as in
// Office. Electron-agnostic: main.cjs adds the system dialogs and windows; the bridge contract
// tests use it as is.
//
//   <vault>/files.json               {version:1, documents:{[doc]: Binding}, recent:[...], autosave:{[path]:true}}
//   <vault>/running/<product>.json   {pid}: present while the app runs; left behind by a crash
//
// A Binding ties a working copy (the vault document `doc`) to its file: {kind, path, format, name,
// autosave, savedHash (content hash at the last save or open), open, pid, closedAt, unsavedAt}.
// `savedHere` (the person saved it in this session: AutoSave may rewrite it) lives in memory only.
// Behaviour translated from wordcraft crates/ui-egui/src/app/files.rs (save before close, AutoSave,
// keep unsaved new documents), deckcraft crates/ui-egui/src/backstage/files.rs (recent list:
// missing files, remove from Recent) and printcraft file.clear_recent, at the commits named in
// core/common/commands/file.mjs.

const crypto=require('node:crypto');
const {assertLocalFilePath}=require('./safe-path.cjs');
const {plainFileName}=require('./folder-files.cjs');
const RECENT_LIMIT=50;
const fail=(code,message,data)=>Object.assign(new Error(message),{code,...(data!==undefined?{data}:{})});
const hashOf=content=>crypto.createHash('sha256').update(JSON.stringify(content??null)).digest('hex');
/** What a save writes: the content and the document properties (a changed property is an unsaved change too). */
const stateHash=file=>hashOf({content:file?.content??null,properties:file?.properties??null});
const pidAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;if(pid===process.pid)return true;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const pathKey=p=>{let x=path.resolve(String(p));if(process.platform==='win32'||process.platform==='darwin')x=x.toLowerCase();return x;};

/**
 * @param {{store: any, root: string, product?: string, worker?: (op: object) => Promise<any>,
 *   beforeSave?: (file: any) => Promise<void>|void, now?: () => number, resolveLinks?: (file: any) => Promise<any[]>,
 *   newHost?: boolean | ((kind: string) => boolean)}} opts
 *   newHost: the new shell edits these documents (a development or test build, ARKEMIS_NEW_HOST), so
 *   File › New makes schema-2 documents for every app whose foundation can create them; otherwise
 *   only for apps whose manifest is ready (core/generated/apps.mjs `ready`).
 */
async function createFiles({store,root,product='studio',worker,beforeSave,now=()=>Date.now(),resolveLinks,newHost=false}={}){
 if(!store||typeof store.get!=='function')throw new TypeError('createFiles needs the vault store');
 const lifecycle=await import('../core/common/commands/file.mjs');
 const {isUpgrade}=await import('../core/kernel/open-migrate.mjs');
 const model=await import('../core/model.mjs');
 const policy=await import('../core/import-policy.mjs');
 const indexPath=path.join(root,'files.json');
 const runningDir=path.join(root,'running');
 const kinds=product==='studio'?['quill','grid','prism','folio','slate']:[product];
 const trusted=new Set();      // pathKey of files the person chose in a system dialog this session
 const live=new Map();        // doc -> binding (this process's view, with savedHere)
 const counters={};           // kind -> last untitled number this session
 const listeners=new Set();
 let index={version:1,documents:{},recent:[],autosave:{}};
 let crashed=false;
 let queue=Promise.resolve();

 const lock=async fn=>{
  const lockPath=indexPath+'.lock',deadline=Date.now()+10000;let handle;
  while(!handle){
   try{handle=await fs.open(lockPath,'wx');await handle.writeFile(String(process.pid));}
   catch(e){if(e.code!=='EEXIST')throw e;
    try{const owner=Number(await fs.readFile(lockPath,'utf8'));const stat=await fs.stat(lockPath);if(!pidAlive(owner)||Date.now()-stat.mtimeMs>15000)await fs.unlink(lockPath).catch(()=>{});}catch{}
    if(Date.now()>deadline)throw fail('timeout','Another Arkemis app is updating the recent files list. Try again.');
    await new Promise(r=>setTimeout(r,20));}
  }
  try{return await fn();}finally{await handle.close().catch(()=>{});await fs.unlink(lockPath).catch(()=>{});}
 };
 const readIndex=async()=>{
  try{const j=JSON.parse(await fs.readFile(indexPath,'utf8'));if(j&&typeof j==='object'&&j.version===1)return {version:1,documents:j.documents&&typeof j.documents==='object'?j.documents:{},recent:Array.isArray(j.recent)?j.recent.filter(r=>r&&typeof r.path==='string'):[],autosave:j.autosave&&typeof j.autosave==='object'?j.autosave:{}};}
  catch(e){if(e.code!=='ENOENT')await fs.copyFile(indexPath,indexPath+'.damaged').catch(()=>{});}
  return {version:1,documents:{},recent:[],autosave:{}};
 };
 /** Read-modify-write files.json under its lock (other Arkemis apps share the vault). */
 const update=fn=>{const run=queue.then(()=>lock(async()=>{index=await readIndex();const out=await fn(index);await fs.mkdir(root,{recursive:true});const temp=indexPath+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(index));await fs.rename(temp,indexPath);return out;}));queue=run.catch(()=>{});return run;};
 const persisted=b=>({kind:b.kind,path:b.path??null,format:b.format??null,name:b.name,autosave:!!b.autosave,savedHash:b.savedHash??null,open:!!b.open,pid:b.open?process.pid:null,closedAt:b.closedAt??null,unsavedAt:b.unsavedAt??null,...(b.done?{done:true}:{})});
 const publicBinding=b=>b?{doc:b.doc,kind:b.kind,path:b.path??null,format:b.format??null,name:b.name,autosave:!!b.autosave,savedHere:!!b.savedHere,untitled:!b.path,writable:!!(b.path&&lifecycle.saveType(b.kind,b.format))}:null;
 const emit=b=>{const out=publicBinding(b);for(const l of [...listeners]){try{l(out);}catch{}}};
 const save=async b=>{live.set(b.doc,b);await update(i=>{i.documents[b.doc]=persisted(b);});emit(b);return publicBinding(b);};
 const assertKind=k=>{if(!kinds.includes(k))throw fail('unavailable',`This app does not edit ${k} documents`,{kind:k});};
 const known=doc=>live.get(doc)??(index.documents[doc]?{doc,...index.documents[doc],savedHere:false}:null);
 /** Schema 2 for `kind`: its foundation can create content, and its new host is live (manifest ready, or newHost). */
 async function schema2(kind){
  const foundation=await import('../core/generated/apps.mjs').then(m=>m.apps?.[kind]).catch(()=>null);
  if(typeof foundation?.schema?.createContent!=='function')return false;
  return foundation.ready===true||(typeof newHost==='function'?!!newHost(kind):newHost===true);
 }

 const touchRecent=(i,p,kind)=>{const key=pathKey(p);const at=i.recent.findIndex(r=>pathKey(r.path)===key);const pinned=at>=0&&!!i.recent[at].pinned;if(at>=0)i.recent.splice(at,1);i.recent.unshift({path:path.resolve(p),kind,name:lifecycle.stemOf(p),pinned,openedAt:new Date(now()).toISOString()});
  // Pinned files never fall off; the oldest unpinned ones do.
  while(i.recent.length>RECENT_LIMIT){const last=i.recent.map(r=>r.pinned).lastIndexOf(false);if(last<0)break;i.recent.splice(last,1);}};

 // Startup: load the index; a running marker whose process is gone means the last session crashed.
 index=await readIndex();
 await fs.mkdir(runningDir,{recursive:true});
 const marker=path.join(runningDir,product+'.json');
 try{const prev=JSON.parse(await fs.readFile(marker,'utf8'));crashed=!!prev&&prev.pid!==process.pid&&!pidAlive(prev.pid);}catch{}
 await fs.writeFile(marker,JSON.stringify({pid:process.pid,started:new Date(now()).toISOString()}));

 /** The binding of `doc`: this process's live one, else the index's (another session's). */
 const binding=doc=>publicBinding(known(doc));
 /** Remove a closed document's working copy (its file has everything) and its index entry. */
 async function dropDone(doc){
  if(live.get(doc)?.open)return;
  try{const f=await store.get(doc);if(f)await store.remove(doc,f.revision);}catch{return;}
  await update(i=>{if(i.documents[doc]?.done)delete i.documents[doc];}).catch(()=>{});
 }
 // Working copies of documents closed just before the last session ended.
 for(const [doc,p] of Object.entries(index.documents))if(p?.done){const t=setTimeout(()=>{void dropDone(doc);},1500);t.unref?.();}
 async function workingCopy(doc){const f=await store.get(doc);if(!f)throw fail('not_found',`Document ${doc} was not found`,{doc});return f;}

 // A conversion written by a host (schema 1 -> 2 on opening) is not the person's change: when the
 // document had no unsaved changes before it, it has none after it (core/kernel/open-migrate.mjs isUpgrade).
 if(typeof store.afterSave==='function')store.afterSave((prev,saved)=>{
  if(!isUpgrade(prev,saved))return;const b=known(saved.id);if(!b||!b.savedHash||b.savedHash!==stateHash(prev))return;
  b.savedHash=stateHash(saved);return save(b);
 });
 const files={
  kinds,
  /** Does this process make and keep schema-2 documents of `kind` (the new shell edits them)? */
  schema2,
  get crashed(){return crashed;},
  binding,
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  /** The person chose `p` in a system dialog (main calls this with what the dialogs returned): opening it needs no approval. */
  trust(p){if(typeof p!=='string'||!p)return;trusted.add(pathKey(p));while(trusted.size>5000)trusted.delete(trusted.values().next().value);},
  /** Is `p` a file the person chose this session, one that is open, or one in the recent list? */
  isKnownPath(p){if(typeof p!=='string'||!p)return false;const key=pathKey(p);return trusted.has(key)||!!files.findOpen(p)||index.recent.some(r=>pathKey(r.path)===key);},
  /** The open document whose file is `p`, if any (this process). */
  findOpen(p){const key=pathKey(p);for(const b of live.values())if(b.open&&b.path&&pathKey(b.path)===key)return b.doc;return null;},
  /** A vault document this session opens (an old library document gets an untitled binding). */
  async adopt(doc){
   if(live.get(doc)?.open)return binding(doc);
   const file=await workingCopy(doc);assertKind(file.kind);
   const b=known(doc)??{doc,kind:file.kind,path:null,format:null,name:file.title||'Document',autosave:false,savedHash:null};
   b.open=true;b.closedAt=null;b.unsavedAt=null;delete b.done;
   return save(b);
  },
  /** File › New: an untitled working copy named Document1, Book1, Presentation1... */
  async create(kind,{title,content}={}){
   assertKind(kind);
   if(!lifecycle.canCreate(kind)&&!title)throw fail('disabled',kind==='folio'?'PDF has no blank document: create a PDF from a file instead':'Slate makes pages and sections, not files');
   const used=new Set([...live.values()].filter(b=>b.open&&!b.path).map(b=>b.name));
   let name=title;
   if(!name){do{counters[kind]=(counters[kind]??0)+1;name=lifecycle.untitledName(kind,counters[kind]);}while(used.has(name));}
   const v2=await schema2(kind);
   const made=model.createFile(kind,name,v2?{schema:2}:{});
   // A document made from content (Mailings: Finish & Merge, Envelopes, Labels): schema-2 content of this kind only.
   if(content&&v2&&kind==='quill')made.content=content;
   const saved=await store.save(made);
   await save({doc:saved.id,kind,path:null,format:null,name,autosave:false,savedHere:false,savedHash:stateHash(saved),open:true,closedAt:null,unsavedAt:null});
   return {doc:saved.id,kind,name,file:saved};
  },
  /** File › Open: read the file through the format worker into a working copy bound to it. */
  async open(p,{kind}={}){
   if(typeof p!=='string'||!path.isAbsolute(p))throw fail('invalid_params','path must be an absolute file path',{path:'/path'});assertLocalFilePath(p);
   const full=path.resolve(p);
   const already=files.findOpen(full);
   if(already){const b=live.get(already);return {doc:already,kind:b.kind,name:b.name,path:b.path,alreadyOpen:true};}
   let stat;try{stat=await fs.stat(full);}catch{throw fail('not_found',`Sorry, we couldn't find ${full}. Is it possible it was moved, renamed or deleted?`,{path:full});}
   if(!stat.isFile())throw fail('invalid_params',`${full} is not a file`,{path:'/path'});
   if(stat.size>30_000_000)throw fail('too_large','Files over 30 MB cannot be opened yet',{path:full});
   const format=lifecycle.extensionOf(full);
   const target=kind??(product==='studio'?null:product);
   if(target&&!lifecycle.openExtensions(target).includes(format))throw fail('invalid_params',`${lifecycle.FILE_TYPES[target]?.product??'This app'} cannot open .${format||'extensionless'} files`,{path:full});
   if(typeof worker!=='function')throw fail('unavailable','Opening files is not available here');
   // The worker reads schema 2 for apps the new shell edits (newHost, or a ready manifest).
   let imported;try{imported=await worker({operation:'import',path:full,format,title:lifecycle.stemOf(full),kind:target??null,newHost:typeof newHost==='function'?!!newHost(target):newHost===true});}
   catch(e){throw fail('failed',`We're sorry. We can't open ${path.basename(full)} because we found a problem with its contents: ${e.message}`,{path:full});}
   let prepared;try{prepared=policy.prepareImport(imported,target??'studio',format);}catch(e){throw fail('invalid_params',e.message,{path:full});}
   assertKind(prepared.kind);
   if(beforeSave)await beforeSave(prepared);
   const saved=await store.save({...prepared,title:lifecycle.stemOf(full)});
   const writes=!!lifecycle.saveType(saved.kind,format);
   await save({doc:saved.id,kind:saved.kind,path:full,format:writes?lifecycle.formatForPath(saved.kind,full):format,name:lifecycle.stemOf(full),autosave:!!index.autosave[pathKey(full)],savedHere:false,savedHash:stateHash(saved),open:true,closedAt:null,unsavedAt:null});
   await update(i=>touchRecent(i,full,saved.kind));
   return {doc:saved.id,kind:saved.kind,name:lifecycle.stemOf(full),path:full,alreadyOpen:false,file:saved};
  },
  /** Write `file` (the live document) to `p` in `format` (worker: temp file + rename); with `bind` the document is that file now. */
  async write(doc,file,{path:p,format,bind=false}={}){
   if(typeof p!=='string'||!path.isAbsolute(p))throw fail('invalid_params','path must be an absolute file path',{path:'/path'});assertLocalFilePath(p);
   if(!file||typeof file!=='object'||file.id!==doc)throw fail('invalid_params','file must be the document being saved',{path:'/file'});
   try{model.validateFile(file);}catch(e){throw fail('invalid_params',e.message);}
   assertKind(file.kind);
   const type=lifecycle.saveType(file.kind,format);
   if(!type)throw fail('invalid_params',`${lifecycle.FILE_TYPES[file.kind]?.product??'This app'} can't save a ${String(format).toUpperCase()} file`,{path:'/format'});
   const full=path.resolve(p);
   if(typeof worker!=='function')throw fail('unavailable','Saving to a file is not available here');
   let dir;try{dir=await fs.stat(path.dirname(full));}catch{throw fail('not_found',`The folder ${path.dirname(full)} does not exist`,{path:full});}
   if(!dir.isDirectory())throw fail('invalid_params',`${path.dirname(full)} is not a folder`,{path:full});
   if(beforeSave)await beforeSave(file);
   const links=typeof resolveLinks==='function'?await resolveLinks(file).catch(()=>[]):[];
   try{await worker({operation:'export',file:{...file,resolvedLinks:links},format:type.format,path:full});}
   catch(e){throw fail('failed',`${path.basename(full)} couldn't be saved: ${e.message}`,{path:full});}
   let b=known(doc)??{doc,kind:file.kind,path:null,format:null,name:file.title,autosave:false,open:true};
   if(bind){
    b={...b,doc,kind:file.kind,path:full,format:type.format,name:lifecycle.stemOf(full),savedHere:true,savedHash:stateHash(file),open:true,unsavedAt:null};
    if(index.autosave[pathKey(full)])b.autosave=true;
    await save(b);
    await update(i=>touchRecent(i,full,file.kind));
   }
   return {path:full,format:type.format,revision:file.revision,binding:binding(doc)};
  },
  async setAutosave(doc,on){
   const b=known(doc);if(!b)throw fail('not_found',`Document ${doc} has no file information`,{doc});
   b.autosave=!!on;
   if(b.path)await update(i=>{if(on)i.autosave[pathKey(b.path)]=true;else delete i.autosave[pathKey(b.path)];});
   return save(b);
  },
  /** wordcraft rename(): rename the file in its folder (keeping its extension), or name a new document. */
  async rename(doc,name){
   const b=known(doc);if(!b)throw fail('not_found',`Document ${doc} has no file information`,{doc});
   if(typeof name!=='string'||name.length>200)throw fail('invalid_params','The name must be text of at most 200 characters',{path:'/name'});
   if(b.path&&!plainFileName(name))throw fail('invalid_params','The name must be a plain file name: no folders, no "..", no reserved characters',{path:'/name'});
   if(!b.path){b.name=name;return save(b);}
   const ext=path.extname(b.path);
   const given=!!ext&&name.toLowerCase().endsWith(ext.toLowerCase())&&name.length>ext.length;
   const target=path.join(path.dirname(b.path),given?name:name+ext);
   if(pathKey(target)!==pathKey(b.path)){
    let exists=true;try{await fs.access(target);}catch{exists=false;}
    if(exists)throw fail('conflict',`A file named ${path.basename(target)} already exists in that folder`,{path:target});
    await fs.rename(b.path,target);
    const old=b.path;
    await update(i=>{for(const r of i.recent)if(pathKey(r.path)===pathKey(old)){r.path=target;r.name=lifecycle.stemOf(target);}});
   }
   b.path=target;b.name=lifecycle.stemOf(target);
   return save(b);
  },
  /** The document closed. A clean or saved one leaves the vault; unsaved work of a new document stays recoverable (Word keeps it). */
  async closed(doc,{discard=false,keepModified=false}={}){
   const b=known(doc);if(!b)return;
   b.open=false;b.closedAt=new Date(now()).toISOString();
   if(discard&&!b.path){b.unsavedAt=b.closedAt;await save(b);return;}
   // A window that went away without asking (a crashed renderer): its unsaved work stays recoverable.
   if(keepModified&&!discard){const f=await store.get(doc).catch(()=>null);if(f&&b.savedHash!==stateHash(f)){b.unsavedAt=b.closedAt;await save(b);return;}}
   // Its file has everything: the working copy is done (never a recovery candidate) and goes away
   // once the window's last snapshot is written; a crash before that is cleaned up at the next start.
   live.delete(doc);
   await update(i=>{i.documents[doc]={...persisted(b),done:true};});
   const timer=setTimeout(()=>{void dropDone(doc);},3000);timer.unref?.();
  },
  async recent(kind){
   const list=index.recent.filter(r=>!kind||r.kind===kind);
   const out=[];for(const r of list){let missing=false;try{await fs.access(r.path);}catch{missing=true;}out.push({path:r.path,name:r.name??lifecycle.stemOf(r.path),folder:path.dirname(r.path),kind:r.kind,pinned:!!r.pinned,missing,openedAt:r.openedAt??null});}
   return out;
  },
  async pin(p,on){await update(i=>{const r=i.recent.find(x=>pathKey(x.path)===pathKey(p));if(!r)throw fail('not_found','That file is not in the recent list',{path:p});r.pinned=!!on;});return files.recent();},
  async forget(p){await update(i=>{i.recent=i.recent.filter(x=>pathKey(x.path)!==pathKey(p));});return files.recent();},
  async clearRecent(kind){await update(i=>{i.recent=i.recent.filter(x=>x.pinned||(kind&&x.kind!==kind));});return files.recent(kind);},
  /** Documents kept for recovery: new ones closed without saving, ones open when the app stopped, and the old library's. */
  async unsaved(kind){
   const out=[];const list=await store.list();
   for(const f of list){
    if((kind&&f.kind!==kind)||!kinds.includes(f.kind)||live.get(f.id)?.open)continue;
    const p=index.documents[f.id];
    let reason=null;
    if(p?.done)continue;
    if(!p)reason='library';
    else if(p.unsavedAt)reason='closed';
    else if(p.open&&!pidAlive(p.pid))reason=p.savedHash&&p.savedHash===stateHash(f)?null:'crash';
    if(!reason)continue;
    out.push({doc:f.id,kind:f.kind,name:p?.name??f.title,path:p?.path??null,updatedAt:f.updatedAt,reason});
   }
   return out.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  /** Bring a kept document back as it was left (still unsaved: `modified`). */
  async recover(doc){
   const f=await workingCopy(doc);assertKind(f.kind);
   const p=index.documents[doc];
   const b=p?{doc,...p,done:undefined,savedHere:false,open:true,closedAt:null,unsavedAt:null}:{doc,kind:f.kind,path:null,format:null,name:f.title||'Document',autosave:false,savedHere:false,savedHash:null,open:true};
   await save(b);
   return {doc,kind:f.kind,name:b.name,path:b.path??null,modified:!b.savedHash||b.savedHash!==stateHash(f)};
  },
  async discardUnsaved(doc){
   if(live.get(doc)?.open)throw fail('conflict','The document is open: close it first',{doc});
   const f=await store.get(doc);if(f)await store.remove(doc,f.revision);
   live.delete(doc);await update(i=>{delete i.documents[doc];});
   return {discarded:true,doc};
  },
  /** Content of the working copy differs from the file on disk (a new document: changed since it was made). */
  async modified(doc){const b=known(doc);if(!b)return null;const f=await store.get(doc);return !!f&&b.savedHash!==stateHash(f);},
  /** Clean quit: no crash marker; documents still open are written as closed. */
  async shutdown(){
   for(const b of live.values())b.open=false;
   await update(i=>{for(const b of live.values())if(i.documents[b.doc])i.documents[b.doc]=persisted(b);}).catch(()=>{});
   await fs.unlink(marker).catch(()=>{});
  },
 };
 return files;
}
module.exports={createStore,createFiles,hashOf,stateHash};
