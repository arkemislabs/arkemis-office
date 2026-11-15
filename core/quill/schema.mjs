// Quill schema 2: the content validator, the blank document, and the kernel app-op hook
// (docs/architecture.md sections 4.2 and 18). The content model is upstream's serialized
// `Document` (wordcraft crates/doc at aadb077e072b7de05f724e359d8db82e151f125c), chunked and with
// stable ids; see core/quill/model/README.md. No DOM, no Node built-ins.

import {createContent as blankContent, CONTENT_KEYS, PART_KINDS, isQuill2} from './model/content.mjs';
import {applyOp} from './model/ops.mjs';
import {ID_RE} from './model/ids.mjs';
import {isCharBoundary, OBJ} from './model/text.mjs';
import {MAX_TABLE_DEPTH} from './model/table.mjs';

export const SCHEMA_VERSION = 2;
export {isQuill2};

/** Content for a new document (Document::new: one empty Normal paragraph, Letter, built-in styles). */
export function createContent() {
  return blankContent();
}

/** The kernel's app-op hook: apply a Quill op, returning the new content and the op that undoes it. */
export function apply(content, op) {
  return applyOp(content, op);
}

/** Hard limits on what a stored document may hold (hostile files). */
export const MAX_BLOCKS = 2_000_000;

const fail = msg => { throw new Error(`Invalid Quill document: ${msg}`); };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate schema-2 content (structure, run lengths, object markers, unique ids). Throws an Error
 * naming the first problem. Linear in the document's size.
 */
export function validateContent(content) {
  if (!isObj(content)) fail('content must be an object');
  if (content.doc !== undefined) fail('schema-1 content (doc) in a schema-2 file');
  for (const k of CONTENT_KEYS) if (!(k in content)) fail(`missing ${k}`);
  if (!isObj(content.body) || !Array.isArray(content.body.chunks) || !content.body.chunks.length) fail('body.chunks must be a non-empty array');
  const ids = new Set();
  const useId = (id, what) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) fail(`${what} has no valid id (${JSON.stringify(id)})`);
    if (ids.has(id)) fail(`id ${id} is used twice`);
    ids.add(id);
  };
  let count = 0;
  const checkSection = (s, where) => {
    if (!isObj(s)) fail(`${where}: section must be an object`);
    useId(s.id, `${where} section`);
    for (const k of ['pageW', 'pageH', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight']) if (!isNum(s[k])) fail(`${where}: section ${k} must be a number`);
  };
  const checkObject = (o, where, depth = 0) => {
    if (!isObj(o) || typeof o.type !== 'string') fail(`${where}: inline object without a type`);
    if (o.oid !== undefined) useId(o.oid, `${where} object`);
    if (o.type === 'group') {
      if (!Array.isArray(o.children) || depth > 8) fail(`${where}: bad group`);
      for (const c of o.children) checkObject(c.obj, where, depth + 1);
    }
  };
  const checkBlocks = (blocks, where, depth) => {
    if (!Array.isArray(blocks)) fail(`${where}: blocks must be an array`);
    if (depth > MAX_TABLE_DEPTH + 1) fail(`${where}: tables nest too deep`);
    for (const b of blocks) {
      if (++count > MAX_BLOCKS) fail('too many blocks');
      if (!isObj(b)) fail(`${where}: block must be an object`);
      if (b.kind === 'para') {
        useId(b.id, `${where} paragraph`);
        if (typeof b.text !== 'string') fail(`${where}: paragraph ${b.id} text`);
        if (!Array.isArray(b.runs)) fail(`${where}: paragraph ${b.id} runs`);
        let sum = 0;
        for (const r of b.runs) {
          if (!isObj(r) || !Number.isInteger(r.len) || r.len <= 0) fail(`${where}: paragraph ${b.id} has a bad run`);
          if (r.props !== undefined && !isObj(r.props)) fail(`${where}: paragraph ${b.id} run props`);
          sum += r.len;
          if (!isCharBoundary(b.text, Math.min(sum, b.text.length))) fail(`${where}: paragraph ${b.id} run splits a character`);
        }
        if (sum !== b.text.length) fail(`${where}: paragraph ${b.id} runs cover ${sum} of ${b.text.length} characters`);
        let markers = 0;
        for (let i = b.text.indexOf(OBJ); i >= 0; i = b.text.indexOf(OBJ, i + 1)) markers++;
        const objs = b.objects ?? [];
        if (!Array.isArray(objs) || objs.length !== markers) fail(`${where}: paragraph ${b.id} has ${markers} object markers and ${objs.length} objects`);
        for (const o of objs) checkObject(o, where);
        for (const k of ['props', 'mark']) if (b[k] !== undefined && !isObj(b[k])) fail(`${where}: paragraph ${b.id} ${k}`);
        if (b.section !== undefined) checkSection(b.section, where);
      } else if (b.kind === 'table') {
        useId(b.id, `${where} table`);
        if (!Array.isArray(b.grid) || !b.grid.every(isNum)) fail(`${where}: table ${b.id} grid`);
        if (!Array.isArray(b.rows)) fail(`${where}: table ${b.id} rows`);
        for (const r of b.rows) {
          useId(r?.id, `${where} row`);
          if (!Array.isArray(r.cells)) fail(`${where}: row ${r.id} cells`);
          for (const c of r.cells) {
            useId(c?.id, `${where} cell`);
            if (!Array.isArray(c.blocks) || !c.blocks.length) fail(`${where}: cell ${c.id} must hold blocks`);
            checkBlocks(c.blocks, where, depth + 1);
          }
        }
      } else fail(`${where}: unknown block kind ${JSON.stringify(b.kind)}`);
    }
  };
  for (const chunk of content.body.chunks) checkBlocks(chunk, 'body', 0);
  if (!content.body.chunks.some(c => c.length)) fail('the body holds no block');
  if (!isObj(content.parts)) fail('parts must be an object');
  for (const [k, p] of Object.entries(content.parts)) {
    if (!/^\d{1,10}$/.test(k)) fail(`part id ${k}`);
    if (!isObj(p) || !PART_KINDS.includes(p.kind)) fail(`part ${k} kind`);
    if (!Array.isArray(p.blocks) || !p.blocks.length) fail(`part ${k} must hold blocks`);
    checkBlocks(p.blocks, `part ${k}`, 0);
  }
  checkSection(content.lastSection, 'lastSection');
  if (!isObj(content.styles) || !Array.isArray(content.styles.styles)) fail('styles');
  for (const s of content.styles.styles) if (!isObj(s) || typeof s.id !== 'string' || typeof s.name !== 'string') fail('a style needs an id and a name');
  if (!isObj(content.numbering) || !Array.isArray(content.numbering.abstracts) || !Array.isArray(content.numbering.nums)) fail('numbering');
  if (!isObj(content.comments)) fail('comments');
  for (const [k, c] of Object.entries(content.comments)) if (!/^\d{1,10}$/.test(k) || !isObj(c)) fail(`comment ${k}`);
  for (const k of ['revisions', 'sources', 'customProps', 'glossary']) if (!Array.isArray(content[k])) fail(`${k} must be an array`);
  for (const k of ['settings', 'core', 'footnoteSeparators', 'endnoteSeparators', 'media', 'passthrough']) if (!isObj(content[k])) fail(`${k} must be an object`);
  for (const k of ['media', 'passthrough']) for (const [name, v] of Object.entries(content[k])) if (typeof v !== 'string') fail(`${k} ${name} must be base64`);
  return content;
}
