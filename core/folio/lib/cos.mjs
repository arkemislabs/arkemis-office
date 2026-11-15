// The JSON form of PDF objects the folio model keeps annotation dictionaries in, so a comment is
// stored as the dictionary printcraft edits (keys it does not understand are left alone) and the
// kernel's path-based changes, undo and anchors work on it.
//
// Translated from the object model of printcraft crates/cos (Object, Dict, PdfString, ObjRef) as
// crates/annot uses it, at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
//   number, boolean, null          the same
//   name /Highlight                '/Highlight'
//   text string                    {$t: 'text'}            (PDFDocEncoding or UTF-16 on write)
//   byte string                    {$x: 'hex'}             (kept byte for byte)
//   array                          [ ... ]
//   dictionary                     {Key: value, ...}       (a key that starts with '$' is stored as '$$...')
//   reference to a source object   {$ref: [num, gen]}      (only valid in the document it came from)
//
// No DOM, no Node built-ins.

export const isName = v => typeof v === 'string' && v.startsWith('/');
export const name = n => `/${n}`;
/** The name's text without the slash, or null. */
export const nameOf = v => (isName(v) ? v.slice(1) : null);
export const text = s => ({$t: String(s)});
export const isText = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$t === 'string';
export const isBytes = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$x === 'string';
export const isRef = v => !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$ref);
export const isDict = v => !!v && typeof v === 'object' && !Array.isArray(v) && !isText(v) && !isBytes(v) && !isRef(v);
export const ref = (num, gen = 0) => ({$ref: [num, gen]});

/** A string object's text (text strings; byte strings read as Latin-1), or a name's text. */
export function textOf(v) {
  if (isText(v)) return v.$t;
  if (isBytes(v)) {
    let s = '';
    for (let i = 0; i + 1 < v.$x.length; i += 2) s += String.fromCharCode(parseInt(v.$x.slice(i, i + 2), 16));
    return s;
  }
  if (isName(v)) return v.slice(1);
  return null;
}

/** `dict[key]` as a finite number, or undefined. */
export function num(d, key) {
  const v = d?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `dict[key]` as an array of numbers (every element a finite number), or null. */
export function nums(d, key) {
  const v = d?.[key];
  if (!Array.isArray(v)) return null;
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return v;
}

/** pdfcraft `Dict::int`: an integer value, or undefined. */
export function int(d, key) {
  const v = d?.[key];
  return Number.isInteger(v) ? v : undefined;
}

/** A name entry's text without the slash (pdfcraft `Dict::name`), or undefined. */
export function nameAt(d, key) {
  const v = d?.[key];
  return isName(v) ? v.slice(1) : undefined;
}

/** A dictionary key as stored in JSON (keys beginning with '$' are escaped). */
export const jsonKey = k => (k.startsWith('$') ? `$${k}` : k);
export const pdfKey = k => (k.startsWith('$$') ? k.slice(1) : k);

/** Deep copy of a JSON object value (dictionaries are immutable in the session; edits copy). */
export const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Encode bytes as the $x hex form. */
export function bytes(u8) {
  let s = '';
  for (const b of u8) s += b.toString(16).padStart(2, '0');
  return {$x: s};
}
