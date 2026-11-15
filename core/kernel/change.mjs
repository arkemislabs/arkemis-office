// Path-based changes over plain JSON with recorded inverses and structural sharing
// (docs/architecture.md section 4.2). No DOM, no Node built-ins.
//
// A transaction works on the document tree `{...fileMeta, content}`. Commands write through
// `ChangeApi` (paths relative to `content`) and, for file metadata, `setMeta`. Every write copies
// only the objects along its path; objects copied earlier in the same transaction are reused, so
// a command that writes 10,000 cells of one block copies that block once.
//
// Op shapes (paths are relative to the document tree, so content ops start with 'content'):
//   {op:'set',    path, value, old, had}       had: whether the key existed before
//   {op:'delete', path, old}                   object key (arrays use splice)
//   {op:'splice', path, index, remove, items, removed}
//   {op:'app',    path:['content'], forward, inverse}   app-specific op (schema.mjs apply)

import {CommandError} from './errors.mjs';

const META_LOCKED = new Set(['content', 'id', 'schema', 'kind', 'revision', 'createdAt', 'updatedAt']);
const isObj = x => x !== null && typeof x === 'object';

/** Normalize a path: an array of keys, or a string like "/sheets/0/name" or "sheets.0.name". */
export function normPath(path) {
  if (Array.isArray(path)) return path.map(k => (typeof k === 'number' ? k : String(k)));
  if (typeof path !== 'string') throw new CommandError('failed', 'A change path must be an array or a string');
  if (path === '' || path === '/') return [];
  const parts = path.includes('/') ? path.replace(/^\//, '').split('/') : path.split('.');
  return parts.map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const indexKey = (container, key, path, allowEnd = false) => {
  if (!Array.isArray(container)) return key;
  const i = typeof key === 'number' ? key : Number(key);
  if (!Number.isInteger(i) || i < 0 || i > container.length - (allowEnd ? 0 : 1)) {
    throw new CommandError('failed', `Array index ${String(key)} is out of range at /${path.join('/')}`);
  }
  return i;
};

/** Read a value at a path (undefined when absent). */
export function getIn(root, path) {
  let node = root;
  for (const key of normPath(path)) {
    if (!isObj(node)) return undefined;
    node = node[Array.isArray(node) ? Number(key) : key];
  }
  return node;
}

function copyOf(node, owned) {
  if (owned.has(node)) return node;
  const c = Array.isArray(node) ? node.slice() : {...node};
  owned.add(c);
  return c;
}

/** Copy the root and every node along `path` (inclusive), then let `mutate` change the last one. */
function edit(root, path, mutate, owned) {
  if (!isObj(root)) throw new CommandError('failed', 'The document is not an object');
  const top = copyOf(root, owned);
  let node = top;
  for (let i = 0; i < path.length; i++) {
    const key = indexKey(node, path[i], path.slice(0, i + 1));
    const child = node[key];
    if (!isObj(child)) throw new CommandError('failed', `Nothing to change at /${path.slice(0, i + 1).join('/')}`);
    const c = copyOf(child, owned);
    if (c !== child) node[key] = c;
    node = c;
  }
  mutate(node);
  return top;
}

/** Apply one op to a tree, returning the new tree. `owned` holds objects safe to mutate in place. */
export function applyOp(root, op, {owned = new WeakSet(), appApply} = {}) {
  switch (op.op) {
    case 'set': {
      const parent = op.path.slice(0, -1), key = op.path[op.path.length - 1];
      if (!op.path.length) throw new CommandError('failed', 'Cannot replace the whole document tree');
      return edit(root, parent, node => { node[indexKey(node, key, op.path, true)] = op.value; }, owned);
    }
    case 'delete': {
      const parent = op.path.slice(0, -1), key = op.path[op.path.length - 1];
      return edit(root, parent, node => {
        if (Array.isArray(node)) throw new CommandError('failed', 'Use splice to remove array items');
        delete node[key];
      }, owned);
    }
    case 'splice':
      return edit(root, op.path, node => {
        if (!Array.isArray(node)) throw new CommandError('failed', `Not an array at /${op.path.join('/')}`);
        if (!Number.isInteger(op.index) || op.index < 0 || op.index > node.length) throw new CommandError('failed', `Splice index ${op.index} is out of range`);
        node.splice(op.index, op.remove, ...op.items);
      }, owned);
    case 'app': {
      if (typeof appApply !== 'function') throw new CommandError('failed', 'This app has no app-specific operations');
      const {content} = appApply(root.content, op.forward);
      return edit(root, [], node => { node.content = content; }, owned);
    }
    default:
      throw new CommandError('failed', `Unknown change op ${op.op}`);
  }
}

/** Apply a list of ops in order (undo and redo replay). */
export function applyOps(root, ops, opts = {}) {
  const o = {owned: new WeakSet(), ...opts};
  let tree = root;
  for (const op of ops) tree = applyOp(tree, op, o);
  return tree;
}

/** The op that undoes `op`. */
export function invertOp(op) {
  switch (op.op) {
    case 'set': return op.had ? {op: 'set', path: op.path, value: op.old, old: op.value, had: true} : {op: 'delete', path: op.path, old: op.value};
    case 'delete': return {op: 'set', path: op.path, value: op.old, old: undefined, had: false};
    case 'splice': return {op: 'splice', path: op.path, index: op.index, remove: op.items.length, items: op.removed, removed: op.items};
    case 'app': return {op: 'app', path: op.path, forward: op.inverse, inverse: op.forward};
    default: throw new CommandError('failed', `Unknown change op ${op.op}`);
  }
}

/** Inverse list for a forward list (reversed). */
export const invertOps = ops => ops.map(invertOp).reverse();

/** A content-relative view of an op (path without the leading 'content'), for address mapping. */
export function contentOp(op) {
  if (op.path[0] !== 'content') return null;
  return {...op, path: op.path.slice(1)};
}

/**
 * Start a transaction over a document tree. Returns the ChangeApi the command writes through,
 * plus accessors for the current tree and the recorded ops.
 */
export function createTransaction(tree, {appApply, maxOps = 1_000_000} = {}) {
  let current = tree;
  let owned = new WeakSet();
  const ops = [];
  const record = op => {
    if (ops.length >= maxOps) throw new CommandError('too_large', `A command may record at most ${maxOps} changes`);
    // A value placed into the tree may hold nodes this transaction copied (and so may mutate in
    // place) that are also reachable elsewhere: give them up first, so two tree positions never
    // share a mutable node and recorded values never change after the fact. Small values are
    // walked; for a large one it is cheaper to stop reusing every copy.
    if (op.op === 'set') release(op.value);
    else if (op.op === 'splice') op.items.forEach(release);
    current = applyOp(current, op, {owned, appApply});
    ops.push(op);
  };
  const release = value => {
    if (!isObj(value)) return;
    let budget = 512;
    const stack = [value];
    while (stack.length) {
      const node = stack.pop();
      if (--budget < 0) { owned = new WeakSet(); return; }
      owned.delete(node);
      for (const k in node) { const v = node[k]; if (isObj(v)) stack.push(v); }
    }
  };
  const contentPath = path => ['content', ...normPath(path)];
  const api = Object.freeze({
    get(path) { return getIn(current.content, path); },
    set(path, value) {
      if (value === undefined) throw new CommandError('failed', 'Use delete to remove a value');
      const full = contentPath(path);
      if (full.length === 1) {
        record({op: 'set', path: full, value, old: current.content, had: true});
        return;
      }
      const parent = getIn(current, full.slice(0, -1));
      if (!isObj(parent)) throw new CommandError('failed', `Nothing to change at /${full.slice(1, -1).join('/')}`);
      const key = full[full.length - 1];
      const k = Array.isArray(parent) ? indexKey(parent, key, full, true) : key;
      if (Array.isArray(parent) && k === parent.length) { api.splice(full.slice(1, -1), k, 0, value); return; }
      const had = Array.isArray(parent) ? k < parent.length : Object.hasOwn(parent, k);
      const old = had ? parent[k] : undefined;
      if (had && old === value) return;
      record({op: 'set', path: [...full.slice(0, -1), k], value, old, had});
    },
    delete(path) {
      const full = contentPath(path);
      if (full.length === 1) throw new CommandError('failed', 'Cannot delete the document content');
      const parent = getIn(current, full.slice(0, -1));
      const key = full[full.length - 1];
      if (Array.isArray(parent)) { api.splice(full.slice(1, -1), indexKey(parent, key, full), 1); return; }
      if (!isObj(parent) || !Object.hasOwn(parent, key)) return;
      record({op: 'delete', path: full, old: parent[key]});
    },
    splice(path, index, remove, ...items) {
      const full = contentPath(path);
      const arr = getIn(current, full);
      if (!Array.isArray(arr)) throw new CommandError('failed', `Not an array at /${full.slice(1).join('/')}`);
      if (!Number.isInteger(index) || index < 0 || index > arr.length) throw new CommandError('failed', `Splice index ${index} is out of range`);
      const n = Math.max(0, Math.min(Number.isInteger(remove) ? remove : 0, arr.length - index));
      if (!n && !items.length) return;
      record({op: 'splice', path: full, index, remove: n, items, removed: arr.slice(index, index + n)});
    },
    apply(appOp) {
      if (typeof appApply !== 'function') throw new CommandError('failed', 'This app has no app-specific operations');
      const {content, inverse} = appApply(current.content, appOp);
      const op = {op: 'app', path: ['content'], forward: appOp, inverse};
      if (ops.length >= maxOps) throw new CommandError('too_large', `A command may record at most ${maxOps} changes`);
      current = {...current, content};
      owned = new WeakSet();
      ops.push(op);
    },
    setMeta(key, value) {
      if (typeof key !== 'string' || META_LOCKED.has(key)) throw new CommandError('failed', `File field ${key} cannot be changed by a command`);
      const had = Object.hasOwn(current, key);
      const old = current[key];
      if (had && old === value) return;
      if (value === undefined) { if (had) record({op: 'delete', path: [key], old}); return; }
      record({op: 'set', path: [key], value, old, had});
    },
  });
  return {
    api,
    ops,
    get tree() { return current; },
    get content() { return current.content; },
  };
}
