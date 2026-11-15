import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';import path from 'node:path';import {getSchema} from '@tiptap/core';import StarterKit from '@tiptap/starter-kit';
const output=path.resolve(`artifacts/rich-schema-${process.pid}.mjs`);await fs.mkdir(path.dirname(output),{recursive:true});
await build({entryPoints:['./src/editors/RichFormatting.ts'],outfile:output,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
const {ParagraphFormatting,nextFontSize}=await import(pathToFileURL(output));
test('paragraph spacing persists in heading and paragraph schema JSON',()=>{const schema=getSchema([StarterKit,ParagraphFormatting]);for(const type of ['paragraph','heading']){const attrs={lineHeight:1.5,spaceBefore:12,spaceAfter:24,...(type==='heading'?{level:2}:{})},doc=schema.nodeFromJSON({type:'doc',content:[{type,attrs,content:[{type:'text',text:'Formatted'}]}]});assert.equal(doc.toJSON().content[0].attrs.lineHeight,1.5);assert.equal(doc.toJSON().content[0].attrs.spaceBefore,12);assert.equal(doc.toJSON().content[0].attrs.spaceAfter,24);}});
test('font size steps respect bounds and nonpreset sizes',()=>{assert.equal(nextFontSize(13,1),14);assert.equal(nextFontSize(13,-1),12);assert.equal(nextFontSize(192,1),192);assert.equal(nextFontSize(6,-1),6);});
const textOutput=path.resolve(`artifacts/rich-style-schema-${process.pid}.mjs`);await build({entryPoints:['./src/editors/TextStyle.ts'],outfile:textOutput,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});const {TextStyle}=await import(pathToFileURL(textOutput));
test('highlight and script persist and render with other font attributes',()=>{const schema=getSchema([StarterKit,TextStyle]),mark=schema.mark('textStyle',{fontFamily:'Arial',fontSize:18,backgroundColor:'#ffff00',verticalAlign:'super'});assert.equal(mark.toJSON().attrs.backgroundColor,'#ffff00');assert.equal(mark.toJSON().attrs.verticalAlign,'super');const html=TextStyle.config.renderHTML({HTMLAttributes:mark.attrs});assert.match(html[1].style,/background-color:#ffff00/);assert.match(html[1].style,/vertical-align:super/);});
import {EditorState,TextSelection} from '@tiptap/pm/state';
import {history,undo,redo,closeHistory} from '@tiptap/pm/history';
import {TableKit} from '@tiptap/extension-table';
import {paragraphLayoutTransaction,makeRichTable} from '../core/rich-dialogs.mjs';
import {createFile,validateFile} from '../core/model.mjs';
test('paragraph dialog transaction preserves untouched mixed attributes and one-step undo',()=>{
 const schema=getSchema([StarterKit,ParagraphFormatting]),doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{spaceAfter:12,indentLeft:36},content:[{type:'text',text:'First'}]},{type:'heading',attrs:{level:2,spaceAfter:24,indentLeft:72},content:[{type:'text',text:'Second'}]}]});
 let state=EditorState.create({doc,selection:TextSelection.create(doc,1,13),plugins:[history()]});const before=state.doc.toJSON();state=state.apply(closeHistory(paragraphLayoutTransaction(state,{indentFirstLine:-18,lineHeight:2})));assert.equal(state.doc.child(0).attrs.indentLeft,36);assert.equal(state.doc.child(1).attrs.indentLeft,72);assert.equal(state.doc.child(1).attrs.spaceAfter,24);assert.equal(state.doc.child(1).attrs.level,2);assert.equal(state.doc.child(1).attrs.indentFirstLine,-18);assert.ok(undo(state,tr=>state=state.apply(tr)));assert.deepEqual(state.doc.toJSON(),before);assert.ok(redo(state,tr=>state=state.apply(tr)));assert.equal(state.doc.child(0).attrs.lineHeight,2);
 const file=createFile('quill');file.content.doc=state.doc.toJSON();const saved=JSON.parse(JSON.stringify(file));validateFile(saved);assert.equal(saved.content.doc.content[0].attrs.indentFirstLine,-18);
});
test('table dialog native schema insertion is editable and undoable',()=>{
 const schema=getSchema([StarterKit,TableKit]),doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before'}]}]});let state=EditorState.create({doc,selection:TextSelection.create(doc,7),plugins:[history()]});const before=state.doc.toJSON(),table=schema.nodeFromJSON(makeRichTable({rows:2,columns:3,width:501,header:true}));state=state.apply(closeHistory(state.tr.replaceSelectionWith(table)));const inserted=state.doc.toJSON().content.find(n=>n.type==='table');assert.equal(inserted.content[0].content[0].type,'tableHeader');assert.deepEqual(inserted.content[1].content[2].attrs.colwidth,[167]);const file=createFile('quill');file.content.doc=state.doc.toJSON();validateFile(JSON.parse(JSON.stringify(file)));assert.ok(undo(state,tr=>state=state.apply(tr)));assert.deepEqual(state.doc.toJSON(),before);
});
test('paragraph schema parses and renders a negative first-line indent in HTML',()=>{
 const attributes=ParagraphFormatting.config.addGlobalAttributes()[0].attributes;
 assert.equal(attributes.indentFirstLine.parseHTML({style:{textIndent:'-18pt'}}),-18);
 assert.deepEqual(attributes.indentFirstLine.renderHTML({indentFirstLine:-18}),{style:'text-indent:-18pt'});
 assert.equal(attributes.indentLeft.parseHTML({style:{marginLeft:'36pt'}}),36);
 assert.equal(attributes.indentFirstLine.parseHTML({style:{textIndent:'-900pt'}}),null);
});
