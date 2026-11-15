// Link Properties (submit: edit.link): the web address a link opens and how it looks (rectangle shown or not, colour, width, solid, dashed or underline,
// highlight when pressed). It opens for a rectangle just drawn with the Link tool (the command passes the page and rectangle in) and for an existing link.
//
// Translated from printcraft at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/ui-egui/src/tools/link_ui.rs (LinkDraft: web,
// url, target, style; the dialog body) and crates/annot/src/links.rs (LinkStyle: visible, colour, width, dashed, underline, highlight). The action "go to a
// page" is not offered here (docs/spec/patches/folio/edit-content.json). No DOM, no Node built-ins.

import {defineDialog} from '../../kernel/dialog.mjs';
import {defaultLinkStyle, HIGHLIGHTS} from '../lib/edit-links.mjs';

const LINES = {Solid: 'solid', Dashed: 'dashed', Underline: 'underline'};
const hexOf = c => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgbOf = h => (/^#?[0-9a-f]{6}$/i.test(String(h)) ? [0, 2, 4].map(i => parseInt(String(h).replace('#', '').slice(i, i + 2), 16) / 255) : [0, 0, 1]);

/** Dialog values → the look params of edit.link. */
export function valuesToParams(v) {
  const goto = v.action === 'Go to a page' ? {gotoPage: Math.max(0, (Math.trunc(Number(v.page)) || 1) - 1)} : {uri: String(v.url ?? '').trim()};
  return {...goto, visible: !!v.visible, color: rgbOf(v.color), width: Math.min(12, Math.max(0.5, Number(v.width) || 1)),
    line: LINES[v.line] ?? 'solid', highlight: Object.hasOwn(HIGHLIGHTS, v.highlight) ? v.highlight : 'Invert'};
}

export default defineDialog({
  id: 'dialog.link-properties',
  title: 'Link Properties',
  command: 'edit.link',
  init(ctx) {
    const d = defaultLinkStyle();
    return {action: 'Open a web page', page: 1, __count: Math.max(1, (ctx?.doc?.pages ?? []).length), url: '', visible: d.visible, color: hexOf(d.color), width: d.width, line: 'Solid', highlight: d.highlight};
  },
  validate(v) {
    if (v.action === 'Go to a page') { const n = Number(v.page); return Number.isInteger(n) && n >= 1 && n <= (Number(v.__count) || 1) ? [] : [{field: 'page', message: `Type a page from 1 to ${Number(v.__count) || 1}`}]; }
    return String(v.url ?? '').trim() ? [] : [{field: 'url', message: 'Type the web address'}];
  },
  toCommand: v => ({command: 'edit.link', params: {...(v.__page ? {page: v.__page} : {}), ...(v.__rect ? {rect: v.__rect} : {}), ...valuesToParams(v)}}),
});
