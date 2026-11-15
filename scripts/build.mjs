import {build} from 'esbuild';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {writeLicenses} from './write-licenses.mjs';
import {WORKER_ENTRIES} from './renderer-entries.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Registry, spec and icon indexes (core/generated, src/generated) are rebuilt from folder contents first.
const generated=await (await import('./generate.mjs')).generate({root,strict:process.env.ARKEMIS_STRICT==='1',log:console});
if(generated.errors.length)throw new Error(`generate: ${generated.errors.length} errors (see above)`);
// Diagnostics UI and pending-control previews are compiled out unless explicitly enabled.
const envDefines={'process.env.ARKEMIS_DIAGNOSTICS':JSON.stringify(process.env.ARKEMIS_DIAGNOSTICS==='1'?'1':'0'),'process.env.ARKEMIS_SHOW_PENDING':JSON.stringify(process.env.ARKEMIS_SHOW_PENDING==='1'?'1':'0'),'process.env.ARKEMIS_NEW_HOST':JSON.stringify(process.env.ARKEMIS_NEW_HOST==='1'&&process.env.ARKEMIS_STRICT!=='1'?'1':'0')};
await fs.mkdir(path.join(root,'dist'),{recursive:true});
const result=await build({absWorkingDir:root,entryPoints:['src/main.tsx'],outdir:'dist',bundle:true,splitting:true,format:'esm',platform:'browser',target:'chrome142',minify:true,metafile:true,loader:{'.png':'dataurl','.svg':'dataurl','.woff2':'file'},assetNames:'fonts/[name]',define:{'process.env.NODE_ENV':'"production"',...envDefines},logLevel:'info'});
await fs.copyFile(path.join(root,'src/index.html'),path.join(root,'dist/index.html'));
// Worker entry points the renderer starts with new Worker('./<name>.js', {type: 'module'}) (esbuild does not
// follow `new Worker(new URL(...))`): each is bundled on its own when its source exists (Grid's recalculation).
for(const w of WORKER_ENTRIES){try{await fs.access(path.join(root,w.entry));}catch{continue;}await build({absWorkingDir:root,entryPoints:[w.entry],outfile:path.join('dist',w.out),bundle:true,format:'esm',platform:'browser',target:'chrome142',minify:true,define:{'process.env.NODE_ENV':'"production"',...envDefines},logLevel:'info'});}
// Which shell this bundle runs (main reads it: a new-host renderer edits schema-2 documents).
await fs.writeFile(path.join(root,'dist/host.json'),JSON.stringify({newHost:envDefines['process.env.ARKEMIS_NEW_HOST']==='"1"'}));
// The spelling dictionary (dictionary-en: SCOWL en_US Hunspell, MIT AND BSD) the spelling worker fetches next to itself (src/workers/spelling.ts, core/common/lib/spelling-engine.mjs); its licence travels with it.
await fs.mkdir(path.join(root,'dist/dictionaries'),{recursive:true});
for(const [from,to] of [['index.aff','en-US.aff'],['index.dic','en-US.dic'],['license','en-US.LICENSE.txt']])await fs.copyFile(path.join(root,'node_modules/dictionary-en',from),path.join(root,'dist/dictionaries',to));
await fs.copyFile(path.join(root,'src/pdf-automation.html'),path.join(root,'dist/pdf-automation.html'));
await fs.copyFile(path.join(root,'node_modules/pdfjs-dist/build/pdf.worker.mjs'),path.join(root,'dist/pdf.worker.mjs'));
for(const folder of ['cmaps','standard_fonts','wasm'])await fs.cp(path.join(root,'node_modules/pdfjs-dist',folder),path.join(root,'dist/pdfjs',folder),{recursive:true});
const pdfAutomation=await build({absWorkingDir:root,entryPoints:['src/pdf-automation.ts'],outfile:'dist/pdf-automation.js',bundle:true,format:'esm',platform:'browser',target:'chrome142',minify:true,metafile:true,logLevel:'info'});
await fs.writeFile(path.join(root,'dist/build-meta.json'),JSON.stringify(result.metafile,null,2));
await fs.mkdir(path.join(root,'runtime'),{recursive:true});
await fs.copyFile(path.join(root,'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'),path.join(root,'runtime/pdfium.wasm'));
// PDFium's ESM entry uses import.meta.url during initialization even when the
// WASM bytes are supplied. Select its native CJS entry for this CJS worker.
const worker=await build({absWorkingDir:root,entryPoints:['electron/format-worker.cjs'],outfile:'runtime/format-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',alias:{'@embedpdf/pdfium':path.join(root,'node_modules/@embedpdf/pdfium/dist/index.cjs')},minify:true,metafile:true,legalComments:'eof',logLevel:'info'});
await fs.writeFile(path.join(root,'runtime/build-meta.json'),JSON.stringify(worker.metafile,null,2));
const ocrWorker=await build({absWorkingDir:root,entryPoints:['node_modules/tesseract.js/src/worker-script/node/index.js'],outfile:'runtime/ocr-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['tesseract.js-core/*'],minify:true,metafile:true,legalComments:'eof',logLevel:'info'});
await fs.writeFile(path.join(root,'runtime/ocr-build-meta.json'),JSON.stringify(ocrWorker.metafile,null,2));
await fs.cp(path.join(root,'node_modules/tesseract.js-core'),path.join(root,'runtime/node_modules/tesseract.js-core'),{recursive:true});
await fs.access(path.join(root,'assets/ocr/eng.traineddata'));
await fs.access(path.join(root,'assets/ocr/LICENSE'));
// The OCR core stays external because its selected JS loader locates adjacent WASM.
const ocrExternalLicenses={inputs:{'node_modules/tesseract.js-core/package.json':{}}};
await writeLicenses(root,[result.metafile,worker.metafile,pdfAutomation.metafile,ocrWorker.metafile,ocrExternalLicenses]);

await fs.rm(path.join(root,'dist/brand/products/glass'),{recursive:true,force:true});
await fs.cp(path.join(root,"assets/brand"),path.join(root,"dist/brand"),{recursive:true,filter:source=>!source.endsWith('-master.png')&&path.basename(source)!=='glass'});
