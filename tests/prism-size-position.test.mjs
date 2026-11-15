import test from 'node:test';import assert from 'node:assert/strict';import {sizePositionElements} from '../core/prism-size-position.mjs';
import {createFile,applyCommand} from '../core/model.mjs';import {exportDocument,importDocument} from '../electron/formats.cjs';
const items=[{id:'a',type:'shape',x:0,y:0,w:144,h:72},{id:'b',type:'shape',x:20,y:30,w:100,h:100}];
test('source size semantics apply scale, explicit dimensions, aspect and normalized rotation atomically',()=>{
 const result=sizePositionElements(items,['a','b'],{scaleW:150,lockAspect:true,rot:-90,x:-72});assert.equal(result[0].w,216);assert.equal(result[0].h,108);assert.equal(result[1].w,150);assert.equal(result[1].h,150);assert.equal(result[0].rotation,270);assert.equal(result[0].x,-72);assert.equal(items[0].w,144);
 const widthWins=sizePositionElements(items,['a'],{w:288,h:10,lockAspect:true});assert.equal(widthWins[0].h,144);assert.equal(widthWins[1],items[1]);
 assert.equal(sizePositionElements(items,['a'],{h:144,lockAspect:true})[0].w,288);
 assert.equal(sizePositionElements(items,['a'],{scaleW:200,w:120})[0].w,120);
 for(const patch of [{w:0},{w:16000},{x:Infinity},{scaleH:-1},{rot:NaN},{lockAspect:'yes'},{unknown:2}])assert.throws(()=>sizePositionElements(items,['a'],patch));
 assert.throws(()=>sizePositionElements(items,['missing'],{}));assert.throws(()=>sizePositionElements(items,['a','a'],{}));
});
test('revision-checked size command and native PPTX retain exact geometry',async()=>{
 const file=createFile('prism'),slide=file.content.slides[0];slide.elements=[...structuredClone(items)];
 const next=applyCommand(file,{type:'transform_slide_elements',baseRevision:0,slideId:slide.id,ids:['a'],transform:{type:'size-position',w:216,lockAspect:true,rot:-90,x:-72,y:36}});
 const reopened=await importDocument(await exportDocument(next,'pptx'),'pptx','Sizes');const shape=reopened.content.slides[0].elements[0];
 assert.equal(shape.x,-72);assert.equal(shape.y,36);assert.equal(shape.w,216);assert.equal(shape.h,108);assert.equal(shape.rotation,270);assert.equal(next.revision,1);
});

test('aspect lock alone does not resize objects with different sizes',()=>{for(const lockAspect of [true,false])assert.deepEqual(sizePositionElements(items,['a','b'],{lockAspect}),items);});
