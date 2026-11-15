import test from 'node:test';import assert from 'node:assert/strict';
import {dragPdfOverlay} from '../core/pdf-drag.mjs';
test('annotation dragging moves in PDF coordinates and clamps to the page',()=>{
 const overlay={x:20,y:30,width:100,height:40};const page={width:400,height:500};
 assert.deepEqual(dragPdfOverlay(overlay,page,{x:50,y:50},{x:85,y:35},'move'),{x:55,y:15,width:100,height:40});
 assert.deepEqual(dragPdfOverlay(overlay,page,{x:50,y:50},{x:900,y:-20},'move'),{x:300,y:0,width:100,height:40});
 assert.deepEqual(overlay,{x:20,y:30,width:100,height:40});
});
test('resize remains within page bounds and rejects nonfinite pointer input',()=>{
 const overlay={x:20,y:30,width:100,height:40},page={width:400,height:500};
 assert.deepEqual(dragPdfOverlay(overlay,page,{x:0,y:0},{x:15,y:25},'resize'),{x:20,y:30,width:115,height:65});
 assert.equal(dragPdfOverlay(overlay,page,{x:0,y:0},{x:-500,y:900},'resize').width,8);
 assert.throws(()=>dragPdfOverlay(overlay,page,{x:0,y:0},{x:NaN,y:0},'move'),/coordinate/i);
});
