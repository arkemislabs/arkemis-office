import test from 'node:test';import assert from 'node:assert/strict';
import {editSlides,slideshowIndices,presentationSlideIndex,stepPresentation} from '../core/prism-slides.mjs';
const deck=()=>({activeSlideId:'b',slides:['a','b','c'].map(id=>({id,name:id,background:'#ffffff',notes:'',elements:[{id:id+'shape',type:'shape',x:0,y:0,w:20,h:20}]}))});
test('duplicates a selection in document order after its last member, with independent IDs',()=>{
 const source=deck();let i=0;const result=editSlides(source,{type:'duplicate',ids:['c','a']},()=>`copy${++i}`);
 assert.deepEqual(result.slides.map(s=>s.name),['a','b','c','a','c']);assert.equal(new Set(result.slides.flatMap(s=>[s.id,...s.elements.map(e=>e.id)])).size,10);assert.equal(source.slides.length,3);
});
test('hide selection toggles together and slideshow excludes hidden slides',()=>{
 let content=editSlides(deck(),{type:'hide',ids:['a','c']});assert.deepEqual(slideshowIndices(content.slides),[1]);
 assert.equal(presentationSlideIndex(0,content.slides),1);assert.equal(stepPresentation(1,1,content.slides),1);assert.equal(stepPresentation(1,-1,content.slides),1);
 assert.equal(presentationSlideIndex(0,content.slides.map(s=>({...s,hidden:true}))),null);
 content=editSlides(content,{type:'hide',ids:['a','c']});assert.deepEqual(slideshowIndices(content.slides),[0,1,2]);
});
test('stable selection move/delete chooses valid current slide, can delete all',()=>{
 const source=deck();assert.deepEqual(editSlides(source,{type:'move',ids:['a','c'],to:1}).slides.map(s=>s.id),['b','a','c']);
 const deleted=editSlides(source,{type:'delete',ids:['a','b']});assert.equal(deleted.activeSlideId,'c');
 const empty=editSlides(source,{type:'delete',ids:['a','b','c']});assert.deepEqual(empty.slides,[]);assert.equal(empty.activeSlideId,'');
 assert.throws(()=>editSlides(source,{type:'delete',ids:['missing']}));
});
test('hidden slide and name roundtrip through PPTX',async()=>{
 const {createFile}=await import('../core/model.mjs');const {exportDocument,importDocument}=await import('../electron/formats.cjs');const file=createFile('prism');file.content.slides[0].hidden=true;file.content.slides[0].name='Appendix & <notes>';
 const result=await importDocument(await exportDocument(file,'pptx'),'pptx','Hidden');assert.equal(result.content.slides[0].hidden,true);assert.equal(result.content.slides[0].name,'Appendix & <notes>');
});
