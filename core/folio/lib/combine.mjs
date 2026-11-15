// Combine files: read the files of the list (checking each can be combined), and combine them, in order,
// into one PDF with one bookmark per file and, per file, the pages of its range.
//
// Translated from printcraft crates/engine/src/sources.rs (open_source_with, source_document,
// combine_source_check, source_page_count: a file that needs a password, has the wrong one, forbids
// assembling pages, or can't be read is not combined) and crates/engine/src/session/files.rs
// (combine_unlocked_reporting: the page range of each file, "1-3, 6" or all; fields whose names collide
// are renamed, never merged; one bookmark per file titled with its name) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Not translated: the grid view's page cards, duplicate-file warnings and combining a file in several parts.
// No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFHexString, PDFRef} from 'pdf-lib';
import {openPdf, PasswordError} from './protect.mjs';
import {importPages} from './page-import.mjs';
import {looksLikePdf} from './page-source.mjs';
import {parseRanges} from '../commands/page.mjs';

export const MAX_FILES = 1000;

/**
 * Open a file for combining. `problem` is why it cannot be (printcraft SourceProblem): 'password' (needs one),
 * 'wrong-password', 'not-permitted' (its permissions forbid assembling pages), 'unreadable', 'not-pdf'.
 * @returns {Promise<{doc: PDFDocument|null, pages: number, problem: string|null, message: string|null}>}
 */
export async function readSource(bytes, password = '') {
  if (!(bytes instanceof Uint8Array) || !bytes.length || !looksLikePdf(bytes)) return {doc: null, pages: 0, problem: 'not-pdf', message: 'is not a PDF'};
  let opened;
  try { opened = await openPdf(bytes, password ?? ''); } catch (e) {
    if (e instanceof PasswordError) return {doc: null, pages: 0, problem: e.code === 'wrong_password' ? 'wrong-password' : 'password', message: e.code === 'wrong_password' ? 'the password is incorrect' : 'needs a password'};
    return {doc: null, pages: 0, problem: 'unreadable', message: `could not be read: ${e.message}`};
  }
  if (opened.security && !opened.security.owner) {
    const {permissionsOfRecord} = await import('./protect.mjs');
    const p = permissionsOfRecord(opened.security);
    if (p && p.assemble === false) return {doc: null, pages: 0, problem: 'not-permitted', message: "its permissions don't allow combining its pages: enter the permissions password"};
  }
  try {
    const doc = await PDFDocument.load(opened.bytes, {updateMetadata: false, ignoreEncryption: true});
    if (!doc.getPageCount()) return {doc: null, pages: 0, problem: 'unreadable', message: 'has no pages'};
    return {doc, pages: doc.getPageCount(), problem: null, message: null};
  } catch (e) { return {doc: null, pages: 0, problem: 'unreadable', message: `could not be read: ${e.message}`}; }
}

/** One outline item per entry: [{title, pageRef}]. */
function writeOutline(doc, entries) {
  if (!entries.length) return;
  const ctx = doc.context;
  const root = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  entries.forEach((e, i) => {
    const d = ctx.obj({Title: PDFHexString.fromText(e.title), Parent: root, Dest: [e.pageRef, PDFName.of('Fit')]});
    if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < entries.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], d);
  });
  ctx.assign(root, ctx.obj({Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: entries.length}));
  doc.catalog.set(PDFName.of('Outlines'), root);
}

/**
 * Combine `sources` ([{name, bytes, password?, range?}]) in order. A file that cannot be read stops it
 * unless `skipUnreadable`, in which case it is left out. `bookmarks` (default true) writes one bookmark per file; `blankAfterOdd` adds a blank page after a file that
 * adds an odd number of pages (Acrobat's Combine options, not in printcraft: not checked against upstream).
 * @returns {Promise<{bytes: Uint8Array, pages: number, files: number, renamedFields: [string, string][], skipped: string[]}>}
 */
export async function combineFiles(sources, {skipUnreadable = false, bookmarks = true, blankAfterOdd = false} = {}) {
  const out = await PDFDocument.create();
  const entries = [];
  const renamed = [];
  const skipped = [];
  let files = 0;
  for (const s of sources) {
    const r = await readSource(s.bytes, s.password);
    if (!r.doc) {
      if (skipUnreadable) { skipped.push(s.name); continue; }
      const e = new Error(`${s.name} ${r.message}`);
      e.problem = r.problem;
      throw e;
    }
    const range = String(s.range ?? '').trim();
    const indices = range ? parseRanges(range, r.pages) : Array.from({length: r.pages}, (_, i) => i);
    if (!indices.length) throw new Error(`${s.name}: no pages in the range`);
    const first = out.getPageCount();
    const res = await importPages(out, r.doc, indices, {conflicts: 'rename'});
    renamed.push(...res.renamed);
    entries.push({title: s.name.replace(/\.pdf$/i, ''), pageRef: out.getPage(first).ref});
    if (blankAfterOdd && indices.length % 2 === 1) { const last = out.getPage(out.getPageCount() - 1); const {width, height} = last.getSize(); out.addPage([width, height]); }
    files++;
  }
  if (!files) throw new Error('There are no files to combine.');
  if (bookmarks) writeOutline(out, entries);
  out.setProducer('Arkemis PDF');
  const bytes = await out.save({updateFieldAppearances: false});
  return {bytes, pages: out.getPageCount(), files, renamedFields: renamed, skipped};
}

export {PDFRef};
