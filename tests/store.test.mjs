import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createFile} from '../core/model.mjs';
test('crashed write and reclaim owners do not permanently block the shared vault',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arkemis-lock-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {spawnSync}=await import('node:child_process');const child=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'});assert.equal(child.status,0);const pid=Number(child.stdout.trim());assert.ok(pid>0);
 for(const name of ['.write-lock','.write-lock.reclaim'])await fs.writeFile(path.join(dir,name),JSON.stringify({pid}));
 const {createStore}=await import('../electron/store.cjs');const store=await createStore(dir);assert.equal((await store.save(createFile('quill','Recovered lock'))).revision,1);
});
test('separate app stores sharing one vault cannot overwrite the same revision',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arkemis-multi-app-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {createStore}=await import('../electron/store.cjs');const a=await createStore(dir),b=await createStore(dir);
 const original=await a.save(createFile('quill','Shared'));
 const results=await Promise.allSettled([a.save({...original,title:'Quill'}),b.save({...original,title:'Bridge'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/conflict/i);
 assert.equal((await b.get(original.id)).revision,2);
});
test('atomic store prevents lost updates, rejects traversal and recovers a damaged document',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arkemis-studio-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const m=await import('../electron/store.cjs').catch(()=>({}));assert.equal(typeof m.createStore,'function');
 const store=await m.createStore(dir);let f=await store.save(createFile('quill','Original'));assert.equal(f.revision,1);
 const results=await Promise.allSettled([store.save({...f,title:'First'}),store.save({...f,title:'Second'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/conflict/i);
 await assert.rejects(()=>store.get('../../outside'),/id/i);
 await fs.writeFile(path.join(dir,f.id+'.json'),'broken');
 const recovered=await store.get(f.id);assert.equal(recovered.title,'Original');assert.ok(store.warnings.length);
 await store.remove(f.id,recovered.revision);assert.equal((await store.list()).length,0);
});
test('internal JSON storage migrates legacy documents without changing their identity or revision',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'suite-json-migration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=createFile('quill','Existing work');file.revision=5;
 await fs.writeFile(path.join(dir,file.id+'.ark'),JSON.stringify(file));await fs.writeFile(path.join(dir,file.id+'.ark.bak'),JSON.stringify({...file,revision:4}));
 const {createStore}=await import('../electron/store.cjs');const store=await createStore(dir);const [loaded]=await store.list();assert.equal(loaded.id,file.id);assert.equal(loaded.revision,5);
 assert.ok((await fs.readdir(dir)).includes(file.id+'.json'));assert.ok(!(await fs.readdir(dir)).includes(file.id+'.ark'));
 const saved=await store.save({...loaded,title:'Updated'});assert.equal(saved.revision,6);assert.deepEqual((await store.list()).map(f=>f.id),[file.id]);
});
