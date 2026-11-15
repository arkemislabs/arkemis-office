import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangeElements,nudgeElements,resizeImage,layerElements} from '../core/prism-helpers.mjs';
const objects=[{id:'a',x:20,y:20,w:100,h:50},{id:'b',x:250,y:80,w:50,h:100},{id:'c',x:500,y:150,w:100,h:50}];
test('aligns selected objects to selection bounds while retaining others',()=>{const r=arrangeElements(objects,['a','b'],'right');assert.equal(r[0].x,200);assert.equal(r[1].x,250);assert.equal(r[2],objects[2]);assert.equal(objects[0].x,20);});
test('aligns a single object to slide bounds',()=>assert.equal(arrangeElements(objects,['a'],'center')[0].x,430));
test('distribution gives equal gaps and preserves endpoints',()=>{const r=arrangeElements(objects,['a','b','c'],'distribute-x');assert.equal(r[1].x,285);assert.equal(r[0].x,20);assert.equal(r[2].x,500);});
// Adapted from DeckCraft's distribute_wide_middle_stays_in_selection_bounds,
// commit f893f6af7d36a5409fd804e81a34fd895cfefedf, crates/engine/src/tests.rs.
// MIT notice: assets/third-party-licenses/artcraft-reference.txt.
test('distribution uses union bounds when the middle object extends farthest',()=>{
 const source=[[0,10],[20,100],[30,10]].map(([x,w],i)=>({id:String(i),x,y:10,w,h:10}));
 assert.deepEqual(arrangeElements(source,['0','1','2'],'distribute-x').map(e=>e.x),[0,10,110]);
 assert.deepEqual(source.map(e=>e.x),[0,20,30]);
});
test('vertical distribution includes the full height of every selected object',()=>{
 const source=[[0,10],[20,100],[30,10]].map(([y,h],i)=>({id:String(i),x:10,y,w:10,h}));
 const unselected={id:'other',x:0,y:400,w:10,h:20};
 const result=arrangeElements([...source,unselected],['0','1','2'],'distribute-y');
 assert.deepEqual(result.slice(0,3).map(e=>e.y),[0,10,110]);assert.equal(result[3],unselected);
});
test('group nudge clamps at slide boundary without distorting spacing',()=>{const r=nudgeElements(objects,['a','b'],-100,10);assert.equal(r[0].x,0);assert.equal(r[1].x,230);assert.equal(r[1].y,90);});
test('layer operations retain relative selected order',()=>assert.deepEqual(layerElements(objects,['a','c'],'back').map(x=>x.id),['a','c','b']));
test('translated one-step ordering moves a selected block without reversing it',()=>{
 const items=['a','b','c','d','e'].map(id=>({id}));
 assert.deepEqual(layerElements(items,['b','c'],'forward').map(x=>x.id),['a','d','b','c','e']);
 assert.deepEqual(layerElements(items,['c','d'],'backward').map(x=>x.id),['a','c','d','b','e']);
 assert.deepEqual(items.map(x=>x.id),['a','b','c','d','e']);
});
test('one-step ordering respects boundaries, separated selections and no-op identity',()=>{
 const items=['a','b','c','d','e'].map(id=>({id}));
 assert.deepEqual(layerElements(items,['a','c','e'],'forward').map(x=>x.id),['b','a','d','c','e']);
 assert.equal(layerElements(items,['d','e'],'forward'),items);
 assert.equal(layerElements(items,['a','b'],'backward'),items);
 assert.equal(layerElements(items,[],'front'),items);
 assert.throws(()=>layerElements(items,['a'],'unknown'),/direction/);
});
test('image resizing retains ratio and bounds',()=>{const r=resizeImage({x:800,y:400,w:100,h:50},300,200);assert.equal(r.w,160);assert.equal(r.h,80);});

import {samePresentationContent} from '../core/prism-helpers.mjs';
test('presentation history recognizes autosave echoes and navigation as unchanged',()=>{
 const expected={activeSlideId:'a',slides:[{id:'a',notes:'local',background:'#fff',elements:[{id:'x',x:10,y:20}]},{id:'b',notes:'',elements:[]}]};
 const echo={slides:[{elements:[{y:20,x:10,id:'x'}],background:'#fff',notes:'local',id:'a'},{elements:[],notes:'',id:'b'}],activeSlideId:'b'};
 assert.equal(samePresentationContent(expected,echo),true);
 for(const change of [d=>{d.slides[0].notes='external';},d=>{d.slides[0].elements[0].x=50;},d=>{d.slides.reverse();},d=>{d.slides.push({id:'external',elements:[]});}]){const external=structuredClone(expected);change(external);assert.equal(samePresentationContent(expected,external),false);}
});

import {duplicateElements} from '../core/prism-helpers.mjs';
test('duplication near right and bottom edges preserves group spacing',()=>{
 const source=[{id:'a',x:800,y:440,w:100,h:50},{id:'b',x:900,y:490,w:50,h:40}];let i=0;
 const copies=duplicateElements(source,['a','b'],()=>`copy-${++i}`);
 assert.deepEqual(copies.map(e=>[e.x,e.y]),[[810,450],[910,500]]);
 assert.deepEqual(copies.map(e=>e.id),['copy-1','copy-2']);assert.equal(source[0].x,800);
});
