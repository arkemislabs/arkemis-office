import {saveAs} from './helpers/file-actions.mjs';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const expect=baseExpect.configure({timeout:30000});

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=path.join(root,'artifacts');await fs.mkdir(artifacts,{recursive:true});
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arkemis-studio-e2e-'));
const env={...process.env,ARKEMIS_STUDIO_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.ARKEMIS_ELECTRON_PATH||path.resolve(root,'../node_modules/electron/dist/electron.exe');
let app,page;const errors=[];const report={data,checks:[],measurements:[]};
async function launch(){
 const started=performance.now();app=await electron.launch({executablePath,args:[root],env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(20000);
 page.on('pageerror',e=>errors.push(e.message));await expect(page.getByRole('heading',{name:'Your files',exact:true,level:1})).toBeVisible();
 report.measurements.push({launchToWorkspaceMs:Math.round(performance.now()-started),...await page.evaluate(()=>window.studio.metrics())});
}
async function home(){const back=page.getByRole('button',{name:'Back to workspace',exact:true});if(await back.isVisible())await back.click();else await page.getByRole('button',{name:'Arkemis Studio home'}).click();}
async function create(kind,title){await home();await page.locator('.tool-launcher.'+kind).click();await page.getByLabel('Document title',{exact:true}).fill(title);}
async function save(){await page.getByLabel('Document title',{exact:true}).click();await page.keyboard.press('Control+s');await expect(page.getByRole('status')).toContainText('All changes saved');}
async function open(title){await home();await page.getByRole('button',{name:'Open '+title,exact:true}).click();}
async function cell(address,value){await page.getByRole('gridcell',{name:address,exact:true}).dblclick();await page.getByLabel('Edit '+address,{exact:true}).fill(value);await page.getByLabel('Edit '+address,{exact:true}).press('Enter');}
async function exportAs(format,label){
 const filename=path.join(artifacts,'e2e.'+format);
 await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},filename);
 await saveAs(page,label);
 await expect(page.getByRole('status')).toContainText('Saved a copy successfully');return fs.readFile(filename);
}
try{
 await launch();await page.screenshot({path:path.join(artifacts,'workspace.png')});
 await create('quill','E2E Document');await page.getByLabel('Document content',{exact:true}).fill('A persistent document with meaningful words.');await save();
 const docx=await JSZip.loadAsync(await exportAs('docx','Word document'));assert.match(await docx.file('word/document.xml').async('string'),/persistent document/);
 await page.screenshot({path:path.join(artifacts,'quill.png')});report.checks.push('Quill edit, save and DOCX package content');
 await create('grid','E2E Workbook');await cell('A1','20');await cell('A2','22');await cell('B1','=SUM(A1:A2)');await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('42');
 await page.getByRole('button',{name:'Add sheet',exact:true}).click();await cell('A1','Second sheet');await page.getByRole('button',{name:'Sheet 1',exact:true}).click();await save();
 const xlsx=await JSZip.loadAsync(await exportAs('xlsx','Excel workbook'));assert.match(await xlsx.file('xl/worksheets/sheet1.xml').async('string'),/SUM\(A1:A2\)/);assert.ok(xlsx.file('xl/worksheets/sheet2.xml'));
 await page.screenshot({path:path.join(artifacts,'grid.png')});report.checks.push('Grid formula 42, second sheet, XLSX formulas and sheets');
 await open('E2E Document');await page.getByRole('tab',{name:'Insert',exact:true}).click();await page.getByRole('button',{name:'Link value',exact:true}).click();await page.getByLabel('Workbook',{exact:true}).selectOption({label:'E2E Workbook'});await page.getByLabel('Cell',{exact:true}).fill('B1');await page.getByLabel('Label',{exact:true}).fill('Project total');await page.getByRole('button',{name:'Connect live value'}).click();await expect(page.locator('.linked-value strong')).toHaveText('42');await save();
 await open('E2E Workbook');await cell('A2','30');await save();await open('E2E Document');await expect(page.locator('.linked-value strong')).toHaveText('50');report.checks.push('Linked value changes 42 to 50 after source edit');
 await create('prism','E2E Presentation');await page.getByRole('group',{name:'Text: A new perspective',exact:true}).dblclick();await page.getByLabel('Slide text',{exact:true}).fill('A tested presentation');await page.getByLabel('Speaker notes',{exact:true}).fill('Remember the audience.');await page.getByRole('button',{name:'Add slide',exact:true}).click();await page.getByRole('button',{name:'Slide 1',exact:true}).click();await save();
 await page.getByRole('button',{name:'Present',exact:true}).click();await expect(page.getByRole('dialog',{name:'Presentation',exact:true})).toContainText('A tested presentation');await page.getByRole('button',{name:'Next slide',exact:true}).click();await expect(page.locator('.ed-presentation-controls')).toContainText('2 / 2');await page.getByRole('button',{name:'Exit presentation'}).click();
 const pptx=await JSZip.loadAsync(await exportAs('pptx','PowerPoint presentation'));assert.match(await pptx.file('ppt/slides/slide1.xml').async('string'),/A tested presentation/);assert.ok(pptx.file('ppt/slides/slide2.xml'));
 await page.screenshot({path:path.join(artifacts,'prism.png')});report.checks.push('Prism text, notes, second slide, presentation navigation, PPTX content');
 await create('slate','E2E Note');await page.getByLabel('Note content',{exact:true}).fill('Capture this thought for tomorrow.');await page.getByLabel('New tag',{exact:true}).fill('Verified');await page.getByRole('button',{name:'Add tag',exact:true}).click();await save();await page.screenshot({path:path.join(artifacts,'slate.png')});
 await app.close();await launch();
 await open('E2E Document');await expect(page.getByLabel('Document content',{exact:true})).toContainText('persistent document');await expect(page.locator('.linked-value strong')).toHaveText('50');
 await open('E2E Workbook');await expect(page.getByRole('gridcell',{name:'B1',exact:true})).toHaveText('50');await expect(page.getByRole('button',{name:'Sheet 2',exact:true})).toBeVisible();
 await open('E2E Presentation');await expect(page.getByRole('group',{name:'Text: A tested presentation',exact:true})).toBeVisible();await expect(page.getByLabel('Speaker notes',{exact:true})).toHaveValue('Remember the audience.');
 await open('E2E Note');await expect(page.getByLabel('Note content',{exact:true})).toContainText('Capture this thought');await expect(page.locator('.ed-tag')).toContainText('Verified');report.checks.push('All four editors persist across full Electron restart');
 await open('E2E Document');await page.getByLabel('Document content',{exact:true}).fill(Array.from({length:120},(_,i)=>`Paragraph ${i+1}: This document must print beyond the first visible screen.`).join('\n'));
 await save();const pdfBase64=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.printToPDF({printBackground:true,pageSize:'A4'})).toString('base64'));
 const pdf=Buffer.from(pdfBase64,'base64');await fs.writeFile(path.join(artifacts,'multipage.pdf'),pdf);const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;assert.ok(pages>=3,`Long document printed only ${pages} page(s)`);report.checks.push(`Rich-document print produces ${pages} pages without viewport clipping`);
 assert.deepEqual(errors,[]);report.passed=true;console.log(JSON.stringify(report,null,2));
}catch(error){report.passed=false;report.error=error.stack;if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});throw error;}
finally{await fs.writeFile(path.join(artifacts,'e2e-report.json'),JSON.stringify(report,null,2));if(app){if(!report.passed)await app.evaluate(({app})=>app.exit(1)).catch(()=>{});await app.close().catch(()=>{});}}
