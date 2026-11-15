// The active sheet as a web page (.html): its used range as the HTML table the clipboard copy draws (values as displayed, fonts, colours,
// fills, alignment and merges as inline styles), in a page titled with the sheet's name. Excel's Save As > Web Page (*.htm, *.html).
// Not in gridcraft (its web page export is the Share menu's Export as Web Page, not checked against upstream); built on the
// clipboard's own table writer. U:grid/formats-html. No DOM, no Node built-ins.

import {engineFor} from '../model/calc.mjs';
import {activeSheetIndex} from '../model/sheet.mjs';
import {rangeText, rangeHtml} from '../lib/edit-clip.mjs';

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function write(file) {
  const content = file.content ?? file;
  const si = activeSheetIndex(content);
  const sheet = content.sheets[si];
  const used = engineFor(content).usedRange(si);
  const range = used ? {start: {row: 0, col: 0}, end: used.end} : {start: {row: 0, col: 0}, end: {row: 0, col: 0}};
  const table = rangeHtml(content, si, range, rangeText(content, si, range));
  if (table === null) throw new Error('the sheet is too large to save as a web page; save it as a workbook or CSV instead');
  const title = esc(sheet?.name ?? 'Sheet');
  return new TextEncoder().encode(`<!DOCTYPE html>\r\n<html lang="en">\r\n<head>\r\n<meta charset="utf-8">\r\n<title>${title}</title>\r\n</head>\r\n<body>\r\n${table}\r\n</body>\r\n</html>\r\n`);
}
