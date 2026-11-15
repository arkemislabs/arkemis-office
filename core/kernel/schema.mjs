// `s`: a tiny parameter validator whose schemas double as JSON Schema
// (docs/architecture.md sections 5.1 and 15.3). No DOM, no Node built-ins.
//
//   const params = s.object({range: s.optional(s.address('range')), value: s.optional(s.boolean())});
//   validate(params, {value: true})   -> {ok: true, value: {value: true}}
//   toJSONSchema(params)              -> {type: 'object', properties: {...}, additionalProperties: false}
//
// Schemas are frozen plain objects tagged with SCHEMA, so they can be inspected, compared and
// serialized by the generator.

import {CommandError} from './errors.mjs';

export const SCHEMA = Symbol.for('arkemis.schema');

const make = (type, opts = {}, extra = {}) => Object.freeze({[SCHEMA]: true, type, ...extra, ...clean(opts)});
const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
export const isSchema = x => !!x && typeof x === 'object' && x[SCHEMA] === true;

const ADDRESS_MAX = 4096;
const anchorRe = /^@a\d{1,9}$/;

export const s = Object.freeze({
  /** @param {{min?: number, max?: number, pattern?: string, description?: string, trim?: boolean}} [o] */
  string: o => make('string', o),
  /** A string that is never journaled or echoed (passwords). */
  secret: o => make('string', o, {secret: true}),
  /** @param {{min?: number, max?: number, integer?: boolean, description?: string}} [o] */
  number: o => make('number', o),
  integer: o => make('number', {...o, integer: true}),
  boolean: o => make('boolean', o),
  literal: (value, o) => make('literal', o, {value}),
  enum: (values, o) => {
    if (!Array.isArray(values) || !values.length) throw new TypeError('s.enum needs a non-empty array');
    return make('enum', o, {values: Object.freeze([...values])});
  },
  array: (items, o) => { assertSchema(items, 's.array'); return make('array', o, {items}); },
  object: (properties = {}, o) => {
    for (const [k, v] of Object.entries(properties)) assertSchema(v, `s.object property ${k}`);
    if (o?.additional && o.additional !== true) assertSchema(o.additional, 's.object additional');
    return make('object', o, {properties: Object.freeze({...properties})});
  },
  record: (values, o) => { assertSchema(values, 's.record'); return make('record', o, {values}); },
  union: (options, o) => {
    if (!Array.isArray(options) || !options.length) throw new TypeError('s.union needs options');
    options.forEach((x, i) => assertSchema(x, `s.union option ${i}`));
    return make('union', o, {options: Object.freeze([...options])});
  },
  optional: (inner, defaultValue) => {
    assertSchema(inner, 's.optional');
    return Object.freeze({...inner, optional: true, ...(defaultValue === undefined ? {} : {default: defaultValue})});
  },
  nullable: inner => { assertSchema(inner, 's.nullable'); return Object.freeze({...inner, nullable: true}); },
  /** A document address (anchor `@a12` or path `/sh:k3f/B7`, or a friendly form the resolver canonicalizes). */
  address: (kind, o) => make('address', o, kind ? {kind} : {}),
  /** `#RRGGBB`, `RRGGBB`, `#RRGGBBAA`, `auto` or `none`. */
  color: o => make('color', o),
  any: o => make('any', o),
  describe: (inner, description) => { assertSchema(inner, 's.describe'); return Object.freeze({...inner, description}); },
});

function assertSchema(x, where) {
  if (!isSchema(x)) throw new TypeError(`${where}: expected a schema built with s.*`);
}

const ptr = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const colorRe = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function check(schema, value, path, errors, opts) {
  if (value === undefined) {
    if (schema.optional) return schema.default === undefined ? undefined : structuredClone(schema.default);
    errors.push({path, message: 'is required'});
    return undefined;
  }
  if (value === null && schema.nullable) return null;
  switch (schema.type) {
    case 'any': return value;
    case 'string': {
      if (typeof value !== 'string') { errors.push({path, message: `must be a string, got ${kindOf(value)}`}); return value; }
      const v = schema.trim ? value.trim() : value;
      if (schema.min !== undefined && v.length < schema.min) errors.push({path, message: schema.min === 1 ? 'must not be empty' : `must have at least ${schema.min} characters`});
      if (schema.max !== undefined && v.length > schema.max) errors.push({path, message: `must have at most ${schema.max} characters`});
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) errors.push({path, message: `must match ${schema.pattern}`});
      return v;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push({path, message: `must be a finite number, got ${kindOf(value)}`}); return value; }
      if (schema.integer && !Number.isInteger(value)) errors.push({path, message: 'must be a whole number'});
      if (schema.min !== undefined && value < schema.min) errors.push({path, message: `must be at least ${schema.min}`});
      if (schema.max !== undefined && value > schema.max) errors.push({path, message: `must be at most ${schema.max}`});
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push({path, message: `must be true or false, got ${kindOf(value)}`});
      return value;
    case 'literal':
      if (value !== schema.value) errors.push({path, message: `must be ${JSON.stringify(schema.value)}`});
      return value;
    case 'enum':
      if (!schema.values.includes(value)) errors.push({path, message: `must be one of ${schema.values.map(v => JSON.stringify(v)).join(', ')}`});
      return value;
    case 'color':
      if (typeof value !== 'string' || !(colorRe.test(value) || value === 'auto' || value === 'none')) errors.push({path, message: 'must be a color like #1F6FEB, "auto" or "none"'});
      return value;
    case 'address':
      if (typeof value !== 'string' || !value.trim() || value.length > ADDRESS_MAX) { errors.push({path, message: 'must be an address string'}); return value; }
      if (value.startsWith('@') && !anchorRe.test(value)) errors.push({path, message: 'is not a valid anchor (expected @a<number>)'});
      return value;
    case 'array': {
      if (!Array.isArray(value)) { errors.push({path, message: `must be an array, got ${kindOf(value)}`}); return value; }
      if (schema.min !== undefined && value.length < schema.min) errors.push({path, message: `must have at least ${schema.min} items`});
      if (schema.max !== undefined && value.length > schema.max) { errors.push({path, message: `must have at most ${schema.max} items`}); return value; }
      return value.map((v, i) => check(schema.items, v, ptr(path, i), errors, opts));
    }
    case 'record': {
      if (kindOf(value) !== 'object') { errors.push({path, message: `must be an object, got ${kindOf(value)}`}); return value; }
      const keys = Object.keys(value);
      if (schema.max !== undefined && keys.length > schema.max) { errors.push({path, message: `must have at most ${schema.max} entries`}); return value; }
      const out = {};
      for (const k of keys) out[k] = check(schema.values, value[k], ptr(path, k), errors, opts);
      return out;
    }
    case 'object': {
      if (kindOf(value) !== 'object') { errors.push({path, message: `must be an object, got ${kindOf(value)}`}); return value; }
      const out = {};
      const partial = opts.partial && path === '';
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (partial && value[k] === undefined) continue;
        const v = check(sub, value[k], ptr(path, k), errors, opts);
        if (v !== undefined) out[k] = v;
      }
      for (const k of Object.keys(value)) {
        if (Object.hasOwn(schema.properties, k)) continue;
        if (schema.additional === true) out[k] = value[k];
        else if (isSchema(schema.additional)) out[k] = check(schema.additional, value[k], ptr(path, k), errors, opts);
        else errors.push({path: ptr(path, k), message: 'is not a known parameter'});
      }
      return out;
    }
    case 'union': {
      let best = null;
      for (const option of schema.options) {
        const errs = [];
        const v = check({...option, optional: false}, value, path, errs, opts);
        if (!errs.length) return v;
        if (!best || errs.length < best.length) best = errs;
      }
      errors.push(...(best || [{path, message: 'does not match any allowed form'}]));
      return value;
    }
    default:
      errors.push({path, message: `unknown schema type ${schema.type}`});
      return value;
  }
}

/**
 * Validate and normalize a value (defaults filled in, strings trimmed where asked).
 * `partial: true` accepts a top-level object with required properties missing (spec control
 * `args` are partial params).
 */
export function validate(schema, value, opts = {}) {
  assertSchema(schema, 'validate');
  const errors = [];
  const out = check(schema, value, '', errors, opts);
  return errors.length ? {ok: false, errors} : {ok: true, value: out};
}

/** Validate or throw `invalid_params` whose data carries the JSON-Schema path of the first error. */
export function parse(schema, value, opts) {
  const r = validate(schema, value, opts);
  if (r.ok) return r.value;
  const first = r.errors[0];
  const where = first.path ? first.path.slice(1).replace(/\//g, '.') : 'params';
  throw new CommandError('invalid_params', `${where} ${first.message}`, {path: first.path, errors: r.errors});
}

/** JSON Schema (2020-12 subset) for `engine.commands`. */
export function toJSONSchema(schema) {
  assertSchema(schema, 'toJSONSchema');
  const out = base(schema);
  if (schema.nullable && out.type && typeof out.type === 'string') out.type = [out.type, 'null'];
  else if (schema.nullable) return {anyOf: [out, {type: 'null'}]};
  return out;
}

function base(schema) {
  const meta = {};
  if (schema.description) meta.description = schema.description;
  if (schema.default !== undefined) meta.default = schema.default;
  switch (schema.type) {
    case 'any': return {...meta};
    case 'string': return {type: 'string', ...meta,
      ...(schema.min !== undefined ? {minLength: schema.min} : {}), ...(schema.max !== undefined ? {maxLength: schema.max} : {}),
      ...(schema.pattern !== undefined ? {pattern: schema.pattern} : {}), ...(schema.secret ? {writeOnly: true, 'x-secret': true} : {})};
    case 'number': return {type: schema.integer ? 'integer' : 'number', ...meta,
      ...(schema.min !== undefined ? {minimum: schema.min} : {}), ...(schema.max !== undefined ? {maximum: schema.max} : {})};
    case 'boolean': return {type: 'boolean', ...meta};
    case 'literal': return {const: schema.value, ...meta};
    case 'enum': return {enum: [...schema.values], ...meta};
    case 'color': return {type: 'string', pattern: '^(#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})|auto|none)$', ...meta};
    case 'address': return {type: 'string', minLength: 1, maxLength: ADDRESS_MAX, 'x-address': schema.kind || true, ...meta,
      description: schema.description || `Document address${schema.kind ? ` (${schema.kind})` : ''}: a path like /sh:<id>/A1:C9 or an anchor @a<n>`};
    case 'array': return {type: 'array', items: toJSONSchema(schema.items), ...meta,
      ...(schema.min !== undefined ? {minItems: schema.min} : {}), ...(schema.max !== undefined ? {maxItems: schema.max} : {})};
    case 'record': return {type: 'object', additionalProperties: toJSONSchema(schema.values), ...meta,
      ...(schema.max !== undefined ? {maxProperties: schema.max} : {})};
    case 'object': {
      const properties = {}, required = [];
      for (const [k, v] of Object.entries(schema.properties)) {
        properties[k] = toJSONSchema(v);
        if (!v.optional) required.push(k);
      }
      return {type: 'object', properties, ...(required.length ? {required} : {}),
        additionalProperties: schema.additional === true ? true : isSchema(schema.additional) ? toJSONSchema(schema.additional) : false, ...meta};
    }
    case 'union': return {anyOf: schema.options.map(toJSONSchema), ...meta};
    default: throw new TypeError(`unknown schema type ${schema.type}`);
  }
}

/** Required top-level property names of an object schema (used to decide whether the UI opens a dialog). */
export function requiredKeys(schema) {
  if (!isSchema(schema) || schema.type !== 'object') return [];
  return Object.entries(schema.properties).filter(([, v]) => !v.optional).map(([k]) => k);
}

// Names that look secret even when a schema forgot to say so (a second line of defence: the schema's `secret` flag is the rule).
const SECRET_NAME = /(^password$|Password$|^secret$|Secret$|^token$|Token$|^passphrase$|Passphrase$|^passcode$|^pin$|^PIN$|Pin$|^apiKey$|ApiKey$|^privateKey$|^pwd$)/;
const MASK = '••••';
const mask = v => (v === undefined || v === null || v === '' ? v : MASK);

/**
 * Copy of `value` for journals with every secret replaced: whatever a schema marks `secret` (a string field, an array of them, an
 * object, in a union), whatever its name, and whatever type the value turns out to be; plus keys that look secret by name.
 */
export function redact(schema, value) {
  if (schema?.type === 'union') {
    if (schema.secret) return mask(value);
    return schema.options.reduce((acc, option) => redact(option, acc), value);
  }
  if (schema?.secret) return mask(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redact(schema?.type === 'array' ? schema.items : null, v));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const sub = schema?.type === 'object' ? schema.properties[k] : schema?.type === 'record' ? schema.values : null;
    if ((sub && sub.secret) || SECRET_NAME.test(k)) out[k] = mask(v);
    else out[k] = redact(sub, v);
  }
  return out;
}

/** Whether a schema (anywhere inside) declares a secret field. */
export function hasSecrets(schema) {
  if (!isSchema(schema)) return false;
  if (schema.secret) return true;
  if (schema.type === 'object') return Object.entries(schema.properties).some(([k, v]) => SECRET_NAME.test(k) || hasSecrets(v));
  if (schema.type === 'array') return hasSecrets(schema.items);
  if (schema.type === 'record') return hasSecrets(schema.values);
  if (schema.type === 'union') return schema.options.some(hasSecrets);
  return false;
}
