// The text of a PDF as pdfium reads it (tests only). Not a test file.
import fs from 'node:fs';
import {init} from '@embedpdf/pdfium';

export async function pdfText(bytes) {
  const p = await init({wasmBinary: new Uint8Array(fs.readFileSync(new URL('../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)))});
  p.PDFiumExt_Init();
  const m = p.pdfium, input = m.wasmExports.malloc(bytes.length);
  m.HEAPU8.set(bytes, input);
  const doc = p.FPDF_LoadMemDocument(input, bytes.length, '');
  let all = '';
  try {
    for (let i = 0; i < p.FPDF_GetPageCount(doc); i++) {
      const page = p.FPDF_LoadPage(doc, i), tp = p.FPDFText_LoadPage(page);
      const n = p.FPDFText_CountChars(tp);
      const buf = m.wasmExports.malloc((n + 1) * 2);
      p.FPDFText_GetText(tp, 0, n, buf);
      all += m.UTF16ToString(buf) + '\n';
      m.wasmExports.free(buf); p.FPDFText_ClosePage(tp); p.FPDF_ClosePage(page);
    }
  } finally { p.FPDF_CloseDocument(doc); m.wasmExports.free(input); }
  return all;
}
