import test from 'node:test';import assert from 'node:assert/strict';import JSZip from 'jszip';
import {createFile} from '../core/model.mjs';import {exportDocument} from '../electron/formats.cjs';import {importPresentation} from '../electron/ooxml.cjs';
test('Prism preserves chosen font families through PPTX export and import',async()=>{
 const file=createFile('prism');file.content.slides[0].elements[0].fontFamily='Georgia';
 const zip=await JSZip.loadAsync(await exportDocument(file,'pptx'));
 assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/typeface="Georgia"/);
 const imported=await importPresentation(zip,createFile,'Imported font');
 assert.equal(imported.content.slides[0].elements[0].fontFamily,'Georgia');
});
test('Quill exports international font-family names without substitution',async()=>{
 const file=createFile('quill');file.content.doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Hello',marks:[{type:'textStyle',attrs:{fontFamily:'Noto Sans देवनागरी'}}]}]}]};
 const zip=await JSZip.loadAsync(await exportDocument(file,'docx'));assert.match(await zip.file('word/document.xml').async('string'),/Noto Sans देवनागरी/);
});
