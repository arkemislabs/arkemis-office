import test from 'node:test';import assert from 'node:assert/strict';import {createFile,validateFile} from '../core/model.mjs';
test('header/footer parts and page fields validate through the rich document schema',()=>{
 const f=createFile('quill');f.content.doc.content[0].content=[{type:'text',text:'Before'},{type:'pageBreak'},{type:'text',text:'After'}];
 f.content.headerFooter={differentFirstPage:true,evenAndOdd:false,headers:{default:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Header'}]}]}},footers:{default:{type:'doc',content:[{type:'paragraph',content:[{type:'wordField',attrs:{kind:'PAGE'}},{type:'text',text:' of '},{type:'wordField',attrs:{kind:'NUMPAGES'}}]}]}}};
 assert.equal(validateFile(f),f);
 for(const bad of [{headers:{default:{type:'image'}}},{headers:{unknown:{type:'doc'}}},{differentFirstPage:'yes'},{footers:{default:{type:'doc',content:[{type:'wordField',attrs:{kind:'EXEC'}}]}}}])assert.throws(()=>validateFile({...f,content:{...f.content,headerFooter:bad}}));
});
