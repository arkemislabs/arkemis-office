// Quill's foundation model API, handed to every command as `ctx.model` (docs/architecture.md
// sections 4.2 and 5.1). Arkemis glue over the translated wordcraft crates/doc model
// (aadb077e072b7de05f724e359d8db82e151f125c); see README.md in this folder for the types and how
// to iterate stories, blocks and runs. No DOM, no Node built-ins.
//
// A command edits like this:
//
//   run(ctx, p) {
//     return ctx.model.edit(ctx, d => {                 // d: a Document over ctx.doc
//       const [{anchor, focus}] = ctx.model.selection(ctx);
//       d.formatRange(anchor, focus, c => ({...c, bold: true}));
//       return {changed: 1};
//     });
//   }
//
// `edit` commits the Document's single app op through `ctx.change.apply`, so the kernel records
// the forward op and its inverse (the replaced chunks, parts and fields: structural sharing), maps
// sticky anchors through the op's steps and undoes it exactly. A command that throws commits
// nothing.

import {CommandError} from '../../kernel/errors.mjs';
import {Document, BODY} from './document.mjs';
import {isQuill2} from './content.mjs';
import * as address from '../address.mjs';

export {Document, BODY};
// The view a document is saved with and opened in (U:quill/view: w:zoom, w:view).
export {fileForSave, initialView} from '../lib/view-file.mjs';
export * as para from './para.mjs';
export * as props from './props.mjs';
export * as styles from './styles.mjs';
export * as numbering from './numbering.mjs';
export * as numfmt from './numfmt.mjs';
export * as section from './section.mjs';
export * as table from './table.mjs';
export * as text from './text.mjs';
export * as ranges from './ranges.mjs';
export * as content from './content.mjs';
export * as body from './body.mjs';
export * as ids from './ids.mjs';
export * as ops from './ops.mjs';
export * as editing from './edit.mjs';
export * as wrap from './wrap.mjs';
export * as fill from './fill.mjs';
export * as lineDash from './line-dash.mjs';
export * as effects from './effects.mjs';
export * as link from './link.mjs';
export * as symbolFonts from './symbol-fonts.mjs';
export * as localeNumber from './locale-number.mjs';
export * as collate from './collate.mjs';
export * as wordart from './wordart.mjs';
export * as freeform from './freeform.mjs';
export * as connector from './connector.mjs';
export * as geom from '../lib/geom.mjs';
export * as legacyForm from './legacy-form.mjs';
export * as eq from './eq.mjs';
export * as chart from './chart.mjs';
export * as smartArt from './smart-art.mjs';
export * as imeText from './ime-text.mjs';
export * as encoding from './encoding.mjs';
export * as cfbGuard from './cfb-guard.mjs';
export {isQuill2};

const needs2 = () => new CommandError('disabled', 'This document has not been converted to the new Quill format yet');

/** Whether the open document is schema-2 content (commands' state() uses it to disable themselves). */
export const ready = ctx => isQuill2(ctx?.doc);

/** A Document over the command's current content (reads see edits made earlier in the transaction). */
export function open(ctx) {
  if (!isQuill2(ctx?.doc)) throw needs2();
  return new Document(ctx.doc);
}

/** Commit what `d` changed as one app op; returns the op (null when nothing changed). */
export function commit(ctx, d) {
  const op = d.takeOp();
  if (op) ctx.change.apply(op);
  return op;
}

/**
 * Open a Document, let `f(d)` change it, and commit the result as one op. Returns what `f`
 * returns. Throwing commits nothing (the kernel rolls the transaction back).
 */
export function edit(ctx, f) {
  const d = open(ctx);
  const out = f(d);
  if (out && typeof out.then === 'function') throw new CommandError('failed', 'model.edit takes a synchronous function');
  commit(ctx, d);
  return out;
}

/** The selection as positions [{anchor, focus}] (`{story, path, off}`); a document start caret when empty. */
export function selection(ctx) {
  if (!isQuill2(ctx?.doc)) throw needs2();
  const got = address.selectionPositions(ctx.doc, ctx.selection);
  if (got.length) return got;
  const start = new Document(ctx.doc).startOf(BODY);
  return [{anchor: start, focus: start}];
}

/** The primary selection range, ordered: [from, to]. */
export function selectionRange(ctx) {
  const all = selection(ctx);
  const r = all[ctx.selection?.primary ?? 0] ?? all[0];
  return address.cmpPositions(r.anchor, r.focus) <= 0 ? [r.anchor, r.focus] : [r.focus, r.anchor];
}

/** Set the selection from positions (call after the edit, so the addresses name committed ids). */
export function setSelection(ctx, ranges, primary = 0) {
  ctx.setSelection(address.selectionOf(ctx.doc, ranges, primary));
}

/** The [from, to] positions an address covers (a caret gives two equal positions). */
export const range = (ctx, input) => address.rangeOf(ctx.doc, input);
/** The position an address names. */
export const position = (ctx, input) => address.positionOf(ctx.doc, input);
/** The canonical caret address of a position. */
export const addressOf = (ctx, pos) => address.addressOf(ctx.doc, pos);
