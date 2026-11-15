import test from 'node:test';import assert from 'node:assert/strict';
import {exportExtensions,extensionLabel} from '../core/file-formats.mjs';
test('only established extensions are exposed, labeled literally',()=>{
 for(const kind of ['quill','grid','prism','slate','folio'])for(const ext of exportExtensions(kind)){assert.equal(extensionLabel(ext),'.'+ext);assert.notEqual(ext,'ark');}
 assert.deepEqual(exportExtensions('prism'),['pptx']);assert.deepEqual(exportExtensions('folio'),['pdf']);assert.throws(()=>exportExtensions('unknown'));
});
