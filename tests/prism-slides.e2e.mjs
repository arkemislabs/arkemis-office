import {_electron,expect as baseExpect} from '@playwright/test';import fs from 'node:fs/promises';import path from 'node:path';
const expect=baseExpect.configure({timeout:20000}),root=path.resolve(import.meta.dirname,'..');
const vault=await fs.mkdtemp(path.join(root,'artifacts','slide-workflow-')),env={...process.env,ARKEMIS_STUDIO_DATA:vault};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
 app=await _electron.launch({executablePath:path.resolve(root,'../node_modules/electron/dist/electron.exe'),args:[root,'--product=prism'],env,timeout:60000});const page=await app.firstWindow();
 await page.locator('.tool-launcher.prism').click();await page.getByRole('button',{name:'New slide',exact:true}).click();await page.getByRole('button',{name:'New slide',exact:true}).click();
 await page.getByRole('button',{name:'Slide 2',exact:true}).click();await page.getByRole('tab',{name:'Slide Show',exact:true}).click();await page.getByRole('button',{name:'Hide selected slides',exact:true}).click();
 await page.getByRole('tab',{name:'Slide Show',exact:true}).click();await page.getByRole('button',{name:'From beginning',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Presentation'})).toBeVisible();await page.getByRole('button',{name:'Next slide',exact:true}).click();await expect(page.locator('.ed-presentation-controls')).toContainText('3 / 3');
 await page.getByRole('button',{name:'Exit presentation',exact:true}).click();await page.getByRole('tab',{name:'Home',exact:true}).click();
 await page.getByRole('button',{name:'Slide 1',exact:true}).click();await page.getByRole('button',{name:'Slide 3',exact:true}).click({modifiers:['Control']});
 await page.locator('.ed-slide-actions').getByRole('button',{name:'Duplicate slide',exact:true}).click();await expect(page.locator('.ed-slide-thumb')).toHaveCount(5);await expect(page.locator('.ed-slide-thumb[aria-pressed="true"]')).toHaveCount(2);
 await page.locator('.ed-slide-actions').getByRole('button',{name:'Delete slide',exact:true}).click();await expect(page.locator('.ed-slide-thumb')).toHaveCount(3);
 await page.getByRole('button',{name:'Slide 1',exact:true}).click();await page.getByRole('button',{name:'Slide 3',exact:true}).click({modifiers:['Shift']});await page.locator('.ed-slide-actions').getByRole('button',{name:'Delete slide',exact:true}).click();
 await expect(page.getByRole('button',{name:'Create a slide',exact:true})).toBeVisible();await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.locator('.ed-slide-thumb')).toHaveCount(3);
 await expect.poll(()=>page.locator('.ed-stage-wrap').evaluate(el=>el.clientWidth)).toBeGreaterThan(500);await page.screenshot({path:path.join(root,'artifacts','prism-slide-workflow.png')});console.log('PASS: multi-select duplicate/delete, hidden-slide presentation, empty-deck undo');
}finally{if(app)await app.close();}
