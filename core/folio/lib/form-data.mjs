// Form data exchange: Export data (XFDF, FDF, XML, CSV, tab-delimited text), Import data
// (the same, found from the content), and Merge data files into a spreadsheet.
//
// Translated from printcraft crates/xfdf/src/lib.rs (export_data, data_values, merge_csv,
// import_table, tab_delimited, runs_as_formula, csv_guarded, csv_text), xfdf.rs (xfdf_fields,
// export_xfdf, walk_xfdf, apply_values), fdf.rs (export_fdf, walk_fdf, import_fdf) and common.rs
// (esc, xml_name, walk_xfdf, MAX_DEPTH) at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Form data files come from other people: a DTD
// is refused, nesting is bounded. Comments are exchanged by the comment commands (comment-pdf.mjs),
// not here. No DOM, no Node built-ins.

import {XMLParser} from 'fast-xml-parser';
import {readFields} from './form-read.mjs';
import {setValues, FormError, exportOf} from './form-edit.mjs';

export const FORMATS = Object.freeze({xfdf: 'XFDF', fdf: 'FDF', xml: 'XML', csv: 'CSV', txt: 'Text'});
export const formatOfExtension = ext => ({xfdf: 'xfdf', fdf: 'fdf', xml: 'xml', xdp: 'xml', csv: 'csv', txt: 'txt', tab: 'txt', tsv: 'txt'}[String(ext).toLowerCase()] ?? null);
const MAX_DEPTH = 64;
const MAX_VALUES = 1_000_000;

export class DataError extends Error {
  constructor(message, code = 'malformed') { super(message); this.name = 'DataError'; this.code = code; }
}

const esc = s => String(s).replace(/[&<>"\t\n\r]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;'}[c]))
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '');

function xmlName(name) {
  let s = [...name].map(c => (/[\p{L}\p{N}_.-]/u.test(c) ? c : '_')).join('');
  if (!/^[\p{L}_]/u.test(s)) s = `_${s}`;
  return s;
}

/** A button's value for data export: its appearance state, named through /Opt when the field has export values (forms lib.rs export_for_state, printcraft 8f16855). */
function exportForState(f, state) {
  const i = f.widgets.findIndex(w => w.onState === state);
  return (i >= 0 ? exportOf(f, i) : null) ?? state;
}

/** The exchanged fields: [{name, value: [..], kind}] (buttons and signature fields carry no data). */
function exchanged(pdf) {
  return readFields(pdf).filter(f => f.kind !== 'pushbutton' && f.kind !== 'signature')
    .map(f => ({name: f.name, kind: f.kind, value: f.kind === 'checkbox' || f.kind === 'radio' ? (f.value.length ? f.value.map(v => exportForState(f, v)) : ['Off']) : f.value}));
}

// ── export ──────────────────────────────────────────────────────────────────────────────────

/** XFDF with the field values as nested <field> elements. */
export function exportXfdf(pdf, file = '') {
  const root = {values: [], kids: []};
  for (const f of exchanged(pdf)) {
    let node = root;
    const parts = f.name.split('.');
    const head = parts.slice(0, MAX_DEPTH - 1), tail = parts.slice(MAX_DEPTH - 1).join('.');
    for (const part of tail ? [...head, tail] : head) {
      let k = node.kids.find(x => x[0] === part);
      if (!k) { k = [part, {values: [], kids: []}]; node.kids.push(k); }
      node = k[1];
    }
    node.values = f.value;
  }
  const write = (name, node) => `<field name="${esc(name)}">${node.values.map(v => `<value>${esc(v)}</value>`).join('')}${node.kids.map(([k, n]) => write(k, n)).join('')}</field>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<fields>\n${root.kids.map(([k, n]) => write(k, n)).join('')}</fields>\n<f href="${esc(file)}"/>\n</xfdf>\n`;
}

const pdfString = s => {
  const t = String(s);
  if (/^[\x20-\x7e]*$/.test(t)) return `(${t.replace(/[\\()]/g, '\\$&')})`;
  let hex = 'FEFF';
  for (let i = 0; i < t.length; i++) hex += t.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
};
const pdfName = s => `/${[...s].map(c => (/[A-Za-z0-9._+-]/.test(c) ? c : [...new TextEncoder().encode(c)].map(b => `#${b.toString(16).padStart(2, '0').toUpperCase()}`).join(''))).join('')}`;

/** FDF (ISO 32000-2 section 12.7.8): the field values in PDF syntax. */
export function exportFdf(pdf, file = '') {
  const fields = exchanged(pdf);
  if (fields.length > 100_000) throw new DataError('FDF export exceeds the 100,000 values limit; no data was exported', 'limit');
  let body = '<< /FDF << /Fields [';
  for (const f of fields) {
    body += `<< /T ${pdfString(f.name)} /V `;
    if (f.kind === 'checkbox' || f.kind === 'radio') body += pdfName(f.value[0] ?? 'Off');
    else if (f.kind === 'list' && f.value.length > 1) body += `[${f.value.map(pdfString).join(' ')}]`;
    else body += pdfString(f.value[0] ?? '');
    body += ' >> ';
  }
  body += `] /F ${pdfString(file)} >> >>`;
  return new TextEncoder().encode(`%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n${body}\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`.replace(/[\u0080-￿]/g, ''));
}

const runsAsFormula = s => { const t = s.trimStart(); const c = t[0]; return c === '=' || c === '@' || ((c === '+' || c === '-') && !Number.isFinite(Number(t))); };
const csvGuarded = s => runsAsFormula(s.replace(/^'+/, ''));
const csvText = cell => { if (cell.startsWith("'") && csvGuarded(cell.slice(1))) return cell.slice(1); return cell; };
const csvQuote = s => {
  const g = csvGuarded(s) ? `'${s}` : s;
  return /[,"\n\r\t]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
};

/** Form data as XML, CSV or tab-delimited text. */
export function exportData(pdf, format) {
  const fields = exchanged(pdf).map(f => [f.name, f.kind === 'list' || f.kind === 'combo' ? f.value.join(', ') : f.value.join(', ')]);
  if (format === 'xml') {
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<fields xmlns:xfdf="http://ns.adobe.com/xfdf-transition/">\n';
    for (const [k, v] of fields) { const tag = xmlName(k); out += `<${tag}${tag === k ? '' : ` xfdf:original="${esc(k)}"`}>${esc(v)}</${tag}>\n`; }
    return `${out}</fields>\n`;
  }
  if (format === 'csv') return `${fields.map(f => csvQuote(f[0])).join(',')}\n${fields.map(f => csvQuote(f[1])).join(',')}\n`;
  const clean = s => s.replace(/[\t\n\r]/g, ' ');
  return `${fields.map(f => clean(f[0])).join('\t')}\n${fields.map(f => clean(f[1])).join('\t')}\n`;
}

/** Export in the format of the file name's extension (XFDF when unknown). Returns text or, for FDF, bytes. */
export function exportAs(pdf, format, file = '') {
  switch (format) {
    case 'fdf': return exportFdf(pdf, file);
    case 'xfdf': return exportXfdf(pdf, file);
    default: return exportData(pdf, format);
  }
}

// ── reading data files ──────────────────────────────────────────────────────────────────────

/** A tiny PDF-syntax reader for FDF files: dictionaries, arrays, strings, names, numbers. */
function parseFdfObjects(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /[\s\0]/.test(text[i])) i++; };
  const readString = () => {
    i++;
    let depth = 1, bytes = [];
    while (i < text.length && depth) {
      const c = text[i++];
      if (c === '\\') {
        const e = text[i++];
        if (e === 'n') bytes.push(10); else if (e === 'r') bytes.push(13); else if (e === 't') bytes.push(9); else if (e === 'b') bytes.push(8); else if (e === 'f') bytes.push(12);
        else if (/[0-7]/.test(e)) { let o = e; while (o.length < 3 && /[0-7]/.test(text[i])) o += text[i++]; bytes.push(parseInt(o, 8) & 255); }
        else if (e === '\r' || e === '\n') { if (e === '\r' && text[i] === '\n') i++; }
        else bytes.push(e.charCodeAt(0) & 255);
      } else if (c === '(') { depth++; bytes.push(40); } else if (c === ')') { depth--; if (depth) bytes.push(41); } else bytes.push(c.charCodeAt(0) & 255);
    }
    return decodeBytes(bytes);
  };
  const decodeBytes = bytes => {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) { let s = ''; for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]); return s; }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(Uint8Array.from(bytes.slice(3)));
    return String.fromCharCode(...bytes);
  };
  const value = depth => {
    if (depth > MAX_DEPTH) throw new DataError(`the file nests more than ${MAX_DEPTH} deep`);
    ws();
    const c = text[i];
    if (c === '<' && text[i + 1] === '<') {
      i += 2;
      const d = {};
      for (;;) {
        ws();
        if (text[i] === '>' && text[i + 1] === '>') { i += 2; return d; }
        if (i >= text.length || text[i] !== '/') throw new DataError('malformed FDF dictionary');
        const k = name();
        d[k] = value(depth + 1);
      }
    }
    if (c === '<') { const e = text.indexOf('>', i); if (e < 0) throw new DataError('malformed FDF hex string'); const hex = text.slice(i + 1, e).replace(/\s/g, ''); i = e + 1; const bytes = []; for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16)); return decodeBytes(bytes); }
    if (c === '[') { i++; const a = []; for (;;) { ws(); if (text[i] === ']') { i++; return a; } if (i >= text.length) throw new DataError('malformed FDF array'); a.push(value(depth + 1)); } }
    if (c === '(') return readString();
    if (c === '/') return {name: name()};
    const m = /^[^\s\0()<>[\]{}/%]+/.exec(text.slice(i, i + 64));
    if (!m) throw new DataError('malformed FDF');
    i += m[0].length;
    if (/^\d+$/.test(m[0])) { const r = /^\s+(\d+)\s+R\b/.exec(text.slice(i, i + 20)); if (r) { i += r[0].length; return {ref: Number(m[0])}; } }
    return Number.isFinite(Number(m[0])) ? Number(m[0]) : m[0];
  };
  const name = () => { i++; const m = /^[^\s\0()<>[\]{}/%]*/.exec(text.slice(i))[0]; i += m.length; return m.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); };
  return {value, ws, at: () => i, seek: k => { i = k; }};
}

function fdfValues(bytes) {
  const text = Array.from(bytes, b => String.fromCharCode(b)).join('');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const p = parseFdfObjects(text.slice(m.index + m[0].length));
    try { objs.set(Number(m[1]), p.value(0)); } catch { /* an unreadable object is skipped */ }
  }
  const root = objs.get(1) ?? [...objs.values()][0];
  const body = root?.FDF;
  if (!body || typeof body !== 'object') throw new DataError('this file has no FDF data');
  const out = [];
  let budget = MAX_VALUES;
  const resolve = o => (o && typeof o === 'object' && 'ref' in o ? objs.get(o.ref) : o);
  const walk = (list, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new DataError(`FDF fields nest more than ${MAX_DEPTH} deep`);
    for (const raw of list) {
      if (--budget < 0) throw new DataError('the file holds too many values');
      const f = resolve(raw);
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const t = typeof f.T === 'string' ? f.T : null;
      const full = t === null ? prefix : prefix ? `${prefix}.${t}` : t;
      const v = resolve(f.V);
      if (full && v !== undefined) {
        const one = x => (typeof x === 'string' ? x : x && typeof x === 'object' && 'name' in x ? x.name : String(x));
        out.push([full, Array.isArray(v) ? v.map(one) : [one(v)]]);
      }
      if (Array.isArray(resolve(f.Kids))) walk(resolve(f.Kids), full, depth + 1);
    }
  };
  const fields = resolve(body.Fields);
  if (Array.isArray(fields)) walk(fields, '', 0);
  return out;
}

const xmlParser = () => new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: false,
  isArray: n => n === 'field' || n === 'value', processEntities: true, allowBooleanAttributes: true});
const checkXml = text => {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new DataError('the file has a DTD, which is refused');
  let depth = 0, max = 0;
  for (const m of text.matchAll(/<(\/?)([^\s/>!?][^>]*?)(\/?)>/g)) { if (m[1]) depth--; else if (!m[3]) { depth++; max = Math.max(max, depth); } }
  if (max > 1024) throw new DataError(`the file nests XML elements ${max} deep`);
};

function xfdfValues(text) {
  checkXml(text);
  let doc;
  try { doc = xmlParser().parse(text); } catch (e) { throw new DataError(String(e.message ?? e)); }
  const root = doc.xfdf;
  if (!root) throw new DataError('this file is not XFDF', 'unknown');
  const out = [];
  const walk = (nodes, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new DataError(`XFDF fields nest more than ${MAX_DEPTH} deep`);
    for (const f of nodes ?? []) {
      const name = f['@_name'];
      if (typeof name !== 'string') continue;
      const full = prefix ? `${prefix}.${name}` : name;
      const vals = (f.value ?? []).map(v => (typeof v === 'string' ? v : v?.['#text'] ?? ''));
      const kids = f.field ?? [];
      if (vals.length || (!kids.length && !f['value-richtext'])) out.push([full, vals]);
      walk(kids, full, depth + 1);
    }
  };
  const fields = root.fields;
  if (fields && typeof fields === 'object') walk(fields.field ?? [], '', 0);
  return out;
}

const tabDelimited = t => { const lines = t.split(/\r?\n/); if (lines.length < 2) throw new DataError('this file is not form data', 'unknown'); const row = lines[1].split('\t'); return lines[0].split('\t').map((k, i) => [k, [row[i] ?? '']]).filter(([k]) => k !== ''); };
const hasTabDelimiter = text => {
  let quoted = false, start = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') i++;
    else if (c === '"' && (quoted || start)) { quoted = !quoted; start = false; }
    else if (c === '\t' && !quoted) return true;
    else if ((c === '\r' || c === '\n') && !quoted) return false;
    else if (c === ',' && !quoted) start = true;
    else start = false;
  }
  return quoted && (text.split('\n')[0] ?? '').includes('\t');
};

function tableValues(text) {
  const t = text.replace(/^﻿/, '');
  if (t.trimStart().startsWith('<')) {
    checkXml(t);
    let doc;
    try { doc = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: false, processEntities: true}).parse(t); } catch (e) { throw new DataError(String(e.message ?? e)); }
    const rootKey = Object.keys(doc).find(k => !k.startsWith('?'));
    const root = doc[rootKey];
    if (typeof root !== 'object') return [];
    return Object.entries(root).filter(([k]) => !k.startsWith('@_')).map(([k, v]) => {
      const node = Array.isArray(v) ? v[0] : v;
      const name = node && typeof node === 'object' && node['@_xfdf:original'] ? node['@_xfdf:original'] : k;
      return [name, [typeof node === 'string' ? node : node?.['#text'] ?? '']];
    });
  }
  if (hasTabDelimiter(t)) return tabDelimited(t);
  const records = [];
  let record = [], cur = '', quoted = false, hasQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"' && quoted && t[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') { quoted = !quoted; hasQuotes = true; }
    else if (c === ',' && !quoted) { record.push(cur); cur = ''; }
    else if (c === '\r' && !quoted && t[i + 1] === '\n') continue;
    else if (c === '\n' && !quoted) { record.push(cur); cur = ''; records.push([record, hasQuotes]); record = []; hasQuotes = false; }
    else cur += c;
  }
  record.push(cur);
  records.push([record, hasQuotes]);
  const rows = records.filter(([r, q]) => q || !(r.length === 1 && r[0] === '')).map(([r]) => r);
  if (rows.length < 2) throw new DataError('this file is not form data', 'unknown');
  const [head, row] = rows;
  if (head.length === 1 && row.length > 1) return tabDelimited(t);
  return head.map((k, i) => [csvText(k), [csvText(row[i] ?? '')]]);
}

/** The field values in a data file (FDF or XFDF, XML, CSV or text) in file order: [[name, [values]]]. */
export function dataValues(bytes) {
  const head = Array.from(bytes.subarray(0, 8), b => String.fromCharCode(b)).join('');
  if (head.startsWith('%FDF')) return fdfValues(bytes);
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  const t = text.trimStart();
  if (t.startsWith('<')) {
    try { return xfdfValues(t); } catch (e) { if (!(e instanceof DataError && e.code === 'unknown')) throw e; }
  }
  return tableValues(text);
}

/** Merge Data Files into Spreadsheet: one CSV row per file, one column per field name (in first-seen order). */
export function mergeCsv(files) {
  const columns = [];
  for (const f of files) for (const [k] of f) if (!columns.includes(k)) columns.push(k);
  const q = s => { const g = runsAsFormula(s) ? `'${s}` : s; return /[,"\n\r\t]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
  let out = `${columns.map(q).join(',')}\n`;
  for (const f of files) out += `${columns.map(c => { const hit = f.find(([k]) => k === c); return hit ? q(hit[1].join(', ')) : ''; }).join(',')}\n`;
  return out;
}

/** The values of a filled-in PDF form, for Merge data files (a PDF is accepted as a data file too). */
export function valuesOfFilledPdf(pdf) {
  return exchanged(pdf).map(f => [f.name, f.value]);
}

/**
 * Import: set the values a data file holds in the form (read-only fields take imported data, as in Acrobat).
 * Returns {fields, rejected: [name]} and throws DataError when nothing in the file matches.
 */
export function importInto(pdf, bytes) {
  const values = dataValues(bytes);
  const all = readFields(pdf);
  const entries = [];
  for (const [name, vals] of values) {
    const f = all.find(x => x.name === name);
    if (!f || f.kind === 'pushbutton' || f.kind === 'signature') continue;
    const first = vals[0] ?? '';
    let v;
    if (f.kind === 'text') v = first;
    else if (f.kind === 'checkbox') v = !!first && first !== 'Off';
    else if (f.kind === 'radio') v = first && first !== 'Off' ? first : null;
    else if (f.kind === 'list' && f.flags & (1 << 21) && vals.length === 1 && !f.options.some(([e]) => e === first)) v = first.split(', ').filter(Boolean);
    else v = vals.filter(Boolean);
    entries.push([name, v]);
  }
  const results = setValues(pdf, entries, {force: true});
  const report = {fields: results.filter(r => !r.error).length, rejected: results.filter(r => r.error).map(r => r.name)};
  if (!report.fields && !report.rejected.length) throw new DataError('nothing in the file matches this document', 'nothing');
  return report;
}

export {FormError};
