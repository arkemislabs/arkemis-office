import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createFile,applyCommand} from '../core/model.mjs';
import {exportDocument,importDocument} from '../electron/formats.cjs';
import {paragraphDecoration,applyParagraphBorder,paragraphDecorationStyle,paragraphDecorationTransaction} from '../core/rich-paragraph.mjs';
import {getSchema} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {EditorState,TextSelection} from '@tiptap/pm/state';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const output=path.resolve(`artifacts/paragraph-schema-${process.pid}.mjs`);
await build({entryPoints:['src/editors/RichFormatting.ts'],outfile:output,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
const {ParagraphFormatting}=await import(pathToFileURL(output));
const border={style:'double',width:1.5,color:'#336699',space:4};
test('translated paragraph border presets toggle sides and keep explicit none distinct from inheritance',()=>{
 let b=applyParagraphBorder(null,{kind:'bottom',color:'#336699'});
 assert.deepEqual(b.bottom,{style:'single',width:.5,color:'#336699',space:1});
 b=applyParagraphBorder(b,{kind:'bottom'});assert.deepEqual(b,{});
 b=applyParagraphBorder({between:border},{kind:'outside',width:2});assert.deepEqual(b.between,border);assert.equal(b.left.space,1);
 assert.equal(applyParagraphBorder(b,{kind:'horizontalLine'}).bottom.width,1.5);assert.deepEqual(applyParagraphBorder(b,{kind:'none'}),{});
 assert.deepEqual(applyParagraphBorder(b,{sides:{left:{color:'#112233'}}}),{left:{style:'single',width:.5,color:'#112233',space:4}});
});
test('decoration validation rejects unsafe and malformed styling without mutating input',()=>{
 const attrs={paragraphShading:'#f0e0d0',paragraphBorders:{left:border}};
 assert.match(paragraphDecorationStyle(attrs),/border-left:1.5pt double #336699/);
 for(const invalid of [{paragraphShading:'red;display:none'},{paragraphBorders:{left:{...border,width:Infinity}}},{paragraphBorders:{bad:border}},{paragraphBorders:[]}])assert.throws(()=>paragraphDecoration(invalid));
 assert.throws(()=>applyParagraphBorder(attrs.paragraphBorders,{kind:'unknown'}));assert.equal(attrs.paragraphBorders.left.width,1.5);
});
test('selected paragraph formatting excludes next paragraph start and retains heading and marks',()=>{
 const schema=getSchema([StarterKit,ParagraphFormatting]),doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'One',marks:[{type:'bold'}]}]},{type:'heading',attrs:{level:2},content:[{type:'text',text:'Two'}]},{type:'paragraph',content:[{type:'text',text:'Three'}]}]});
 const state=EditorState.create({doc,selection:TextSelection.create(doc,1,6)}),tr=paragraphDecorationTransaction(state,{paragraphShading:'#ffeeaa'});
 assert.equal(tr.doc.child(0).attrs.paragraphShading,'#ffeeaa');assert.equal(tr.doc.child(1).attrs.paragraphShading,null);assert.equal(tr.doc.child(0).firstChild.marks[0].type.name,'bold');
 const caret=EditorState.create({doc,selection:TextSelection.create(doc,7)});assert.equal(paragraphDecorationTransaction(caret,{border:{kind:'outside'}}).doc.child(1).attrs.paragraphBorders.top.style,'single');
});
test('paragraph shading and borders survive DOCX import/edit/export',async()=>{
 const file=createFile('quill','Paragraph borders');file.content.doc.content=[{type:'paragraph',attrs:{paragraphShading:'#ffeeaa',paragraphBorders:{top:border,bottom:{...border,style:'dotted',space:1}}},content:[{type:'text',text:'Callout',marks:[{type:'bold'}]}]}];
 const bytes=await exportDocument(file,'docx'),zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml').async('string');assert.match(xml,/<w:pBdr>/);assert.match(xml,/<w:top(?=[^>]*w:val="double")(?=[^>]*w:sz="12")(?=[^>]*w:space="4")/);assert.match(xml,/<w:pPr>[\s\S]*?<w:shd[^>]*w:fill="ffeeaa"/i);
 const loaded=await importDocument(bytes,'docx','Imported');assert.deepEqual(loaded.content.doc.content[0].attrs.paragraphBorders,{top:border,bottom:{...border,style:'dotted',space:1}});assert.equal(loaded.content.doc.content[0].attrs.paragraphShading.toLowerCase(),'#ffeeaa');
 const edited=applyCommand(loaded,{type:'format_paragraph',baseRevision:loaded.revision,path:[0],expectedText:'Callout',formatting:{paragraphShading:'#ddeeff',paragraphBorders:{}}});const round=await importDocument(await exportDocument(edited,'docx'),'docx','Again');assert.equal(round.content.doc.content[0].attrs.paragraphShading.toLowerCase(),'#ddeeff');assert.ok(Object.values(round.content.doc.content[0].attrs.paragraphBorders).every(b=>b.style==='nil'));
});
test('DOCX email and telephone links retain their targets and bold text',async()=>{
 const f=createFile('quill','Links');f.content.doc.content=[{type:'paragraph',content:['mailto:hello@example.com','tel:+441234567890','https://example.com/a?b=1'].map(href=>({type:'text',text:href,marks:[{type:'bold'},{type:'link',attrs:{href}}]}))}];
 const reopened=await importDocument(await exportDocument(f,'docx'),'docx','Links');assert.deepEqual(reopened.content.doc.content[0].content.map(n=>n.marks.find(m=>m.type==='link')?.attrs.href),f.content.doc.content[0].content.map(n=>n.text));assert.ok(reopened.content.doc.content[0].content.every(n=>n.marks.some(m=>m.type==='bold')));
});
