// Export a PDF > Spreadsheet (.xlsx), XML 1.0 and PostScript / EPS.
//
// Not checked against upstream: printcraft at 8f16855 has no engine for these (its catalogue plans Spreadsheet and PostScript / EPS, M10, and has no XML), so they follow
// what Acrobat's Export a PDF does:
//   Spreadsheet   each table the page text lays out becomes a sheet of its own (merged cells where a cell spans columns, numbers stored as numbers); a document with no
//                 table puts its paragraphs in one sheet, a row each. The tables are the ones Export to Word detects (lib/export-office.mjs `tables`).
//   XML 1.0       the document as an element tree (document, page, heading, paragraph, table, row, cell) with the page size and number; text only, no tags are read.
//   PostScript    a Level 2 file, one page for each PDF page, each drawn as a JPEG picture the size of the page (`DCTDecode`, ASCII85); Encapsulated PostScript is one page
//                 with a %%BoundingBox. The pages are pictures: the text is not kept as text and the fonts are not embedded.
// No DOM, no Node built-ins (JSZip writes the workbook).

import JSZip from 'jszip';
import {items, esc, allowed} from './export-office.mjs';

// ── Spreadsheet ─────────────────────────────────────────────────────────────────────────────

const colName = n => { let s = ''; for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };
const NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** A cell's text as a number when it reads as one (no leading zeros, no currency or percent sign: those stay text). */
export function numberOf(text) {
  const t = String(text).trim();
  if (!NUMBER.test(t)) return null;
  const plain = t.replace(/,/g, '');
  if (/^[+-]?0\d/.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : null;
}

const cleanText = s => Array.from(String(s)).filter(allowed).join('');
const MAX_SHEET_NAME = 31;
function sheetName(want, used) {
  let base = want.replace(/[\][:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, MAX_SHEET_NAME) || 'Sheet';
  let name = base, k = 2;
  while (used.has(name.toLowerCase())) { const tail = ` (${k++})`; name = base.slice(0, MAX_SHEET_NAME - tail.length) + tail; }
  used.add(name.toLowerCase());
  return name;
}

/** The sheets a document's pages make: [{name, rows: [[{text, bold, span}]]}]. */
export function sheetsOf(pages) {
  const sheets = [];
  const used = new Set();
  let n = 0;
  const paragraphs = [];
  pages.forEach((page, pi) => {
    for (const it of items([page])) {
      if (it.kind === 'table') {
        n++;
        sheets.push({name: sheetName(`Table ${n}`, used), page: pi, rows: it.table.rows.map(row => row.map(c => ({text: c.text, bold: !!c.bold, span: Math.max(1, c.span ?? 1)})))});
      } else if (it.kind === 'para') paragraphs.push({text: it.runs.map(r => r.text).join(''), bold: it.level > 0, page: pi});
    }
  });
  if (!sheets.length) sheets.push({name: sheetName('Text', used), page: 0, rows: paragraphs.map(p => [{text: p.text, bold: p.bold, span: 1}])});
  return sheets;
}

function sheetXml(sheet) {
  let rows = '';
  const merges = [];
  sheet.rows.forEach((row, r) => {
    let col = 0, cells = '';
    for (const c of row) {
      const ref = `${colName(col)}${r + 1}`;
      const num = numberOf(c.text);
      const style = c.bold ? ' s="1"' : '';
      if (c.text.trim() !== '') cells += num !== null ? `<c r="${ref}"${style}><v>${num}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(cleanText(c.text))}</t></is></c>`;
      if (c.span > 1) merges.push(`${ref}:${colName(col + c.span - 1)}${r + 1}`);
      col += c.span;
    }
    rows += `<row r="${r + 1}">${cells}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}</worksheet>`;
}

/** A workbook (.xlsx): the sheets from `sheetsOf`. Resolves to the file's bytes. */
export async function xlsx(pages) {
  const sheets = sheetsOf(pages);
  const zip = new JSZip();
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  zip.file('[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

// ── XML 1.0 ─────────────────────────────────────────────────────────────────────────────────

/** The document as XML: `<document title pages>` with a `<page number width height>` each holding its headings, paragraphs and tables in reading order. */
export function xml(pages, title) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<document title="${esc(title)}" pages="${pages.length}">\n`;
  pages.forEach((page, i) => {
    out += ` <page number="${i + 1}" width="${Math.round(page.width * 100) / 100}" height="${Math.round(page.height * 100) / 100}">\n`;
    for (const it of items([page])) {
      if (it.kind === 'para') out += `  <${it.level > 0 ? `heading level="${it.level}"` : 'paragraph'}>${esc(it.runs.map(r => r.text).join(''))}</${it.level > 0 ? 'heading' : 'paragraph'}>\n`;
      else if (it.kind === 'table') {
        out += '  <table>\n';
        for (const row of it.table.rows) out += `   <row>${row.map(c => `<cell${c.span > 1 ? ` colspan="${c.span}"` : ''}>${esc(c.text)}</cell>`).join('')}</row>\n`;
        out += '  </table>\n';
      }
    }
    out += ' </page>\n';
  });
  return `${out}</document>\n`;
}

// ── PostScript and EPS ──────────────────────────────────────────────────────────────────────

/** ASCII85 (Adobe): the bytes as text lines of 72 characters ending with `~>`. */
export function ascii85(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? bytes[i + k] : 0);
    if (n === 4 && v === 0) { out += 'z'; continue; }
    const d = [];
    for (let k = 0; k < 5; k++) { d.unshift(v % 85); v = Math.floor(v / 85); }
    out += d.slice(0, n + 1).map(x => String.fromCharCode(33 + x)).join('');
  }
  out += '~>';
  return out.replace(/(.{72})/g, '$1\n');
}

const psComment = s => String(s).replace(/[^\x20-\x7e]/g, '?');
const n2 = v => String(Math.round(v * 100) / 100);

/**
 * PostScript Level 2 for pages already drawn as JPEG pictures: [{width, height, jpeg, pixelWidth, pixelHeight}] (width and height in points). `eps` writes one page with a
 * %%BoundingBox (Encapsulated PostScript). Returns the file as bytes (7-bit text).
 */
export function postscript(pages, {title = 'Document', eps = false} = {}) {
  if (!pages.length) throw new Error('there are no pages to write');
  const use = eps ? pages.slice(0, 1) : pages;
  const bw = Math.ceil(Math.max(...use.map(p => p.width))), bh = Math.ceil(Math.max(...use.map(p => p.height)));
  let s = `%!PS-Adobe-3.0${eps ? ' EPSF-3.0' : ''}\n%%Creator: Arkemis PDF\n%%Title: ${psComment(title)}\n%%Pages: ${use.length}\n%%BoundingBox: 0 0 ${bw} ${bh}\n%%DocumentData: Clean7Bit\n%%LanguageLevel: 2\n%%EndComments\n`;
  use.forEach((p, i) => {
    s += `%%Page: ${i + 1} ${i + 1}\n%%PageBoundingBox: 0 0 ${Math.ceil(p.width)} ${Math.ceil(p.height)}\n`;
    if (!eps) s += `<< /PageSize [${n2(p.width)} ${n2(p.height)}] >> setpagedevice\n`;
    s += `gsave\n${n2(p.width)} ${n2(p.height)} scale\n/DeviceRGB setcolorspace\n<< /ImageType 1 /Width ${p.pixelWidth} /Height ${p.pixelHeight} /BitsPerComponent 8 /Decode [0 1 0 1 0 1]\n   /ImageMatrix [${p.pixelWidth} 0 0 -${p.pixelHeight} 0 ${p.pixelHeight}]\n   /DataSource currentfile /ASCII85Decode filter << /ColorTransform 1 >> /DCTDecode filter >> image\n${ascii85(p.jpeg)}\ngrestore\nshowpage\n`;
  });
  return new TextEncoder().encode(`${s}%%EOF\n`);
}
