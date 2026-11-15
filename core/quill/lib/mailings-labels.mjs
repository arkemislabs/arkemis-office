// Mailings › Create › Envelopes and Labels: an envelope (a landscape page with the return address at
// the top left and the delivery address in the middle), as a new document or as a section of its own
// at the start of this one; and a sheet of labels laid out like the product (a table of labels with
// spacer columns and rows for the gaps), a full page of the same label, one per recipient, or a single
// label at a row and column.
//
// Translated from wordcraft crates/engine/src/cmd/mailings/labels.rs (`ENVELOPE_SIZES`,
// `envelope_size`, `envelopes`, `LabelProduct`, `LABEL_PRODUCTS`, `labels`) and the form helpers of
// crates/ui-egui/src/dialogs/dialogs_layout/print.rs (`envelope_label`, `product_label`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {Document, BODY} from '../model/document.mjs';
import {createContent} from '../model/content.mjs';
import {defaultSection} from '../model/section.mjs';
import * as P from '../model/para.mjs';
import {newId} from '../model/ids.mjs';
import {addressBlock} from './mailings-merge.mjs';

/** Common envelope sizes: [name, width, height] in points (long side first). */
export const ENVELOPE_SIZES = Object.freeze([
  ['Envelope #10', 684.0, 297.0], ['Envelope #9', 639.0, 279.0], ['Envelope Monarch', 540.0, 279.0], ['Envelope DL', 623.6, 311.8],
  ['Envelope C4', 918.4, 649.1], ['Envelope C5', 649.1, 459.2], ['Envelope C6', 459.2, 323.1], ['Envelope B5', 708.7, 498.9],
]);

const params = m => new CommandError('invalid_params', m);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Envelope size by name (`Envelope DL`, or just `DL`, any case), or `width`/`height` in points (envelope_size). */
export function envelopeSize(v) {
  if (Number.isFinite(v.width) && Number.isFinite(v.height)) {
    const w = clamp(v.width, 144, 1584), h = clamp(v.height, 144, 1584);
    return [Math.max(w, h), Math.min(w, h)];
  }
  const name = String(v.size ?? 'Envelope #10').trim().toLowerCase();
  const hit = ENVELOPE_SIZES.find(([n]) => n.toLowerCase() === name || n.slice('Envelope '.length).toLowerCase() === name);
  if (!hit) throw params(`unknown envelope size \`${String(v.size).trim()}\``);
  return [hit[1], hit[2]];
}

/** Longest label or envelope address text accepted. */
export const MAX_LABEL_TEXT = 2000;
function labelText(v, key) {
  const t = v[key];
  if (typeof t !== 'string') return null;
  if ([...t].length > MAX_LABEL_TEXT) throw params(`\`${key}\` is longer than ${MAX_LABEL_TEXT} characters`);
  return t;
}

/** `DL   110 × 220 mm` / `#10   4.13 × 9.5 in`: metric sizes in millimetres, the others in inches (envelope_label). */
export function envelopeLabel([name, w, h]) {
  const short = name.replace(/^Envelope /, '');
  if (short.startsWith('#') || short === 'Monarch') {
    const i = pt => Math.round((pt / 72) * 100) / 100;
    return `${short}   ${i(h)} × ${i(w)} in`;
  }
  const mm = pt => Math.round((pt * 25.4) / 72);
  return `${short}   ${mm(h)} × ${mm(w)} mm`;
}

const para = (text, props, id, mk) => {
  const p = P.styled(P.paragraphWithText(text, props, mk()), 'NoSpacing');
  void id;
  return p;
};
const lines = t => t.split('\n').slice(0, 20);

/** The delivery address Envelopes starts with: the previewed recipient's address block, else a sample. */
export function defaultDelivery(m) {
  return m.rows.length ? addressBlock(m, m.record) : 'Recipient Name\nStreet Address\nCity, ST 00000';
}

/**
 * Envelopes: the blocks and the section of an envelope. `add` puts it at the start of `d`'s body as a
 * section of its own and returns {width, height, added}; without it returns a new document's content
 * {width, height, content} (envelopes).
 */
export function envelopes(d, m, v) {
  const delivery = labelText(v, 'delivery') ?? defaultDelivery(m);
  const ret = labelText(v, 'return') ?? '';
  const [w, h] = envelopeSize(v);
  const sect = {...defaultSection(), pageW: w, pageH: h, landscape: true, marginTop: 22, marginLeft: 22, marginRight: 22, marginBottom: 22};
  const mk = newId;
  const blocks = [];
  const retLines = ret === '' ? [] : lines(ret);
  for (const l of retLines) blocks.push(para(l, {size: 10}, null, mk));
  const spacer = Math.max(1, 6 - Math.min(retLines.length, 6));
  for (let i = 0; i < spacer + 2; i++) blocks.push(P.styled(P.newParagraph(mk()), 'NoSpacing'));
  let last = null;
  for (const l of lines(delivery)) {
    const p = para(l, {}, null, mk);
    p.props = {...p.props, indentLeft: w * 0.42};
    if (last) blocks.push(last);
    last = p;
  }
  if (v.add === true) {
    // The envelope's own section ends with its last address line.
    const end = last ?? P.styled(P.newParagraph(mk()), 'NoSpacing');
    blocks.push({...end, section: {...sect, id: mk()}});
    d.storyMut(BODY).splice(0, 0, blocks);
    return {width: w, height: h, added: blocks.length};
  }
  if (last) blocks.push(last);
  const nd = new Document(createContent(blocks));
  nd.setField('lastSection', {...sect, id: nd.c.lastSection.id});
  nd.ensureNonempty();
  return {width: w, height: h, content: nd.content};
}

const MM = 72 / 25.4;
const prod = (id, kind, paper, cols, rows, width, height, top, side, hPitch, vPitch) => ({id, kind, paper, cols, rows, width, height, top, side, hPitch, vPitch});

/** Common label sheets (the sizes are the industry's; the names are ours): width, height, top margin, side margin and the pitch in points. */
export const LABEL_PRODUCTS = Object.freeze([
  prod('letter-3x10', 'address', 'Letter', 3, 10, 189, 72, 36, 13.5, 198, 72),
  prod('letter-2x10', 'address', 'Letter', 2, 10, 288, 72, 36, 11.25, 301.5, 72),
  prod('letter-2x7', 'address', 'Letter', 2, 7, 288, 96, 60, 11.25, 301.5, 96),
  prod('letter-2x5', 'shipping', 'Letter', 2, 5, 288, 144, 36, 11.25, 301.5, 144),
  prod('letter-4x20', 'return', 'Letter', 4, 20, 126, 36, 36, 21.6, 147.6, 36),
  prod('a4-3x7', 'address', 'A4', 3, 7, 63.5 * MM, 38.1 * MM, 15.15 * MM, 7.21 * MM, 66.04 * MM, 38.1 * MM),
  prod('a4-2x7', 'address', 'A4', 2, 7, 99.1 * MM, 38.1 * MM, 15.15 * MM, 4.65 * MM, 101.6 * MM, 38.1 * MM),
  prod('a4-3x8', 'address', 'A4', 3, 8, 63.5 * MM, 33.9 * MM, 12.9 * MM, 7.21 * MM, 66.04 * MM, 33.9 * MM),
  prod('a4-2x4', 'shipping', 'A4', 2, 4, 99.1 * MM, 67.7 * MM, 13.1 * MM, 4.65 * MM, 101.6 * MM, 67.7 * MM),
]);

export const labelProduct = id => LABEL_PRODUCTS.find(p => p.id === id) ?? null;

/** `Address labels, 3 × 10, 2.625" × 1" (Letter)` (product_label). */
export function productLabel(p) {
  const kind = p.kind === 'shipping' ? 'Shipping labels' : p.kind === 'return' ? 'Return address labels' : 'Address labels';
  const size = p.paper === 'A4' ? `${(p.width / MM).toFixed(1)} × ${(p.height / MM).toFixed(1)} mm`
    : `${Math.round((p.width / 72) * 1000) / 1000}" × ${Math.round((p.height / 72) * 1000) / 1000}"`;
  return `${kind}, ${p.cols} × ${p.rows}, ${size} (${p.paper})`;
}

/**
 * Labels: a new document with a table of labels laid out like the sheet (`product`; spacer columns and
 * rows stand for the gaps): a full page of the same `text` (or one recipient per label), or (`single`:
 * `{row, col}`, from 1) one label at that place on the sheet. Returns {labels, filled, product, content}.
 */
export function labels(m, v) {
  let p = LABEL_PRODUCTS[0];
  if (typeof v.product === 'string') {
    p = labelProduct(v.product);
    if (!p) throw params(`unknown label product \`${v.product}\``);
  }
  const rows = Number.isFinite(v.rows) ? clamp(Math.floor(v.rows), 1, 40) : p.rows;
  const cols = Number.isFinite(v.cols) ? clamp(Math.floor(v.cols), 1, 10) : p.cols;
  const single = v.single ? (() => { const at = k => Math.max(1, Math.floor(v.single[k] ?? 1) || 1); return [Math.min(at('row'), rows), Math.min(at('col'), cols)]; })() : null;
  const fromRec = single === null && (typeof v.fromRecipients === 'boolean' ? v.fromRecipients : m.rows.length > 0 && typeof v.text !== 'string');
  const text = labelText(v, 'text') ?? 'Name\nAddress\nCity, ST 00000';
  const [pageW, pageH] = p.paper === 'A4' ? [595.3, 841.9] : [612, 792];
  const hGap = Math.max(0, p.hPitch - p.width), vGap = Math.max(0, p.vPitch - p.height);
  // Grid columns: label, gap, label, …; rows likewise.
  const gridCols = [], gridRows = [];
  for (let c = 0; c < cols; c++) { gridCols.push(c); if (c + 1 < cols && hGap > 0.5) gridCols.push(null); }
  for (let r = 0; r < rows; r++) { gridRows.push(r); if (r + 1 < rows && vGap > 0.5) gridRows.push(null); }
  const colW = c => (c === null ? hGap : p.width);
  const width = gridCols.reduce((s, c) => s + colW(c), 0);
  void width;
  let k = 0, made = 0;
  const tableRows = gridRows.map(r => {
    const cells = gridCols.map(c => {
      const cellProps = {span: 1, width: colW(c)};
      if (r === null || c === null) return {id: newId(), props: cellProps, blocks: [P.newParagraph(newId())]};
      let content;
      if (single && (single[0] !== r + 1 || single[1] !== c + 1)) content = '';
      else if (fromRec) { content = k < m.rows.length ? addressBlock(m, k) : ''; k += 1; } else content = text;
      if (content) made += 1;
      cellProps.valign = 'center';
      const blocks = (content === '' ? [''] : lines(content)).map(l => {
        const q = P.styled(P.paragraphWithText(l, {}, newId()), 'NoSpacing');
        q.props = {...q.props, align: 'left', indentLeft: 9};
        return q;
      });
      return {id: newId(), props: cellProps, blocks};
    });
    return {id: newId(), props: {height: r === null ? vGap : p.height, heightRule: 'exact'}, cells};
  });
  const table = {kind: 'table', id: newId(), props: {borders: {}, fixed: true}, grid: gridCols.map(colW), rows: tableRows};
  const nd = new Document(createContent([table, P.newParagraph(newId())]));
  nd.setField('lastSection', {...nd.c.lastSection, pageW, pageH, marginTop: p.top, marginBottom: 0, marginLeft: p.side,
    marginRight: Math.max(0, pageW - p.side - p.hPitch * (cols - 1) - p.width), header: 0, footer: 0});
  nd.ensureNonempty();
  return {labels: single ? 1 : rows * cols, filled: made, product: p.id, content: nd.content};
}
