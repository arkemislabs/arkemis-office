import test from 'node:test';
import assert from 'node:assert/strict';
import {createPdfRenderQueue} from '../core/pdf-render-queue.mjs';
test('thumbnail rendering never exceeds its concurrency bound',async()=>{
 const queue=createPdfRenderQueue(2);let active=0,maximum=0;const releases=[];
 const tasks=Array.from({length:5},()=>queue(async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>releases.push(resolve));active--;}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(active,2);
 while(releases.length||active){releases.shift()?.();await new Promise(resolve=>setImmediate(resolve));}
 await Promise.all(tasks);assert.equal(maximum,2);
});
test('cancelled offscreen thumbnails never start queued rendering',async()=>{
 const queue=createPdfRenderQueue(1);let release,started=false;const first=queue(()=>new Promise(resolve=>{release=resolve;}));
 const controller=new AbortController(),second=queue(async()=>{started=true;},{signal:controller.signal});controller.abort();
 await assert.rejects(second,{name:'AbortError'});release();await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(started,false);
});
