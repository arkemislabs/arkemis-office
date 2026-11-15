import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createFile} from '../core/model.mjs';
import {exportDocument,importDocument} from '../electron/formats.cjs';
import {paragraphLayout,makeRichTable,safePasteJSON} from '../core/rich-dialogs.mjs';
test('paragraph layout validates indentation, hanging and supported spacing atomically',()=>{
 assert.deepEqual(paragraphLayout({indentLeft:36,indentRight:18,indentFirstLine:-18,lineHeight:1.5}),{indentLeft:36,indentRight:18,indentFirstLine:-18,lineHeight:1.5});
 for(const attrs of [{indentLeft:-1},{indentRight:721},{indentFirstLine:Infinity},{lineHeight:0},{spaceAfter:-1},{textAlign:'unsafe'},{surprise:1}])assert.throws(()=>paragraphLayout(attrs));
});
test('table builder produces editable native cells, explicit widths and optional header',()=>{
 const table=makeRichTable({rows:4,columns:3,width:600,header:true});assert.equal(table.content.length,4);assert.equal(table.content[0].content[0].type,'tableHeader');assert.equal(table.content[1].content[0].type,'tableCell');assert.deepEqual(table.content[3].content[2].attrs.colwidth,[200]);assert.equal(table.content[0].content[0].content[0].type,'paragraph');
 assert.equal(makeRichTable({rows:1,columns:1,width:250,header:false}).content[0].content[0].type,'tableCell');for(const options of [{rows:0,columns:2,width:500},{rows:2,columns:13,width:500},{rows:2,columns:4,width:50}])assert.throws(()=>makeRichTable(options));
});
test('pasted JSON strips external images and unsafe link URLs, preserving safe emphasis',()=>{
 const doc={type:'doc',content:[{type:'image',attrs:{src:'https://tracker.example/pixel'}},{type:'paragraph',content:[{type:'text',text:'Hi',marks:[{type:'bold'},{type:'link',attrs:{href:'java\nscript:alert(1)'}}]},{type:'text',text:'Safe',marks:[{type:'link',attrs:{href:'https://example.com'}}]}]}]};const clean=safePasteJSON(doc);assert.equal(clean.content.length,1);assert.deepEqual(clean.content[0].content[0].marks,[{type:'bold'}]);assert.equal(clean.content[0].content[1].marks[0].attrs.href,'https://example.com');assert.equal(doc.content.length,2);
});
test('DOCX roundtrip preserves hanging/first-line indent and native table widths/header',async()=>{
 for(const first of [-18,24]){const file=createFile('quill');file.content.doc.content=[{type:'paragraph',attrs:{indentLeft:36,indentRight:18,indentFirstLine:first,lineHeight:1.5,spaceBefore:6,spaceAfter:12},content:[{type:'text',text:'Paragraph'}]},makeRichTable({rows:3,columns:2,width:480,header:true})];const bytes=await exportDocument(file,'docx'),zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml').async('string');assert.match(xml,/w:left="720"/);assert.match(xml,new RegExp(`w:${first<0?'hanging':'firstLine'}="${Math.abs(first)*20}"`));assert.match(xml,/w:tblHeader/);const restored=await importDocument(bytes,'docx','Layout');const attrs=restored.content.doc.content[0].attrs;assert.equal(attrs.indentLeft,36);assert.equal(attrs.indentRight,18);assert.equal(attrs.indentFirstLine,first);const table=restored.content.doc.content.find(n=>n.type==='table');assert.equal(table.content[0].content[0].type,'tableHeader');assert.deepEqual(table.content[1].content[0].attrs.colwidth,[240]);}
});
import {validateFile,applyCommand} from '../core/model.mjs';
test('native validation and format_paragraph reject malformed indentation',()=>{
 const file=createFile('quill');file.content.doc.content=[{type:'paragraph',attrs:{indentLeft:36},content:[{type:'text',text:'Hello'}]}];
 for(const value of [-1,721,'36pt',Infinity]){const invalid=structuredClone(file);invalid.content.doc.content[0].attrs.indentLeft=value;assert.throws(()=>validateFile(invalid));}
 const result=applyCommand(file,{type:'format_paragraph',baseRevision:0,path:[0],expectedText:'Hello',formatting:{indentLeft:72,indentFirstLine:-18}});assert.equal(result.content.doc.content[0].attrs.indentFirstLine,-18);assert.throws(()=>applyCommand(file,{type:'format_paragraph',baseRevision:0,path:[0],expectedText:'Hello',formatting:{indentFirstLine:-721}}));
});
test('formatted paste validates table structure before insertion',()=>{
 const table=makeRichTable({rows:2,columns:2,width:400,header:true});table.content[0].content[0].attrs.colspan=1000000000;assert.throws(()=>safePasteJSON({type:'doc',content:[table]}),/span/);
});
import {pasteAttributes} from '../core/rich-dialogs.mjs';
test('clipboard attribute allowlist preserves validated native paragraph and cell formatting',()=>{
 const borders={bottom:{style:'double',width:1.5,color:'#336699',space:4}},paragraph={'data-paragraphshading':JSON.stringify('#ffeeaa'),'data-paragraphborders':JSON.stringify(borders),style:'margin-left:36pt;text-indent:-18pt'};
 assert.deepEqual(pasteAttributes('p',paragraph),paragraph);
 const cellBorders={top:{style:'double',color:'#336699',size:1.5}},cell={colspan:'2',rowspan:'1',colwidth:'120,180','data-cell-fill':'#ffeeaa','data-cell-vertical':'center','data-cell-borders':JSON.stringify(cellBorders)};
 assert.deepEqual(pasteAttributes('td',cell),cell);assert.deepEqual(pasteAttributes('th',{'data-colwidth':'120'}),{colwidth:'120'});assert.deepEqual(pasteAttributes('table',{'data-table-align':'right'}),{'data-table-align':'right'});
 assert.deepEqual(pasteAttributes('p',{onclick:'attack()',style:'background:url(https://tracker)',random:'x'}),{});
 for(const attrs of [{colspan:'1000000000'},{rowspan:'501'},{colspan:'2.5'},{colwidth:'1,'.repeat(64)},{colwidth:'Infinity'},{'data-cell-fill':'url(evil)'},{'data-cell-borders':'{"top":{"style":"bad"}}'}])assert.throws(()=>pasteAttributes('td',attrs));
 assert.throws(()=>pasteAttributes('p',{'data-paragraphborders':'{"bottom":{"width":999}}'}));
});
test('safe pasted native table retains decoration and widths but rejects ragged geometry',()=>{
 const table=makeRichTable({rows:2,columns:2,width:400,header:true});table.content[0].content[0].attrs.backgroundColor='#ffeeaa';table.content[0].content[0].attrs.verticalAlign='center';table.content[0].content[0].attrs.cellBorders={bottom:{style:'double',size:2,color:'#112233'}};table.content[0].content[0].content[0].attrs={paragraphShading:'#ddeeff',paragraphBorders:{bottom:{style:'double',width:1,color:'#112233',space:2}}};assert.deepEqual(safePasteJSON({type:'doc',content:[table]}).content[0],table);table.content[1].content.pop();assert.throws(()=>safePasteJSON({type:'doc',content:[table]}),/rectangular/);
});
import {plainPasteText} from '../core/rich-dialogs.mjs';
test('HTML-only plain paste preserves paragraph/list breaks and table cell boundaries',()=>{
 const element=(tag,...children)=>({nodeName:tag.toUpperCase(),nodeType:1,childNodes:children.map(c=>typeof c==='string'?{nodeType:3,nodeValue:c}:c)});
 assert.equal(plainPasteText(element('fragment',element('p','A'),element('p','B'))),'A\nB');
 assert.equal(plainPasteText(element('fragment',element('ul',element('li','First'),element('li','Second')),element('table',element('tbody',element('tr',element('td','A'),element('td','B')),element('tr',element('td','C'),element('td','D')))))),'First\nSecond\nA\tB\nC\tD');
 assert.equal(plainPasteText(element('div','Before',element('p','After',element('br'),'Break'),element('script','bad'))),'Before\nAfter\nBreak');
});
import {readRichClipboard} from '../core/rich-dialogs.mjs';
test('Rich clipboard prefers native HTML unchanged and does not mask bridge failure',async()=>{
 const payload={text:'',html:'<p>A</p><p>B</p>'};let browserCalls=0;const browser={read:async()=>{browserCalls++;throw Error('browser should not be used');}};
 assert.deepEqual(await readRichClipboard(async()=>payload,browser),payload);assert.equal(browserCalls,0);await assert.rejects(readRichClipboard(async()=>{throw Error('Native failure');},browser),/Native failure/);assert.equal(browserCalls,0);
 await assert.rejects(readRichClipboard(async()=>({text:'x'.repeat(2_000_001),html:''}),browser),/too large/);await assert.rejects(readRichClipboard(async()=>({text:'',html:''}),browser),/no text/);
 assert.deepEqual(await readRichClipboard(undefined,{readText:async()=>'Plain fallback'}),{html:'',text:'Plain fallback'});
});
