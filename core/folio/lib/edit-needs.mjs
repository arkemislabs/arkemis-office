// The catalog's `Needs` for the Edit, Organize, Scan & OCR and Export families, with the reasons
// printcraft's UI gives when a command is unavailable.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt): crates/engine/src/commands.rs:405-440
// (`Needs`, `enabled`: Document, Modification, Assembly, Copying, Marks(kind)) and
// crates/ui-egui/src/commands.rs:116-150 (`disabled_reason`). No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {marksInBytes} from './edit-marks.mjs';

const pagesOf = ctx => (Array.isArray(ctx.doc?.pages) ? ctx.doc.pages : null);
const allowed = (ctx, key) => !(ctx.doc?.permissions && ctx.doc.permissions[key] === false);

export const NO_DOCUMENT = 'Open a document first';
export const SECURITY = "The document's security settings don't allow this change";
export const COPY_REFUSED = "The document's security settings don't allow copying its content";

/** Needs::Document. */
export function documentOpen(ctx) {
  const list = pagesOf(ctx);
  return list && list.length ? {enabled: true} : {enabled: false, reason: NO_DOCUMENT};
}
/** Needs::Modification. */
export function modification(ctx) {
  const o = documentOpen(ctx);
  if (!o.enabled) return o;
  return allowed(ctx, 'modify') ? {enabled: true} : {enabled: false, reason: SECURITY};
}
/** Needs::Assembly. */
export function assembly(ctx) {
  const o = documentOpen(ctx);
  if (!o.enabled) return o;
  return allowed(ctx, 'assemble') && allowed(ctx, 'modify') ? {enabled: true} : {enabled: false, reason: SECURITY};
}
/** Needs::Copying. */
export function copying(ctx) {
  const o = documentOpen(ctx);
  if (!o.enabled) return o;
  return allowed(ctx, 'copy') ? {enabled: true} : {enabled: false, reason: COPY_REFUSED};
}

const KIND_WORD = {HeaderFooter: 'header or footer', Watermark: 'watermark', Background: 'background'};
const cache = new Map();
/** The mark kinds in the document's source (cached per source). */
export function marksOf(content) {
  const b64 = content?.sourceBase64;
  if (typeof b64 !== 'string' || !b64) return [];
  const key = `${b64.length}:${b64.slice(0, 48)}:${b64.slice(-96)}`;
  if (!cache.has(key)) {
    let kinds = [];
    try { kinds = marksInBytes(globalThis.atob(b64)); } catch { kinds = []; }
    cache.set(key, kinds);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
/** Needs::Marks(kind): "This document has no {kind} to change". */
export const marks = kind => ctx => {
  const m = modification(ctx);
  if (!m.enabled) return m;
  return marksOf(ctx.doc).includes(kind) ? {enabled: true} : {enabled: false, reason: `This document has no ${KIND_WORD[kind]} to change`};
};

/** Throw `disabled` with the reason when a state says no. */
export function guard(ctx, state) {
  const st = state(ctx);
  if (!st.enabled) throw new CommandError('disabled', st.reason);
}
