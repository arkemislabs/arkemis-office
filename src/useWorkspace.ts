import {useCallback,useEffect,useRef,useState} from 'react';
import type {StudioFile} from './types';
export function useWorkspace(){
 const [files,setFiles]=useState<StudioFile[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const ref=useRef<StudioFile[]>([]),dirty=useRef(new Set<string>()),epochs=useRef(new Map<string,number>()),timers=useRef(new Map<string,ReturnType<typeof setTimeout>>()),inflight=useRef(new Map<string,Promise<void>>());
 const publish=useCallback((next:StudioFile[])=>{ref.current=next;setFiles(next);},[]);
 const persist=useCallback(async function persist(id:string):Promise<void>{
  const running=inflight.current.get(id);if(running){await running;if(dirty.current.has(id))return persist(id);return;}
  clearTimeout(timers.current.get(id));timers.current.delete(id);if(!dirty.current.has(id))return;
  const file=ref.current.find(f=>f.id===id);if(!file)return;const epoch=epochs.current.get(id);setSaving(true);
  const operation=(async()=>{try{const saved=await window.studio.save(file);const latest=ref.current.find(f=>f.id===id);const unchanged=epochs.current.get(id)===epoch;
   if(unchanged)dirty.current.delete(id);publish(ref.current.map(f=>f.id===id?(unchanged?saved:{...latest!,revision:saved.revision,updatedAt:saved.updatedAt}):f));
  }catch(e){setError(String((e as Error).message));throw e;}finally{inflight.current.delete(id);setSaving(inflight.current.size>0);}})();
  inflight.current.set(id,operation);await operation;if(dirty.current.has(id))return persist(id);
 },[publish]);
 const flush=useCallback(async()=>{for(const id of [...dirty.current])await persist(id);},[persist]);
 const update=useCallback((id:string,patch:Partial<StudioFile>)=>{const next=ref.current.map(f=>f.id===id?{...f,...patch,updatedAt:new Date().toISOString()}:f);publish(next);dirty.current.add(id);epochs.current.set(id,(epochs.current.get(id)??0)+1);clearTimeout(timers.current.get(id));timers.current.set(id,setTimeout(()=>{persist(id).catch(()=>{});},650));},[publish,persist]);
 const add=useCallback(async(file:StudioFile)=>{const saved=await window.studio.save(file);publish([saved,...ref.current]);return saved;},[publish]);
 const accept=useCallback((file:StudioFile)=>publish([file,...ref.current.filter(f=>f.id!==file.id)]),[publish]);
 const remove=useCallback(async(id:string)=>{await persist(id);const f=ref.current.find(x=>x.id===id);if(f)await window.studio.remove(id,f.revision);dirty.current.delete(id);publish(ref.current.filter(f=>f.id!==id));},[persist,publish]);
 const reload=useCallback(async(id:string)=>{clearTimeout(timers.current.get(id));await inflight.current.get(id)?.catch(()=>{});const f=(await window.studio.list()).find(x=>x.id===id);dirty.current.delete(id);publish(f?ref.current.map(x=>x.id===id?f:x):ref.current.filter(x=>x.id!==id));setError('');},[publish]);
 useEffect(()=>window.studio.onRemoved(id=>{if(dirty.current.has(id)){setError('This file was deleted in another app. Save a copy to keep your local edits.');return;}publish(ref.current.filter(f=>f.id!==id));}),[publish]);
 const recoverCopy=useCallback(async(id:string)=>{
  clearTimeout(timers.current.get(id));timers.current.delete(id);
  await inflight.current.get(id)?.catch(()=>{});
  const current=ref.current.find(f=>f.id===id);if(!current)throw new Error('The document is no longer open.');
  const copy={...structuredClone(current),id:crypto.randomUUID(),revision:0,title:(current.title+' — copy').slice(0,240),createdAt:new Date().toISOString()};
  // Persist the local content under a fresh identity before discarding any dirty state.
  const saved=await add(copy);await reload(id);return saved;
 },[add,reload]);
 useEffect(()=>{window.studio.list().then(publish).catch(e=>setError(e.message)).finally(()=>setLoading(false));const off=window.studio.onChanged(file=>{if(dirty.current.has(file.id)){setError('Arkemis changed a document with unsaved local edits. Save a copy or reload the saved version.');return;}publish(ref.current.some(f=>f.id===file.id)?ref.current.map(f=>f.id===file.id?file:f):[file,...ref.current]);});const flushOff=window.studio.onFlush(flush);return()=>{off();flushOff();for(const timer of timers.current.values())clearTimeout(timer);};},[publish,flush]);
 return {files,loading,error,setError,saving,update,add,accept,remove,flush,reload,recoverCopy,latest:()=>ref.current};
}
