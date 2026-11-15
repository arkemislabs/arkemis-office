// Which hyperlink targets may be opened. A cell's link comes from the document (often a file somebody
// sent), so it is hostile input: only http, https and mailto ever leave the workbook for the system;
// file:, smb:, UNC paths, custom URL handlers, javascript: and the like are refused. Everything
// without a scheme stays an in-workbook reference.
// Translated from gridcraft crates/engine/src/links.rs (`classify`) and crates/engine/src/cmd/
// insert/links.rs (`links_outside`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {parseRange, splitSheet} from './addr.mjs';

const ALLOWED = ['http', 'https', 'mailto'];

/** {kind: 'internal'|'external'|'refused', target|reason}. The single place that decides what may be opened. */
export function classify(target) {
  const t = String(target).trim();
  if ([...t].some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)) return {kind: 'refused', reason: 'The link contains control characters.'};
  if (t.startsWith('\\') || t.startsWith('//')) return {kind: 'refused', reason: "Links to network locations aren't opened."};
  if (parseRange(t)) return {kind: 'internal', target: t};
  const i = t.indexOf(':');
  if (i < 0) return {kind: 'internal', target: t};
  const scheme = t.slice(0, i), rest = t.slice(i + 1);
  if (!(/^[A-Za-z]/.test(scheme) && /^[A-Za-z0-9+.-]*$/.test(scheme))) return {kind: 'internal', target: t};
  const lower = scheme.toLowerCase();
  if (ALLOWED.includes(lower) && rest.trim()) return {kind: 'external', target: t};
  return {kind: 'refused', reason: `Links of type "${lower}:" aren't opened. Only http, https and mailto links are allowed.`};
}

/**
 * Sorts a link target as the two pages of Excel's Insert Hyperlink dialog do: "Place in This Document"
 * is a sheet reference, a defined name or `#...`; anything else ("Existing File or Web Page") is outside
 * the workbook and saved as a relationship.
 */
export function linkIsOutside(content, target) {
  const t = String(target).trim();
  if (t.startsWith('#')) return false;
  if ((content.names ?? []).some(n => n.name.toLowerCase() === t.toLowerCase())) return false;
  if ((content.sheets ?? []).some(sh => (sh.tables ?? []).some(tb => tb.name?.toLowerCase() === t.toLowerCase()))) return false;
  const [name, body] = splitSheet(t);
  // Sheet names can't hold : \ / ? * [ ] so `https://...!A1` or `C:\...!A1` is no sheet reference, and
  // `Book.xlsx#Sheet1!A1` is a place in another file unless a sheet has that name.
  const onSheet = name === null || (content.sheets ?? []).some(sh => sh.name.toLowerCase() === name.toLowerCase()) || (name !== '' && !/[:\/?*[\]#]/.test(name));
  return !(onSheet && parseRange(body.replace(/\$/g, '')));
}
