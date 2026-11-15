import {_electron,expect} from '@playwright/test';import fs from 'node:fs/promises';import path from 'node:path';
const root=process.cwd(),prior=JSON.parse(await fs.readFile(path.join(root,'artifacts/packages-slate-report.json'),'utf8')),env={...process.env,ARKEMIS_STUDIO_DATA:prior.data};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:path.join(root,'release/slate/win-unpacked/Arkemis Slate.exe'),env,args:[],timeout:60000});const page=await app.firstWindow();
app.process().stdout?.on('data',d=>process.stdout.write(d));
await page.getByRole('button',{name:'Open Packaged slate',exact:true}).click();await expect(page.getByLabel('Note content',{exact:true})).toContainText('Packaged slate worker');console.log('Saved Slate note reopened successfully');
await app.evaluate(({BrowserWindow,ipcMain,app})=>{ipcMain.on('studio:flushed',(_,result)=>console.log('CLOSE_DIAGNOSTIC flushed',result));BrowserWindow.getAllWindows()[0].on('closed',()=>console.log('CLOSE_DIAGNOSTIC window closed'));app.on('will-quit',()=>console.log('CLOSE_DIAGNOSTIC will quit'));});
const closed=app.waitForEvent('close',{timeout:60000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
try{await closed;console.log('Native window close passed');await fs.writeFile(path.join(root,'artifacts/slate-close-report.json'),JSON.stringify({passed:true,reopened:true,method:'BrowserWindow.close',data:prior.data},null,2));}catch(error){console.log(error.message);await app.evaluate(({app})=>app.exit(1)).catch(()=>{});throw error;}
