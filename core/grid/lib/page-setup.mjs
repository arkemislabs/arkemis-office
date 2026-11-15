// Page setup of a sheet: paper sizes, margins, orientation, scaling, header and footer text, the print
// area, titles and page breaks.
// Modelled on gridcraft crates/model/src/features/print.rs (`PrintSettings`, `Orientation`, `HfPage`)
// and crates/engine/src/cmd/print.rs, with Excel's own presets and codes (the xlsx `paperSize` codes
// of ECMA-376 18.18.50). MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Stored on the sheet: pageSetup {orientation: 'portrait'|'landscape', paper, scale (10-400), fitWidth,
// fitHeight (pages, 0 = automatic), margins {left, right, top, bottom, header, footer} in inches,
// centerH, centerV, printGridlines, printHeadings, blackAndWhite, draft, comments ('none'|'end'|
// 'asDisplayed'), errors ('displayed'|'blank'|'dash'|'na'), pageOrder ('down'|'over'), firstPage,
// headerFooter {header, footer, differentOddEven, differentFirst, scaleWithDoc, alignWithMargins},
// rowBreaks [first row of the next page], colBreaks}; printArea 'A1:C5,E1:F2'; printTitles 'Sheet1!$A:$B,Sheet1!$1:$2'.

/**
 * Paper sizes: [name, xlsx paperSize code (null: the file has none), width, height in points, portrait]. B4, B5 and B6 are the JIS
 * sizes (257x364, 182x257, 128x182 mm); the ISO series is B4 (ISO) and so on (gridcraft known_paper, crates/xlsx tables.rs).
 */
export const PAPERS = Object.freeze([
  ['Letter', 1, 612, 792], ['Legal', 5, 612, 1008], ['Tabloid', 3, 792, 1224], ['Ledger', 4, 1224, 792], ['Executive', 7, 522, 756],
  ['A3', 8, 841.89, 1190.55], ['A4', 9, 595.28, 841.89], ['A5', 11, 419.53, 595.28], ['A6', 70, 297.64, 419.53],
  ['B4', 12, 728.5, 1031.81], ['B5', 13, 515.91, 728.5], ['B6', 88, 362.83, 515.91],
  ['B4 (ISO)', 42, 708.66, 1000.63], ['B5 (ISO)', null, 498.9, 708.66], ['B6 (ISO)', null, 354.33, 498.9],
  ['Japanese Postcard', 43, 283.46, 419.53], ['Japanese Double Postcard', 69, 419.53, 566.93],
  ['Japanese Envelope #3', 73, 340.16, 666.14], ['Japanese Envelope #4', 74, 255.12, 581.1],
  ['Japanese Envelope Kaku #2', 71, 680.31, 941.1], ['Japanese Envelope Kaku #3', 72, 612.28, 785.2],
]);
export const PAPER_NAMES = Object.freeze(PAPERS.map(p => p[0]));
/** Spaces, hyphens, underscores and parentheses do not matter: `B5 (JIS)`, `b5-jis` and `b5` are one name. */
const norm = name => String(name).trim().toLowerCase().replace(/[\s\-_()]/g, '');
const ALIASES = {usletter: 'letter', uslegal: 'legal', '11x17': 'tabloid', b4jis: 'b4', b5jis: 'b5', b6jis: 'b6', postcard: 'japanesepostcard', doublepostcard: 'japanesedoublepostcard',
  'chou#3': 'japaneseenvelope#3', 'chou#4': 'japaneseenvelope#4', 'kaku#2': 'japaneseenvelopekaku#2', 'kaku#3': 'japaneseenvelopekaku#3'};
export const paperByName = name => { const n = norm(name); const k = ALIASES[n] ?? n; return PAPERS.find(p => norm(p[0]) === k) ?? null; };
export const paperByCode = code => PAPERS.find(p => p[1] === code) ?? null;
/** The paper's size in points (portrait); an unknown name is Letter (gridcraft paper_size). */
export const paperPoints = name => { const p = paperByName(name) ?? PAPERS[0]; return [p[2], p[3]]; };

export const MARGIN_PRESETS = Object.freeze({
  normal: {left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3},
  wide: {left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5},
  narrow: {left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3},
});

export const DEFAULT_SETUP = Object.freeze({orientation: 'portrait', paper: 'Letter', scale: 100, fitWidth: 0, fitHeight: 0, margins: MARGIN_PRESETS.normal});

/** A sheet's page setup with the defaults filled in. */
export function setupOf(sheet) {
  const p = sheet?.pageSetup ?? {};
  return {...DEFAULT_SETUP, ...p, margins: {...MARGIN_PRESETS.normal, ...(p.margins ?? {})}};
}

/** Whether the setup scales to fit a number of pages rather than by a percentage. */
export const fitsToPages = p => (p.fitWidth ?? 0) > 0 || (p.fitHeight ?? 0) > 0;

/** `Sheet1!$A:$B,Sheet1!$1:$2` from the columns and rows to repeat (`A:B`, `1:2`), or '' for none. */
export function titlesText(sheetName, cols, rows) {
  const q = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  const parts = [];
  if (cols) { const m = /^\$?([A-Za-z]{1,3})(?::\$?([A-Za-z]{1,3}))?$/.exec(String(cols).trim()); if (!m) return null; parts.push(`${q}!$${m[1].toUpperCase()}:$${(m[2] ?? m[1]).toUpperCase()}`); }
  if (rows) { const m = /^\$?(\d{1,7})(?::\$?(\d{1,7}))?$/.exec(String(rows).trim()); if (!m) return null; parts.push(`${q}!$${m[1]}:$${m[2] ?? m[1]}`); }
  return parts.join(',');
}

/** The columns and rows a titles text repeats: {cols: 'A:B'|'', rows: '1:2'|''}. */
export function titlesParts(text) {
  const out = {cols: '', rows: ''};
  for (const part of String(text ?? '').split(',')) {
    const body = part.slice(part.lastIndexOf('!') + 1).replace(/\$/g, '').trim();
    if (/^[A-Za-z]{1,3}:[A-Za-z]{1,3}$/.test(body)) out.cols = body.toUpperCase();
    else if (/^\d+:\d+$/.test(body)) out.rows = body;
  }
  return out;
}

/** The header and footer choices Excel lists (&L left, &C centre, &R right; &P page, &N pages, &A sheet, &F file, &D date). */
export const HEADER_FOOTER_PRESETS = Object.freeze(['', 'Page &P', 'Page &P of &N', '&A', 'Confidential', '&F', '&A, Page &P', '&D', 'Prepared by &F &D']);

/** Header/footer codes and the field names shown for them while editing (gridcraft `HF_FIELDS`). */
export const HF_FIELDS = Object.freeze([['P', '&[Page]'], ['N', '&[Pages]'], ['D', '&[Date]'], ['T', '&[Time]'], ['Z', '&[Path]'], ['F', '&[File]'], ['A', '&[Tab]'], ['G', '&[Picture]']]);

/** The raw sections of a header or footer text, [left, centre, right] with codes kept (`split_header_footer`); text before the first &L, &C or &R is the centre. */
export function splitHeaderFooter(spec) {
  const out = ['', '', ''];
  let cur = 1, i = 0;
  const chars = [...String(spec ?? '')].slice(0, 10_000);
  while (i < chars.length) {
    const c = chars[i], next = chars[i + 1];
    const sec = Math.min(cur, 2);
    if (c !== '&') { out[sec] += c; i += 1; continue; }
    if (next === undefined) { i += 2; continue; }
    if (next === 'L' || next === 'l') cur = 0;
    else if (next === 'C' || next === 'c') cur = 1;
    else if (next === 'R' || next === 'r') cur = 2;
    else if (next === '"') {
      // &"Font,Style" is kept whole.
      const close = chars.indexOf('"', i + 2);
      const end = close < 0 ? chars.length : close + 1;
      out[sec] += chars.slice(i, end).join('');
      i = end;
      continue;
    } else out[sec] += '&' + next;
    i += 2;
  }
  return out;
}
/** A header or footer text from its raw sections (`join_header_footer`). */
export const joinHeaderFooter = parts => ['&L', '&C', '&R'].map((code, i) => (parts[i] ? code + parts[i] : '')).join('');

/** The sections of a header or footer text: {left, center, right}. */
export function sections(text) { const [left, center, right] = splitHeaderFooter(text); return {left, center, right}; }
/** A header or footer text from its sections. */
export const joinSections = ({left = '', center = '', right = ''}) => joinHeaderFooter([left, center, right]);

/** A raw section as the person edits it: &P shows as &[Page], &N as &[Pages], and so on (`codes_to_fields`). */
export function codesToFields(raw) {
  const chars = [...String(raw ?? '')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '&') { out += chars[i]; continue; }
    const n = chars[++i];
    if (n === undefined) break;
    const hit = HF_FIELDS.find(([code]) => code === n.toUpperCase());
    out += hit ? hit[1] : '&' + n;
  }
  return out;
}
/** The inverse of codesToFields: field names become codes again; a dangling & at the end is a literal ampersand (`fields_to_codes`). */
export function fieldsToCodes(text) {
  const chars = [...String(text ?? '')].slice(0, 10_000);
  let out = '', i = 0;
  while (i < chars.length) {
    if (chars[i] !== '&') { out += chars[i]; i += 1; continue; }
    if (chars[i + 1] === '&') { out += '&&'; i += 2; continue; }
    const rest = chars.slice(i, i + 12).join('');
    const hit = HF_FIELDS.find(([, field]) => rest.startsWith(field));
    if (hit) { out += '&' + hit[0]; i += hit[1].length; continue; }
    out += i + 1 === chars.length ? '&&' : '&';
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Header and footer text as it prints and as the Page Layout view shows it

/** Side margin of headers and footers, in points, when Align with Page Margins is off (`HF_FIXED_SIDE_MARGIN`). */
export const HF_FIXED_SIDE_MARGIN = 0.7 * 72;

/** Today's date and the current time as headers and footers show them (`&D`, `&T`: m/d/yyyy and h:mm AM/PM; `hf_date_time`). */
export function hfDateTime(now = new Date()) {
  const h = now.getHours();
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(now.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return {date, time};
}

/**
 * Expands a header or footer text into its left, centre and right sections (`expand_header_footer`):
 * [{text, bold, italic, size}] with the page, pages, date, time, sheet, file and path filled in from `cx`
 * ({page, pages, sheet, file, path, date, time}). &B and &I toggle bold and italic, &"Font,Style" honours Bold and
 * Italic, a number sets the size in points; underline, strike, colour and pictures are not rendered.
 */
export function expandHeaderFooter(spec, cx) {
  const out = [0, 1, 2].map(() => ({text: '', bold: false, italic: false, size: null}));
  let cur = 1, i = 0;
  const chars = [...String(spec ?? '')].slice(0, 10_000);
  while (i < chars.length) {
    const c = chars[i];
    if (c !== '&') { out[Math.min(cur, 2)].text += c; i += 1; continue; }
    const code = chars[i + 1];
    if (code === undefined) break;
    i += 2;
    const sec = out[Math.min(cur, 2)];
    const up = code.toUpperCase();
    if (up === 'L') cur = 0;
    else if (up === 'C') cur = 1;
    else if (up === 'R') cur = 2;
    else if (up === 'P') {
      // &P, &P+n, &P-n
      let n = cx.page;
      const sign = chars[i];
      if (sign === '+' || sign === '-') {
        let digits = '';
        for (let k = i + 1; k < chars.length && /[0-9]/.test(chars[k]) && digits.length < 6; k++) digits += chars[k];
        if (digits) { n = sign === '+' ? n + Number(digits) : n - Number(digits); i += 1 + digits.length; }
      }
      sec.text += String(n);
    } else if (up === 'N') sec.text += String(cx.pages);
    else if (up === 'D') sec.text += cx.date;
    else if (up === 'T') sec.text += cx.time;
    else if (up === 'A') sec.text += cx.sheet;
    else if (up === 'F') sec.text += cx.file;
    else if (up === 'Z') sec.text += cx.path;
    else if (code === '&') sec.text += '&';
    else if (up === 'B') sec.bold = !sec.bold;
    else if (up === 'I') sec.italic = !sec.italic;
    else if (code === '"') {
      // &"Font,Style": skip the font name; honour Bold and Italic in the style.
      let rest = '';
      for (let k = i; k < chars.length && chars[k] !== '"'; k++) rest += chars[k];
      const lower = rest.toLowerCase();
      if (lower.includes('bold')) sec.bold = true;
      if (lower.includes('italic') || lower.includes('oblique')) sec.italic = true;
      i += [...rest].length + 1;
    } else if (/[0-9]/.test(code)) {
      let digits = code;
      for (let k = i; k < chars.length && /[0-9]/.test(chars[k]) && digits.length < 3; k++) digits += chars[k];
      i += digits.length - 1;
      sec.size = Math.min(409, Math.max(1, Number(digits)));
    } else if (up === 'K') i = Math.min(i + 6, chars.length);
  }
  return out;
}

/** Which header and footer pair a page shows (`hf_page`): the first page, an even page, or the rest. */
export function hfPageKind(setup, pageNumber) {
  const hf = setup.headerFooter ?? {};
  if (hf.differentFirst && pageNumber === 1) return 'first';
  if (hf.differentOddEven && pageNumber % 2 === 0) return 'even';
  return 'odd';
}
/** The header or footer text a kind of page uses (`hf`): the first page's or the even pages' own, else the odd pages' (an empty own text shows nothing). */
export function hfText(setup, kind, footer) {
  const hf = setup.headerFooter ?? {};
  const key = kind === 'first' ? (footer ? 'firstFooter' : 'firstHeader') : kind === 'even' ? (footer ? 'evenFooter' : 'evenHeader') : footer ? 'footer' : 'header';
  return String(hf[key] ?? '');
}
