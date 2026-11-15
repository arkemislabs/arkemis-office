// The bridge's document methods over one Session (docs/architecture.md sections 15.3 and 15.4,
// docs/bridge-protocol.md section 3.2). Shared by the renderer (RendererBridge, live Session) and
// the main-process headless host, so both answer identically. No DOM, no Node built-ins.
//
//   const methods = createRpcMethods(session, {manifest, viewAvailable: true});
//   if (methods.has(method)) return methods.call(method, params);
//
// Every command runs with origin 'bridge': params are validated, the approval gate applies and
// edits land on the undo stack as "Automation: <label>".

import {CommandError, toCommandError} from './errors.mjs';
import {s, parse, toJSONSchema} from './schema.mjs';
import {isAnchor} from './address.mjs';

export const DOC_ID_PATTERN = '^[a-zA-Z0-9_-]{1,80}$';
export const READ_LIMIT_BYTES = 8 * 1024 * 1024;
const FIND_NODE_BUDGET = 200_000;
const FIND_TEXT_BUDGET = 64 * 1024 * 1024;
const BINARY_KEYS = new Set(['sourceBase64']);

const doc = s.string({min: 1, max: 80, pattern: DOC_ID_PATTERN, description: 'Document id (from documents.list)'});
const anyObject = s.object({}, {additional: true});
const approval = s.optional(s.object({nonce: s.string({min: 1, max: 200})}));
const address = s.string({min: 1, max: 4096, description: 'Address (/path or @a<n> anchor)'});
const READ_AS = ['text', 'runs', 'props', 'values', 'formulas', 'display', 'json'];

/** Param schemas of the methods this module answers (also used for docs). */
export const METHOD_PARAMS = Object.freeze({
  'engine.commands': s.object({
    search: s.optional(s.string({max: 200})),
    family: s.optional(s.string({max: 200})),
    doc: s.optional(doc),
    kind: s.optional(s.string({max: 20})),
  }),
  'engine.execute': s.object({
    doc: s.optional(s.nullable(doc)),
    command: s.string({min: 1, max: 200}),
    params: s.optional(anyObject),
    baseVersion: s.optional(s.integer({min: 0})),
    dryRun: s.optional(s.boolean()),
    approval,
  }),
  'engine.batch': s.object({
    doc,
    steps: s.array(s.object({command: s.string({min: 1, max: 200}), params: s.optional(anyObject)}), {min: 1, max: 1000}),
    label: s.optional(s.string({max: 200})),
    baseVersion: s.optional(s.integer({min: 0})),
    dryRun: s.optional(s.boolean()),
    approval,
  }),
  'document.inspect': s.object({
    doc,
    address: s.optional(address),
    depth: s.optional(s.integer({min: 0, max: 8})),
    cursor: s.optional(s.string({max: 4096})),
    limit: s.optional(s.integer({min: 1, max: 1000})),
  }),
  'document.read': s.object({doc, address, as: s.optional(s.enum(READ_AS))}),
  'document.find': s.object({
    doc,
    query: s.string({min: 1, max: 1000}),
    scope: s.optional(address),
    regex: s.optional(s.boolean()),
    matchCase: s.optional(s.boolean()),
    wholeWord: s.optional(s.boolean()),
    limit: s.optional(s.integer({min: 1, max: 1000})),
  }),
  'document.anchor': s.object({doc, address}),
  'selection.get': s.object({doc}),
  'selection.set': s.object({
    doc,
    ranges: s.array(s.object({anchor: address, focus: s.optional(address)}), {max: 1000}),
    primary: s.optional(s.integer({min: 0})),
  }),
});

export const RPC_METHODS = Object.freeze(Object.keys(METHOD_PARAMS));

/** Replace large binary payloads (PDF source bytes) in a read result. */
function withholdBinary(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map(v => withholdBinary(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = BINARY_KEYS.has(k) && typeof v === 'string' ? {withheld: 'binary', length: v.length} : withholdBinary(v, depth + 1);
  }
  return out;
}

function assertSize(value, what) {
  let text;
  try { text = JSON.stringify(value); } catch { return; }
  if (text && text.length > READ_LIMIT_BYTES) {
    throw new CommandError('too_large', `${what} is larger than ${READ_LIMIT_BYTES / 1024 / 1024} MB: read a narrower address`, {length: text.length});
  }
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileQuery({query, regex, matchCase, wholeWord}) {
  let source = regex ? query : escapeRe(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, 'g' + (matchCase ? '' : 'i') + 'u');
  } catch (e) {
    throw new CommandError('invalid_params', `query is not a valid regular expression: ${e instanceof Error ? e.message : e}`, {path: '/query'});
  }
}

/** Text search over the string leaves of JSON content (used until an app's address.mjs exports find). */
function genericFind(content, scopePath, scopeAddress, re, limit) {
  const matches = [];
  let nodes = 0, text = 0, truncated = false;
  const start = scopePath.reduce((node, k) => (node == null ? undefined : node[k]), content);
  const walk = (node, path) => {
    if (matches.length >= limit || truncated) return;
    if (++nodes > FIND_NODE_BUDGET) { truncated = true; return; }
    if (typeof node === 'string') {
      text += node.length;
      if (text > FIND_TEXT_BUDGET) { truncated = true; return; }
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(node)) && matches.length < limit) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const from = m.index, to = from + m[0].length;
        const base = path.length ? '/' + path.map(k => String(k).replace(/[%/]/g, c => encodeURIComponent(c))).join('/') : '';
        matches.push({address: `${base}/t:${from}-${to}`, path: base || '/', from, to, text: m[0],
          context: node.slice(Math.max(0, from - 40), Math.min(node.length, to + 40))});
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (BINARY_KEYS.has(k) || k === 'id') continue;
      walk(v, [...path, k]);
      if (matches.length >= limit || truncated) return;
    }
  };
  walk(start, scopePath);
  return {matches, truncated: truncated || matches.length >= limit, scope: scopeAddress};
}

/**
 * @param {import('./session.mjs').Session | any} session
 * @param {{manifest?: {commands?: any[]}, viewAvailable?: boolean}} [opts]
 */
export function createRpcMethods(session, {manifest, viewAvailable = true} = {}) {
  const index = new Map();
  for (const entry of manifest?.commands ?? []) {
    if (entry && (entry.app === session.app || entry.app === undefined)) index.set(entry.id, entry);
  }

  /** A view command (registered here, or only in the renderer per the manifest) asked for where there is no view. */
  const needsWindow = id => !viewAvailable && (session.registry.get(id) ?? index.get(id))?.needs === 'view';
  const windowError = id => new CommandError('unavailable', `${id} needs the document open in a window`, {hint: 'documents.open', command: id});

  const docState = id => session.get(id);
  const canonical = (id, input) => {
    const w = session.where(id, input);
    if (w.deleted) throw new CommandError('not_found', `The content anchor ${input} pointed at was deleted`, {address: input, deleted: true, nearest: w.nearest});
    return w.address;
  };
  const astOf = (id, input) => session.addressing.parse(isAnchor(input) ? canonical(id, input) : input);

  function describeCommand(c, docId) {
    const entry = index.get(c.id);
    const out = {
      id: c.id, label: c.label, family: c.family, description: c.description ?? entry?.description ?? '',
      shortcut: c.shortcut ?? entry?.shortcut ?? null, ribbon: entry?.ribbon ?? [], dialog: c.dialog ?? null,
      params: toJSONSchema(c.params), risk: c.risk, needs: c.needs, undo: c.undo, scope: c.scope,
    };
    if (c.riskFor) out.riskVaries = true;
    if (c.needs === 'view' && !viewAvailable) {
      out.enabled = false; out.disabledReason = 'Needs the document open in a window (documents.open)';
    } else if (docId !== undefined && (c.scope === 'app' || session.docs.has(docId))) {
      const st = session.state(docId, c.id);
      out.enabled = st.enabled !== false;
      if (st.enabled === false && st.reason) out.disabledReason = st.reason;
      if (st.checked !== undefined) out.checked = st.checked;
    }
    return out;
  }

  const handlers = {
    'engine.commands'(p) {
      const commands = session.registry.list({search: p.search, family: p.family}).map(c => describeCommand(c, p.doc));
      if (!viewAvailable) {
        // Commands that only run in a window are listed so clients know they exist.
        const q = (p.search || '').toLowerCase();
        for (const e of index.values()) {
          if (e.needs !== 'view' || session.registry.has(e.id)) continue;
          if (p.family && e.family !== p.family) continue;
          if (q && !`${e.id} ${e.label} ${e.description ?? ''}`.toLowerCase().includes(q)) continue;
          commands.push({id: e.id, label: e.label, family: e.family, description: e.description ?? '', shortcut: e.shortcut ?? null,
            ribbon: e.ribbon ?? [], dialog: e.dialog ?? null, params: e.params, risk: e.risk, needs: 'view', undo: e.undo, scope: e.scope,
            enabled: false, disabledReason: 'Needs the document open in a window (documents.open)'});
        }
        commands.sort((a, b) => a.id.localeCompare(b.id));
      }
      return {app: session.app, commands};
    },

    async 'engine.execute'(p) {
      if (needsWindow(p.command)) throw windowError(p.command);
      return session.execute(p.doc ?? null, p.command, p.params ?? {},
        {origin: 'bridge', baseVersion: p.baseVersion, dryRun: p.dryRun, approval: p.approval});
    },

    async 'engine.batch'(p) {
      p.steps.forEach((step, i) => {
        if (needsWindow(step.command)) {
          const e = windowError(step.command);
          e.data = {...e.data, path: `/steps/${i}/command`};
          throw e;
        }
      });
      return session.batch(p.doc, p.steps, {origin: 'bridge', label: p.label, baseVersion: p.baseVersion, dryRun: p.dryRun, approval: p.approval});
    },

    'document.inspect'(p) {
      const d = docState(p.doc);
      const where = p.address ?? '/';
      const ast = astOf(p.doc, where);
      session.addressing.resolve(d.file.content, ast);
      const page = session.addressing.enumerate(d.file.content, ast, {depth: p.depth ?? 1, cursor: p.cursor, limit: p.limit ?? 100});
      const out = {doc: d.id, kind: d.file.kind, title: d.file.title, version: d.version, address: session.addressing.format(ast),
        nodes: page.nodes};
      if (page.cursor) out.cursor = page.cursor;
      assertSize(out, 'The inspection');
      return out;
    },

    'document.read'(p) {
      const d = docState(p.doc);
      const as = p.as ?? 'json';
      const value = withholdBinary(session.read(p.doc, p.address, as));
      const out = {doc: d.id, version: d.version, address: canonical(p.doc, p.address), as, value};
      assertSize(out, 'The read');
      return out;
    },

    'document.find'(p) {
      const d = docState(p.doc);
      const limit = p.limit ?? 100;
      const scopeAst = astOf(p.doc, p.scope ?? '/');
      const find = session.foundation?.address?.find;
      if (typeof find === 'function') {
        const r = find(d.file.content, {query: p.query, scope: scopeAst, regex: !!p.regex, matchCase: !!p.matchCase, wholeWord: !!p.wholeWord, limit});
        return {doc: d.id, version: d.version, ...r};
      }
      const re = compileQuery(p);
      const scopePath = scopeAst.segments ? scopeAst.segments.map(sg => (sg.key === undefined ? sg.kind : `${sg.kind}:${sg.key}`)) : [];
      return {doc: d.id, version: d.version, ...genericFind(d.file.content, scopePath, session.addressing.format(scopeAst), re, limit)};
    },

    'document.anchor'(p) {
      const anchor = session.anchor(p.doc, p.address);
      return {anchor, address: canonical(p.doc, anchor)};
    },

    'selection.get'(p) {
      const d = docState(p.doc);
      return {doc: d.id, version: d.version, selection: d.selection};
    },

    'selection.set'(p) {
      docState(p.doc);
      for (const [i, r] of p.ranges.entries()) {
        for (const key of ['anchor', 'focus']) {
          if (r[key] === undefined) continue;
          try { astOf(p.doc, r[key]); } catch (e) {
            const ce = toCommandError(e);
            throw new CommandError(ce.code, ce.message, {...(ce.data || {}), path: `/ranges/${i}/${key}`});
          }
        }
      }
      session.setSelection(p.doc, {ranges: p.ranges, primary: p.primary ?? 0}, {origin: 'bridge'});
      const d = docState(p.doc);
      return {doc: d.id, version: d.version, selection: d.selection};
    },
  };

  return Object.freeze({
    methods: RPC_METHODS,
    has: method => Object.hasOwn(handlers, method),
    /** Validate params and run a method. Throws CommandError. */
    async call(method, params) {
      if (!Object.hasOwn(handlers, method)) throw new CommandError('not_found', `Unknown method ${method}`, {method});
      const p = parse(METHOD_PARAMS[method], params ?? {});
      try {
        return await handlers[method](p);
      } catch (e) {
        throw toCommandError(e);
      }
    },
  });
}
