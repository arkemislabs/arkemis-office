// Legacy form fields (FORMCHECKBOX, FORMTEXT, FORMDROPDOWN): what their w:ffData says, read from
// the raw XML a field object keeps in its `form` (ECMA-376 Part 1 §17.16.17). Only what layout
// and PDF export need; the XML stays the source of truth for saving.
// Translated from wordcraft crates/doc/src/legacy_form.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A form is `{type: 'checkBox', name, checked, size}` (size points or null = follows the text) |
// `{type: 'text', name, maxLen}` | `{type: 'dropDown', name, entries, selected}`. No DOM, no Node built-ins.

/** Most drop-down entries kept (Word allows 25). */
export const MAX_ENTRIES = 64;

const on = v => !['0', 'false', 'off'].includes(v.trim());
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Every start (or empty) tag `<name ...>` in `xml`, in order. */
function* tags(xml, name) {
  const pat = `<${name}`;
  let from = 0;
  for (;;) {
    const at = xml.indexOf(pat, from);
    if (at < 0) return;
    const after = at + pat.length;
    from = after;
    const c = xml[after];
    // `<w:checkBox` must not match `<w:checkBoxes`: the name ends at a space, `/` or `>`.
    if (c === ' ' || c === '/' || c === '>') {
      const end = xml.indexOf('>', after);
      if (end < 0) return;
      yield xml.slice(at, end + 1);
    }
  }
}
const tag = (xml, name) => { for (const t of tags(xml, name)) return t; return null; };

/** The element `name` with its content, or the self-closing tag alone. */
function element(xml, name) {
  const open = tag(xml, name);
  if (open === null) return null;
  const start = xml.indexOf(open);
  if (open.endsWith('/>')) return open;
  const close = `</${name}>`;
  const end = xml.indexOf(close, start);
  return end < 0 ? null : xml.slice(start, end + close.length);
}

/** The w:val of a single tag, entities resolved. */
function attrIn(t) {
  const i = t.indexOf('w:val=');
  if (i < 0) return null;
  const at = i + 'w:val='.length;
  const quote = t[at];
  if (quote !== '"' && quote !== "'") return null;
  const end = t.indexOf(quote, at + 1);
  return end < 0 ? null : unescape(t.slice(at + 1, end));
}
const attrOf = (xml, name) => { const t = tag(xml, name); return t === null ? null : attrIn(t); };
const parseUint = v => (v !== null && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : null);

/** The field's definition, or null when `ffData` holds none of the three. */
export function parseLegacyForm(ffData) {
  const xml = String(ffData ?? '');
  const name = attrOf(xml, 'w:name') ?? '';
  const cb = element(xml, 'w:checkBox');
  if (cb !== null) {
    const dflt = (() => { const v = attrOf(cb, 'w:default'); return v !== null && on(v); })();
    const ct = tag(cb, 'w:checked');
    const checked = ct !== null ? (() => { const v = attrIn(ct); return v === null || on(v); })() : dflt;
    const sv = attrOf(cb, 'w:size');
    const n = sv !== null && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(sv) ? Number(sv.trim()) : NaN;
    const size = Number.isFinite(n) && n > 0 ? Math.min(n / 2, 1584) : null;
    return {type: 'checkBox', name, checked, size};
  }
  const dd = element(xml, 'w:ddList');
  if (dd !== null) {
    const entries = [];
    for (const t of tags(dd, 'w:listEntry')) { const v = attrIn(t); if (v !== null) entries.push(v); if (entries.length >= MAX_ENTRIES) break; }
    const pick = n => parseUint(attrOf(dd, n));
    let selected = pick('w:result') ?? pick('w:default');
    if (selected === null || selected >= entries.length) selected = 0;
    return {type: 'dropDown', name, entries, selected};
  }
  if (xml.includes('<w:textInput')) {
    const ti = element(xml, 'w:textInput');
    const ml = ti !== null ? parseUint(attrOf(ti, 'w:maxLength')) : null;
    return {type: 'text', name, maxLen: ml !== null && ml > 0 && ml <= 4294967295 ? ml : null};
  }
  return null;
}

/** The text a drop-down shows (its selected entry); null for other kinds or an empty list. */
export const legacyFormShownText = f => (f?.type === 'dropDown' ? f.entries[f.selected] ?? null : null);

/** What a legacy form field shows on the page: a check box its box (checked or not), a drop-down its selected entry, a text field what it holds (`fallback`). */
export function legacyFormText(instr, ffData, fallback) {
  const name = String(instr ?? '').trim().split(/s+/)[0]?.toUpperCase();
  if (name !== 'FORMCHECKBOX' && name !== 'FORMDROPDOWN' && name !== 'FORMTEXT') return fallback;
  const f = parseLegacyForm(ffData);
  if (!f) return fallback;
  if (f.type === 'checkBox') return f.checked ? '☒' : '☐';
  if (f.type === 'dropDown') return legacyFormShownText(f) ?? fallback;
  return fallback;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The w:ffData of a new legacy form field (what Word writes): kind text, checkBox or dropDown. */
export function legacyFormXml(kind, {name = '', entries = [], checked = false, maxLen = null, selected = 0} = {}) {
  const head = `<w:ffData><w:name w:val="${esc(name)}"/><w:enabled/><w:calcOnExit w:val="0"/>`;
  if (kind === 'checkBox') return `${head}<w:checkBox><w:sizeAuto/><w:default w:val="${checked ? 1 : 0}"/>${checked ? '<w:checked/>' : ''}</w:checkBox></w:ffData>`;
  if (kind === 'dropDown') return `${head}<w:ddList>${selected > 0 ? `<w:result w:val="${selected}"/>` : ''}${entries.slice(0, MAX_ENTRIES).map(e => `<w:listEntry w:val="${esc(e)}"/>`).join('')}</w:ddList></w:ffData>`;
  return `${head}<w:textInput>${maxLen ? `<w:maxLength w:val="${maxLen}"/>` : ''}</w:textInput></w:ffData>`;
}
