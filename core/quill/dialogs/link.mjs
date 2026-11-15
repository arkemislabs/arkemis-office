// Insert › Links › Link (Ctrl+K; submit: insert.link).
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`link_dialog`: Link to Existing
// File or Web Page / Place in This Document (Top of the Document, Headings, Bookmarks from
// link.targets), Text to display, Address; OK runs insert.link with {url} or the place, and the
// text) at aadb077e072b7de05f724e359d8db82e151f125c. Word's Remove Link button runs
// insert.removeLink when the selection is a link. E-mail Address makes a mailto: link (Word's, not
// upstream: not checked against upstream); Create New Document has no upstream command, so it is not offered (behaviour fidelity).
// Browse for File, Bookmark… (Select Place in Document) and ScreenTip… (saved as w:tooltip) are drawn by src/apps/quill/dialogs/link.tsx.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import * as P from '../model/para.mjs';
import {headings} from '../commands/insert.mjs';

/** The places in this document a link can go to: [{value, label, level}] (link.targets). */
export function placeOptions(targets) {
  const out = [{value: JSON.stringify({top: true}), label: 'Top of the Document', level: 0}];
  for (const h of targets.headings ?? []) out.push({value: JSON.stringify({heading: h.address ?? h.block}), label: `${'  '.repeat(Math.max(0, (h.level ?? 1) - 1))}${h.text}`, level: h.level});
  for (const b of targets.bookmarks ?? []) out.push({value: JSON.stringify({bookmark: b}), label: b, level: 0});
  return out;
}

/** The top of the document, its headings and its bookmarks as the place list (link.targets). */
export function placesOf(ctx) {
  const S = T.open(ctx);
  const hs = headings(S.d).map(([block, level, htext]) => ({block, level, text: htext,
    address: ctx.model.addressOf(ctx, {story: 'body', path: [block], off: 0}).replace(/\/t:.*$/, '')}));
  const bookmarks = [...new Set(S.d.bookmarks().map(([n]) => n).filter(n => !n.startsWith('_')))];
  return placeOptions({headings: hs, bookmarks});
}

export default defineDialog({
  id: 'dialog.link',
  title: 'Insert Hyperlink',
  command: 'insert.link',
  init(ctx) {
    const S = T.open(ctx);
    const [a, b] = T.ordered(S.sel);
    let text = '', address = '', tip = '';
    if (!T.isCollapsed(S.sel) && a.story === b.story && a.path.join('/') === b.path.join('/')) {
      const p = S.d.para(a.story, a.path);
      text = p ? p.text.slice(a.off, b.off).replace(/￼/g, '') : '';
      // The first selected character's formatting (propsOfChar: the character starting at the selection).
      const first = p ? P.propsOfChar(p, a.off) : null;
      address = first?.link ?? '';
      tip = first?.linkTip ?? '';
    }
    const mail = /^mailto:([^?]*)(?:[?]subject=(.*))?$/i.exec(address);
    const decode = x => { try { return decodeURIComponent(x ?? ''); } catch { return x ?? ''; } };
    return {linkTo: mail ? 'email' : 'file', text, address: mail ? '' : address, email: mail ? decode(mail[1]) : '', subject: mail ? decode(mail[2]) : '', place: null, places: placesOf(ctx), tip, isLink: !!address};
  },
  // Choosing a place (Bookmark…) makes it a link to this document.
  derive: (v, changed) => (changed.includes('place') && v.place ? {linkTo: 'place'} : {}),
  buttons: {
    removeLink: (_ctx, v) => (v.isLink ? {command: 'insert.removeLink', params: {}} : null),
  },
  validate(v) {
    if (v.linkTo === 'place') return v.place ? [] : [{field: 'place', message: 'Choose a place in this document.'}];
    if (v.linkTo === 'email') return /^[^s@,;]+@[^s@,;]+$/.test(String(v.email ?? '').trim()) ? [] : [{field: 'email', message: 'Type an e-mail address, such as name@example.com.'}];
    return String(v.address ?? '').trim() ? [] : [{field: 'address', message: 'Type the address of the file or web page.'}];
  },
  toCommand(v) {
    const mailto = () => `mailto:${String(v.email).trim()}${String(v.subject ?? '').trim() ? `?subject=${encodeURIComponent(String(v.subject).trim())}` : ''}`;
    const params = v.linkTo === 'place' ? JSON.parse(v.place) : {url: v.linkTo === 'email' ? mailto() : String(v.address).trim()};
    const text = String(v.text ?? '');
    if (text.trim()) params.text = text;
    if (String(v.tip ?? '').trim()) params.tooltip = String(v.tip).trim();
    return {command: 'insert.link', params};
  },
});
