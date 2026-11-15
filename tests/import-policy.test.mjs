import test from 'node:test';import assert from 'node:assert/strict';
test('individual apps admit only matching file formats and native kinds',async()=>{
 const {importExtensions,prepareImport}=await import('../core/import-policy.mjs');
 assert.deepEqual(importExtensions('grid'),['xlsx','csv']);
 const workbook={kind:'grid',content:{sheets:[]}};
 assert.throws(()=>prepareImport(workbook,'quill','ark'),/Grid/);
 assert.throws(()=>prepareImport(workbook,'quill','xlsx'),/format/i);
 assert.equal(prepareImport(workbook,'studio','ark'),workbook);
});
test('document imports into Slate become notes, native files never change kind silently',async()=>{
 const {prepareImport}=await import('../core/import-policy.mjs');
 const document={kind:'quill',content:{doc:{type:'doc'}}};
 const note=prepareImport(document,'slate','docx');
 assert.equal(note.kind,'slate');assert.deepEqual(note.content.tags,[]);assert.equal(document.kind,'quill');
 assert.throws(()=>prepareImport(document,'slate','ark'),/Quill/);
 const markdown={kind:'slate',content:{doc:{type:'doc'},tags:[]}};
 assert.equal(prepareImport(markdown,'quill','md').kind,'quill');
});
