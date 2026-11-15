// Hand-written minimal WordprocessingML fixtures, translated from wordcraft
// crates/docx/tests/it/fixtures.rs (`zip`, `rels`, `docx`, `read_body`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
import JSZip from 'jszip';
import {read} from '../../core/quill/formats/docx-read.mjs';

export const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

export async function zip(entries) {
  const z = new JSZip();
  for (const [name, bytes] of entries) z.file(name, bytes);
  return z.generateAsync({type: 'uint8array'});
}
export function rels(list) {
  let s = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (const [id, ty, target] of list) {
    const ext = target.startsWith('http') ? ' TargetMode="External"' : '';
    s += `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ty}" Target="${target}"${ext}/>`;
  }
  return s + '</Relationships>';
}
/** A package with `body` as the document body and extra [path, content] parts. */
export function docx(body, docRels = [], extra = []) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`;
  return zip([['_rels/.rels', ROOT_RELS], ['word/document.xml', doc], ['word/_rels/document.xml.rels', rels(docRels)], ...extra]);
}
export async function readBody(body, docRels = [], extra = []) { return read(await docx(body, docRels, extra)); }
export const blocksOf = c => c.body.chunks.flat();
export const parasOf = c => blocksOf(c).filter(b => b.kind === 'para');
export async function unzip(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const out = {};
  for (const f of Object.values(z.files)) if (!f.dir) out[f.name] = await f.async('uint8array');
  return out;
}
export const text = (files, name) => new TextDecoder().decode(files[name]);
/** Content without the ids (which a save may re-mint): for "re-reads identically". */
export function withoutIds(c) {
  return JSON.parse(JSON.stringify(c, (k, v) => (k === 'id' && typeof v === 'string' && /^[0-9a-z]{8}$/.test(v) ? undefined : k === 'oid' ? undefined : v)));
}
/** The first path where two JSON values differ (null when equal): for readable failures. */
export function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { const d = firstDiff(a[k], b[k], `${path}/${k}`); if (d) return d; }
  return null;
}
