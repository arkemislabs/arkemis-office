// Rich text on the system clipboard as HTML: Prism writes `<p>` paragraphs with `<b>`, `<i>` and
// `<u>` when it copies text, and reads bold, italic and underline back from HTML that Pages,
// Keynote, Word or a browser put on the clipboard. Anything else in the markup is skipped; a
// hostile fragment is capped, never executed.
// Translated from deckcraft crates/engine/src/cmd/richclip.rs (`body_to_html`, `tags`,
// `push_escaped`, `html_to_body`, `tag_kind`, `is_break`, `is_block`, `tag_style`, `weight_bold`,
// `attr`, `new_para`, `trim_end_space`, `push_run`, `collapse_space`, `decode_text`,
// `numeric_char`, `same_words`, `fold`) at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. U:prism/edit. No DOM, no Node built-ins.

import {normalizeParagraph, isBreakRun, bodyText} from '../model/text.mjs';

export const MAX_HTML = 1 << 20;
const MAX_PARAS = 2000;
const MAX_RUNS = 10000;

const escape = t => t.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

function tags(props = {}) {
  let open = '', close = '';
  if (props.bold === true) { open += '<b>'; close = '</b>' + close; }
  if (props.italic === true) { open += '<i>'; close = '</i>' + close; }
  if (typeof props.underline === 'string' && props.underline.toLowerCase() !== 'none') { open += '<u>'; close = '</u>' + close; }
  return [open, close];
}

/** deckcraft `body_to_html`: one `<p>` per paragraph (separated by `<br>`), `<b>`, `<i>`, `<u>`. */
export function bodyToHtml(body) {
  let out = '';
  (body?.paragraphs ?? []).forEach((p, i) => {
    if (i > 0) out += '<br>';
    out += '<p>';
    for (const r of p.runs ?? []) {
      const [open, close] = tags(r.props);
      out += open + (isBreakRun(r) ? '<br>' : escape(r.text ?? '')) + close;
      if (out.length > MAX_HTML) break;
    }
    out += '</p>';
  });
  return out;
}

function tagKind(name) {
  switch (name) {
    case 'b': case 'strong': return 'b';
    case 'i': case 'em': return 'i';
    case 'u': return 'u';
    case 'span': case 'font': return 'span';
    case 'p': case 'div': case 'li': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'block';
    default: return '';
  }
}
const isBreak = n => n === 'br' || n === 'hr';
const isBlock = n => ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(n);

/** Whether a `font-weight` in `style` turns bold on (true) or off (false); null when it says nothing. */
function weightBold(style) {
  const at = style.indexOf('font-weight');
  if (at < 0) return null;
  const rest = style.slice(at + 'font-weight'.length).replace(/^[:\s]+/u, '');
  if (rest.startsWith('bold')) return true;
  if (rest.startsWith('normal') || rest.startsWith('lighter')) return false;
  const m = /^[0-9]+/.exec(rest);
  return m ? Number(m[0]) >= 600 : null;
}

/** deckcraft `attr`: a quoted attribute value (named after whitespace, followed by `=`). */
function attr(tag, key) {
  const lower = tag.toLowerCase();
  let at = -1;
  for (let i = lower.indexOf(key); i >= 0; i = lower.indexOf(key, i + 1)) {
    const named = i > 0 && /\s/.test(lower[i - 1]);
    const eq = tag.slice(i + key.length).trimStart().startsWith('=');
    if (named && eq) { at = i; break; }
  }
  if (at < 0) return null;
  const after = tag.slice(at + key.length).trimStart().slice(1).trimStart();
  const q = after[0];
  if (q !== '"' && q !== "'") return null;
  const end = after.indexOf(q, 1);
  return end < 0 ? null : after.slice(1, end);
}

function tagStyle(name, src) {
  let bold = name === 'b' || name === 'strong' ? 1 : 0;
  let italic = name === 'i' || name === 'em' ? 1 : 0;
  let underline = name === 'u' ? 1 : 0;
  const style = attr(src, 'style');
  if (style !== null) {
    const s = style.toLowerCase();
    const w = weightBold(s);
    if (w !== null) bold = w ? 1 : 0;
    if (s.includes('font-style:italic') || s.includes('font-style: italic')) italic = 1;
    if (['text-decoration:underline', 'text-decoration: underline', 'text-decoration-line:underline', 'text-decoration-line: underline'].some(x => s.includes(x))) underline = 1;
  }
  return [bold, italic, underline];
}

const paraEmpty = p => p.runs.every(r => !(r.text ?? ''));
/** Whitespace at the end of a paragraph does not render in HTML. */
function trimEndSpace(paragraphs) {
  const p = paragraphs[paragraphs.length - 1];
  const r = p?.runs[p.runs.length - 1];
  if (r) r.text = r.text.replace(/ +$/u, '');
}
function newPara(paragraphs) {
  if (paragraphs.length >= MAX_PARAS) return;
  if (!paraEmpty(paragraphs[paragraphs.length - 1])) {
    trimEndSpace(paragraphs);
    paragraphs.push({level: 0, runs: []});
  }
}

/** Text with each run of HTML whitespace collapsed to one space. */
function collapseSpace(s) { return s.replace(/[ \t\n\r]+/g, ' '); }

function numericChar(digits) {
  const hex = /^[xX]/.test(digits);
  const body = hex ? digits.slice(1) : digits;
  if (!body || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(body)) return null;
  const n = parseInt(body, hex ? 16 : 10);
  if (!Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  const c = String.fromCodePoint(n);
  // eslint-disable-next-line no-control-regex
  return /^\p{Cc}$/u.test(c) && c !== '\n' && c !== '\t' ? null : c;
}

/** deckcraft `decode_text`: entities decoded, whitespace collapsed; a bare `&` stays as typed. */
export function decodeText(raw) {
  let out = '';
  let rest = raw;
  for (let at = rest.indexOf('&'); at >= 0; at = rest.indexOf('&')) {
    out += collapseSpace(rest.slice(0, at));
    rest = rest.slice(at);
    const win = rest.slice(0, Math.min(rest.length, 32));
    const end = win.indexOf(';');
    if (end < 0) { out += '&'; rest = rest.slice(1); continue; }
    const entity = rest.slice(1, end);
    const decoded = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '}[entity] ?? (entity.startsWith('#') ? numericChar(entity.slice(1)) : null);
    if (decoded !== null) { out += decoded; rest = rest.slice(end + 1); }
    else { out += '&'; rest = rest.slice(1); }
  }
  if (rest && !rest.startsWith('&')) out += collapseSpace(rest);
  return out;
}

/** deckcraft `html_to_body`: the formatted text of an HTML fragment, or null when it has no text. */
export function htmlToBody(html) {
  if (typeof html !== 'string' || html.length > MAX_HTML) return null;
  let i = 0, bold = 0, italic = 0, underline = 0, runs = 0, skip = 0;
  const stack = [];
  const paragraphs = [{level: 0, runs: []}];
  while (i < html.length && paragraphs.length <= MAX_PARAS && runs <= MAX_RUNS) {
    if (html[i] === '<') {
      let end = html.indexOf('>', i + 1);
      if (end < 0) end = html.length;
      const raw = html.slice(i + 1, end);
      i = Math.min(end + 1, html.length);
      const token = raw.trim();
      if (token.startsWith('!') || token.startsWith('?')) continue;
      const closing = token.startsWith('/');
      const nameSrc = token.replace(/^\/+/, '').trim();
      const ne = nameSrc.search(/[\s/>]/);
      const name = (ne < 0 ? nameSrc : nameSrc.slice(0, ne)).toLowerCase();
      if (name === 'script' || name === 'style' || name === 'head') {
        if (closing) skip = Math.max(skip - 1, 0);
        else if (!token.endsWith('/')) skip += 1;
        continue;
      }
      if (skip > 0) continue;
      if (closing) {
        const kind = tagKind(name);
        if (kind) {
          const from = Math.max(stack.length - 64, 0);
          for (let k = stack.length - 1; k >= from; k--) {
            if (stack[k][0] === kind) {
              const [, db, di, du] = stack[k];
              bold -= db; italic -= di; underline -= du;
              stack.length = k;
              break;
            }
          }
        }
        if (isBlock(name)) newPara(paragraphs);
        continue;
      }
      if (isBreak(name)) { newPara(paragraphs); continue; }
      const [db, di, du] = tagStyle(name, nameSrc);
      if (db + di + du > 0 && !token.endsWith('/') && stack.length < 128) {
        bold += db; italic += di; underline += du;
        stack.push([tagKind(name), db, di, du]);
      }
      continue;
    }
    if (skip > 0) { i += 1; continue; }
    let end = html.indexOf('<', i);
    if (end < 0) end = html.length;
    let text = decodeText(html.slice(i, end));
    i = end;
    // A space at the start of a paragraph, or after a space, does not render in HTML.
    const last = paragraphs[paragraphs.length - 1].runs.at(-1);
    if (!last || last.text.endsWith(' ')) text = text.replace(/^ +/u, '');
    if (!text) continue;
    if (runs >= MAX_RUNS) continue;
    const props = {};
    if (bold > 0) props.bold = true;
    if (italic > 0) props.italic = true;
    if (underline > 0) props.underline = 'sng';
    paragraphs[paragraphs.length - 1].runs.push(Object.keys(props).length ? {text, props} : {text});
    runs += 1;
  }
  while (paragraphs.length > 1 && paraEmpty(paragraphs[paragraphs.length - 1])) paragraphs.pop();
  trimEndSpace(paragraphs);
  if (paragraphs.every(paraEmpty)) return null;
  return {body: {}, paragraphs: paragraphs.map(p => normalizeParagraph(p))};
}

const fold = s => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/ /g, ' ').replace(/^[\n \t]+|[\n \t]+$/g, '');
/** deckcraft `same_words`: do the HTML's words and the paste's plain text say the same thing? */
export const sameWords = (htmlPlain, pasted) => fold(htmlPlain) === fold(pasted);
export {bodyText};
