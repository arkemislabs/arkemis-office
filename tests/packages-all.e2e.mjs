import {saveAs} from './helpers/file-actions.mjs';
import {execFileSync} from 'node:child_process';
import {_electron,expect as baseExpect} from '@playwright/test';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import JSZip from 'jszip';
import {extractFile} from '@electron/asar';
const expect=baseExpect.configure({timeout:30000}),root=process.cwd(),artifacts=path.join(root,'artifacts'),data=await fs.mkdtemp(path.join(artifacts,'all-packages-vault-')),env={...process.env,ARKEMIS_STUDIO_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const selected=process.argv.slice(2);assert.ok(selected.every(kind=>['quill','grid','prism','slate'].includes(kind)));const kinds=selected.length?selected:['quill','grid','prism','slate'];
const report={data,products:[],shutdownErrors:[]};let app,page;
async function close(){
 const started=performance.now(),child=app.process();let timer,onExit;
 // Observe the actual OS process, not just inspector/CDP disconnection.
 const exit=new Promise(resolve=>{onExit=(code,signal)=>resolve({code,signal});child.once('exit',onExit);timer=setTimeout(()=>resolve({timedOut:true}),15000);if(child.exitCode!==null||child.signalCode!==null)resolve({code:child.exitCode,signal:child.signalCode});});
 try{
  const clickError=await page.getByRole('button',{name:'Close window',exact:true}).click().then(()=>null,error=>error);
  const result=await exit;
  assert.equal(result.timedOut,undefined,'Application process did not exit within 15 seconds');
  assert.equal(result.signal,null,'Application was terminated by a signal');
  assert.equal(result.code,0,'Application exited with a nonzero code');
  if(clickError&&!page.isClosed())throw clickError;
 }catch(error){
  let state;try{state=await Promise.race([app.evaluate(({BrowserWindow})=>({windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible()})),handles:process._getActiveHandles().map(h=>({type:h.constructor.name,address:typeof h.address==='function'?h.address():null,listening:h.listening})),exitCode:process.exitCode})),new Promise(resolve=>setTimeout(()=>resolve({diagnosticTimeout:true}),2000))]);}catch(e){state={error:e.message};}
  report.shutdownErrors.push({message:error.message,pid:child.pid,windowClosed:page.isClosed(),exitCode:child.exitCode,connections:await fs.readdir(path.join(data,'connections')).catch(()=>[]),state});
  try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else child.kill();}catch{}
 }finally{clearTimeout(timer);child.removeListener('exit',onExit);}
 app=null;return Math.round(performance.now()-started);
}
async function launch(kind){const name=kind[0].toUpperCase()+kind.slice(1);app=await _electron.launch({executablePath:path.join(root,'release/office/win-unpacked/Arkemis Office.exe'),args:['--product='+kind],env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(30000);await app.evaluate(async({app,BrowserWindow},trace)=>{const fs=process.getBuiltinModule('fs');const log=(event,extra={})=>fs.appendFileSync(trace,JSON.stringify({time:Date.now(),event,...extra})+'\n');for(const event of ['window-all-closed','before-quit','will-quit','quit'])app.on(event,()=>log(event));app.once('before-quit',()=>{log('test-inspector-disconnect');process.getBuiltinModule('inspector').close();});for(const win of BrowserWindow.getAllWindows())for(const event of ['close','closed'])win.on(event,()=>log('window-'+event,{id:win.id}));log('instrumented',{windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible()}))});},path.join(data,kind+'-close-trace.jsonl'));await expect(page.locator('.tool-launcher.'+kind)).toBeVisible();assert.equal(await page.evaluate(()=>window.studio.product),kind);}
try{for(const kind of kinds){
 console.log('Testing package',kind);await launch(kind);await page.locator('.tool-launcher.'+kind).click();const title='Packaged '+kind;await page.getByLabel('Document title',{exact:true}).fill(title);
 const clip=await page.evaluate(async()=>{await window.studio.clipboardWrite({text:'Packaged clipboard transport',html:'<p><strong>Packaged clipboard transport</strong></p>'});return window.studio.clipboardRead();});assert.equal(clip.text,'Packaged clipboard transport');assert.ok(clip.html.includes('<strong>Packaged clipboard transport</strong>'));
 if(kind==='quill'||kind==='slate'){const editor=page.getByLabel(kind==='quill'?'Document content':'Note content',{exact:true});await editor.click();await page.getByRole('button',{name:'Paste text',exact:true}).click();await expect(editor).toContainText('Packaged clipboard transport');}

 if(kind==='grid'){await page.getByRole('gridcell',{name:'A1',exact:true}).dblclick();await page.getByLabel('Edit A1',{exact:true}).fill('41');await page.getByLabel('Edit A1',{exact:true}).press('Enter');await page.getByRole('gridcell',{name:'B1',exact:true}).dblclick();await page.getByLabel('Edit B1',{exact:true}).fill('=A1+1');await page.getByLabel('Edit B1',{exact:true}).press('Enter');await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('42');}
 else if(kind==='prism'){await page.getByRole('group',{name:'Text: A new perspective',exact:true}).dblclick();await page.getByLabel('Slide text',{exact:true}).fill('Packaged Prism worker');}
 else await page.getByLabel(kind==='quill'?'Document content':'Note content',{exact:true}).fill('Packaged '+kind+' worker');
 await page.getByLabel('Document title',{exact:true}).click();await page.keyboard.press('Control+s');await page.evaluate(()=>window.studio.list());await expect(page.getByRole('alert')).toHaveCount(0);
 const visual=await page.evaluate(async kind=>{await document.fonts.ready;const image=document.querySelector('.document-header .product-glyph img');return {kind,logo:image?.getAttribute('src'),logoLoaded:!!image?.naturalWidth,fontLoaded:true,chrome:getComputedStyle(document.querySelector('.document-header')).backgroundColor};},kind);assert.equal(visual.logo,`./brand/products/${kind}.svg`);assert.equal(visual.logoLoaded,true);assert.equal(visual.fontLoaded,true);assert.equal(visual.chrome,'rgb(24, 24, 24)');
 const appPath=await app.evaluate(({app})=>app.getAppPath()),iconEntry=`assets/brand/products/${kind}.ico`,iconBytes=extractFile(appPath,path.join('assets','brand','products',kind+'.ico'));const bundled={iconPath:path.join(appPath,iconEntry),iconBytes:iconBytes.length,icoHeader:[...iconBytes.subarray(0,4)],icoEntries:iconBytes.readUInt16LE(4)};assert.deepEqual(bundled.icoHeader,[0,0,1,0]);assert.ok(bundled.iconBytes>100);assert.equal(bundled.icoEntries,7);
 const format=kind==='grid'?'xlsx':kind==='prism'?'pptx':'docx',filePath=path.join(artifacts,`packaged-${kind}.${format}`);await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},filePath);await saveAs(page,'.'+format);await expect(page.getByRole('dialog',{name:'Save As',exact:true})).toHaveCount(0);
 const zip=await JSZip.loadAsync(await fs.readFile(filePath)),entry=kind==='grid'?'xl/worksheets/sheet1.xml':kind==='prism'?'ppt/slides/slide1.xml':'word/document.xml';assert.ok((await zip.file(entry).async('string')).includes(kind==='grid'?'A1+1':kind==='prism'?'Packaged Prism worker':'Packaged '+kind+' worker'));
 const persisted=(await page.evaluate(()=>window.studio.list())).find(f=>f.title===title);assert.equal(persisted.kind,kind);assert.ok(persisted.revision>=2);await page.screenshot({path:path.join(artifacts,`${kind}-final-packaged.png`)});const closeMs=await close();assert.equal(JSON.parse(await fs.readFile(path.join(data,'documents',persisted.id+'.json'),'utf8')).title,title);
 if(kind!=='quill'){await launch(kind);await page.getByRole('button',{name:'Open '+title,exact:true}).click();await expect(page.getByLabel('Document title',{exact:true})).toHaveValue(title);await close();}
 report.products.push({...visual,...bundled,export:format,savedRevision:persisted.revision,closeMs,reopened:kind!=='quill'});console.log('Verified package',kind);
 }report.passed=report.shutdownErrors.length===0;if(!report.passed)process.exitCode=1;console.log(JSON.stringify(report,null,2));}
catch(error){report.passed=false;report.error=error.stack;if(page)await page.screenshot({path:path.join(artifacts,'all-packages-failure.png')}).catch(()=>{});throw error;}
finally{await fs.writeFile(path.join(artifacts,selected.length?'packages-'+selected.join('-')+'-report.json':'all-packages-report.json'),JSON.stringify(report,null,2));if(app){try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(app.process().pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else app.process().kill();}catch{}}}




