// Bounds for pdf-lib on untrusted PDFs (security audit H3).
//
// pdf-lib inflates Flate streams (object streams above all) into a buffer that doubles as needed, with no
// ceiling, and decodes them synchronously: a 1 MB file can ask for a gigabyte and block the thread for
// seconds. Importing this module (a side effect, once per realm) puts a ceiling on every decoded stream and
// on the size of a file handed to PDFDocument.load. Both fail with a plain Error, which every caller of
// PDFDocument.load already treats as "this file can't be opened".
// No DOM, no Node built-ins.

import {PDFContext, PDFDocument, PDFName, decodePDFRawStream} from 'pdf-lib';

/** Largest single decoded stream (a content stream, an object stream, an image). */
export const PDF_MAX_STREAM_BYTES = 128 * 1024 * 1024;
/** Most memory all the streams of one PDFDocument.load may grow to together (pdf-lib skips a stream it cannot decode and goes on). */
export const PDF_MAX_LOAD_DECODED_BYTES = 512 * 1024 * 1024;
/** Largest file PDFDocument.load will parse (imports are capped at 30 MB, a document's source at 10 MB). */
export const PDF_MAX_LOAD_BYTES = 32 * 1024 * 1024;

const PATCHED = Symbol.for('arkemis.pdfGuard');
// Loads in flight share the counter; it starts over whenever none is running.
const load_ = {running: 0, decoded: 0};

function decodeStreamPrototype() {
  const ctx = PDFContext.create();
  // An empty zlib stream: just enough to make pdf-lib build its Flate decoder so the shared base class can be reached.
  const raw = ctx.stream(new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), {Filter: PDFName.of('FlateDecode')});
  const decoder = decodePDFRawStream(raw);
  return Object.getPrototypeOf(Object.getPrototypeOf(decoder));
}

function install() {
  const proto = decodeStreamPrototype();
  if (typeof proto?.ensureBuffer !== 'function') throw new Error('pdf-guard: pdf-lib stream internals changed; the decode cap is not installed');
  if (!proto.ensureBuffer[PATCHED]) {
    const original = proto.ensureBuffer;
    const guarded = function ensureBuffer(requested) {
      if (requested > this.buffer.byteLength) {
        // Only what grows while a load is running counts toward the load's total.
        const counting = load_.running > 0;
        if (requested > PDF_MAX_STREAM_BYTES || (counting && load_.decoded > PDF_MAX_LOAD_DECODED_BYTES)) {
          if (counting) load_.decoded += PDF_MAX_STREAM_BYTES;
          throw new Error('This PDF has a stream that expands past the size limit.');
        }
        const before = this.buffer.byteLength;
        const out = original.call(this, requested);
        if (counting) load_.decoded += this.buffer.byteLength - before;
        return out;
      }
      return original.call(this, requested);
    };
    guarded[PATCHED] = true;
    proto.ensureBuffer = guarded;
  }
  const load = PDFDocument.load;
  if (!load[PATCHED]) {
    const bounded = async function load_pdf(pdf, options) {
      const size = typeof pdf === 'string' ? pdf.length : pdf?.byteLength ?? 0;
      if (size > PDF_MAX_LOAD_BYTES) throw new Error('This PDF is too large to open.');
      if (load_.running++ === 0) load_.decoded = 0;
      try {
        const doc = await load.call(this, pdf, options);
        if (load_.decoded > PDF_MAX_LOAD_DECODED_BYTES) throw new Error('This PDF expands past the size limit.');
        return doc;
      } finally { load_.running--; }
    };
    bounded[PATCHED] = true;
    PDFDocument.load = bounded;
  }
}
install();
