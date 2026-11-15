// Insert Hyperlink dialog model (submit: insert.link).
// Excel's Insert Hyperlink (Existing File or Web Page, Place in This Document, E-mail Address;
// Display, ScreenTip, Remove Link) on gridcraft's link dialog (crates/ui-egui/src/dialogs.rs,
// `insertLink`) and cmd/insert/links.rs at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Create New Document is not offered.
//
// Values: linkTo (web, place, email), text (Display), target (address, or the e-mail address),
// tooltip, cellReference, place (the sheet), emailSubject, plus `places` for the body's list.

import {defineDialog} from '../../kernel/dialog.mjs';
import {a1, parseRange} from '../lib/addr.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import {cellAt} from '../model/store.mjs';
import {displayAt} from '../model/index.mjs';

export default defineDialog({
  id: 'dialog.insertLink',
  title: 'Insert Hyperlink',
  command: 'insert.link',
  init(ctx) {
    const content = baseDoc(ctx);
    const sel = gridSel(ctx);
    const sheet = content.sheets[sel.sheet];
    const key = a1(sel.active.row, sel.active.col);
    const h = sheet.hyperlinks?.[key];
    const c = cellAt(sheet, sel.active.row, sel.active.col);
    const text = c && (c.v !== undefined || c.f !== undefined) ? displayAt(content, sel.sheet, sel.active.row, sel.active.col).text : '';
    const places = {sheets: content.sheets.map(s => s.name), names: (content.names ?? []).filter(n => !n.hidden).map(n => n.name)};
    const base = {linkTo: 'web', text, target: 'https://', tooltip: h?.tooltip ?? '', cellReference: 'A1', place: sheet.name, emailSubject: '', places, hasLink: !!h};
    if (h?.location) {
      const at = h.location.lastIndexOf('!');
      return {...base, linkTo: 'place', cellReference: at >= 0 ? h.location.slice(at + 1) : h.location, place: at >= 0 ? h.location.slice(0, at).replace(/^'|'$/g, '').replace(/''/g, "'") : sheet.name};
    }
    if (h?.target) {
      const m = /^mailto:([^?]*)(?:\?subject=(.*))?$/i.exec(h.target);
      if (m) return {...base, linkTo: 'email', target: decodeURIComponent(m[1]), emailSubject: m[2] ? decodeURIComponent(m[2]) : ''};
      return {...base, target: h.target};
    }
    return base;
  },
  validate(v) {
    if (v.linkTo === 'place') {
      const r = parseRange(String(v.cellReference ?? '').replace(/\$/g, ''));
      return r ? [] : [{field: 'cellReference', message: 'Type a cell reference, for example A1.'}];
    }
    const t = String(v.target ?? '').trim();
    if (v.linkTo === 'email') return t ? [] : [{field: 'target', message: 'Type an e-mail address.'}];
    return t && t !== 'https://' ? [] : [{field: 'target', message: 'Type the address to link to.'}];
  },
  toCommand(v) {
    let target;
    if (v.linkTo === 'place') {
      const sheet = String(v.place ?? '');
      const q = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
      target = `${q}!${String(v.cellReference).replace(/\$/g, '').toUpperCase()}`;
    } else if (v.linkTo === 'email') {
      const subject = String(v.emailSubject ?? '').trim();
      target = `mailto:${String(v.target).trim()}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
    } else target = String(v.target).trim();
    const params = {target};
    if (String(v.text ?? '') !== '') params.text = String(v.text);
    if (String(v.tooltip ?? '') !== '') params.tooltip = String(v.tooltip);
    return {command: 'insert.link', params};
  },
  buttons: {'Remove Link': () => ({command: 'insert.link', params: {remove: true}, close: true})},
});
