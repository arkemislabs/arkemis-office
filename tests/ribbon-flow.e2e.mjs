import {previewRibbonIcons} from '../scripts/ribbon-icon-preview.mjs';
import {_electron,expect as baseExpect} from '@playwright/test';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const expect=baseExpect.configure({timeout:30000}),root=process.cwd(),artifacts=path.join(root,'artifacts');await fs.mkdir(artifacts,{recursive:true});
const data=await fs.mkdtemp(path.join(artifacts,'ribbon-flow-')),env={...process.env,ARKEMIS_STUDIO_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const errors=[],checks=[];
const tab=async name=>page.getByRole('tab',{name,exact:true}).click();
const command=name=>page.getByRole('tabpanel').getByRole('button',{name,exact:true});
try{
for(const kind of ['quill','grid','prism']){
 app=await _electron.launch({executablePath:path.resolve(root,'../node_modules/electron/dist/electron.exe'),args:[root,'--product='+kind],env,timeout:60000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.tool-launcher.'+kind).click();await expect(page.getByRole('tab',{name:'Home',exact:true})).toBeVisible();
 assert.deepEqual((await page.getByRole('tab').allTextContents()).slice(0,3),['File','Edit','Home']);
 if(kind==='quill'){
  const editor=page.locator('.tiptap');await editor.fill('Ribbon find replacement');await tab('Edit');await command('Select All').click();await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('Ribbon find replacement');
  await command('Find').click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await tab('View');await page.getByLabel('Document zoom').selectOption('125');await expect(page.locator('.ed-paper')).toHaveCSS('zoom','1.25');checks.push('Quill Edit selects actual text, Find opens its working dialog, View changes zoom');
 }else if(kind==='grid'){
  await page.getByRole('gridcell',{name:'A1',exact:true}).dblclick();await page.getByLabel('Edit A1',{exact:true}).fill('17');await page.getByLabel('Edit A1',{exact:true}).press('Enter');
  await page.getByLabel('Go to cell',{exact:true}).fill('A1');await page.getByLabel('Go to cell',{exact:true}).press('Enter');await tab('Home');await command('Insert row above').click();await expect(page.getByRole('gridcell',{name:'A2',exact:true})).toHaveText('17');
  await tab('Edit');await command('Undo').click();await expect(page.getByRole('gridcell',{name:'A1',exact:true})).toHaveText('17');await command('Redo').click();await expect(page.getByRole('gridcell',{name:'A2',exact:true})).toHaveText('17');
  await command('Find').click();await expect(page.getByLabel('Find cell values or formulas')).toBeFocused();await expect(page.getByRole('tab',{name:'Page Layout',exact:true})).toHaveCount(0);checks.push('Grid Home structural insert uses real history through Edit; Find focuses; unsupported Page Layout absent');
 }else{
  const objects=page.locator('.ed-slide-stage .ed-slide-object');const initial=await objects.count();await tab('Edit');await command('Select All objects').click();await expect(page.locator('.ed-slide-stage .is-selected')).toHaveCount(initial);await command('Duplicate objects').click();await expect(objects).toHaveCount(initial*2);await command('Undo').click();await expect(objects).toHaveCount(initial);
  await tab('Insert');assert.deepEqual(await page.getByRole('tabpanel').locator('.ribbon-group-label').allTextContents(),['Images','Illustrations','Links','Text']);await command('Shape').click();await expect(objects).toHaveCount(initial+1);checks.push('Prism Edit selection and duplication undo; Insert follows source order and creates a shape');
 }
 const icons=await previewRibbonIcons(page,{directory:path.join(artifacts,'ribbon-icons'),product:kind});const missingIcons=icons.flatMap(tab=>tab.missing.map(item=>({tab:tab.tab,...item})));console.log(JSON.stringify({kind,missingIcons}));assert.deepEqual(missingIcons,[],kind+' has ribbon commands without SVG icons');await page.screenshot({path:path.join(artifacts,'ribbon-flow-'+kind+'.png')});await app.close();app=null;
}
assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'ribbon-flow-report.json'),JSON.stringify({passed:true,data,checks},null,2));console.log(JSON.stringify({passed:true,checks}));
}finally{if(app)await app.close().catch(()=>{});}
