import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createFile,validateFile} from '../core/model.mjs';
import {exportDocument,importDocument} from '../electron/formats.cjs';
import {appendPageNumber,storyEditorState} from '../core/rich-page-parts.mjs';
import {getSchema} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {EditorState} from '@tiptap/pm/state';
import {history,undo} from '@tiptap/pm/history';
const doc=(...content)=>({type:'doc',content});
const p=(...content)=>({type:'paragraph',content});
const t=text=>({type:'text',text});
const field=kind=>({type:'wordField',attrs:{kind}});
test('page-number insertion preserves existing paragraphs and tables without mutation',()=>{
 const before=doc(p(t('Company')),{type:'table',content:[]});const next=appendPageNumber(before,true);
 assert.deepEqual(next.content.slice(0,2),before.content);assert.equal(before.content.length,2);assert.equal(next.content[2].content[1].attrs.kind,'PAGE');
});
test('switching story keeps draft text but resets history so Undo cannot cross variants',()=>{
 const schema=getSchema([StarterKit]);let state=EditorState.create({schema,doc:schema.nodeFromJSON(doc(p(t('Default')))),plugins:[history()]});state=state.apply(state.tr.insertText(' edited',8));assert.ok(undo(state));
 state=storyEditorState(state,doc(p(t('First'))));assert.equal(undo(state),false);assert.equal(state.doc.textContent,'First');state=state.apply(state.tr.insertText(' edited',6));undo(state,tr=>{state=state.apply(tr);});assert.equal(state.doc.textContent,'First');
});
test('DOCX default first and even stories retain formatted text, native page fields and page breaks',async()=>{
 const f=createFile('quill','Page stories');f.content.doc=doc(p(t('Before'),{type:'pageBreak'},t('After')));
 f.content.headerFooter={differentFirstPage:true,evenAndOdd:true,headers:{default:doc(p({...t('Company'),marks:[{type:'bold'}]})),first:doc(p(t('Cover'))),even:doc(p(t('Even header')))},footers:{default:doc(p(t('Page '),field('PAGE'),t(' of '),field('NUMPAGES'))),first:doc(p(t('First footer')))}};
 validateFile(f);const bytes=await exportDocument(f,'docx'),zip=await JSZip.loadAsync(bytes),body=await zip.file('word/document.xml').async('string');
 assert.match(body,/w:type="page"/);assert.match(body,/w:titlePg/);
 const back=await importDocument(bytes,'docx','Stories');assert.equal(back.content.headerFooter.headers.default.content[0].content[0].text,'Company');assert.equal(back.content.headerFooter.footers.default.content[0].content[1].attrs.kind,'PAGE');assert.equal(back.content.headerFooter.footers.default.content[0].content[3].attrs.kind,'NUMPAGES');assert.equal(back.content.headerFooter.headers.first.content[0].content[0].text,'Cover');assert.equal(back.content.headerFooter.headers.even.content[0].content[0].text,'Even header');
 assert.equal(back.content.doc.content[0].content[1].type,'pageBreak');
 const second=await importDocument(await exportDocument(back,'docx'),'docx','Second');assert.deepEqual(second.content.headerFooter,back.content.headerFooter);
});
test('invalid fields and invalid header stories are rejected',()=>{
 const f=createFile('quill','Invalid');f.content.doc=doc(p(field('INCLUDETEXT')));assert.throws(()=>validateFile(f));
 f.content.doc=doc(p());f.content.headerFooter={headers:{default:{type:'text',text:'bad'}}};assert.throws(()=>validateFile(f));
});
test('external simple page fields preserve bold and reject unsupported instructions or multiple sections',async()=>{
 const f=createFile('quill','External');f.content.doc=doc(p(t('Placeholder')));const bytes=await exportDocument(f,'docx');
 const change=async replacement=>{const z=await JSZip.loadAsync(bytes);const xml=await z.file('word/document.xml').async('string');z.file('word/document.xml',xml.replace(/<w:p>.*?<\/w:p>/s,replacement));return z.generateAsync({type:'nodebuffer'});};
 const imported=await importDocument(await change('<w:p><w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:b/></w:rPr><w:t>7</w:t></w:r></w:fldSimple></w:p>'),'docx','Simple');const n=imported.content.doc.content[0].content[0];assert.equal(n.type,'wordField');assert.equal(n.attrs.kind,'PAGE');assert.equal(n.marks[0].type,'bold');
 const complex=await importDocument(await change('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'),'docx','Complex');assert.deepEqual(complex.content.doc.content[0].content[0].marks,[{type:'bold'},{type:'textStyle',attrs:{color:'#FF0000'}}]);
 await assert.rejects(async()=>importDocument(await change('<w:p><w:fldSimple w:instr="PAGE \\* ROMAN"><w:r><w:t>VII</w:t></w:r></w:fldSimple></w:p>'),'docx','Roman'),/Unsupported Word field/);
 await assert.rejects(async()=>importDocument(await change('<w:p><w:pPr><w:sectPr/></w:pPr></w:p>'),'docx','Sections'),/multiple sections/);
});
