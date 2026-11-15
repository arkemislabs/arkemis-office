// What the rail's Layers, Attachments and Tags panels list, read from the PDF with pdf-lib, and the changes they make.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/layers.rs            set_default_layer_state: /BaseState /ON, /ON the visible layers, /OFF the hidden ones, the rest of the
//                                          configuration (/Order, /RBGroups, /AS) kept; a document without /OCProperties is left alone
//   crates/render (Layer, info.layers)     the layers: the optional content groups, by name, with their initial visibility
//   crates/ui-egui/src/panels/right.rs     the Layers rows (eye, name), the Attachments rows (name, size, "on page n", description), Save attachment,
//                                          delete (only an attachment of the document itself), Attach a file
//   crates/ui-egui/src/tools/tags_ui.rs    the Tags tree: each reachable structure element by its tag, its text and page
// A layer's visibility is written into the document's default configuration, so the page view (which draws what the file says) follows it and the
// change is one undo step. Not translated: the layers' nesting from /Order (a flat list, as upstream's rows are), Reset to Initial Visibility, the
// tags' properties editing. No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFStream, PDFNumber, PDFRawStream, decodePDFRawStream} from 'pdf-lib';

const N = s => PDFName.of(s);
const MAX_ROWS = 5000;
const key = ref => `${ref.objectNumber} ${ref.generationNumber}`;
const refOfKey = k => { const [o, g] = String(k).split(' ').map(Number); return PDFRef.of(o, g ?? 0); };

const textOf = v => {
  if (v instanceof PDFString || v instanceof PDFHexString) { try { return v.decodeText(); } catch { return ''; } }
  if (v instanceof PDFName) return v.decodeText();
  return '';
};
const look = (doc, v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);

// ---- layers ---------------------------------------------------------------------------------

function ocProperties(doc) {
  const p = look(doc, doc.catalog.get(N('OCProperties')));
  return p instanceof PDFDict ? p : null;
}

/** The optional content groups, in the order the file lists them: [{id: "12 0", name, visible}]. */
export function readLayers(doc) {
  const props = ocProperties(doc);
  if (!props) return [];
  const groups = look(doc, props.get(N('OCGs')));
  if (!(groups instanceof PDFArray)) return [];
  const config = look(doc, props.get(N('D')));
  const cfg = config instanceof PDFDict ? config : null;
  const refsIn = name => {
    const a = cfg ? look(doc, cfg.get(N(name))) : null;
    return new Set(a instanceof PDFArray ? a.asArray().filter(x => x instanceof PDFRef).map(key) : []);
  };
  const base = cfg ? look(doc, cfg.get(N('BaseState'))) : null;
  const baseOff = base instanceof PDFName && base.decodeText() === 'OFF';
  const on = refsIn('ON'), off = refsIn('OFF');
  const out = [];
  for (const g of groups.asArray()) {
    if (!(g instanceof PDFRef) || out.length >= MAX_ROWS) continue;
    const d = doc.context.lookup(g);
    if (!(d instanceof PDFDict)) continue;
    const id = key(g);
    const visible = baseOff ? on.has(id) && !off.has(id) : !off.has(id);
    out.push({id, name: textOf(look(doc, d.get(N('Name')))) || `Layer ${out.length + 1}`, visible});
  }
  return out;
}

/** layers.rs `set_default_layer_state`: write `visible` ({id: boolean}) into the default configuration. Returns whether anything was written. */
export function writeLayerState(doc, visible) {
  const props = ocProperties(doc);
  if (!props) return false;
  const layers = readLayers(doc).map(l => ({...l, visible: visible[l.id] ?? l.visible}));
  const refs = on => doc.context.obj(layers.filter(l => l.visible === on).map(l => refOfKey(l.id)));
  const d = look(doc, props.get(N('D')));
  const config = d instanceof PDFDict ? d : doc.context.obj({});
  config.set(N('BaseState'), N('ON'));
  config.set(N('ON'), refs(true));
  config.set(N('OFF'), refs(false));
  props.set(N('D'), config);
  return true;
}

// ---- attachments ----------------------------------------------------------------------------

function* nameTreeFiles(doc, node, depth = 0) {
  const n = look(doc, node);
  if (!(n instanceof PDFDict) || depth > 16) return;
  const names = look(doc, n.get(N('Names')));
  if (names instanceof PDFArray) {
    const a = names.asArray();
    for (let i = 0; i + 1 < a.length; i += 2) yield {name: textOf(look(doc, a[i])), spec: a[i + 1], holder: {node: n, index: i + 1}};
  }
  const kids = look(doc, n.get(N('Kids')));
  if (kids instanceof PDFArray) for (const k of kids.asArray()) yield* nameTreeFiles(doc, k, depth + 1);
}

function fileSpec(doc, spec) {
  const d = look(doc, spec);
  if (!(d instanceof PDFDict)) return null;
  const ef = look(doc, d.get(N('EF')));
  if (!(ef instanceof PDFDict)) return null;
  const streamRef = ef.get(N('UF')) ?? ef.get(N('F'));
  const stream = look(doc, streamRef);
  if (!(stream instanceof PDFStream)) return null;
  const name = textOf(look(doc, d.get(N('UF')))) || textOf(look(doc, d.get(N('F')))) || '';
  const desc = textOf(look(doc, d.get(N('Desc'))));
  const params = look(doc, stream.dict.get(N('Params')));
  const sizeObj = params instanceof PDFDict ? look(doc, params.get(N('Size'))) : null;
  return {name, description: desc || null, stream, size: sizeObj instanceof PDFNumber ? sizeObj.asNumber() : null};
}

/**
 * The attachments: those of the document (the /EmbeddedFiles name tree) and the files comments carry (FileAttachment annotations).
 * @returns {{key: string, name: string, size: number|null, description: string|null, source: {kind: 'document'}|{kind: 'annotation', page: number}}[]}
 */
export function readAttachments(doc) {
  const out = [];
  const names = look(doc, doc.catalog.get(N('Names')));
  const embedded = names instanceof PDFDict ? names.get(N('EmbeddedFiles')) : null;
  if (embedded) for (const e of nameTreeFiles(doc, embedded)) {
    const f = fileSpec(doc, e.spec);
    if (f && out.length < MAX_ROWS) out.push({key: `doc:${e.name}`, name: f.name || e.name, size: f.size ?? f.stream.getContentsSize?.() ?? null, description: f.description, source: {kind: 'document'}});
  }
  doc.getPages().forEach((page, pi) => {
    const annots = look(doc, page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    annots.asArray().forEach((a, ai) => {
      const d = look(doc, a);
      if (!(d instanceof PDFDict)) return;
      const sub = look(doc, d.get(N('Subtype')));
      if (!(sub instanceof PDFName) || sub.decodeText() !== 'FileAttachment') return;
      const f = fileSpec(doc, d.get(N('FS')));
      if (f && out.length < MAX_ROWS) out.push({key: `annot:${pi}:${ai}`, name: f.name || 'attachment', size: f.size ?? null, description: f.description, source: {kind: 'annotation', page: pi}});
    });
  });
  return out;
}

/** The bytes of one attachment, decoded. */
export function attachmentBytes(doc, attachmentKey) {
  let spec = null;
  if (attachmentKey.startsWith('doc:')) {
    const names = look(doc, doc.catalog.get(N('Names')));
    const embedded = names instanceof PDFDict ? names.get(N('EmbeddedFiles')) : null;
    if (embedded) for (const e of nameTreeFiles(doc, embedded)) if (`doc:${e.name}` === attachmentKey) { spec = e.spec; break; }
  } else {
    const m = /^annot:(\d+):(\d+)$/.exec(attachmentKey);
    if (m) {
      const page = doc.getPages()[Number(m[1])];
      const annots = page ? look(doc, page.node.get(N('Annots'))) : null;
      const d = annots instanceof PDFArray ? look(doc, annots.get(Number(m[2]))) : null;
      if (d instanceof PDFDict) spec = d.get(N('FS'));
    }
  }
  const f = spec ? fileSpec(doc, spec) : null;
  if (!f) return null;
  const bytes = f.stream instanceof PDFRawStream ? decodePDFRawStream(f.stream).decode() : f.stream.getContents();
  return {name: f.name || 'attachment', bytes};
}

/** Remove an attachment of the document itself from its name tree (only those can be deleted, as upstream). */
export function removeAttachment(doc, attachmentKey) {
  if (!attachmentKey.startsWith('doc:')) return false;
  const names = look(doc, doc.catalog.get(N('Names')));
  const embedded = names instanceof PDFDict ? names.get(N('EmbeddedFiles')) : null;
  if (!embedded) return false;
  for (const e of nameTreeFiles(doc, embedded)) {
    if (`doc:${e.name}` !== attachmentKey) continue;
    const arr = look(doc, e.holder.node.get(N('Names')));
    const items = [];
    for (let i = 0; i + 1 < arr.size(); i += 2) if (i !== e.holder.index - 1) items.push(arr.get(i), arr.get(i + 1));
    e.holder.node.set(N('Names'), doc.context.obj(items));
    return true;
  }
  return false;
}

// ---- tags -----------------------------------------------------------------------------------

/**
 * The structure tree: [{tag, title, page, children}] for the elements reachable from /StructTreeRoot (at most 5,000 elements, 40 deep).
 * `title` is the element's /Alt or /ActualText or /T.
 */
export function readTags(doc) {
  const rootRef = doc.catalog.get(N('StructTreeRoot'));
  const root = look(doc, rootRef);
  if (!(root instanceof PDFDict)) return [];
  const pageIndex = new Map(doc.getPages().map((p, i) => [key(p.ref), i]));
  let budget = MAX_ROWS;
  const seen = new Set();
  const walk = (node, depth, inheritedPage) => {
    const out = [];
    const items = node instanceof PDFArray ? node.asArray() : [node];
    for (const item of items) {
      if (budget <= 0 || depth > 40) break;
      const ref = item instanceof PDFRef ? item : null;
      if (ref && seen.has(key(ref))) continue;
      const d = look(doc, item);
      if (d instanceof PDFArray) { out.push(...walk(d, depth, inheritedPage)); continue; }
      if (!(d instanceof PDFDict)) continue;
      const type = look(doc, d.get(N('S')));
      if (!(type instanceof PDFName)) { if (d.get(N('K'))) out.push(...walk(look(doc, d.get(N('K'))), depth + 1, inheritedPage)); continue; }
      if (ref) seen.add(key(ref));
      budget--;
      const pg = d.get(N('Pg'));
      const page = pg instanceof PDFRef && pageIndex.has(key(pg)) ? pageIndex.get(key(pg)) : inheritedPage;
      const title = textOf(look(doc, d.get(N('Alt')))) || textOf(look(doc, d.get(N('ActualText')))) || textOf(look(doc, d.get(N('T')))) || null;
      const k = d.get(N('K'));
      out.push({tag: type.decodeText(), title, page: page ?? null, children: k ? walk(look(doc, k), depth + 1, page) : []});
    }
    return out;
  };
  const k = root.get(N('K'));
  return k ? walk(look(doc, k), 0, null) : [];
}
