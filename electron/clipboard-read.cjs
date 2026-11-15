'use strict';
// What a paste reads from the system clipboard: text, HTML and a copied picture.
//
// A copied picture (a screenshot, "Copy image" in a browser) came through as an empty clipboard: only text and HTML were read, so
// Slate said "The clipboard is empty" and Grid "Nothing to paste". The picture now comes as `picture` (a data URL), and as an <img>
// in `html` when the clipboard has no HTML of its own (or only an <img> pointing at the web, which no app may fetch).

const TEXT_LIMIT = 2 * 1024 * 1024;
const PICTURE_LIMIT = 30 * 1024 * 1024;
const PICTURE_TYPE = /^image\/(png|jpeg|gif|webp)$/;

/** `data` ({text, html}) with `picture` added, and the picture as the HTML when the HTML holds nothing else. */
function withPicture(data, picture) {
  if (!picture) return data;
  const html = data.html || '';
  const onlyPicture = !data.text.trim() && (!html || (/<img\b/i.test(html) && !/<img\b[^>]*\bsrc\s*=\s*["']?data:/i.test(html) && !html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()));
  return {...data, picture, ...(onlyPicture ? {html: `<img src="${picture}" alt="">`} : {})};
}

/**
 * Read the clipboard through Electron's `clipboard` (its async `read()` of items, and `readImage()` for a picture the items don't
 * list). Resolves {text, html, picture?}; text or HTML over 2 MB is refused, a picture over 30 MB is left out.
 */
async function readClipboardData(clipboard) {
  const data = {text: '', html: ''};
  const found = new Set();
  let picture = null;
  for (const item of await clipboard.read()) {
    for (const [mime, key] of [['text/plain', 'text'], ['text/html', 'html']]) {
      if (found.has(key) || !item.types.includes(mime)) continue;
      const blob = await item.getType(mime);
      if (blob.size > TEXT_LIMIT) throw new Error('Clipboard text and HTML must each be strings under 2 MB.');
      data[key] = await blob.text();
      found.add(key);
    }
    const type = !picture && item.types.find(t => PICTURE_TYPE.test(t));
    if (type) {
      const blob = await item.getType(type);
      if (blob.size <= PICTURE_LIMIT) picture = `data:${type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    }
  }
  // Where the async clipboard doesn't list it, the system's own picture (a screenshot tool's copy).
  if (!picture) {
    try {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        if (png.length <= PICTURE_LIMIT) picture = `data:image/png;base64,${png.toString('base64')}`;
      }
    } catch { /* no picture */ }
  }
  return withPicture(data, picture);
}

module.exports = {readClipboardData, withPicture, PICTURE_LIMIT};
