import {_electron as electron,expect} from '@playwright/test';
import {PDFDocument,PDFName,PDFHexString} from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'artifacts/pdf-layout-ui');
await fs.mkdir(out,{recursive:true});
const pdf=await PDFDocument.create(),sheet=pdf.addPage([400,500]);
const field=pdf.getForm().createTextField('A long customer field name that must wrap inside the properties dock');field.addToPage(sheet,{x:30,y:250,width:250,height:30});
const ctx=pdf.context,N=PDFName.of,outline=ctx.register(ctx.obj({Type:'Outlines'})),item=ctx.register(ctx.obj({Title:PDFHexString.fromText('A long bookmark title that must remain inside its dock without horizontal scrolling'),Dest:[sheet.ref,N('Fit')],Parent:outline}));ctx.lookup(outline).set(N('First'),item);ctx.lookup(outline).set(N('Last'),item);pdf.catalog.set(N('Outlines'),outline);
const input=path.join(out,'layout-fixture.pdf');await fs.writeFile(input,await pdf.save());
const env={...process.env,ARKEMIS_STUDIO_DATA:await fs.mkdtemp(path.join(out,'profile-'))};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
 app=await electron.launch({executablePath:path.resolve(root,'../node_modules/electron/dist/electron.exe'),args:[root,'--product=folio'],env});const page=await app.firstWindow();
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},input);await page.getByRole('button',{name:'Open file',exact:true}).click();
 await expect(page.locator('.pdf-app-bar')).toBeVisible();
 for(const [width,height] of [[980,680],[1400,940]]){
  await app.evaluate(({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows().find(w=>w.isVisible());w.unmaximize();w.setSize(...size);},[width,height]);
  const bannerGeometry=await page.evaluate(()=>{
   const bar=document.querySelector('.pdf-app-bar'),controls=bar.querySelector('.app-window-controls'),slot=document.querySelector('.shell-error-slot');
   const before={barY:bar.getBoundingClientRect().y,controlY:controls.getBoundingClientRect().y};
   const fixture=document.createElement('div');fixture.className='error-banner';fixture.dataset.layoutFixture='error';fixture.setAttribute('role','alert');const text=document.createElement('span');text.textContent='Layout test: this file could not be saved. Your local changes remain available. Please choose another destination.';fixture.append(text);slot.append(fixture);
   return {before,after:{barY:bar.getBoundingClientRect().y,controlY:controls.getBoundingClientRect().y},bannerTop:fixture.getBoundingClientRect().top,barBottom:bar.getBoundingClientRect().bottom};
  });
  assert.deepEqual(bannerGeometry.after,bannerGeometry.before);assert.ok(bannerGeometry.bannerTop>=bannerGeometry.barBottom,JSON.stringify(bannerGeometry));
  await page.screenshot({path:path.join(out,`${width}-error-banner.png`)});
  await page.locator('[data-layout-fixture="error"]').evaluate(e=>e.remove());
  await page.getByRole('button',{name:'All tools',exact:true}).click();await page.getByRole('button',{name:'Organize Pages',exact:true}).click();
  for(const [button,title] of [['Bookmarks','Bookmarks'],['Form fields','Form fields'],['Check signatures','Digital signatures'],['Comments','Properties & comments'],['Page thumbnails','Page thumbnails']]){
   await page.getByRole('button',{name:button,exact:true}).click();const dock=page.locator('.folio-side-dock');await expect(dock).toBeVisible();if(button==='Form fields')await expect(dock.locator('.folio-form-fields input')).toHaveCount(1);if(button==='Check signatures')await expect(dock).toContainText('No digital signatures found.');
   await expect(dock.locator('h2,h3,strong').filter({hasText:new RegExp('^'+title+'$')})).toHaveCount(1);await expect(dock.locator('.folio-dock-heading')).toHaveCount(1);await expect(dock.getByRole('heading',{name:title,exact:true})).toHaveCount(1);
   const geometry=await page.evaluate(()=>{const dock=document.querySelector('.folio-side-dock'),tools=document.querySelector('.folio-tools-pane'),center=document.querySelector('.folio-center'),rail=document.querySelector('.folio-right-rail');const r=e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,top:b.top,bottom:b.bottom}};return {width:innerWidth,body:document.body.scrollWidth,dock:r(dock),tools:r(tools),center:r(center),rail:r(rail),railOverflow:rail.scrollWidth-rail.clientWidth,railControls:Array.from(rail.querySelectorAll('button')).map(r),dockOverflow:dock.scrollWidth-dock.clientWidth,toolsOverflow:tools.scrollWidth-tools.clientWidth};});
   assert.ok(geometry.body<=geometry.width+1,JSON.stringify(geometry));assert.ok(geometry.railOverflow<=1,JSON.stringify(geometry));assert.ok(geometry.railControls.every(r=>r.left>=geometry.rail.left&&r.right<=geometry.rail.right),JSON.stringify(geometry));assert.ok(geometry.dockOverflow<=1&&geometry.toolsOverflow<=1,JSON.stringify(geometry));assert.ok(geometry.center.width>=300,JSON.stringify(geometry));assert.ok(geometry.tools.right<=geometry.center.left+1&&geometry.center.right<=geometry.dock.left+1&&geometry.dock.right<=geometry.rail.left+1,JSON.stringify(geometry));
   await dock.locator('button').last().scrollIntoViewIfNeeded();await expect(dock.locator('button').last()).toBeInViewport();await page.screenshot({path:path.join(out,`${width}-${button.replaceAll(' ','-')}.png`)});
  }
  const apply=page.getByRole('button',{name:'Apply page labels',exact:true});await apply.scrollIntoViewIfNeeded();await expect(apply).toBeInViewport();
  for(const name of ['Create PDF','Edit text','Text & markup','Export PDF','Comment','Draw signature','Scan & OCR','Find & extract text','View options']){
   await page.getByRole('button',{name:'All tools',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();
   const pane=page.locator('.folio-tools-pane'),options=pane.getByRole('region',{name:'PDF tool options'});await expect(options).toBeVisible();
   await expect(pane.locator('.folio-tools-list')).toHaveCount(0);
   assert.ok(await pane.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${name} must not overflow horizontally at ${width}`);
   const last=options.locator('button,input,select,textarea').last();if(await last.count()){await last.scrollIntoViewIfNeeded();await expect(last).toBeInViewport();}
   await page.screenshot({path:path.join(out,`${width}-tool-${name.replaceAll(/[^a-zA-Z]+/g,'-')}.png`)});
  }
 }
 console.log('PDF layout passed: five docks, single headings, bounded widths, reachable actions at 980×680 and 1400×940.');
}finally{if(app){const child=app.process();await Promise.race([app.evaluate(({app})=>app.exit(0)).catch(()=>{}),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill();await Promise.race([app.close().catch(()=>{}),new Promise(r=>setTimeout(r,2000))]);}}
