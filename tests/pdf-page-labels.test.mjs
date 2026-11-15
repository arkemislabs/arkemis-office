import test from 'node:test';
import assert from 'node:assert/strict';
import {romanPdfLabel,alphaPdfLabel,formatPdfLabel,previewPdfLabel,labelAt,validatePdfLabelRanges,longestRomanLength} from '../core/pdf-page-labels.mjs';
test('upstream PDF numeral fixtures',()=>{
 assert.equal(romanPdfLabel(4), 'iv');assert.equal(romanPdfLabel(1994),'mcmxciv');
 for(const [n,label] of [[0,'a'],[1,'a'],[26,'z'],[27,'aa'],[52,'zz'],[53,'aaa']])assert.equal(alphaPdfLabel(n),label);
});
test('upstream bounds checked before repeating hostile u64 values',()=>{
 assert.equal(romanPdfLabel(1024000).length,1024);assert.equal(romanPdfLabel(1024001),null);
 assert.equal(alphaPdfLabel(26*1024).length,1024);assert.equal(alphaPdfLabel(26*1024+1),null);
 assert.equal(romanPdfLabel(4,2),'iv');assert.equal(romanPdfLabel(4,1),null);
 assert.equal(alphaPdfLabel(27,2),'aa');assert.equal(alphaPdfLabel(27,1),null);
 for(const max of [0,1024,Number.MAX_SAFE_INTEGER]){assert.equal(romanPdfLabel(18446744073709551615n,max),null);assert.equal(alphaPdfLabel(18446744073709551615n,max),null);}
});
test('checked style formatting differs intentionally from preview fallback',()=>{
 assert.equal(formatPdfLabel('R',1994),'MCMXCIV');assert.equal(formatPdfLabel('A',27),'AA');assert.equal(formatPdfLabel(null,10),'');
 assert.throws(()=>formatPdfLabel('r',1024001));assert.equal(previewPdfLabel('r',1024001),'1024001');
 assert.throws(()=>formatPdfLabel('D',100,2));assert.throws(()=>formatPdfLabel('bogus',1));
});
test('range lookup applies prefix, physical fallback and u32 overflow guard',()=>{
 const ranges=[{start:0,style:'r',prefix:'',first:1},{start:3,style:'D',prefix:'A-',first:10}];
 assert.equal(labelAt(ranges,0,8),'i');assert.equal(labelAt(ranges,4,8),'A-11');
 assert.equal(labelAt([],4,8),'5');assert.equal(labelAt([{start:0,style:null,prefix:'',first:1}],2,8),'3');
 assert.throws(()=>labelAt([{start:0,style:'D',prefix:'',first:4294967295}],1,8));assert.throws(()=>labelAt(ranges,8,8));
});
test('strict span validation catches internal Roman peak and multibyte prefix limits',()=>{
 const r={start:0,style:'r',prefix:'x'.repeat(1021),first:7};
 assert.throws(()=>validatePdfLabelRanges([r],3)); // vii and ix fit, viii does not.
 assert.throws(()=>validatePdfLabelRanges([{start:0,style:null,prefix:'é'.repeat(513),first:1}],1));
 assert.throws(()=>validatePdfLabelRanges([{start:0,style:'D',prefix:'',first:4294967295}],2));
 assert.throws(()=>validatePdfLabelRanges([{start:0,style:'D',prefix:'',first:1},{start:0,style:'D',prefix:'',first:1}],2));
 const input=[{start:4,style:'A',prefix:'',first:1},{start:0,style:'D',prefix:'',first:1}];assert.equal(validatePdfLabelRanges(input,8)[0].start,0);assert.equal(input[0].start,4);
});
test('optimized Roman span length equals exhaustive small intervals',()=>{
 for(let lo=1;lo<4200;lo+=137){const hi=lo+1301;let expected=0;for(let n=lo;n<=hi;n++)expected=Math.max(expected,romanPdfLabel(n).length);assert.equal(longestRomanLength(lo,hi),expected);}
 assert.ok(longestRomanLength(1,4294967295)>4000000);
});

test('accepted label ranges stay within exported tree aggregate prefix budget',()=>{const ranges=Array.from({length:4097},(_,start)=>({start,style:null,prefix:'x'.repeat(1024),first:1}));assert.throws(()=>validatePdfLabelRanges(ranges,5000),/4 MiB/);assert.equal(validatePdfLabelRanges(ranges.slice(0,4096),5000).length,4096);});
