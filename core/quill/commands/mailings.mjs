// Mailings tab (U:quill/mailings): Envelopes and Labels, Start Mail Merge, Select Recipients and
// Edit Recipient List (filter and sort), Insert Merge Field, Address Block, Greeting Line, Rules,
// Match Fields, Highlight Merge Fields, Preview Results with the record buttons, Find Recipient,
// Check for Errors and Finish & Merge.
//
// Translated from wordcraft crates/engine/src/cmd/mailings.rs (`specs`, `insert_field`, `quote`),
// mailings/merge.rs, mailings/recipients.rs, mailings/filter.rs and mailings/labels.rs at
// aadb077e072b7de05f724e359d8db82e151f125c; the engine is in core/quill/lib/mailings-merge.mjs,
// mailings-sheet.mjs and mailings-labels.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The recipient list, its filter and sort, the previewed record and Highlight Merge Fields are the
// document's view state (`view.merge`), as upstream keeps them in the session; the kind of merge is
// the document's `settings.mailMerge.kind` (saved as w:mailMerge). A file is read by its bytes (`data`,
// base64, with `path` naming it): commands never read the disk; the window's Open dialog (src/apps/quill/
// ui-commands/mailings.ts) hands the bytes over. Not here (their controls stay hidden): Print Documents
// and Send Email Messages (no printing, no mail), Ask, Fill-in, Merge Sequence #, Set Bookmark, Update
// Labels, the Step-by-Step Wizard and Outlook contacts (no upstream engine), and .xls workbooks.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import * as T from '../lib/table-session.mjs';
import {UPSTREAM_COMMIT} from '../lib/caret-session.mjs';
import {decode, decodeAs, isText} from '../formats/txt-read.mjs';
import * as sheet from '../lib/mailings-sheet.mjs';
import {
  MERGE_KINDS, emptyMerge, kindOf, mergeOf, viewMerge, parseCsv, tableFromRows, headerSplit, applyFilter, parseRules, parseSort, rulesJson, sortJson,
  mergefieldName, addressMap, mergeFields, refreshDoc, mergeRange, mergeDocument,
} from '../lib/mailings-merge.mjs';
import {envelopes, labels} from '../lib/mailings-labels.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/mailings.rs', 'crates/engine/src/cmd/mailings/merge.rs',
  'crates/engine/src/cmd/mailings/recipients.rs', 'crates/engine/src/cmd/mailings/filter.rs', 'crates/engine/src/cmd/mailings/labels.rs']};

const NONE = s.object({});
const bad = m => new CommandError('invalid_params', m);
const failed = m => new CommandError('failed', m);
const ready = T.ready;

const hasRecipients = ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return mergeOf(ctx).rows.length ? {enabled: true} : {enabled: false, reason: 'Select recipients first'};
};
/** Edit Recipient List needs a list to edit (fields, even with no entries yet). */
const hasList = ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  const m = mergeOf(ctx);
  return m.headers.length || m.rows.length ? {enabled: true} : {enabled: false, reason: 'Select recipients first'};
};

/** Whether the document's protection keeps merge commands from touching it (protect::enforced). */
const enforced = c => !!c?.settings?.protection && c.settings.protection !== 'trackedChanges';

/** Keep `m` in the view and bring the merge fields in the document up to date (refresh_shown). */
function put(ctx, m, {refresh = true} = {}) {
  ctx.setView({merge: viewMerge(m)});
  if (refresh && !enforced(ctx.doc)) ctx.model.edit(ctx, d => { refreshDoc(d, m); });
}

// ---- start --------------------------------------------------------------------------------------------

function start(ctx, p) {
  const kind = String(p.kind ?? 'letters').trim().toLowerCase();
  if (!MERGE_KINDS.includes(kind)) throw bad(`\`kind\` must be one of ${MERGE_KINDS.join(', ')}`);
  if (kindOf(ctx.doc) !== (kind === 'normal' ? '' : kind)) {
    ctx.model.edit(ctx, d => { d.updateField('settings', st => { st.mailMerge = kind === 'normal' ? null : {kind}; }); });
  }
  return {kind};
}

// ---- recipients (recipients.rs) ----------------------------------------------------------------------------

function base64Bytes(text) {
  const t = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) throw bad('`data` isn\'t valid base64');
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { throw bad('`data` isn\'t valid base64'); }
}
const extensionOf = path => (/\.([^./\\]+)$/.exec(String(path ?? ''))?.[1] ?? '').toLowerCase();

/** A text recipient list's characters: in `encoding` when given (a label such as gbk, big5, shift_jis, utf-16le), else as detected (decode). */
function decodeList(bytes, p) {
  const label = typeof p.encoding === 'string' ? p.encoding.trim() : '';
  if (!label) return decode(bytes);
  const text = decodeAs(bytes, label);
  if (text === null) throw bad(`unknown \`encoding\` \`${label}\``);
  return text;
}

/** The table a `mailings.recipients` call names: {headers, rows, sheet?} or {sheets, chooseSheet: true} (recipients). */
async function loadTable(p) {
  if (Array.isArray(p.rows)) return {table: tableFromRows(p.fields, p.rows)};
  let all;
  let sheetName = null;
  if (typeof p.csv === 'string') all = parseCsv(p.csv);
  else {
    let bytes, ext;
    if (typeof p.data === 'string') { bytes = base64Bytes(p.data.trim()); ext = typeof p.path === 'string' ? extensionOf(p.path) : null; }
    else if (typeof p.path === 'string') throw failed('this command reads the file\'s bytes: pass them as `data` (base64) and the file\'s name as `path`');
    else throw bad('`csv`, `path`, `data` or `rows` required');
    // A spreadsheet by its contents, or by its name unless it is really text (a CSV or tab-separated export named .xls, as some programs write).
    const named = !!ext && sheet.isExtension(ext);
    const text = isText(bytes);
    const kind = await sheet.detect(bytes);
    const spreadsheet = kind !== null || (named && !text);
    if (named && !spreadsheet) {
      const t = decodeList(bytes, p).trimStart().replace(/^﻿/, '');
      if (t.startsWith('<?xml')) throw failed('this spreadsheet file is an XML spreadsheet, not a workbook; open it in a spreadsheet program, save it as .xlsx or .csv and select it again');
      if (t.startsWith('<')) throw failed('this spreadsheet file is a web page (HTML), not a workbook; open it in a spreadsheet program, save it as .xlsx or .csv and select it again');
    }
    if (spreadsheet) {
      let pick;
      try {
        if (typeof p.sheet === 'string') pick = p.sheet;
        else if (typeof p.sheet === 'number' && Number.isInteger(p.sheet) && p.sheet >= 1) pick = p.sheet - 1;
        else if (p.sheet === undefined || p.sheet === null) {
          const names = await sheet.sheetNames(bytes);
          if (names.length > 1) return {choose: names};
          pick = 0;
        } else throw bad('`sheet` must be a sheet name or number');
        const [names, rows] = await sheet.readRows(bytes, pick);
        sheetName = typeof pick === 'number' ? names[pick] ?? null : names.find(x => x === pick) ?? names.find(x => x.toLowerCase() === pick.trim().toLowerCase()) ?? null;
        all = rows;
      } catch (e) { throw e instanceof CommandError ? e : failed(e?.message ?? String(e)); }
    } else all = parseCsv(decodeList(bytes, p));
  }
  return {table: headerSplit(all, p.headers !== false), sheetName};
}

async function recipients(ctx, p) {
  const r = await loadTable(p);
  if (r.choose) return {sheets: r.choose, chooseSheet: true};
  const [headers, rows] = r.table;
  const m = {...mergeOf(ctx), headers, source: rows, rows, filter: [], sort: [], record: 0};
  const next = applyFilter({...m, rows});
  put(ctx, next);
  const out = {fields: headers, records: next.rows.length};
  if (r.sheetName) out.sheet = r.sheetName;
  return out;
}

function editRecipients(ctx, p) {
  const m = mergeOf(ctx);
  if (Array.isArray(p.rows)) {
    // Edited records keep the list's filter and sort (rules on removed fields drop); a list that fails to load leaves them as they were.
    const [headers, rows] = tableFromRows(p.fields, p.rows);
    const next = applyFilter({...m, headers, source: rows, rows, record: 0});
    put(ctx, next);
    return {fields: headers, records: next.rows.length, of: next.source.length};
  }
  return {headers: m.headers, rows: m.source, records: m.rows.length, rules: rulesJson(m), sort: sortJson(m)};
}

const filterResult = m => ({records: m.rows.length, of: m.source.length, rules: rulesJson(m), sort: sortJson(m)});

function filterRecipients(ctx, p) {
  const m = mergeOf(ctx);
  const filter = parseRules(m.headers, p.rules);
  const sort = p.sort !== undefined ? parseSort(m.headers, p.sort) : p.rules === undefined ? [] : m.sort;
  const next = applyFilter({...m, filter, sort});
  put(ctx, next);
  return filterResult(next);
}

function sortRecipients(ctx, p) {
  const m = mergeOf(ctx);
  const sort = parseSort(m.headers, p.sort ?? (p.field !== undefined ? p : undefined));
  const next = applyFilter({...m, sort});
  put(ctx, next);
  return filterResult(next);
}

// ---- inserting fields (insert_field) -----------------------------------------------------------------------

const quote = f => (f.includes(' ') ? `"${f}"` : f);

/** A merge field at the caret (the selection is replaced), shown as `result` (a «Field» placeholder, or the record's value in a preview). */
function insertField(ctx, instr, result) {
  const S = T.open(ctx);
  const props = T.typingProps(S);
  const at = T.deleteSelection(S);
  const end = S.d.insertObject(at, {type: 'field', instr, result, locked: false}, props);
  T.setCaret(S, end);
  refreshDoc(S.d, mergeOf(ctx));
  return T.finish(S);
}

function rules(ctx, p) {
  const rule = String(p.rule ?? 'NEXT').toUpperCase();
  const f = quote(p.field ?? 'Field');
  let instr;
  switch (rule) {
    case 'IF': instr = `IF { MERGEFIELD ${f} } = "${p.value ?? ''}" "${p.then ?? ''}" "${p.else ?? ''}"`; break;
    case 'SKIPIF': case 'NEXTIF': instr = `${rule} { MERGEFIELD ${f} } = "${p.value ?? ''}"`; break;
    case 'MERGEREC': instr = 'MERGEREC'; break;
    default: instr = 'NEXT';
  }
  return insertField(ctx, instr, '');
}

// ---- preview and records ------------------------------------------------------------------------------------

function goTo(ctx, idx) {
  const m = mergeOf(ctx);
  const n = Math.max(1, m.rows.length);
  const record = Math.min(n - 1, Math.max(0, idx));
  put(ctx, {...m, record, preview: true});
  return {record: record + 1, of: n};
}

function parseRecord(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v.trim(), 10);
  return null;
}

function findRecipient(ctx, p) {
  const m = mergeOf(ctx);
  const q = String(p.text ?? '').toLowerCase();
  const idx = m.rows.findIndex(r => r.some(c => c.toLowerCase().includes(q)));
  if (idx < 0) throw failed('no matching recipient');
  put(ctx, {...m, record: idx, preview: true});
  return {record: idx + 1};
}

function checkErrors(ctx) {
  const m = mergeOf(ctx);
  const d = ctx.model.open(ctx);
  const missing = mergeFields(d).filter(f => !m.headers.some(h => h.toLowerCase() === f.toLowerCase()));
  return {ok: missing.length === 0, unknownFields: missing, records: m.rows.length};
}

// ---- finish & merge -----------------------------------------------------------------------------------------

const TITLES = {letters: 'Letters', emails: 'E-mail Messages', envelopes: 'Envelopes', labels: 'Labels', directory: 'Directory'};

async function finish(ctx, p) {
  const m = mergeOf(ctx);
  mergeRange(m, p);
  const merged = mergeDocument(ctx.doc, m, p, m.kind === 'directory');
  const files = ctx.host?.files;
  if (!files) throw new CommandError('unavailable', 'The merged document needs the document service, which is not available here');
  if (typeof p.path === 'string' && p.path) {
    const ext = extensionOf(p.path) || 'docx';
    await files.write(ctx.docId, {...ctx.file, content: merged.content}, {path: p.path, format: ext, bind: false, mode: 'copy'});
    return {records: merged.records, path: p.path};
  }
  const made = await files.create('quill', {show: ctx.origin !== 'bridge', title: `${TITLES[m.kind] ?? 'Letters'}1`, content: merged.content});
  return {records: merged.records, doc: made?.doc, name: made?.name};
}

/** Print Documents (mailings.printDocuments): the merge into a new document, as Finish & Merge makes it, and the Print page opened for it. */
async function printDocuments(ctx, p) {
  const {path: _path, ...rest} = p ?? {};
  const r = await finish(ctx, rest);
  try { if (r.doc && typeof ctx.host?.files?.show === 'function') ctx.host.files.show('print', r.doc); } catch { /* the page is the window's */ }
  return {...r, ui: {open: 'print'}};
}

// ---- envelopes and labels --------------------------------------------------------------------------------

async function newDocument(ctx, content, title) {
  const files = ctx.host?.files;
  if (!files) throw new CommandError('unavailable', 'A new document needs the document service, which is not available here');
  return files.create('quill', {show: ctx.origin !== 'bridge', title, content});
}

async function envelopesCommand(ctx, p) {
  const m = mergeOf(ctx);
  if (p.add === true) {
    return ctx.model.edit(ctx, d => {
      const r = envelopes(d, m, p);
      return r;
    });
  }
  const r = envelopes(ctx.model.open(ctx), m, p);
  const made = await newDocument(ctx, r.content, 'Envelopes1');
  return {width: r.width, height: r.height, doc: made?.doc};
}

async function labelsCommand(ctx, p) {
  const r = labels(mergeOf(ctx), p);
  const made = await newDocument(ctx, r.content, 'Labels1');
  return {labels: r.labels, filled: r.filled, product: r.product, doc: made?.doc};
}

// ---- the family ---------------------------------------------------------------------------------------------

const RECORD = s.object({record: s.union([s.number(), s.string({max: 64})])});
const columnList = ctx => {
  const r = ready(ctx);
  if (!r.enabled) return r;
  return {enabled: true, value: mergeOf(ctx).headers.map(h => ({id: h, label: h, value: h}))};
};

export default defineCommands({
  family: 'mailings',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    // ---- Create ----
    {id: 'mailings.envelopes', label: 'Envelopes', risk: 'edit', state: ready, dialog: 'dialog.envelopes',
      description: 'Envelopes: an envelope of the chosen size (a landscape page: return address top left, delivery address in the middle) as a new document, or `add` it as a section of its own at the start of this document.',
      params: s.object({delivery: s.optional(s.string({max: 100000})), return: s.optional(s.string({max: 100000})), size: s.optional(s.string({max: 64})),
        width: s.optional(s.number()), height: s.optional(s.number()), add: s.optional(s.boolean())}),
      run: envelopesCommand},
    {id: 'mailings.labels', label: 'Labels', risk: 'edit', state: ready, dialog: 'dialog.labels',
      description: 'Labels: a new document with a sheet of labels (`product`), a full page of the same `text` (or one recipient per label), or one label at `single` {row, col}.',
      params: s.object({text: s.optional(s.string({max: 100000})), product: s.optional(s.string({max: 64})), rows: s.optional(s.number()), cols: s.optional(s.number()),
        fromRecipients: s.optional(s.boolean()), single: s.optional(s.nullable(s.object({row: s.optional(s.number()), col: s.optional(s.number())})))}),
      run: labelsCommand},
    // ---- Start Mail Merge ----
    {id: 'mailings.start', label: 'Start Mail Merge', risk: 'edit', state: (ctx, p) => {
      const r = ready(ctx);
      if (!r.enabled) return r;
      if (!p?.kind) return {enabled: true};
      const cur = kindOf(ctx.doc);
      return {enabled: true, checked: cur === p.kind || (p.kind === 'normal' && cur === '')};
    },
    description: 'Start Mail Merge: the kind of merge document (letters, emails, envelopes, labels, directory, or normal: an ordinary document again).',
    params: s.object({kind: s.optional(s.string({max: 32}))}), run: start},
    {id: 'mailings.recipients', label: 'Select Recipients', risk: 'edit', state: ready, dialog: 'dialog.recipientList',
      description: 'Select Recipients: the recipient list from `csv` text, a file\'s bytes (`data`, base64; `path` names it: .csv/.tsv/.txt, or an .xlsx/.xlsm/.ods workbook) or `rows` (with `fields`). A workbook with several sheets and no `sheet` answers {sheets, chooseSheet: true} and loads nothing.',
      params: s.object({csv: s.optional(s.string({max: 100 << 20})), path: s.optional(s.string({max: 4096})), data: s.optional(s.string({max: 200 << 20})),
        encoding: s.optional(s.string({max: 64})), sheet: s.optional(s.nullable(s.union([s.string({max: 255}), s.number()]))), headers: s.optional(s.boolean()),
        rows: s.optional(s.array(s.any())), fields: s.optional(s.array(s.any()))}),
      run: recipients},
    {id: 'mailings.editRecipients', label: 'Edit Recipient List', shortcut: 'Alt+Shift+E', risk: 'edit', state: hasList, dialog: 'dialog.recipientList',
      description: 'Edit Recipient List: with `rows` (and `fields`) the list becomes those records and keeps its filter and sort; without params the list as {headers, rows (every record), records (how many merge), rules, sort}.',
      params: s.object({rows: s.optional(s.array(s.any())), fields: s.optional(s.array(s.any()))}), run: editRecipients},
    {id: 'mailings.filterRecipients', label: 'Filter Recipients', risk: 'edit', state: hasList,
      description: 'Filter Recipients: `rules` [{field, op (equal, notEqual, less, greater, lessOrEqual, greaterOrEqual, blank, notBlank, contains, notContains), value, join (and|or)}] replace the filter (and `sort` the sort when given; {} clears both). Preview, Finish & Merge and labels use only the matching records, in sort order.',
      params: s.object({rules: s.optional(s.nullable(s.any())), sort: s.optional(s.nullable(s.any()))}), run: filterRecipients},
    {id: 'mailings.sortRecipients', label: 'Sort Recipients', risk: 'edit', state: hasList,
      description: 'Sort Recipients: `sort` [{field, descending}] (or one {field, descending}); with none, the list\'s own order.',
      params: s.object({sort: s.optional(s.nullable(s.any())), field: s.optional(s.string({max: 1000})), descending: s.optional(s.boolean())}), run: sortRecipients},
    // ---- Write & Insert Fields ----
    {id: 'mailings.insertField', label: 'Insert Merge Field', shortcut: 'Alt+Shift+F', risk: 'edit', state: columnList, dialog: 'dialog.insertMergeField',
      description: 'Insert Merge Field: a MERGEFIELD for the recipient-list field `field` at the caret.',
      params: s.object({field: s.string({min: 1, max: 4000, trim: true})}),
      run: (ctx, p) => insertField(ctx, `MERGEFIELD ${quote(p.field)}`, `«${p.field}»`)},
    {id: 'mailings.addressBlock', label: 'Address Block', risk: 'edit', state: ready,
      description: 'Address Block: an ADDRESSBLOCK field (name, company, street, city line, country from the matched fields).',
      params: NONE, run: ctx => insertField(ctx, 'ADDRESSBLOCK', '«AddressBlock»')},
    {id: 'mailings.greetingLine', label: 'Greeting Line', risk: 'edit', state: ready,
      description: 'Greeting Line: a GREETINGLINE field ("Dear First Last,").', params: NONE, run: ctx => insertField(ctx, 'GREETINGLINE', '«GreetingLine»')},
    {id: 'mailings.rules', label: 'Rules', risk: 'edit', state: ready, dialog: 'dialog.mergeRule',
      description: 'Rules: an IF (field, value, then, else), SKIPIF or NEXTIF (field, value), NEXT or MERGEREC field at the caret.',
      params: s.object({rule: s.optional(s.string({max: 16})), field: s.optional(s.string({max: 4000})), value: s.optional(s.string({max: 4000})),
        then: s.optional(s.string({max: 4000})), else: s.optional(s.string({max: 4000}))}),
      run: rules},
    {id: 'mailings.matchFields', label: 'Match Fields', risk: 'read', state: ready, dialog: 'dialog.matchFields',
      description: 'Match Fields: the recipient-list field that fills each part of an address block and greeting line: {fields, address}.',
      params: NONE, run: ctx => { const m = mergeOf(ctx); return {fields: m.headers, address: addressMap(m.headers)}; }},
    {id: 'mailings.highlightFields', label: 'Highlight Merge Fields', risk: 'read', effect: 'view',
      state: ctx => { const r = ready(ctx); return r.enabled ? {enabled: true, checked: !!mergeOf(ctx).highlight} : r; },
      description: 'Highlight Merge Fields: the merge fields are shaded in the document (or back); `value` sets it.',
      params: s.object({value: s.optional(s.boolean())}),
      run: (ctx, p) => { const m = mergeOf(ctx); const value = p.value ?? !m.highlight; ctx.setView({merge: viewMerge({...m, highlight: value})}); return {value}; }},
    // ---- Preview Results ----
    {id: 'mailings.preview', label: 'Preview Results', shortcut: 'Alt+Shift+K', risk: 'edit',
      state: ctx => { const r = hasRecipients(ctx); return r.enabled ? {enabled: true, checked: !!mergeOf(ctx).preview} : r; },
      description: 'Preview Results: the merge fields show the previewed record\'s values (or their «names» again); `value` sets it.',
      params: s.object({value: s.optional(s.boolean())}),
      run: (ctx, p) => { const m = mergeOf(ctx); const next = {...m, preview: p.value ?? !m.preview}; put(ctx, next); return {preview: next.preview, record: next.record + 1}; }},
    {id: 'mailings.next', label: 'Next Record', risk: 'edit', state: hasRecipients, description: 'Next Record: previews the next record.', params: NONE,
      run: ctx => goTo(ctx, mergeOf(ctx).record + 1)},
    {id: 'mailings.previous', label: 'Previous Record', risk: 'edit', state: hasRecipients, description: 'Previous Record: previews the previous record.', params: NONE,
      run: ctx => goTo(ctx, mergeOf(ctx).record - 1)},
    {id: 'mailings.first', label: 'First Record', risk: 'edit', state: hasRecipients, description: 'First Record: previews the first record.', params: NONE, run: ctx => goTo(ctx, 0)},
    {id: 'mailings.last', label: 'Last Record', risk: 'edit', state: hasRecipients, description: 'Last Record: previews the last record.', params: NONE, run: ctx => goTo(ctx, Number.MAX_SAFE_INTEGER)},
    {id: 'mailings.goToRecord', label: 'Go to Record', risk: 'edit',
      state: ctx => { const r = hasRecipients(ctx); return r.enabled ? {enabled: true, value: mergeOf(ctx).record + 1} : r; },
      description: 'Go to Record: previews record `record` (1 = the first; past either end goes to the first or last record).', params: RECORD,
      run: (ctx, p) => {
        const n = parseRecord(p.record);
        if (n === null) throw bad('`record` must be a record number (1 = the first)');
        return goTo(ctx, n - 1);
      }},
    {id: 'mailings.findRecipient', label: 'Find Recipient', risk: 'edit', state: hasRecipients, dialog: 'dialog.findRecipient',
      description: 'Find Recipient: previews the first record with a field containing `text` (any case).', params: s.object({text: s.string({min: 1, max: 4000})}), run: findRecipient},
    // ---- Finish ----
    {id: 'mailings.checkErrors', label: 'Check for Errors', risk: 'read', state: ready, dialog: 'dialog.checkErrors',
      description: 'Check for Errors: the merge fields that are not in the recipient list: {ok, unknownFields, records}.', params: NONE, run: checkErrors},
    {id: 'mailings.finish', label: 'Finish & Merge', shortcut: 'Alt+Shift+N', risk: 'edit', effect: 'persist', undo: 'none', state: hasRecipients, dialog: 'dialog.mergeRecords',
      riskFor: (ctx, p) => (p?.path ? 'irreversible' : 'edit'),
      summary: (ctx, p) => (p?.path ? `Save the merged documents to ${p.path}` : 'Merge the recipients into a new document'),
      description: 'Finish & Merge › Edit Individual Documents: a new document with one merged copy per record (all, the `current` one, or `from` to `to` by record number); with `path` the merged copy is saved there instead.',
      params: s.object({path: s.optional(s.string({max: 4096})), records: s.optional(s.string({max: 16})), from: s.optional(s.number()), to: s.optional(s.number())}),
      run: finish},
    {id: 'mailings.printDocuments', label: 'Print Documents', shortcut: 'Alt+Shift+M', risk: 'edit', effect: 'persist', undo: 'none', state: hasRecipients, dialog: 'dialog.printRecords',
      description: 'Finish & Merge › Print Documents (wordcraft mailings.printDocuments): merges into a new document, as Finish & Merge does (all, the `current` record, or `from` to `to`), and opens Print for it.',
      params: s.object({records: s.optional(s.string({max: 16})), from: s.optional(s.number()), to: s.optional(s.number())}),
      run: printDocuments},
  ],
});

export {emptyMerge, mergefieldName};
