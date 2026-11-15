// Importing pages of another PDF into the document's source: Insert from File, Paste pages,
// Replace Pages.
//
// Translated from printcraft crates/organize/src/import.rs (import_pages: the pages with what they
// use, their comments and form widgets), crates/organize/src/import/fields.rs
// (resolve_field_conflicts: a top-level field whose fully-qualified name is taken becomes the first
// free `Name-1`, `Name-2`… so it stays its own field; FieldConflicts::Merge keeps names) and
// crates/organize/src/lib.rs (replace_pages: only what the page shows changes — Contents,
// Resources, the boxes and Rotate; the target's links, comments, widgets and bookmarks stay) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// pdf-lib copies the page objects (copyPages); no DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString} from 'pdf-lib';
import {CommandError} from '../../kernel/errors.mjs';

const MAX_DEPTH = 64;

const textOf = v => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null);

/** The AcroForm dictionary of `doc`, created when `create`. */
function acroForm(doc, create) {
  let form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!form && create) {
    form = doc.context.obj({Fields: []});
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(form));
  }
  return form ?? null;
}

/** Fully-qualified names of every field in `doc` (fields.rs taken_field_names). */
function takenNames(doc) {
  const taken = new Set();
  const form = acroForm(doc, false);
  const fields = form?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return taken;
  const seen = new Set();
  const walk = (node, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    const dict = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(dict instanceof PDFDict) || seen.has(dict)) return;
    seen.add(dict);
    const t = textOf(dict.lookup(PDFName.of('T')));
    const full = t === null ? prefix : prefix ? `${prefix}.${t}` : t;
    if (t !== null) taken.add(full);
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (const k of kids.asArray()) walk(k, full, depth + 1);
  };
  for (const f of fields.asArray()) walk(f, '', 0);
  return taken;
}

/** The field roots the widgets on `pages` belong to (follow /Parent to the top). */
function widgetRoots(doc, pages) {
  const roots = [];
  const seen = new Set();
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (const e of annots.asArray()) {
      let node = e instanceof PDFRef ? e : null;
      let dict = node ? doc.context.lookup(node) : e;
      if (!(dict instanceof PDFDict)) continue;
      const sub = dict.lookup(PDFName.of('Subtype'));
      if (!(sub instanceof PDFName) || sub.decodeText() !== 'Widget') continue;
      for (let i = 0; i < MAX_DEPTH; i++) {
        const parent = dict.get(PDFName.of('Parent'));
        if (!(parent instanceof PDFRef)) break;
        const pd = doc.context.lookup(parent);
        if (!(pd instanceof PDFDict)) break;
        node = parent; dict = pd;
      }
      // A widget with no /T anywhere and no parent is a field of its own (merged field/widget).
      const key = node ? `${node.objectNumber} ${node.generationNumber}` : null;
      if (node && !seen.has(key)) { seen.add(key); roots.push(node); }
    }
  }
  return roots;
}

/**
 * Register the form fields of imported pages in `dst`'s AcroForm, renaming colliding top-level
 * names (fields.rs resolve_field_conflicts) unless `conflicts` is 'merge'. Returns the renames.
 */
function registerFields(dst, pages, conflicts) {
  const roots = widgetRoots(dst, pages);
  if (!roots.length) return [];
  const taken = conflicts === 'merge' ? new Set() : takenNames(dst);
  const form = acroForm(dst, true);
  let fields = form.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) { fields = dst.context.obj([]); form.set(PDFName.of('Fields'), fields); }
  const present = new Set(fields.asArray().filter(x => x instanceof PDFRef).map(r => `${r.objectNumber} ${r.generationNumber}`));
  const renamed = [];
  for (const root of roots) {
    const dict = dst.context.lookup(root);
    const t = textOf(dict.lookup(PDFName.of('T')));
    if (t !== null && conflicts !== 'merge') {
      let name = t;
      for (let n = 1; taken.has(name); n++) name = `${t}-${n}`;
      if (name !== t) { dict.set(PDFName.of('T'), PDFHexString.fromText(name)); renamed.push([t, name]); }
      taken.add(name);
    }
    const key = `${root.objectNumber} ${root.generationNumber}`;
    if (!present.has(key)) { fields.push(root); present.add(key); }
  }
  return renamed;
}

/**
 * import.rs import_pages: copies of `srcIndices` of `src` appended to `dst`'s page tree (the
 * model decides where they show). Returns the new source indices and any field renames.
 * @param {'rename'|'merge'} conflicts
 */
export async function importPages(dst, src, srcIndices, {conflicts = 'rename'} = {}) {
  const count = src.getPageCount();
  const bad = srcIndices.find(i => !Number.isInteger(i) || i < 0 || i >= count);
  if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist in that file`, {page: bad});
  const copies = await dst.copyPages(src, srcIndices);
  const start = dst.getPageCount();
  for (const page of copies) dst.addPage(page);
  const renamed = registerFields(dst, copies, conflicts);
  return {indices: copies.map((_, k) => start + k), renamed};
}

const SHOWN = ['Contents', 'Resources', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate'];

/** An inheritable attribute of a page node (Resources, MediaBox, CropBox, Rotate). */
function inherited(node, key) {
  let n = node;
  for (let i = 0; n && i < MAX_DEPTH; i++) {
    const v = n.get(PDFName.of(key));
    if (v !== undefined) return v;
    const parent = n.get(PDFName.of('Parent'));
    n = parent ? n.context.lookup(parent) : null;
    if (!(n instanceof PDFDict)) return undefined;
  }
  return undefined;
}

/**
 * lib.rs replace_pages: the source pages `targets` show what `srcIndices` of `src` show; their
 * links, comments, widgets and bookmarks stay.
 */
export async function replacePageContent(dst, targets, src, srcIndices) {
  if (targets.length !== srcIndices.length || !targets.length) throw new CommandError('invalid_params', `${srcIndices.length} pages can't replace ${targets.length}`);
  const copies = await dst.copyPages(src, srcIndices);
  targets.forEach((t, k) => {
    const target = dst.getPage(t).node;
    const from = copies[k].node;
    for (const key of SHOWN) {
      const v = from.get(PDFName.of(key)) ?? (['Resources', 'MediaBox', 'CropBox', 'Rotate'].includes(key) ? inherited(from, key) : undefined);
      if (v !== undefined) target.set(PDFName.of(key), v);
      else target.delete(PDFName.of(key));
    }
  });
}
