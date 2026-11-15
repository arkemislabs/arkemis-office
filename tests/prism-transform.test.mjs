import test from 'node:test';import assert from 'node:assert/strict';
import {transformElements,elementBounds,resizeTransformedElement} from '../core/prism-transform.mjs';
import {arrangeElements,nudgeElements} from '../core/prism-helpers.mjs';
const shape={id:'a',type:'shape',x:100,y:100,w:100,h:40,rotation:30};
test('source rotation normalization and true mirror semantics preserve center',()=>{
 let result=transformElements([shape],['a'],{type:'rotate',by:360})[0];assert.equal(result.rotation,30);
 result=transformElements([shape],['a'],{type:'rotate',degrees:0,by:-90})[0];assert.equal(result.rotation,270);
 const mirrored=transformElements([shape],['a'],{type:'flip',axis:'horizontal'})[0];assert.equal(mirrored.rotation,330);assert.equal(mirrored.flipH,true);
 const restored=transformElements([mirrored],['a'],{type:'flip',axis:'horizontal'})[0];assert.equal(restored.rotation,30);assert.equal(restored.flipH,false);
 assert.equal(shape.rotation,30);assert.equal(mirrored.x,shape.x);
});
test('rotated visual bounds drive selection alignment',()=>{
 const b=elementBounds({...shape,rotation:90});assert.ok(Math.abs(b.x-130)<1e-8);assert.ok(Math.abs(b.y-70)<1e-8);assert.ok(Math.abs(b.w-40)<1e-8);assert.ok(Math.abs(b.h-100)<1e-8);
 const aligned=arrangeElements([{...shape,rotation:90}],['a'],'left')[0];assert.ok(Math.abs(elementBounds(aligned).x)<1e-8);
 const moved=nudgeElements([{...shape,rotation:90}],['a'],-999,-999)[0];assert.ok(Math.abs(elementBounds(moved).x)<1e-8);assert.ok(Math.abs(elementBounds(moved).y)<1e-8);
});
test('rotated corner resize holds opposite visual corner fixed',()=>{
 const result=resizeTransformedElement({...shape,rotation:90},0,20);
 assert.ok(Math.abs(result.w-120)<1e-8);assert.ok(Math.abs(result.h-40)<1e-8);
 assert.ok(Math.abs(result.x-90)<1e-8);assert.ok(Math.abs(result.y-110)<1e-8);
});
test('transform commands reject invalid selections and nonfinite angles',()=>{
 for(const action of [{type:'rotate',by:Infinity},{type:'flip',axis:'bad'},{type:'bad'}])assert.throws(()=>transformElements([shape],['a'],action));
 assert.throws(()=>transformElements([shape],['missing'],{type:'rotate',by:90}));
});
test('PPTX rotation and both flips round-trip for editable objects',async()=>{
 const {createFile}=await import('../core/model.mjs');const {exportDocument,importDocument}=await import('../electron/formats.cjs');
 const file=createFile('prism');file.content.slides[0].elements=[{...shape,rotation:330,flipH:true,flipV:true,fill:'#123456'}];
 const reopened=await importDocument(await exportDocument(file,'pptx'),'pptx','Transformed');const e=reopened.content.slides[0].elements[0];
 assert.equal(e.rotation,330);assert.equal(e.flipH,true);assert.equal(e.flipV,true);assert.ok(Math.abs(e.x-100)<0.01);
});
test('native AI transform command validates and persists revision-bound geometry',async()=>{
 const {createFile,applyCommand,validateFile}=await import('../core/model.mjs');const file=createFile('prism');const slide=file.content.slides[0];slide.elements=[shape];
 const command={type:'transform_slide_elements',baseRevision:0,slideId:slide.id,ids:['a'],transform:{type:'rotate',by:90}};
 assert.equal(applyCommand(file,command).content.slides[0].elements[0].rotation,120);
 const invalid=structuredClone(file);invalid.content.slides[0].elements[0].rotation=Infinity;assert.throws(()=>validateFile(invalid));
});
