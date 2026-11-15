import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
// Native windows must run serially: parallel keyboard tests steal one another's focus.
const checks=['file-ribbon','ribbon-flow','grid-transfer','rich-command-dialogs','prism-size-dialog','shell-layout','pdf-layout','desktop-shell','rich-search','rich-tables','grid-translated-functions','grid-dynamic-arrays','grid-formatting','grid-workbook-references','prism-fidelity','rich-paragraph-links','rich-page-parts','grid-tables','pdf-form-designer','prism-focus','prism-slides','pdf','pdf-bookmarks','pdf-signatures'];
const selected=process.argv.slice(2);
if(selected.some(name=>!checks.includes(name)))throw Error('Choose checks from: '+checks.join(', '));
const report={startedAt:new Date().toISOString(),passed:false,checks:[],scope:'Desktop regression checks only; this does not establish full ArtCraft or Microsoft Office feature parity.'};
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
const reportPath=path.join(root,'artifacts/desktop-verification.json');
async function run(name,args,timeoutMs){
 const started=Date.now();
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
  const timer=setTimeout(()=>{
   // Terminate only this verification child's process tree, never existing user apps.
   if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
   else child.kill('SIGTERM');
   reject(Error(name+' exceeded its verification timeout'));
  },timeoutMs);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(name+' exited '+code));});
 }).then(()=>report.checks.push({name,passed:true,durationMs:Date.now()-started}),error=>{report.checks.push({name,passed:false,durationMs:Date.now()-started,error:error.message});throw error;});
 await fs.writeFile(reportPath,JSON.stringify(report,null,2));
}
try{
 await run('build',['scripts/build.mjs'],180000);
 for(const name of selected.length?selected:checks)await run(name,['tests/'+name+'.e2e.mjs'],240000);
 report.passed=true;
}finally{
 report.finishedAt=new Date().toISOString();
 await fs.writeFile(reportPath,JSON.stringify(report,null,2));
}
