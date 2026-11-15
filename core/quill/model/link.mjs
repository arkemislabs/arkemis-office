// Which hyperlink targets may leave the document: followed by the OS, or written into an exported
// HTML/Markdown file where a browser would run them.
// Translated from wordcraft crates/doc/src/link.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

const isAsciiControl = c => { const n = c.charCodeAt(0); return n < 0x20 || n === 0x7f; };
const clean = url => [...String(url)].filter(c => !isAsciiControl(c) && c !== ' ').join('');

/**
 * Whether Ctrl/⌘+click may hand a hyperlink to the system: web and email links only. Exact: a
 * leading space or a control character makes it not a link.
 */
export function isWebOrMailLink(url) {
  const s = String(url ?? '');
  const i = s.indexOf(':');
  if (i < 0) return false;
  const scheme = s.slice(0, i).toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/** The scheme a browser would see (RFC 3986 §3.1), lower-cased; null for a relative reference. */
function scheme(url) {
  const c = clean(url);
  const i = c.indexOf(':');
  if (i < 0) return null;
  const s = c.slice(0, i);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(s) ? s.toLowerCase() : null;
}

/**
 * Whether a hyperlink may be written as an href in an exported file: a web or email link, a
 * bookmark (#name) or a relative path; never a script, data:, file:, another scheme, a
 * protocol-relative reference or a UNC path.
 */
export function isSafeHref(url) {
  const c = clean(url);
  if (c.replace(/\\/g, '/').startsWith('//')) return false;
  const s = scheme(url);
  if (s !== null) return s === 'http' || s === 'https' || s === 'mailto';
  return c.length > 0;
}
