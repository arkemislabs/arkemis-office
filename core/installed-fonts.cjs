const {execFile}=require('node:child_process');
const path=require('node:path');
let catalog;
exports.installedFonts=()=>catalog??=(async()=>{
 const {normalizeFontFamilies,fallbackFonts}=await import('./font-catalog.mjs');
 if(process.platform!=='win32')return {families:fallbackFonts,system:false};
 // Fixed script, no caller input. The child is hidden, read-only and bounded.
 const script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $collection=New-Object System.Drawing.Text.InstalledFontCollection; try { @($collection.Families | ForEach-Object { $_.Name }) | ConvertTo-Json -Compress } finally { $collection.Dispose() }";
 try{
  const stdout=await new Promise((resolve,reject)=>execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,encoding:'utf8'},(error,out)=>error?reject(error):resolve(out)));
  const families=normalizeFontFamilies(JSON.parse(stdout.replace(/^\uFEFF/,'')));if(!families.length)throw new Error('Empty font catalog');return {families,system:true};
 }catch{return {families:fallbackFonts,system:false};}
})();
