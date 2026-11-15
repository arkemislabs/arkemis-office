// Mail merge engine (Mailings tab): the recipient list (CSV text or table rows, filtered and
// sorted), the merge fields (MERGEFIELD, ADDRESSBLOCK, GREETINGLINE, IF, SKIPIF, NEXTIF, NEXT,
// MERGEREC), Preview Results (the fields show a record's values) and Finish & Merge (a new
// document holding one merged copy per record).
//
// Translated from wordcraft crates/engine/src/cmd/mailings.rs (`MergeState`, `MERGE_KINDS`),
// mailings/merge.rs (`mergefield_name`, `address_map`, `address_block`, `greeting`, `act`,
// `condition`, `placeholder`, `refresh`, `merge_range`, `finish`, `merge_blocks`),
// mailings/recipients.rs (`parse_csv`, `table_from_rows`, `header_split`) and mailings/filter.rs
// (`FilterOp`, `compare_cells`, `rule_holds`, `select_records`, `apply_filter`, `parse_rules`,
// `parse_sort`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.
//
// The merge state lives in the document view (`view.merge`: headers, source, rows, filter, sort,
// preview, record, highlight), as upstream keeps it in the session and not in the document; the
// merge's kind (Letters, Directory…) is the document's `settings.mailMerge.kind`, which .docx keeps
// as w:mailMerge. Everything here is plain data in, plain data out. No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {Document, BODY, reId} from '../model/document.mjs';
import * as P from '../model/para.mjs';
import {newId} from '../model/ids.mjs';
import {bodyFromBlocks} from '../model/body.mjs';
import {fieldNames} from './mailings-sheet.mjs';

/** The kinds of document Start Mail Merge makes. `normal` is an ordinary document again; only `directory` changes how Finish & Merge joins the records. */
export const MERGE_KINDS = Object.freeze(['letters', 'emails', 'envelopes', 'labels', 'directory', 'normal']);

/** Most records and fields a recipient list keeps. */
export const MAX_RECORDS = 100_000;
export const MAX_FIELDS = 1000;
const MAX_RULES = 64;
const MAX_SORT_KEYS = 8;
/** Most merged documents' worth of body blocks Finish & Merge builds. */
const MAX_MERGED_BLOCKS = 200_000;
const MAX_DEPTH = 32;

const failed = m => new CommandError('failed', m);
const params = m => new CommandError('invalid_params', m);

// ---- the state -------------------------------------------------------------------------------------

export const emptyMerge = () => ({headers: [], source: [], rows: [], filter: [], sort: [], preview: false, record: 0, highlight: false});

/** The merge's kind: the document's setting ('' is a normal document). */
export const kindOf = content => (MERGE_KINDS.includes(content?.settings?.mailMerge?.kind) ? content.settings.mailMerge.kind : '');

/** The merge state of a command context (view + document setting). */
export function mergeOf(ctx) {
  return {...emptyMerge(), ...(ctx.view?.merge ?? {}), kind: kindOf(ctx.doc)};
}

/** The view part of a merge state (what is kept in the view). */
export function viewMerge(m) {
  const {kind: _kind, ...rest} = m;
  return rest;
}

// ---- CSV (recipients.rs) ------------------------------------------------------------------------------

/** The field separator: whichever of `,` `;` and tab the first line (outside quotes) uses most. */
function csvSeparator(text) {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let quoted = false, unquoted = '';
  for (const c of first) {
    if (c === '"') quoted = !quoted;
    else if (!quoted) unquoted += c;
  }
  let best = ',', bestN = -1;
  for (const c of [',', ';', '\t']) {
    const n = unquoted.split(c).length - 1;
    if (n > bestN) { best = c; bestN = n; }
  }
  return best;
}

/** Parse CSV (RFC 4180-ish: quotes, doubled quotes, commas/semicolons/tabs); rows with no non-empty field are dropped (parse_csv). */
export function parseCsv(text) {
  const sep = csvSeparator(text);
  const rows = [];
  let row = [], cell = '', q = false;
  const end = () => { if (row.some(x => x !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      end();
    } else cell += c;
    if (rows.length > 100_000) break;
  }
  row.push(cell);
  end();
  return rows;
}

/** A cell value as text (cell()). */
export function cellText(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return x;
  return typeof x === 'object' ? JSON.stringify(x) : String(x);
}

/** A recipient table from `rows` (objects keyed by field, or arrays in `fields` order); without `fields` the columns are the objects' keys (table_from_rows). */
export function tableFromRows(fields, arr) {
  let headers;
  if (Array.isArray(fields)) headers = fields.slice(0, MAX_FIELDS).map(h => cellText(h).trim());
  else {
    if (arr.some(Array.isArray)) throw params('`fields` is required when `rows` are arrays');
    headers = [];
    for (const o of arr) if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!headers.includes(k) && headers.length < MAX_FIELDS) headers.push(k);
  }
  const rows = [];
  for (const r of arr.slice(0, MAX_RECORDS)) {
    if (Array.isArray(r)) rows.push(headers.map((_, i) => cellText(r[i])));
    else if (r && typeof r === 'object') rows.push(headers.map(h => cellText(r[h])));
  }
  return [headers, rows];
}

/** Field names and records from a table's rows: with `headers` the first row names the fields (blank names become `Column N`, repeats are numbered); otherwise every row is a record and the fields are `Column 1`…`Column N` (header_split). */
export function headerSplit(all, headers) {
  if (!all.length) throw failed('the recipient list is empty');
  all = all.slice();
  let fields;
  if (headers) fields = fieldNames(all.shift().slice(0, MAX_FIELDS));
  else {
    const width = Math.min(Math.max(...all.map(r => r.length)), MAX_FIELDS);
    fields = Array.from({length: width}, (_, i) => `Column ${i + 1}`);
  }
  all = all.slice(0, MAX_RECORDS).map(r => { const x = r.slice(0, fields.length); while (x.length < fields.length) x.push(''); return x; });
  return [fields, all];
}

// ---- filter and sort (filter.rs) -------------------------------------------------------------------------

/** Filter Recipients comparisons, in the order the dialog lists them: [id, label]. */
export const FILTER_OPS = Object.freeze([['equal', 'Equal to'], ['notEqual', 'Not equal to'], ['less', 'Less than'], ['greater', 'Greater than'],
  ['lessOrEqual', 'Less than or equal'], ['greaterOrEqual', 'Greater than or equal'], ['blank', 'Is blank'], ['notBlank', 'Is not blank'],
  ['contains', 'Contains'], ['notContains', 'Does not contain']]);
/** Whether the comparison takes a value (Is blank / Is not blank don't). */
export const opHasValue = op => op !== 'blank' && op !== 'notBlank';

/** An id, a symbol (`=`, `<>`, `<`, `>`, `<=`, `>=`) or a spelled-out alias, any case (FilterOp::parse). */
export function parseOp(t) {
  const k = String(t).trim().replace(/[ _-]/g, '').toLowerCase();
  const table = {
    equal: 'equal', equals: 'equal', equalto: 'equal', '=': 'equal', '==': 'equal', eq: 'equal',
    notequal: 'notEqual', notequalto: 'notEqual', '<>': 'notEqual', '!=': 'notEqual', ne: 'notEqual',
    less: 'less', lessthan: 'less', '<': 'less', lt: 'less', greater: 'greater', greaterthan: 'greater', '>': 'greater', gt: 'greater',
    lessorequal: 'lessOrEqual', lessthanorequal: 'lessOrEqual', '<=': 'lessOrEqual', le: 'lessOrEqual',
    greaterorequal: 'greaterOrEqual', greaterthanorequal: 'greaterOrEqual', '>=': 'greaterOrEqual', ge: 'greaterOrEqual',
    blank: 'blank', isblank: 'blank', empty: 'blank', notblank: 'notBlank', isnotblank: 'notBlank', notempty: 'notBlank',
    contains: 'contains', notcontains: 'notContains', doesnotcontain: 'notContains',
  };
  return Object.hasOwn(table, k) ? table[k] : null;
}

const asNumber = s => { const x = s.trim() === '' ? Number.NaN : Number(s); return Number.isFinite(x) ? x : null; };

/** Orders two cells: numbers (compared numerically) before text (compared case-insensitively), a total order (compare_cells). */
export function compareCells(a, b) {
  a = a.trim(); b = b.trim();
  const x = asNumber(a), y = asNumber(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  if (x !== null) return -1;
  if (y !== null) return 1;
  const l = a.toLowerCase(), r = b.toLowerCase();
  return l < r ? -1 : l > r ? 1 : 0;
}

function ruleHolds(r, cell) {
  const ord = () => compareCells(cell, r.value);
  const lower = () => [cell.toLowerCase(), r.value.trim().toLowerCase()];
  switch (r.op) {
    case 'equal': return ord() === 0;
    case 'notEqual': return ord() !== 0;
    case 'less': return ord() < 0;
    case 'greater': return ord() > 0;
    case 'lessOrEqual': return ord() <= 0;
    case 'greaterOrEqual': return ord() >= 0;
    case 'blank': return cell.trim() === '';
    case 'notBlank': return cell.trim() !== '';
    case 'contains': { const [c, v] = lower(); return c.includes(v); }
    case 'notContains': { const [c, v] = lower(); return !c.includes(v); }
    default: return true;
  }
}

/** The records (indices into `rows`) that `filter` keeps, in `sort` order (stable); rules and keys naming a field that isn't in `headers` are ignored (select_records). */
export function selectRecords(headers, rows, filter, sort) {
  const col = f => headers.findIndex(h => h.toLowerCase() === String(f).trim().toLowerCase());
  const rules = filter.map(r => [col(r.field), r]).filter(([c]) => c >= 0);
  const keep = row => {
    if (!rules.length) return true;
    // Or-groups of And-ed rules.
    let any = false, all = true;
    rules.forEach(([c, r], k) => {
      if (k > 0 && r.or) { any = any || all; all = true; }
      all = all && ruleHolds(r, row[c] ?? '');
    });
    return any || all;
  };
  const out = [];
  rows.forEach((r, i) => { if (keep(r)) out.push(i); });
  const keys = sort.map(k => [col(k.field), !!k.descending]).filter(([c]) => c >= 0);
  if (keys.length) {
    out.sort((a, b) => {
      for (const [c, desc] of keys) {
        const o = compareCells(rows[a]?.[c] ?? '', rows[b]?.[c] ?? '');
        if (o !== 0) return desc ? -o : o;
      }
      return a - b;
    });
  }
  return out;
}

/** Recompute the merged records from the list, its filter and its sort; back to the first (apply_filter). */
export function applyFilter(m) {
  const known = f => m.headers.some(h => h.toLowerCase() === String(f).trim().toLowerCase());
  const filter = m.filter.filter(r => known(r.field));
  const sort = m.sort.filter(k => known(k.field));
  const rows = selectRecords(m.headers, m.source, filter, sort).map(i => m.source[i]);
  return {...m, filter, sort, rows, record: 0, preview: rows.length ? m.preview : false};
}

const knownField = (headers, f) => {
  const h = headers.find(x => x.toLowerCase() === String(f).trim().toLowerCase());
  if (h === undefined) throw params(`no field named \`${f}\` in the recipient list`);
  return h;
};

/** Filter rules from command params: [{field, op, value, or}] (parse_rules). */
export function parseRules(headers, v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw params('`rules` must be an array of {field, op, value, join}');
  if (v.length > MAX_RULES) throw params(`at most ${MAX_RULES} filter rules`);
  return v.map(r => {
    if (typeof r?.field !== 'string') throw params('each rule needs a `field`');
    const opName = r.op ?? r.comparison ?? 'equal';
    const op = parseOp(opName);
    if (!op) throw params(`unknown \`op\` \`${opName}\`; one of ${FILTER_OPS.map(o => o[0]).join(', ')}`);
    let or = false;
    if (r.join !== undefined && r.join !== null) {
      const j = String(r.join).trim().toLowerCase();
      if (j === 'or') or = true; else if (j !== 'and') throw params('`join` must be "and" or "or"');
    }
    return {field: knownField(headers, r.field), op, value: r.value === undefined || r.value === null ? '' : cellText(r.value), or};
  });
}

/** Sort keys from command params: [{field, descending}] (parse_sort). */
export function parseSort(headers, v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : typeof v === 'object' || typeof v === 'string' ? [v] : null;
  if (!arr) throw params('`sort` must be an array of {field, descending}');
  if (arr.length > MAX_SORT_KEYS) throw params(`at most ${MAX_SORT_KEYS} sort keys`);
  return arr.map(k => {
    const [field, descending] = typeof k === 'string' ? [k, false] : [k?.field, !!k?.descending];
    if (typeof field !== 'string') throw params('each sort key needs a `field`');
    return {field: knownField(headers, field), descending};
  });
}

export const rulesJson = m => m.filter.map(r => ({field: r.field, op: r.op, value: r.value, join: r.or ? 'or' : 'and'}));
export const sortJson = m => m.sort.map(k => ({field: k.field, descending: !!k.descending}));

// ---- merge fields (merge.rs) ------------------------------------------------------------------------------

/** The name a `MERGEFIELD` instruction merges (null: not one). The field type ignores case and ends at a space or a quote, so `MERGEFIELDX` is another field (mergefield_name). */
export function mergefieldName(instr) {
  const t = String(instr).trim();
  let end = t.search(/[\s"]/);
  if (end < 0) end = t.length;
  if (t.slice(0, end).toLowerCase() !== 'mergefield') return null;
  const rest = t.slice(end).trim();
  if (rest.startsWith('"')) return rest.slice(1).split('"')[0] ?? '';
  return rest.split(/\s+/)[0] ?? '';
}

const keyword = instr => (String(instr).trim().split(/\s+/)[0] ?? '').toUpperCase();

/** The merge field a rule tests: the name in its first nested field, if that is a MERGEFIELD. */
function ruleField(t) {
  const i = t.indexOf('{');
  if (i < 0) return null;
  return mergefieldName(t.slice(i + 1).split('}')[0] ?? '');
}

/** The columns that hold address parts (address_map): key → field name or null. */
export function addressMap(headers) {
  const find = names => headers.find(h => names.some(n => h.replace(/[ _]/g, '').toLowerCase() === n.toLowerCase())) ?? null;
  return {
    firstName: find(['FirstName', 'First', 'GivenName']),
    lastName: find(['LastName', 'Last', 'Surname', 'FamilyName']),
    company: find(['Company', 'Organization', 'CompanyName']),
    address: find(['Address', 'AddressLine1', 'Address1', 'Street']),
    city: find(['City', 'Town']),
    state: find(['State', 'Province', 'Region']),
    postal: find(['PostalCode', 'ZIP', 'ZipCode', 'Postcode']),
    country: find(['Country']),
    title: find(['Title', 'CourtesyTitle']),
  };
}

function value(m, row, field) {
  const i = m.headers.findIndex(h => h.toLowerCase() === String(field).toLowerCase());
  if (i < 0) return '';
  return m.rows[row]?.[i] ?? '';
}

export function addressBlock(m, row) {
  const map = addressMap(m.headers);
  const g = k => (map[k] ? value(m, row, map[k]) : '');
  const name = [g('title'), g('firstName'), g('lastName')].filter(Boolean).join(' ');
  const cityLine = [g('city'), [g('state'), g('postal')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [name, g('company'), g('address'), cityLine, g('country')].filter(Boolean).join('\n');
}

function greeting(m, row) {
  const map = addressMap(m.headers);
  const g = k => (map[k] ? value(m, row, map[k]) : '');
  const name = [g('firstName'), g('lastName')].filter(Boolean).join(' ');
  return name ? `Dear ${name},` : 'Dear Sir or Madam,';
}

/** Comparison of a rule condition `{ MERGEFIELD X } op "value" …` (IF, SKIPIF, NEXTIF) for `row`: whether it holds and the quoted texts after the value (condition). */
function condition(m, t, row) {
  const field = ruleField(t) ?? '';
  const b = t.indexOf('}');
  const rest = b < 0 ? '' : t.slice(b + 1);
  const op = /^[<=>]*/.exec(rest.trimStart())[0];
  const quoted = rest.split('"').filter((_, i) => i % 2 === 1);
  const cmp = quoted.shift() ?? '';
  const v = value(m, row, field);
  // Numbers compare as numbers (Word: "7" = "7.0"), everything else as text.
  const a = asNumber(v), c = asNumber(cmp);
  let ord;
  if (a !== null && c !== null) ord = a < c ? -1 : a > c ? 1 : a === c ? 0 : null;
  else ord = v < cmp ? -1 : v > cmp ? 1 : 0;
  let holds;
  switch (op) {
    case '<>': holds = ord !== 0; break;
    case '<': holds = ord === -1; break;
    case '>': holds = ord === 1; break;
    case '<=': holds = ord === -1 || ord === 0; break;
    case '>=': holds = ord === 1 || ord === 0; break;
    default: holds = ord === 0;
  }
  return [holds, quoted];
}

/** What a merge-related field does for a record: {text}, {next} or {skip} (null = not a merge field) (act). */
function act(m, instr, row) {
  const t = String(instr).trim();
  const name = mergefieldName(t);
  if (name !== null) return {text: value(m, row, name)};
  switch (keyword(t)) {
    case 'ADDRESSBLOCK': return {text: addressBlock(m, row)};
    case 'GREETINGLINE': return {text: greeting(m, row)};
    case 'MERGEREC': return {text: String(row + 1)};
    case 'NEXT': return {next: true};
    case 'NEXTIF': return condition(m, t, row)[0] ? {next: true} : {text: ''};
    case 'SKIPIF': return condition(m, t, row)[0] ? {skip: true} : {text: ''};
    // IF { MERGEFIELD X } = "v" "then" "else" (an IF on other fields isn't ours to touch).
    case 'IF': {
      if (ruleField(t) === null) return null;
      const [holds, texts] = condition(m, t, row);
      return {text: texts[holds ? 0 : 1] ?? ''};
    }
    default: return null;
  }
}

/** What a merge field shows outside Preview Results (null = not a merge field) (placeholder). */
export function placeholder(instr) {
  const n = mergefieldName(instr);
  if (n !== null) return `«${n}»`;
  switch (keyword(instr)) {
    case 'ADDRESSBLOCK': return '«AddressBlock»';
    case 'GREETINGLINE': return '«GreetingLine»';
    case 'NEXT': case 'NEXTIF': case 'SKIPIF': case 'MERGEREC': return '';
    case 'IF': return ruleField(String(instr)) !== null ? '' : null;
    default: return null;
  }
}

/** Whether an instruction is one of the merge fields. */
export const isMergeInstr = instr => placeholder(instr) !== null;

/** The stories a merge resolves: the body, then every header and footer. */
export function mergeStories(content) {
  return [BODY, ...Object.keys(content.parts ?? {}).filter(id => ['header', 'footer'].includes(content.parts[id].kind)).map(Number)];
}

/** Field names used by MERGEFIELD fields in the document (body, headers and footers) (merge_fields). */
export function mergeFields(d) {
  const v = [];
  for (const story of mergeStories(d.c)) {
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      for (const o of p?.objects ?? []) {
        if (o.type !== 'field') continue;
        const name = mergefieldName(o.instr ?? '');
        if (name !== null && !v.includes(name)) v.push(name);
      }
    }
  }
  return v;
}

/**
 * Update merge field results in `d` (a Document): record values when previewing, «Field» placeholders
 * otherwise. NEXT moves later fields of the previewed document to the next record, as Finish & Merge
 * does (refresh). Returns whether anything changed.
 */
export function refreshDoc(d, m) {
  const preview = !!m.preview && m.rows.length > 0;
  const last = m.rows.length;
  let changed = false;
  for (const story of mergeStories(d.c)) {
    let cur = m.record;
    for (const path of d.paraPaths(story)) {
      const p = d.para(story, path);
      if (!p?.objects?.length) continue;
      const updates = [];
      p.objects.forEach((o, k) => {
        if (o.type !== 'field') return;
        const shown = placeholder(o.instr ?? '');
        if (shown === null) return;
        let text = shown;
        if (preview) {
          const a = act(m, o.instr, cur);
          if (a?.next) { cur = Math.min(cur + 1, last); text = ''; } else text = a?.text ?? '';
        }
        if ((o.result ?? '') !== text) updates.push([k, text]);
      });
      if (!updates.length) continue;
      const q = d.paraMut(story, path);
      q.objects = q.objects.map((o, k) => { const u = updates.find(x => x[0] === k); return u ? {...o, result: u[1]} : o; });
      changed = true;
    }
  }
  return changed;
}

/** The records Finish & Merge and Print Documents take (0-based, end exclusive): `records` all or current, or `from` and `to` by record number (merge_range). */
export function mergeRange(m, v) {
  const n = m.rows.length;
  let from, to;
  const which = typeof v.records === 'string' ? v.records.trim() : undefined;
  if (which === 'current') { from = Math.min(m.record, Math.max(0, n - 1)); to = Math.min(m.record + 1, n); }
  else if (which === undefined || which === 'all') {
    from = Math.max(1, Math.floor(v.from ?? 1)) - 1;
    to = Math.min(Math.floor(v.to ?? n), n);
  } else throw params('`records` must be all or current');
  if (from >= to) throw failed(`no records from ${from + 1} to ${to} (the list has ${n})`);
  return [from, to];
}

// ---- Finish & Merge (merge_blocks, finish) ---------------------------------------------------------------

/** Whether blocks hold merge fields (has_merge_fields). */
function hasMergeFields(blocks, depth = 0) {
  return depth <= MAX_DEPTH && blocks.some(b => (b.kind === 'para'
    ? (b.objects ?? []).some(o => o.type === 'field' && isMergeInstr(o.instr ?? ''))
    : b.rows.some(r => r.cells.some(c => hasMergeFields(c.blocks, depth + 1)))));
}

/**
 * Replace the merge fields of story `story` of `d` by their text, in document order, starting with
 * record `cur`. NEXT moves on (records from `end` on are blank). Returns {keep, cur}; keep is false
 * when a SKIPIF drops this merged document (merge_blocks).
 */
function mergeStory(d, m, story, cur, end) {
  for (const path of d.paraPaths(story)) {
    const p = d.para(story, path);
    if (!p?.objects?.length) continue;
    const repl = [];
    for (const [off, o] of P.objectsWithOffsets(p)) {
      if (o.type !== 'field') continue;
      const row = cur < end ? cur : m.rows.length;
      const a = act(m, o.instr ?? '', row);
      if (!a) continue;
      if (a.skip) return {keep: false, cur};
      if (a.next) { cur = Math.min(cur + 1, end); repl.push([off, '']); } else repl.push([off, a.text]);
    }
    if (!repl.length) continue;
    const q = d.paraMut(story, path);
    for (const [off, val] of repl.reverse()) {
      const props = {...P.propsOfChar(q, off)};
      P.deleteRange(q, off, off + 1);
      if (val) P.insertText(q, off, val, props);
    }
  }
  return {keep: true, cur};
}

/** Point a letter's section at its own header/footer copies; the letter's first section starts on a new page (remap_headers). */
function remapHeaders(sp, map, first) {
  const out = {...sp, headers: {...sp.headers}, footers: {...sp.footers}};
  for (const set of [out.headers, out.footers]) {
    for (const k of ['default', 'first', 'even']) {
      const hit = map.find(([old]) => old === set[k]);
      if (set[k] !== null && set[k] !== undefined && hit) set[k] = hit[1];
    }
  }
  if (first) out.start = 'nextPage';
  return out;
}

const storyBlocks = (d, story) => { const bl = d.story(story); const out = []; for (let i = 0; i < bl.len(); i++) out.push(bl.get(i)); return out; };

/**
 * Build one merged copy per record: fields become plain text; records separated by page breaks
 * (letters) or new paragraphs (directory). A true SKIPIF drops the record's copy; NEXT moves the
 * rest of a copy to the next record, and the following copy starts after it. Headers and footers
 * are merged too: with merge fields in them each letter becomes its own section with its own
 * header/footer copies (finish). `content` is the template (schema-2 content); returns
 * {content, records}.
 */
export function mergeDocument(content, m, v, directory) {
  const [from, to] = mergeRange(m, v);
  const hf = Object.keys(content.parts ?? {}).filter(id => ['header', 'footer'].includes(content.parts[id].kind)
    && hasMergeFields(content.parts[id].blocks, 0)).map(Number);
  const perRecord = !directory && hf.length > 0;
  const out = new Document(content);
  const parts = {...content.parts};
  const body = [];
  let nextId = Object.keys(content.parts ?? {}).map(Number).reduce((a, b) => Math.max(a, b), 0) + 1;
  let start = from, count = 0, firstRecord = null, prevSection = null;
  while (start < to) {
    const d = new Document(content);
    const record = start;
    const r = mergeStory(d, m, BODY, start, to);
    start = r.cur + 1;
    if (!r.keep) continue;
    if (firstRecord === null) firstRecord = record;
    let blocks = storyBlocks(d, BODY).map(b => reId(b, newId));
    if (perRecord) {
      // This letter's own header/footer copies, merged with its record.
      const map = [];
      for (const id of hf) {
        const part = content.parts[id];
        if (nextId >= 0xffffffff) throw failed('too many headers and footers to merge');
        const dd = new Document(content);
        mergeStory(dd, m, id, record, to);
        parts[nextId] = {...part, blocks: dd.c.parts[id].blocks.map(b => reId(b, newId))};
        map.push([id, nextId]);
        nextId += 1;
      }
      let first = true;
      blocks = blocks.map(b => {
        if (b.kind === 'para' && b.section) { const x = {...b, section: remapHeaders(b.section, map, first)}; first = false; return x; }
        return b;
      });
      const last = remapHeaders(content.lastSection, map, first);
      const prev = prevSection;
      prevSection = last;
      if (prev) {
        if (body.at(-1)?.kind !== 'para') body.push(P.newParagraph(newId()));
        body[body.length - 1] = {...body.at(-1), section: prev};
      }
    } else if (count > 0 && !directory && body.at(-1)?.kind === 'para') {
      const p = {...body.at(-1)};
      const end = p.text.length;
      const props = {...P.propsAt(p, end)};
      P.insertText(p, end, '\u000C', props);
      body[body.length - 1] = p;
    }
    body.push(...blocks);
    count += 1;
    if (body.length > MAX_MERGED_BLOCKS) break;
  }
  let lastSection = content.lastSection;
  if (prevSection) {
    // The template's own header/footer stories are replaced by the letters' copies.
    for (const id of hf) delete parts[id];
    lastSection = prevSection;
  } else {
    // One shared header/footer (directory, or no letters): merged with the first record.
    const row = firstRecord ?? from;
    for (const id of hf) {
      const dd = new Document(content);
      mergeStory(dd, m, id, row, to);
      parts[id] = {...parts[id], blocks: dd.c.parts[id].blocks};
    }
  }
  out.setField('body', bodyFromBlocks(body));
  out.setField('parts', parts);
  out.setField('lastSection', lastSection);
  // A merged document is an ordinary one again.
  out.updateField('settings', s => { s.mailMerge = null; });
  out.ensureNonempty();
  return {content: out.content, records: count};
}
