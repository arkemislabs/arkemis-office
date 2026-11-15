import {openSaveAs} from './helpers/file-actions.mjs';
import {_electron,expect as baseExpect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const expect=baseExpect.configure({timeout:30000}),root=process.cwd(),artifacts=path.join(root,'artifacts');
const data=await fs.mkdtemp(path.join(artifacts,'prism-focus-vault-')),env={...process.env,ARKEMIS_STUDIO_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app;const report={data};
try{
 app=await _electron.launch({executablePath:path.resolve(root,'../node_modules/electron/dist/electron.exe'),args:[root,'--product=prism'],env,timeout:60000});const page=await app.firstWindow();
 await page.locator('.tool-launcher.prism').click();await page.getByLabel('Document title',{exact:true}).fill('Focus regression');
 const objects=page.locator('.ed-slide-stage .ed-slide-object');await expect(objects).toHaveCount(2);
 const originalOrder=await objects.allTextContents();
 await objects.first().click();await page.getByRole('tab',{name:'Shape Format',exact:true}).click();
 await page.getByRole('button',{name:'Bring forward',exact:true}).click();
 await expect(objects).toHaveText([...originalOrder].reverse());
 await page.getByRole('button',{name:'Send backward',exact:true}).click();
 await expect(objects).toHaveText(originalOrder);
 await page.getByRole('button',{name:'Rotate right',exact:true}).click();
 await expect(objects.first()).toHaveCSS('transform','matrix(0, 1, -1, 0, 0, 0)');
 await page.getByRole('button',{name:'Flip horizontal',exact:true}).click();
 await expect(objects.first()).toHaveCSS('transform','matrix(0, 1, 1, 0, 0, 0)');
 await page.getByLabel('Object rotation',{exact:true}).fill('0');
 await page.getByRole('button',{name:'Flip horizontal',exact:true}).click();
 await expect(objects.first()).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
 await page.getByLabel('Document title',{exact:true}).click();await objects.first().click();await page.keyboard.press('Control+d');await expect(objects).toHaveCount(3);
 await openSaveAs(page);await page.keyboard.press('Control+d');await expect(objects).toHaveCount(3);await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await objects.last().click();await page.keyboard.press('Control+d');await expect(objects).toHaveCount(4);
 report.passed=true;report.checks=['Object pointer selection restores keyboard shortcuts after document title focus','Export dialog suppresses duplicate shortcut','Object pointer selection restores keyboard shortcuts after modal close'];console.log(JSON.stringify(report,null,2));
}catch(error){report.passed=false;report.error=error.stack;throw error;}
finally{await fs.writeFile(path.join(artifacts,'prism-focus-report.json'),JSON.stringify(report,null,2));if(app)await app.close();}
