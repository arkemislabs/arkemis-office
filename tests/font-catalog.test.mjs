import test from 'node:test';import assert from 'node:assert/strict';
test('font catalog retains international family names and rejects malformed data',async()=>{
 const {normalizeFontFamilies,fontFamilyCSS}=await import('../core/font-catalog.mjs');
 assert.deepEqual(normalizeFontFamilies(['Arial','Arial','Noto Sans देवनागरी','',null,'Bad\nFont']),['Arial','Noto Sans देवनागरी']);
 assert.equal(fontFamilyCSS('Noto Sans देवनागरी'),'"Noto Sans देवनागरी"');
 assert.equal(fontFamilyCSS('Bad\nFont'),null);
 assert.equal(fontFamilyCSS('A";color:red;/*'),'"A\\";color:red;/*"');
});
