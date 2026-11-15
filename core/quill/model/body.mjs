// The main story's storage: `content.body = {chunks: Block[][]}`. Upstream keeps `body: Blocks`
// (a Vec of Arc-shared blocks). Arkemis chunks it so an edit copies one chunk of at most
// CHUNK_MAX block pointers instead of the whole story (docs/architecture.md section 4.2): the
// chunks concatenated are upstream's body, in order. Chunk boundaries carry no meaning.
// No DOM, no Node built-ins.

/** A chunk is split in two once it holds more than CHUNK_MAX blocks. */
export const CHUNK_MAX = 1024;
/** Chunks made from a block list hold this many blocks. */
export const CHUNK_SIZE = 512;

/** A body from a flat list of blocks. */
export function bodyFromBlocks(blocks) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) chunks.push(blocks.slice(i, i + CHUNK_SIZE));
  if (!chunks.length) chunks.push([]);
  return {chunks};
}

const prefixCache = new WeakMap();
/** Start index of each chunk (cached per immutable chunks array). */
export function chunkStarts(body) {
  let p = prefixCache.get(body.chunks);
  if (p) return p;
  p = new Array(body.chunks.length + 1);
  p[0] = 0;
  for (let i = 0; i < body.chunks.length; i++) p[i + 1] = p[i] + body.chunks[i].length;
  prefixCache.set(body.chunks, p);
  return p;
}

export const bodyLength = body => chunkStarts(body)[body.chunks.length];

/** [chunk index, index in chunk] of global block index `i` (i may equal the length: the end). */
export function locate(starts, nchunks, i) {
  let lo = 0, hi = nchunks - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid; else hi = mid - 1;
  }
  // The last chunk starting at or before `i`: an index inside it, or (at the end) one past it.
  return [lo, i - starts[lo]];
}

export function bodyGet(body, i) {
  const starts = chunkStarts(body);
  if (!Number.isInteger(i) || i < 0 || i >= starts[body.chunks.length]) return undefined;
  const [c, k] = locate(starts, body.chunks.length, i);
  return body.chunks[c][k];
}

export function* bodyIter(body, from = 0) {
  let skip = from;
  for (const chunk of body.chunks) {
    if (skip >= chunk.length) { skip -= chunk.length; continue; }
    for (let k = skip; k < chunk.length; k++) yield chunk[k];
    skip = 0;
  }
}

export const bodyToArray = body => body.chunks.flat();

const indexCache = new WeakMap();
/** Index of top-level block `id` within its chunk (per-chunk Map, cached per chunk array). */
function chunkIndex(chunk) {
  let m = indexCache.get(chunk);
  if (!m) {
    m = new Map();
    for (let k = 0; k < chunk.length; k++) if (chunk[k]?.id) m.set(chunk[k].id, k);
    indexCache.set(chunk, m);
  }
  return m;
}

/** Global index of the top-level block with `id`, or -1. Only for immutable (committed) bodies. */
export function bodyIndexOf(body, id) {
  const starts = chunkStarts(body);
  for (let c = 0; c < body.chunks.length; c++) {
    const k = chunkIndex(body.chunks[c]).get(id);
    if (k !== undefined) return starts[c] + k;
  }
  return -1;
}

const deepCache = new WeakMap();
/** Every id inside a list of blocks (paragraphs, tables, rows, cells, objects, sections), cached. */
export function deepIds(blocks) {
  let s = deepCache.get(blocks);
  if (s) return s;
  s = new Set();
  collectIds(blocks, s);
  deepCache.set(blocks, s);
  return s;
}

/** Add every id inside `blocks` to `out` (no depth limit: the walk keeps its own stack). */
export function collectIds(blocks, out) {
  const stack = [...blocks].reverse();
  while (stack.length) {
    const b = stack.pop();
    if (!b) continue;
    if (b.id) out.add(b.id);
    if (b.kind === 'para') {
      if (b.section?.id) out.add(b.section.id);
      for (const o of b.objects || []) collectObjectIds(o, out);
    } else if (b.kind === 'table') {
      for (const r of b.rows || []) {
        if (r.id) out.add(r.id);
        for (const c of r.cells || []) {
          if (c.id) out.add(c.id);
          for (let i = (c.blocks || []).length - 1; i >= 0; i--) stack.push(c.blocks[i]);
        }
      }
    }
  }
}

function collectObjectIds(o, out) {
  if (!o) return;
  if (o.oid) out.add(o.oid);
  if (o.type === 'group') for (const c of o.children || []) collectObjectIds(c.obj, out);
}
