// Address strings: the shared grammar, and dispatch to each app's resolver
// (docs/architecture.md section 14). No DOM, no Node built-ins.
//
//   address  := anchor | path
//   anchor   := "@a" digits
//   path     := ("/" segment)+
//   segment  := kind [":" key]
//   text     := "t:" from ["-" to]      ; UTF-16 code units, to exclusive
//
// Apps provide `core/<app>/address.mjs` (section 14.7). Until a foundation lands, the kernel's
// generic resolver treats each segment as a key of the JSON content (`/sheets/0/name`), which is
// enough for kernel tests and for apps that still run schema 1.

import {CommandError} from './errors.mjs';
import {getIn} from './change.mjs';

export const ADDRESS_GRAMMAR_VERSION = 1;
const MAX_LENGTH = 4096;
const anchorRe = /^@a(\d{1,9})$/;

const invalid = (message, input) => new CommandError('invalid_address', message, input === undefined ? undefined : {address: input});

/** Parse into `{anchor}` or `{segments: [{kind, key?}]}`. Throws invalid_address. */
export function parse(input) {
  if (typeof input !== 'string' || !input.length) throw invalid('An address is a non-empty string', input);
  if (input.length > MAX_LENGTH) throw invalid(`An address has at most ${MAX_LENGTH} characters`, input);
  const a = anchorRe.exec(input);
  if (a) return {anchor: input};
  if (!input.startsWith('/')) throw invalid('An address starts with "/" (or is an anchor like @a12)', input);
  if (input === '/') return {segments: []};
  const segments = input.slice(1).split('/').map(raw => {
    if (!raw) throw invalid('An address has an empty segment', input);
    const i = raw.indexOf(':');
    return i < 0 ? {kind: decode(raw)} : {kind: decode(raw.slice(0, i)), key: decode(raw.slice(i + 1))};
  });
  return {segments};
}

const decode = s => { try { return decodeURIComponent(s); } catch { throw invalid(`Bad escape in address segment ${s}`); } };
const encode = s => String(s).replace(/[%/]/g, c => encodeURIComponent(c));

export function format(ast) {
  if (ast?.anchor) return ast.anchor;
  if (!ast || !Array.isArray(ast.segments)) throw invalid('Not an address');
  if (!ast.segments.length) return '/';
  return ast.segments.map(sg => '/' + encode(sg.kind) + (sg.key === undefined ? '' : ':' + encode(sg.key))).join('');
}

export const isAnchor = input => typeof input === 'string' && anchorRe.test(input);

/** `"4-9"` → {from: 4, to: 9}; `"5"` → {from: 5, to: 5} (a caret). */
export function parseTextRange(key) {
  const m = /^(\d{1,10})(?:-(\d{1,10}))?$/.exec(String(key ?? ''));
  if (!m) throw invalid(`Bad text range ${key} (expected from-to)`);
  const from = Number(m[1]), to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw invalid(`Text range ${key} ends before it starts`);
  return {from, to};
}

/** Throw when a UTF-16 offset would split a surrogate pair (the automation.mjs rule). */
export function assertCodeUnitBoundary(text, offset) {
  if (offset > 0 && offset < text.length) {
    const hi = text.charCodeAt(offset - 1), lo = text.charCodeAt(offset);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      throw invalid(`Offset ${offset} splits a Unicode character`);
    }
  }
  if (offset < 0 || offset > text.length) throw invalid(`Offset ${offset} is outside the text (length ${text.length})`);
}

// ---------------------------------------------------------------------------------------------
// Generic JSON resolver (fallback until an app foundation provides core/<app>/address.mjs)

const segKey = sg => (sg.key === undefined ? sg.kind : `${sg.kind}:${sg.key}`);
export const jsonPath = ast => ast.segments.map(segKey);
const fromPath = path => ({segments: path.map(k => {
  const s = String(k), i = s.indexOf(':');
  return i < 0 ? {kind: s} : {kind: s.slice(0, i), key: s.slice(i + 1)};
})});

const startsWith = (a, prefix) => prefix.length <= a.length && prefix.every((k, i) => String(a[i]) === String(k));

export const genericResolver = Object.freeze({
  parse,
  format,
  resolve(content, ast) {
    const path = jsonPath(ast);
    const node = getIn(content, path);
    if (node === undefined) throw new CommandError('not_found', `Nothing at ${format(ast)}`, {address: format(ast)});
    return {kind: Array.isArray(node) ? 'array' : node === null ? 'null' : typeof node, node, path};
  },
  canonical(content, input) { return format(parse(input)); },
  /** Map an address through a content-relative op (see change.mjs contentOp). */
  mapThrough(op, ast) {
    if (!op || !ast?.segments) return ast;
    const path = jsonPath(ast);
    if (op.op === 'splice') {
      if (!startsWith(path, op.path) || path.length === op.path.length) return ast;
      const at = op.path.length, j = Number(path[at]);
      if (!Number.isInteger(j) || j < op.index) return ast;
      if (j >= op.index + op.remove) {
        const next = path.slice();
        next[at] = String(j + op.items.length - op.remove);
        return fromPath(next);
      }
      const nearest = op.path.slice();
      return {deleted: true, nearest: fromPath(nearest)};
    }
    if (op.op === 'delete') {
      if (startsWith(path, op.path)) return {deleted: true, nearest: fromPath(op.path.slice(0, -1))};
      return ast;
    }
    if (op.op === 'set') {
      if (startsWith(path, op.path) && path.length > op.path.length) {
        if (op.value !== null && typeof op.value === 'object' && getIn(op.value, path.slice(op.path.length)) !== undefined) return ast;
        return {deleted: true, nearest: fromPath(op.path)};
      }
      return ast;
    }
    return ast;
  },
  enumerate(content, scope, {depth = 1, limit = 100} = {}) {
    const nodes = [];
    const walk = (node, path, d) => {
      if (nodes.length >= limit) return;
      nodes.push({address: format(fromPath(path)), kind: Array.isArray(node) ? 'array' : node === null ? 'null' : typeof node});
      if (d >= depth || node === null || typeof node !== 'object') return;
      for (const k of Object.keys(node)) walk(node[k], [...path, k], d + 1);
    };
    walk(getIn(content, jsonPath(scope)), jsonPath(scope), 0);
    return {nodes};
  },
  read(content, ast) { return structuredClone(genericResolver.resolve(content, ast).node); },
});

/**
 * The address functions for an app: the app's resolver where it defines them, the generic one
 * otherwise. `appModule` is the namespace of core/<app>/address.mjs (or undefined).
 */
export function createAddressing(appModule) {
  const m = appModule || {};
  const pick = name => (typeof m[name] === 'function' ? m[name] : genericResolver[name]);
  return Object.freeze({
    generic: !appModule,
    parse: input => (isAnchor(input) ? {anchor: input} : pick('parse')(input)),
    format: ast => (ast?.anchor ? ast.anchor : pick('format')(ast)),
    resolve: pick('resolve'),
    canonical: pick('canonical'),
    mapThrough: pick('mapThrough'),
    enumerate: pick('enumerate'),
    read: pick('read'),
    changed: typeof m.changed === 'function' ? m.changed : null,
  });
}
