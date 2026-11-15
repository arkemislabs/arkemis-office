import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const buildDirectory=path.join(root,'build'),stage=path.resolve(buildDirectory,'office');
await fs.mkdir(buildDirectory,{recursive:true});
const actualBuild=await fs.realpath(buildDirectory);
if(actualBuild.toLowerCase()!==buildDirectory.toLowerCase()||path.dirname(stage)!==buildDirectory||path.basename(stage)!=='office')throw new Error('Unsafe Office staging directory');
try{if((await fs.lstat(stage)).isSymbolicLink())throw new Error('Office staging directory must not be a link');}catch(error){if(error.code!=='ENOENT')throw error;}
// Only this resolved, dedicated staging directory is replaced; releases remain intact.
await fs.rm(stage,{recursive:true,force:true});await fs.mkdir(stage,{recursive:true});
const filter=source=>path.basename(source)!=='glass'&&!source.endsWith('-master.png');
for(const directory of ['dist','runtime','core','electron','assets','LICENSES'])await fs.cp(path.join(root,directory),path.join(stage,directory),{recursive:true,filter});
for(const file of ['LICENSE','THIRD_PARTY.md'])await fs.copyFile(path.join(root,file),path.join(stage,file));
await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:'arkemis-office',version:pkg.version,productName:'Arkemis Office',description:pkg.description,author:pkg.author,license:pkg.license,main:pkg.main,type:'module',studioProduct:'studio',dependencies:{}},null,2));
await fs.writeFile(path.join(stage,'package-lock.json'),JSON.stringify({name:'arkemis-office',version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:'arkemis-office',version:pkg.version,license:pkg.license}}},null,2));
for(const file of ['dist/index.html','dist/spelling.js','dist/dictionaries/en-US.dic','dist/dictionaries/en-US.aff','runtime/format-worker.cjs','runtime/pdfium.wasm','core/model.mjs','assets/brand/products/suite.ico','assets/brand/products/suite.icns','assets/brand/products/suite-dock.png'])await fs.access(path.join(stage,file));
// The main process, bundled (release check, Nov 1): the installed app carries no node_modules, and main imports the
// suite's core (pdf-lib, @tiptap, jszip, fast-xml-parser, pkijs, nspell, ...) from source, so without this an installed
// copy can't start its main-process file formats, PDF tools or document recovery.
// Everything main loads, dynamic imports included, goes into electron/main.cjs; the preload and the workers stay as built.
{const {build}=await import('esbuild');
 const r=await build({absWorkingDir:root,entryPoints:['electron/main.cjs'],outfile:path.join(stage,'electron/main.cjs'),allowOverwrite:true,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],
  alias:{'@embedpdf/pdfium':path.join(root,'node_modules/@embedpdf/pdfium/dist/index.cjs')},
  // Modules that locate files from import.meta.url see main.cjs's own place (electron/), as headless-host.mjs expects.
  define:{'import.meta.url':'__mainModuleUrl'},banner:{js:"const __mainModuleUrl=require('node:url').pathToFileURL(__filename).href;"},
  legalComments:'eof',minify:true,logLevel:'warning',metafile:true});
 const unresolved=Object.keys(r.metafile.inputs).filter(f=>/node_modules/.test(f)).length;
 console.log(`Main process bundled: ${Object.keys(r.metafile.inputs).length} modules (${unresolved} from packages).`);}
// macOS (on a Mac, or GitHub's macOS runners): an unsigned Arkemis Office.app (--dir) or disk image; signing is left to whoever publishes a release. Its icon is suite.icns (scripts/render-mac-icons.cjs): without one, Finder, the Dock and the disk
// image showed Electron's logo (0.1.2 on a Mac, Nov 8). Windows: the NSIS installer as before.
const mac=process.platform==='darwin';
const electronDist=mac?path.join(path.dirname(require.resolve('electron/package.json')),'dist'):path.dirname(require.resolve('electron/dist/electron.exe')),electronVersion=(await fs.readFile(path.join(electronDist,'version'),'utf8')).trim();
// Electron fuses (security audit L2), flipped by electron-builder after packing. Every window loads studio://app/ (a custom protocol; its handler reads
// dist/ from main with net.fetch), workers are worker_threads and launching another app runs process.execPath as a normal Electron start, so nothing here
// needs file:// privileges or ELECTRON_RUN_AS_NODE. The app's code is only ever loaded from app.asar, and the asar is integrity-checked.
const electronFuses={runAsNode:false,enableCookieEncryption:true,enableNodeOptionsEnvironmentVariable:false,enableNodeCliInspectArguments:false,enableEmbeddedAsarIntegrityValidation:true,onlyLoadAppFromAsar:true,grantFileProtocolExtraPrivileges:false,resetAdHocDarwinSignature:process.platform==='darwin'};
// macOS document types: Finder lists Arkemis Office under Open With for each, and opens them with it when no other app is
// the default (rank Default: never taking a type from an app the person chose). The file goes to its own app (main.cjs open-file).
const MAC_DOCUMENT_TYPES=[["quill","Document",["docx","dotx","doc","rtf","odt"]],["grid","Spreadsheet",["xlsx","xlsm","xls","csv","ods"]],["prism","Presentation",["pptx","ppsx","ppt","odp"]],["slate","Notebook",["one"]],["folio","PDF document",["pdf"]]].map(([app,name,ext])=>({ext,name:'Arkemis '+name,role:'Editor',rank:'Default',icon:path.join(root,'assets/brand/products/'+app+'.icns')}));
const config={...pkg.build,appId:'ai.arkemis.office',productName:'Arkemis Office',extraMetadata:{name:'arkemis-office',productName:'Arkemis Office',studioProduct:'studio',dependencies:{}},directories:{output:path.join(root,'release/office'),app:'.'},npmRebuild:false,files:['dist/**/*','runtime/**/*','electron/**/*','core/**/*','assets/**/*','LICENSES/**/*','package.json','LICENSE','THIRD_PARTY.md','!node_modules/**/*','!**/glass/**/*','!**/*-master.png'],electronDist,electronVersion,asar:true,electronFuses,extraResources:[{from:path.join(root,'assets/brand/products'),to:'icons',filter:['quill.ico','grid.ico','prism.ico','slate.ico','folio.ico','suite.ico']}],mac:{target:[{target:process.argv.includes('--dir')?'dir':'dmg',arch:[process.arch==='arm64'?'arm64':'x64']}],identity:null,icon:path.join(root,'assets/brand/products/suite.icns'),fileAssociations:MAC_DOCUMENT_TYPES,category:'public.app-category.productivity',darkModeSupport:true},dmg:{title:'Arkemis Office ${version}',icon:path.join(root,'assets/brand/products/suite.icns'),artifactName:'Arkemis-Office-${version}-mac.${ext}'},win:{target:['nsis'],signExecutable:false,icon:path.join(root,'assets/brand/products/suite.ico')},nsis:{...pkg.build.nsis,perMachine:true,include:path.join(root,'scripts/installer/office-uninstall.nsh'),shortcutName:'Arkemis Office',artifactName:'Arkemis-Office-${version}-Setup.${ext}'},artifactName:'Arkemis-Office-${version}-Setup.${ext}'};
const configPath=path.join(buildDirectory,'office.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
console.log(`Office staging ready (${electronVersion}); one launcher and installer for all apps.`);
if(!process.argv.includes('--stage-only'))await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[require.resolve('electron-builder/cli.js'),'--projectDir',stage,'--config',configPath,mac?'--mac':'--win',...(process.argv.includes('--dir')&&!mac?['--dir']:[]),'--publish','never'],{cwd:root,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Office packaging exited '+code)));});
