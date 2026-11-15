import test from 'node:test';
import assert from 'node:assert/strict';
import {Schema} from '@tiptap/pm/model';
import {findTextMatches,pageGeometry,documentStatistics} from '../src/editors/rich-helpers.mjs';
const schema=new Schema({nodes:{doc:{content:'block+'},paragraph:{content:'inline*',group:'block'},text:{group:'inline'}},marks:{bold:{}}});
test('find spans adjacent marked text and keeps ProseMirror selection positions',()=>{
 const doc=schema.node('doc',null,[schema.node('paragraph',null,[schema.text('Hello '),schema.text('world',[schema.mark('bold')]),schema.text(' world')])]);
 assert.deepEqual(findTextMatches(doc,'hello world'),[{from:1,to:12}]);
 assert.deepEqual(findTextMatches(doc,'world'),[{from:7,to:12},{from:13,to:18}]);
 assert.deepEqual(findTextMatches(doc,'HELLO',true),[]);
 assert.deepEqual(findTextMatches(doc,''),[]);
});
test('matches do not cross separate paragraphs',()=>{
 const doc=schema.node('doc',null,[schema.node('paragraph',null,[schema.text('ab')]),schema.node('paragraph',null,[schema.text('cd')])]);
 assert.deepEqual(findTextMatches(doc,'abcd'),[]);
});
test('page dimensions apply orientation and margin presets with safe defaults',()=>{
 assert.deepEqual(pageGeometry({size:'Letter',orientation:'landscape',margins:'narrow'}),{width:279.4,height:215.9,margin:12.7});
 assert.deepEqual(pageGeometry(),{width:210,height:297,margin:25.4});
});
test('document statistics count text separated by blocks',()=>{
 assert.deepEqual(documentStatistics({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'One two'}]},{type:'paragraph',content:[{type:'text',text:'Three'}]}]}),{words:3,characters:12,charactersWithoutSpaces:11,paragraphs:2,readingMinutes:1});
});

