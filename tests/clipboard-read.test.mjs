// The host's clipboard read (electron/clipboard-read.cjs) gives a copied picture to paste: it read only text and HTML, so a
// screenshot or "Copy image" was an empty clipboard in every app. A fake Electron clipboard stands in for the system's.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {readClipboardData, withPicture} = require('../electron/clipboard-read.cjs');

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const blob = (value) => ({size: Buffer.byteLength(value), text: async () => String(value), arrayBuffer: async () => Uint8Array.from(Buffer.isBuffer(value) ? value : Buffer.from(value)).buffer});
const item = (parts) => ({types: Object.keys(parts), getType: async (t) => blob(parts[t])});
const fake = (items, image = null) => ({read: async () => items, readImage: () => image ?? {isEmpty: () => true}});

test('a copied picture (only a picture on the clipboard) comes as `picture` and as the HTML', async () => {
  const got = await readClipboardData(fake([item({'image/png': PNG_BYTES})]));
  assert.equal(got.text, '');
  assert.equal(got.picture, PNG);
  assert.equal(got.html, `<img src="${PNG}" alt="">`, 'apps that read HTML get the picture too');
});

test('"Copy image" in a browser: an <img> pointing at the web plus the picture: the picture wins', async () => {
  const got = await readClipboardData(fake([item({'text/html': '<html><body><!--StartFragment--><img src="https://example.com/cat.png"><!--EndFragment--></body></html>', 'image/png': PNG_BYTES})]));
  assert.equal(got.picture, PNG);
  assert.match(got.html, /^<img src="data:image\/png;base64,/);
});

test('text with a picture keeps its own text and HTML; the picture rides along', async () => {
  const got = await readClipboardData(fake([item({'text/plain': 'Hello', 'text/html': '<p>Hello</p>', 'image/png': PNG_BYTES})]));
  assert.deepEqual([got.text, got.html, got.picture], ['Hello', '<p>Hello</p>', PNG]);
});

test('a screenshot tool\'s picture the async clipboard doesn\'t list is read from the system image', async () => {
  const got = await readClipboardData(fake([], {isEmpty: () => false, toPNG: () => PNG_BYTES}));
  assert.equal(got.picture, PNG);
});

test('plain text alone is unchanged; nothing gives an empty clipboard; oversized text is refused', async () => {
  assert.deepEqual(await readClipboardData(fake([item({'text/plain': 'just text'})])), {text: 'just text', html: ''});
  assert.deepEqual(await readClipboardData(fake([])), {text: '', html: ''});
  await assert.rejects(readClipboardData(fake([item({'text/plain': 'x'.repeat(2 * 1024 * 1024 + 1)})])), /under 2 MB/);
  assert.deepEqual(withPicture({text: 'a', html: ''}, null), {text: 'a', html: ''});
});
