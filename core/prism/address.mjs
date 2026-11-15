// Prism document addresses (docs/architecture.md 14.4 and the 14.7 resolver contract).
// Foundation-owned (F:prism). No DOM, no Node built-ins.
//
//   /                               the presentation
//   /sl:<slideId>                   slide                     ("slide 3" is accepted and canonicalized)
//   /sl:<id>/sp:<shapeId>           shape; groups nest: /sl:<id>/sp:<groupId>/sp:<childId>
//   /sl:<id>/sp:<id>/t:3-8          text in a shape (UTF-16 over the body text, `\n` between paragraphs)
//   /sl:<id>/sp:<tbl>/r:<i>/c:<j>/t:0-4   table cell text
//   /sl:<id>/notes, /sl:<id>/notes/t:0-12  speaker notes
//   /sl:<id>/anim:<index>, /sl:<id>/transition, /sl:<id>/cmt:<index>
//   /layout:<id>, /layout:<id>/sp:<id>, /master:<id>, /master:<id>/sp:<id>, /sec:<index>, /media:<id>
//
// Schema-1 content (today's documents: `slides[].elements[]` with string text) resolves the same
// slide/shape/text/notes forms; any other path (e.g. `/slides/0/elements`) falls back to the
// kernel's generic JSON resolver, so the slide family's schema-1 reads keep working.

import {CommandError} from '../kernel/errors.mjs';
import {parse as parseGeneric, format as formatGeneric, parseTextRange, assertCodeUnitBoundary, genericResolver, jsonPath} from '../kernel/address.mjs';
import {findShape, shapePath, isGroup, childrenOf, slideTitle, kindName, phType, virtualSlide, virtualTarget} from './model/presentation.mjs';
import {bodyText, posOf, paraText, offsetOf, runContent} from './model/text.mjs';
import {ctxForSlide, xfrm as resolveXfrm, run as resolveRun} from './model/resolve.mjs';

const KINDS = new Set(['sl', 'sp', 't', 'r', 'c', 'notes', 'anim', 'transition', 'cmt', 'layout', 'master', 'sec', 'media']);
const isS2 = c => !!c && Array.isArray(c.masters) && !!c.slideSize;
const notFound = (msg, address) => new CommandError('not_found', msg, address ? {address} : undefined);
const invalid = (msg, address) => new CommandError('invalid_address', msg, address ? {address} : undefined);

/** Parse; `slide 3` style inputs are canonical() business, parse is strict. */
export function parse(input) {
  const ast = parseGeneric(input);
  if (ast.anchor) return ast;
  for (const sg of ast.segments) {
    if (sg.kind === 't') parseTextRange(sg.key);
    if ((sg.kind === 'r' || sg.kind === 'c' || sg.kind === 'anim' || sg.kind === 'cmt' || sg.kind === 'sec') && !/^\d{1,6}$/.test(String(sg.key ?? ''))) {
      throw invalid(`${sg.kind}: takes a 0-based index`, input);
    }
    if ((sg.kind === 'sl' || sg.kind === 'sp' || sg.kind === 'layout' || sg.kind === 'master' || sg.kind === 'media') && !sg.key) throw invalid(`${sg.kind}: takes an id`, input);
  }
  return ast;
}
export const format = ast => formatGeneric(ast);
const isPrismPath = ast => ast.segments?.length > 0 && KINDS.has(ast.segments[0].kind) && ast.segments[0].key !== undefined || ast.segments?.[0]?.kind === 'notes';

// ---------------------------------------------------------------------------------------------
// resolve

/**
 * Resolve an address in `content`. Returns {kind, node, path, slide?, shape?, text?, range?, ...};
 * throws not_found / invalid_address.
 */
export function resolve(content, ast) {
  if (!ast.segments.length) return {kind: 'presentation', node: content, path: []};
  if (!isPrismPath(ast)) return genericResolver.resolve(content, ast);
  const addr = format(ast);
  const segs = ast.segments;
  const head = segs[0];
  if (head.kind === 'sl') {
    const slides = content?.slides ?? [];
    const si = slides.findIndex(s => s.id === head.key);
    if (si < 0) {
      const v = virtualSlide(content, head.key);
      if (v) return resolveInSlide(content, v, virtualTarget(content, head.key).path, segs.slice(1), addr);
      throw notFound(`No slide ${head.key}`, addr);
    }
    return resolveInSlide(content, slides[si], ['slides', si], segs.slice(1), addr);
  }
  if (head.kind === 'layout' || head.kind === 'master') {
    for (let mi = 0; mi < (content?.masters ?? []).length; mi++) {
      const m = content.masters[mi];
      if (head.kind === 'master' && m.id === head.key) return resolveShapes({kind: 'master', node: m, path: ['masters', mi]}, m.shapes, segs.slice(1), addr);
      const li = (m.layouts ?? []).findIndex(l => l.id === head.key);
      if (head.kind === 'layout' && li >= 0) return resolveShapes({kind: 'layout', node: m.layouts[li], path: ['masters', mi, 'layouts', li]}, m.layouts[li].shapes, segs.slice(1), addr);
    }
    throw notFound(`No ${head.kind} ${head.key}`, addr);
  }
  if (head.kind === 'sec') {
    const i = Number(head.key);
    const s = content?.sections?.[i];
    if (!s || segs.length > 1) throw notFound(`No section ${head.key}`, addr);
    return {kind: 'section', node: s, path: ['sections', i]};
  }
  if (head.kind === 'media') {
    const i = (content?.media ?? []).findIndex(m => m.id === head.key);
    if (i < 0 || segs.length > 1) throw notFound(`No media ${head.key}`, addr);
    return {kind: 'media', node: content.media[i], path: ['media', i]};
  }
  throw invalid(`Unexpected segment ${head.kind}`, addr);
}

function resolveShapes(owner, shapes, rest, addr) {
  if (!rest.length) return owner;
  if (rest[0].kind !== 'sp') throw invalid(`Expected sp: after ${owner.kind}`, addr);
  const {node, path} = walkShapes(shapes, owner.path.concat('shapes'), rest, addr);
  return {kind: 'shape', node, path};
}

/** Follow a chain of sp: segments; returns {node, path, chain, rest}. */
function walkShapes(list, basePath, segs, addr) {
  let shapes = list ?? [];
  let path = basePath;
  let node = null;
  const chain = [];
  let k = 0;
  while (k < segs.length && segs[k].kind === 'sp') {
    const i = shapes.findIndex(s => s.id === segs[k].key);
    if (i < 0) throw notFound(`No shape ${segs[k].key}`, addr);
    node = shapes[i];
    path = [...path, i];
    chain.push(node.id);
    k++;
    if (k < segs.length && segs[k].kind === 'sp') {
      if (!isGroup(node)) throw notFound(`Shape ${node.id} is not a group`, addr);
      shapes = node.kind.children;
      path = [...path, 'kind', 'children'];
    }
  }
  return {node, path, chain, rest: segs.slice(k)};
}

function textResult(text, key, extra, addr) {
  const {from, to} = parseTextRange(key);
  if (to > text.length) throw invalid(`Text range ${key} is outside the text (length ${text.length})`, addr);
  assertCodeUnitBoundary(text, from);
  assertCodeUnitBoundary(text, to);
  return {...extra, kind: 'text', range: {from, to}, text: text.slice(from, to), fullText: text};
}

function resolveInSlide(content, sl, slidePathArr, rest, addr) {
  const s2 = isS2(content);
  if (!rest.length) return {kind: 'slide', node: sl, path: slidePathArr, slide: sl.id};
  const k = rest[0].kind;
  if (k === 'notes') {
    const text = s2 ? bodyText(sl.notes) : String(sl.notes ?? '');
    const base = {node: sl.notes, path: [...slidePathArr, 'notes'], slide: sl.id, notes: true};
    if (rest.length === 1) return {...base, kind: 'notes', text};
    if (rest[1].kind === 't' && rest.length === 2) return textResult(text, rest[1].key, base, addr);
    throw invalid('Expected t: after notes', addr);
  }
  if (k === 'transition' && rest.length === 1) return {kind: 'transition', node: sl.transition ?? null, path: [...slidePathArr, 'transition'], slide: sl.id};
  if ((k === 'anim' || k === 'cmt') && rest.length === 1) {
    const field = k === 'anim' ? 'animations' : 'comments';
    const i = Number(rest[0].key);
    const node = sl[field]?.[i];
    if (!node) throw notFound(`No ${k === 'anim' ? 'animation' : 'comment'} ${i} on slide ${sl.id}`, addr);
    return {kind: k === 'anim' ? 'animation' : 'comment', node, path: [...slidePathArr, field, i], slide: sl.id};
  }
  if (k !== 'sp') throw invalid(`Unexpected segment ${k} in a slide address`, addr);
  if (!s2) {
    // Schema 1: one level of elements with a plain `text` string.
    const els = sl.elements ?? [];
    const i = els.findIndex(e => e.id === rest[0].key);
    if (i < 0) throw notFound(`No shape ${rest[0].key}`, addr);
    const base = {node: els[i], path: [...slidePathArr, 'elements', i], slide: sl.id, shape: els[i].id};
    if (rest.length === 1) return {...base, kind: 'shape'};
    if (rest.length === 2 && rest[1].kind === 't') return textResult(String(els[i].text ?? ''), rest[1].key, base, addr);
    throw invalid('Schema-1 shapes hold only text (t:)', addr);
  }
  const {node, path, chain, rest: tail} = walkShapes(sl.shapes, [...slidePathArr, 'shapes'], rest, addr);
  const base = {node, path, slide: sl.id, shape: node.id, chain};
  if (!tail.length) return {...base, kind: 'shape'};
  if (tail[0].kind === 't' && tail.length === 1) return textResult(bodyText(node.text), tail[0].key, {...base, body: node.text}, addr);
  if (tail[0].kind === 'r') {
    if (node.kind?.type !== 'table') throw notFound(`Shape ${node.id} is not a table`, addr);
    const r = Number(tail[0].key);
    if (tail[1]?.kind !== 'c') throw invalid('Expected c: after r:', addr);
    const c = Number(tail[1].key);
    const cell = node.kind.rows?.[r]?.cells?.[c];
    if (!cell) throw notFound(`No cell ${r},${c} in table ${node.id}`, addr);
    const cbase = {...base, node: cell, path: [...path, 'kind', 'rows', r, 'cells', c], cell: [r, c]};
    if (tail.length === 2) return {...cbase, kind: 'cell'};
    if (tail.length === 3 && tail[2].kind === 't') return textResult(bodyText(cell.text), tail[2].key, {...cbase, body: cell.text}, addr);
  }
  throw invalid('Unexpected segments after the shape', addr);
}

// ---------------------------------------------------------------------------------------------
// canonical

/** Friendly forms: `slide 3` (1-based), `slide 3 notes`; anything else must parse. */
export function canonical(content, input) {
  const m = /^\s*slide\s+(\d+)(\s+notes)?\s*$/i.exec(String(input));
  if (m) {
    const sl = content?.slides?.[Number(m[1]) - 1];
    if (!sl) throw notFound(`No slide ${m[1]}`, input);
    return `/sl:${sl.id}${m[2] ? '/notes' : ''}`;
  }
  const ast = parse(input);
  if (ast.anchor) return input;
  if (isPrismPath(ast)) resolve(content, ast);
  return format(ast);
}

// ---------------------------------------------------------------------------------------------
// mapThrough (ids are stable: only removals and text edits move an address)

const startsWith = (a, prefix) => prefix.length <= a.length && prefix.every((k, i) => String(a[i]) === String(k));
/** Where in the address a list sits that an op path can touch: returns {listPath?} via ids. */
function idOf(ast) {
  const segs = ast.segments ?? [];
  const last = [...segs].reverse().find(s => s.kind === 'sp' || s.kind === 'sl');
  return last?.key ?? null;
}
const textSeg = ast => (ast.segments ?? []).findIndex(s => s.kind === 't');
const ownerKey = ast => { const i = textSeg(ast); return i > 0 ? ast.segments[i - 1] : null; };
const objText = o => (o && typeof o === 'object' ? (o.paragraphs ? bodyText(o) : typeof o.text === 'string' ? o.text : o.text?.paragraphs ? bodyText(o.text) : null) : null);

/** Map an offset through a text change from `a` to `b` (common prefix/suffix). */
export function mapOffset(off, a, b) {
  if (a === b) return off;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  const room = Math.min(a.length, b.length) - pre;
  while (suf < room && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (off <= pre) return off;
  if (off >= a.length - suf) return off + (b.length - a.length);
  return b.length - suf;
}

export function mapThrough(op, ast) {
  if (!op || !ast?.segments?.length || !isPrismPath(ast)) return genericResolver.mapThrough(op, ast);
  const id = idOf(ast);
  // A splice that removes the object detaches the address (a move re-inserts it in a later op);
  // one that inserts it again re-attaches it.
  if (op.op === 'splice') {
    const removed = (op.removed ?? []).some(x => x?.id === id);
    const inserted = (op.items ?? []).some(x => x?.id === id);
    if (inserted && ast.detached) { const {detached, ...rest} = ast; return rest; }
    if (removed && !inserted) return {...ast, detached: true};
    return ast;
  }
  // A whole object replaced: same id keeps the address; a text body that changed maps offsets.
  if (op.op === 'set') {
    const v = op.value, o = op.old;
    if (Array.isArray(v) && Array.isArray(o) && o.some(x => x?.id === id)) {
      if (v.some(x => x?.id === id)) return ast;
      return {deleted: true, nearest: parentAst(ast)};
    }
    const ti = textSeg(ast);
    if (ti > 0) {
      const owner = ownerKey(ast);
      const sameOwner = (v?.id !== undefined && v.id === owner.key) || (o?.id !== undefined && o.id === owner.key);
      const lastPath = op.path[op.path.length - 1];
      const isBody = (lastPath === 'text' || lastPath === 'notes') && (v?.paragraphs || o?.paragraphs || typeof v === 'string' || typeof o === 'string');
      if (sameOwner || (isBody && owner.kind === 'notes' && lastPath === 'notes')) {
        const a = typeof o === 'string' ? o : objText(o) ?? '', b = typeof v === 'string' ? v : objText(v) ?? '';
        if (a !== b) return mapTextSeg(ast, ti, a, b);
      }
    }
    if (o && typeof o === 'object' && o.id === id && v && v.id !== id) return {deleted: true, nearest: parentAst(ast)};
    return ast;
  }
  if (op.op === 'delete' && op.old?.id === id) return {deleted: true, nearest: parentAst(ast)};
  return ast;
}

function mapTextSeg(ast, ti, a, b) {
  const {from, to} = parseTextRange(ast.segments[ti].key);
  const nf = Math.min(mapOffset(from, a, b), b.length), nt = Math.min(Math.max(mapOffset(to, a, b), nf), b.length);
  const segs = ast.segments.slice();
  segs[ti] = {kind: 't', key: from === to ? String(nf) : `${nf}-${nt}`};
  return {...ast, segments: segs};
}
function parentAst(ast) {
  const segs = ast.segments.slice();
  while (segs.length && !['sl', 'sp'].includes(segs[segs.length - 1].kind)) segs.pop();
  segs.pop();
  return {segments: segs};
}

// ---------------------------------------------------------------------------------------------
// enumerate / read

const node = (address, kind, extra = {}) => ({address, kind, ...extra});

/** Children of `scope` (depth levels), paged by `cursor` (an index) and `limit`. */
export function enumerate(content, scope, {depth = 1, cursor, limit = 100} = {}) {
  if (!isS2(content) && !(scope.segments?.length && isPrismPath(scope)) && scope.segments?.length) return genericResolver.enumerate(content, scope, {depth, limit});
  const out = [];
  const visit = (addr, r, d) => {
    out.push(describe(content, addr, r));
    if (d >= depth) return;
    for (const [childAddr, child] of childrenOfNode(content, addr, r)) visit(childAddr, child, d + 1);
  };
  const r = resolve(content, scope);
  visit(scope.segments.length ? format(scope) : '/', r, 0);
  const start = cursor ? Number(cursor) || 0 : 0;
  const page = out.slice(start, start + limit);
  return start + limit < out.length ? {nodes: page, cursor: String(start + limit)} : {nodes: page};
}

function childrenOfNode(content, addr, r) {
  const base = addr === '/' ? '' : addr;
  const s2 = isS2(content);
  if (r.kind === 'presentation') {
    const out = (content?.slides ?? []).map((sl, i) => [`/sl:${sl.id}`, {kind: 'slide', node: sl, path: ['slides', i], slide: sl.id}]);
    if (s2) for (const m of content.masters) {
      out.push([`/master:${m.id}`, {kind: 'master', node: m}]);
      for (const l of m.layouts ?? []) out.push([`/layout:${l.id}`, {kind: 'layout', node: l}]);
    }
    (content?.sections ?? []).forEach((s, i) => out.push([`/sec:${i}`, {kind: 'section', node: s}]));
    return out;
  }
  if (r.kind === 'slide') {
    const sl = r.node;
    const shapes = s2 ? sl.shapes ?? [] : sl.elements ?? [];
    const out = shapes.map(sh => [`${base}/sp:${sh.id}`, {kind: 'shape', node: sh, slide: sl.id}]);
    out.push([`${base}/notes`, {kind: 'notes', node: sl.notes, slide: sl.id, text: s2 ? bodyText(sl.notes) : String(sl.notes ?? '')}]);
    return out;
  }
  if ((r.kind === 'master' || r.kind === 'layout') && s2) return (r.node.shapes ?? []).map(sh => [`${base}/sp:${sh.id}`, {kind: 'shape', node: sh}]);
  if (r.kind === 'shape' && isGroup(r.node)) return childrenOf(r.node).map(sh => [`${base}/sp:${sh.id}`, {kind: 'shape', node: sh, slide: r.slide}]);
  if (r.kind === 'shape' && r.node?.kind?.type === 'table') {
    const out = [];
    (r.node.kind.rows ?? []).forEach((row, i) => row.cells.forEach((cell, j) => out.push([`${base}/r:${i}/c:${j}`, {kind: 'cell', node: cell}])));
    return out;
  }
  return [];
}

function describe(content, address, r) {
  const n = r.node;
  if (r.kind === 'presentation') return node(address, 'presentation', {slides: content?.slides?.length ?? 0});
  if (r.kind === 'slide') return node(address, 'slide', {index: content.slides.findIndex(s => s.id === n.id), id: n.id,
    title: isS2(content) ? slideTitle(n) : String((n.elements ?? []).find(e => e.type === 'text')?.text ?? ''), hidden: !!n.hidden});
  if (r.kind === 'shape') {
    const text = isS2(content) ? (n.text ? bodyText(n.text) : null) : typeof n.text === 'string' ? n.text : null;
    return node(address, isS2(content) ? kindName(n) : n.type, {id: n.id, name: n.name ?? '', placeholder: phType(n), ...(text !== null ? {text} : {})});
  }
  if (r.kind === 'notes') return node(address, 'notes', {text: r.text});
  if (r.kind === 'cell') return node(address, 'cell', {text: bodyText(n.text)});
  return node(address, r.kind, {id: n?.id, name: n?.name});
}

/** Read an addressed node: as 'text' | 'runs' | 'props' | 'json' (others read as json). */
export function read(content, ast, as = 'json') {
  const r = resolve(content, ast);
  if (!isPrismPath(ast) || r.kind === 'presentation' && as === 'json') return structuredClone(r.node);
  if (as === 'text') {
    if (r.kind === 'text') return r.text;
    if (r.kind === 'notes') return r.text;
    if (r.kind === 'shape') return isS2(content) ? (r.node.text ? bodyText(r.node.text) : '') : String(r.node.text ?? '');
    if (r.kind === 'cell') return bodyText(r.node.text);
    if (r.kind === 'slide') return isS2(content) ? (r.node.shapes ?? []).map(s => (s.text ? bodyText(s.text) : '')).filter(Boolean).join('\n') : (r.node.elements ?? []).map(e => e.text ?? '').filter(Boolean).join('\n');
    throw new CommandError('invalid_params', `${r.kind} has no text`, {path: '/as'});
  }
  if (as === 'runs') {
    const body = r.kind === 'text' || r.kind === 'shape' || r.kind === 'cell' ? (r.body ?? r.node?.text) : r.kind === 'notes' ? r.node : null;
    if (!body?.paragraphs) throw new CommandError('invalid_params', `${r.kind} has no runs`, {path: '/as'});
    return runsOf(content, r, body);
  }
  if (as === 'props') {
    if (r.kind === 'shape' && isS2(content)) {
      const sl = content.slides.find(s => s.id === r.slide);
      const ctx = sl ? ctxForSlide(content, sl) : null;
      return {id: r.node.id, name: r.node.name, kind: kindName(r.node), placeholder: phType(r.node), xfrm: ctx ? resolveXfrm(ctx, r.node) : r.node.xfrm,
        geom: r.node.geom, fill: r.node.fill, line: r.node.line, hidden: !!r.node.hidden, locked: !!r.node.locked, chain: r.chain};
    }
    return structuredClone(r.node);
  }
  return r.kind === 'text' ? {text: r.text, range: r.range} : structuredClone(r.node ?? null);
}

function runsOf(content, r, body) {
  const sl = isS2(content) ? content.slides.find(s => s.id === r.slide) : null;
  const ctx = sl ? ctxForSlide(content, sl) : null;
  const out = [];
  let off = 0;
  const range = r.kind === 'text' ? r.range : null;
  body.paragraphs.forEach((p, pi) => {
    if (pi > 0) off += 1;
    for (const run of p.runs ?? []) {
      const t = runContent(run);
      const from = off, to = off + t.length;
      off = to;
      if (range && (to <= range.from || from >= range.to) && !(range.from === range.to && from <= range.from && range.from <= to)) continue;
      out.push({paragraph: pi, from, to, text: t, props: run.props ?? {}, resolved: ctx && r.node && r.kind !== 'notes' ? resolveRun(ctx, findOwner(r), p, run.props ?? {}) : undefined});
    }
  });
  return out;
}
const findOwner = r => (r.kind === 'cell' ? {kind: {type: 'table'}, text: r.node.text} : r.node);

/** Addresses that changed (for doc.changed): slide and shape addresses from the op paths. */
export function changed(ops, content) {
  const seen = new Set();
  for (const op of ops) {
    const p = op.path ?? [];
    if (p[0] !== 'slides' || !isS2(content) && !Array.isArray(content?.slides)) { seen.add(p.length ? `/${p[0]}` : '/'); continue; }
    const sl = content.slides?.[p[1]];
    if (p.length <= 2 || !sl) { seen.add('/'); continue; }
    if (p[2] === 'shapes' && isS2(content)) {
      let list = sl.shapes, k = 3, addr = `/sl:${sl.id}`;
      while (k < p.length && Number.isInteger(Number(p[k])) && list?.[p[k]]) {
        const sh = list[p[k]];
        addr += `/sp:${sh.id}`;
        if (p[k + 1] === 'kind' && p[k + 2] === 'children') { list = sh.kind.children; k += 3; } else break;
      }
      seen.add(addr);
    } else if (p[2] === 'notes') seen.add(`/sl:${sl.id}/notes`);
    else seen.add(`/sl:${sl.id}`);
  }
  return [...seen];
}

export {jsonPath, offsetOf, posOf, paraText};
