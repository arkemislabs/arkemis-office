// What a saved PDF holds, for the redaction tests that prove text is gone from the bytes: every stream decoded,
// and every hex string (pdf-lib writes text as <hex>) read as text too, so a word hiding in a hex string is found.
import {PDFDocument, PDFStream, PDFRawStream, decodePDFRawStream} from 'pdf-lib';

const hexView = text => [...text.matchAll(/<([0-9a-fA-F\s]+)>/g)].map(m => Buffer.from(m[1].replace(/\s/g, ''), 'hex').toString('latin1')).join('\n');

/** Every decoded stream of a pdf-lib document, plus its hex strings read as text. */
export function everything(doc) {
  const parts = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFStream) {
      try { parts.push(Buffer.from(decodePDFRawStream(o instanceof PDFRawStream ? o : PDFRawStream.of(o.dict, o.getContents())).decode()).toString('latin1')); } catch { /* not decodable here */ }
    }
  }
  const text = parts.join('\n');
  return `${text}\n${hexView(text)}`;
}

/** The same for PDF bytes, raw file text included. */
export async function everythingOfBytes(bytes) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
  const raw = Buffer.from(bytes).toString('latin1');
  return `${everything(doc)}\n${raw}\n${hexView(raw)}`;
}
