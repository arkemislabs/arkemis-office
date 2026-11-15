import test from 'node:test';import assert from 'node:assert/strict';import {createFile,applyCommand} from '../core/model.mjs';
test('slide text formatting addresses an exact UTF-16 selection and preserves surrounding runs',()=>{
 const file=createFile('prism'),slide=file.content.slides[0],e=slide.elements[0];e.text='Hello 🌎 world';e.runs=[{text:e.text,fontFamily:'Georgia',color:'#123456'}];
 const command={type:'format_slide_text',baseRevision:0,slideId:slide.id,elementId:e.id,from:6,to:8,expectedText:'🌎',formatting:{bold:true,fontSize:36}};
 const next=applyCommand(file,command),runs=next.content.slides[0].elements[0].runs;
 assert.deepEqual(runs.map(r=>r.text),['Hello ','🌎',' world']);assert.equal(runs[1].bold,true);assert.equal(runs[1].color,'#123456');assert.equal(runs[0].bold,undefined);assert.equal(e.runs.length,1);
 for(const edit of [{expectedText:'wrong'},{from:7,to:8,expectedText:'\udf0e'},{elementId:'missing'},{formatting:{fontSize:-4}},{formatting:{unknown:true}},{baseRevision:1}])assert.throws(()=>applyCommand(file,{...command,...edit}));
});
