// A spreadsheet node as plain text and as an HTML table (copy, Immersive Reader, search, the accessibility check).
// Kept apart from core/slate/lib/sheet.mjs so reading a page does not load the spreadsheet engine. No DOM, no Node built-ins.

const colName = c => String.fromCharCode(65 + c);
/** The text a cell shows: what the engine calculated, else what was typed. */
export const shownAt = (attrs, row, col) => { const ref = `${colName(col)}${row + 1}`; return attrs.shown?.[ref] ?? attrs.cells?.[ref] ?? ''; };

/** Tab-separated rows of what the sheet shows (trailing empty rows and columns left out). */
export function sheetText(attrs) {
  let lastRow = -1, lastCol = -1;
  for (let r = 0; r < attrs.rows; r++) for (let c = 0; c < attrs.cols; c++) if (shownAt(attrs, r, c) !== '') { lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c); }
  const lines = [];
  for (let r = 0; r <= lastRow; r++) { const cells = []; for (let c = 0; c <= lastCol; c++) cells.push(shownAt(attrs, r, c)); lines.push(cells.join('\t')); }
  return lines.join('\n');
}

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** An HTML table of what the sheet shows. */
export function sheetHtml(attrs) {
  const rows = [];
  for (let r = 0; r < attrs.rows; r++) { const cells = []; for (let c = 0; c < attrs.cols; c++) cells.push(`<td>${esc(shownAt(attrs, r, c))}</td>`); rows.push(`<tr>${cells.join('')}</tr>`); }
  return `<table>${rows.join('')}</table>`;
}
