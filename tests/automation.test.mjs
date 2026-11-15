import test from 'node:test';import assert from 'node:assert/strict';import {createFile,applyCommand} from '../core/model.mjs';
test('Prism order command uses selected stable IDs and rejects stale or invalid edits atomically',()=>{
 const file=createFile('prism'),slide=file.content.slides[0];
 slide.elements=['a','b','c','d'].map(id=>({id,type:'shape',x:0,y:0,w:10,h:10}));
 const command={type:'order_slide_elements',baseRevision:0,slideId:slide.id,ids:['a','b'],direction:'forward'};
 const result=applyCommand(file,command);
 assert.deepEqual(result.content.slides[0].elements.map(e=>e.id),['c','a','b','d']);
 assert.deepEqual(slide.elements.map(e=>e.id),['a','b','c','d']);assert.equal(result.revision,1);
 assert.throws(()=>applyCommand(result,command),/Revision conflict/);
 for(const change of [{ids:['missing']},{ids:[]},{ids:['a','a']},{slideId:'missing'},{direction:'unknown'}])
  assert.throws(()=>applyCommand(file,{...command,...change}));
});
test('structured rich text edits address exact nodes and ranges without screenshots',()=>{
 const f=createFile('quill');f.content.doc.content[0].content=[{type:'text',text:'Hello world',marks:[{type:'bold'}]}];
 const next=applyCommand(f,{type:'replace_text',baseRevision:0,path:[0,0],from:6,to:11,expectedText:'world',text:'Arkemis'});
 assert.equal(next.content.doc.content[0].content[0].text,'Hello Arkemis');assert.equal(next.revision,1);
 assert.deepEqual(next.content.doc.content[0].content[0].marks,[{type:'bold'}]);
 assert.equal(f.content.doc.content[0].content[0].text,'Hello world');
 assert.throws(()=>applyCommand(f,{type:'replace_text',baseRevision:0,path:[0,0],from:6,to:11,expectedText:'wrong',text:'Oops'}),/conflict/i);
 assert.throws(()=>applyCommand(f,{type:'replace_text',baseRevision:0,path:['__proto__'],from:0,to:1,expectedText:'H',text:'Oops'}),/path/i);
});
test('full structured content replacement is validated atomically for all editors',()=>{
 const f=createFile('prism'),content=structuredClone(f.content);content.slides[0].elements[0].text='Agent edited';
 const next=applyCommand(f,{type:'replace_content',baseRevision:0,content});assert.equal(next.content.slides[0].elements[0].text,'Agent edited');
 assert.throws(()=>applyCommand(f,{type:'replace_content',baseRevision:0,content:{slides:[]}}),/slide/i);
 assert.notEqual(f.content.slides[0].elements[0].text,'Agent edited');
});
test('automation snapshots expose revision-bound text paths and character offsets',async()=>{
 const {documentStructure}=await import('../core/automation.mjs');const f=createFile('slate');f.content.doc.content[0].content=[{type:'text',text:'Hi 😀'}];
 const snapshot=documentStructure(f);assert.equal(snapshot.revision,0);assert.deepEqual(snapshot.textNodes[0],{path:[0,0],text:'Hi 😀',length:5,offsetUnit:'utf16'});
});
