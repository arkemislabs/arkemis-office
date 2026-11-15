import {_electron} from '@playwright/test';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createFile} from '../core/model.mjs';
const root=process.cwd(),data=await fs.mkdtemp(path.join(os.tmpdir(),'arkemis-profile-e2e-')),env={...process.env,ARKEMIS_STUDIO_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
console.log({data});
for(const product of ['grid','quill','slate','quill']){
 const app=await _electron.launch({executablePath:path.resolve(root,'../node_modules/electron/dist/electron.exe'),args:[root,'--product='+product],env,timeout:60000});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.studio);
 console.log('LAUNCH',product,await app.evaluate(({app})=>({data:process.env.ARKEMIS_STUDIO_DATA,userData:app.getPath('userData')})),await fs.readdir(path.join(data,'documents')));
 const file=createFile(product,'Persist '+product);await page.evaluate(f=>window.studio.save(f),file);
 console.log('BEFORE CLOSE',await fs.readdir(path.join(data,'documents')));await app.close();console.log('AFTER CLOSE',await fs.readdir(path.join(data,'documents')).catch(e=>e.message));
}
