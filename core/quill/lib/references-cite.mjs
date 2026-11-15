// Citation styles (U:quill/references): the style records, in-text citations and bibliography entries.
//
// Translated from wordcraft crates/engine/src/cmd/citations/render.rs, styles.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Pure functions, no DOM. A source is the camelCase JSON of wordcraft_doc::Source: {tag, kind, author,
// title, year, publisher, city, journal, volume, pages, url, editor, edition, issue, month, day,
// accessed, doi}, all strings; a missing field reads as ''. Rust enums become frozen string
// constants (ORDER, NAME) or tagged records (Cite: {kind: 'authorDate'|'authorPage'|'number', ...}).
// `numbered(style)` is a function (CiteStyle::numbered), not a field.

// ---------------------------------------------------------------------------------------------
// styles.rs
// ---------------------------------------------------------------------------------------------

/** How a style orders its bibliography (and, for numbered styles, numbers its citations) (Order). */
export const ORDER = Object.freeze({
  /** Alphabetical by the first author's surname (the title when there is no author). */
  AUTHOR: 'author',
  /** Alphabetical by title. */
  TITLE: 'title',
  /** In order of first citation in the document. */
  CITED: 'cited',
});

/** How one author's name is written in a bibliography entry (Name). */
export const NAME = Object.freeze({
  /** Rivera, Alex */
  LAST_FIRST: 'lastFirst',
  /** Alex Rivera */
  FIRST_LAST: 'firstLast',
  /** Rivera, A. */
  LAST_INITIALS: 'lastInitials',
  /** A. Rivera */
  INITIALS_LAST: 'initialsLast',
  /** Rivera A. */
  LAST_SPACE_INITIALS: 'lastSpaceInitials',
  /** RIVERA, Alex */
  UPPER_LAST_FIRST: 'upperLastFirst',
  /** RIVERA A */
  UPPER_LAST_BARE_INITIALS: 'upperLastBareInitials',
});

/** The in-text citation kinds (Cite): `(Who<yearSep>Year<pagesSep>Pages)`, `(Who Pages)`, `<open>n<close>`. */
export const CITE = Object.freeze({AUTHOR_DATE: 'authorDate', AUTHOR_PAGE: 'authorPage', NUMBER: 'number'});

/** Cite::AuthorDate { year_sep, pages_sep }. */
const authorDate = (yearSep, pagesSep) => Object.freeze({kind: CITE.AUTHOR_DATE, yearSep, pagesSep});
/** Cite::AuthorPage. */
const AUTHOR_PAGE = Object.freeze({kind: CITE.AUTHOR_PAGE});
/** Cite::Number { open, close, pages_sep }; pages follow `pagesSep` inside the brackets (left out when null). */
const number = (open, close, pagesSep) => Object.freeze({kind: CITE.NUMBER, open, close, pagesSep});

/** Numbered styles cite `[1]`/`(1)` and list entries without a hanging indent (CiteStyle::numbered). */
export function numbered(st) {
  return st.cite.kind === CITE.NUMBER;
}

/**
 * The author list of a bibliography entry (Names): the first author's form and every later
 * author's; between names, between exactly two, before the last of three or more; list at most
 * `max` authors, then `etAl` (0: list them all) (names).
 */
function names(first, rest, sep, two, last, more = {}) {
  return Object.freeze({first, rest, sep, two, last, max: 0, etAl: '', ...more});
}

const AUTHOR_DATE = authorDate(' ', ', p. ');

const GOST_BOOK = '{n}. ⟦{names} ⟧{title}. –⟦ {city} :⟧⟦ {publisher},⟧ {year}.⟦ – URL: {url}.⟧';

const GOST_ARTICLE = '{n}. ⟦{names} ⟧{title} // {journal}. – {year}.⟦ – Vol. {volume}.⟧⟦ – P. {pages}.⟧⟦ – URL: {url}.⟧';

const N = NAME;

/**
 * Every style, in picker order (alphabetical) (STYLES). A record (CiteStyle) is {name, aliases,
 * cite, and, etAlFrom, order, names, book, article, bibTitle}: `aliases` are lowercase
 * letter/digit prefixes of Word's style names and style-sheet file names (the longest match wins);
 * `and` joins two authors in a citation; cite `etAlFrom` authors or more as "First et al.".
 * Entry templates fill `{n}`, `{names}`, `{year}`, `{title}`, `{city}`, `{publisher}`, `{pub}`
 * (city: publisher), `{journal}`, `{volume}`, `{pages}`, `{url}` and `{type}` (GB/T 7714 document
 * type code); text between `⟦` and `⟧` is left out when a field in it is empty, and a full stop
 * never doubles up.
 */
export const STYLES = Object.freeze([
  {
    name: 'APA',
    aliases: ['apa'],
    cite: authorDate(', ', ', p. '),
    and: '&',
    etAlFrom: 3,
    order: ORDER.AUTHOR,
    names: names(N.LAST_INITIALS, N.LAST_INITIALS, ', ', ', & ', ', & '),
    book: '⟦{names} ⟧({year}). {title}.⟦ {publisher}.⟧⟦ {url}⟧',
    article: '⟦{names} ⟧({year}). {title}. {journal}⟦, {volume}⟧⟦, {pages}⟧.⟦ {url}⟧',
    bibTitle: 'References',
  },
  {
    name: 'Chicago',
    aliases: ['chicago'],
    cite: authorDate(' ', ', '),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.AUTHOR,
    names: names(N.LAST_FIRST, N.FIRST_LAST, ', ', ', and ', ', and '),
    book: '⟦{names}. ⟧{year}. {title}.⟦ {pub}.⟧⟦ {url}⟧',
    article: '⟦{names}. ⟧{year}. {title}. {journal}⟦, {volume}⟧⟦, {pages}⟧.⟦ {url}⟧',
    bibTitle: 'References',
  },
  // GB/T 7714 sequence-coding: numbered by first citation, surnames in capitals with bare
  // initials, at most three authors, a document type code after the title.
  {
    name: 'GB/T 7714',
    aliases: ['gb'],
    cite: number('[', ']', ', '),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.CITED,
    names: names(N.UPPER_LAST_BARE_INITIALS, N.UPPER_LAST_BARE_INITIALS, ', ', ', ', ', ', {max: 3, etAl: ', et al.'}),
    book: '[{n}] ⟦{names}. ⟧{title}[{type}].⟦ {pub},⟧ {year}.⟦ {url}.⟧',
    article: '[{n}] ⟦{names}. ⟧{title}[{type}]. {journal}, {year}⟦, {volume}⟧⟦: {pages}⟧.⟦ {url}.⟧',
    bibTitle: 'References',
  },
  // GOST 7.1: a numbered list in alphabetical order (by author or by title); areas separated
  // by " – ", the container after "//".
  {
    name: 'GOST (name sort)',
    aliases: ['gost', 'gostname'],
    cite: number('[', ']', ', p. '),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.AUTHOR,
    names: names(N.LAST_SPACE_INITIALS, N.LAST_SPACE_INITIALS, ', ', ', ', ', '),
    book: GOST_BOOK,
    article: GOST_ARTICLE,
    bibTitle: 'References',
  },
  {
    name: 'GOST (title sort)',
    aliases: ['gosttitle'],
    cite: number('[', ']', ', p. '),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.TITLE,
    names: names(N.LAST_SPACE_INITIALS, N.LAST_SPACE_INITIALS, ', ', ', ', ', '),
    book: GOST_BOOK,
    article: GOST_ARTICLE,
    bibTitle: 'References',
  },
  // Harvard as taught by Anglia Ruskin: "Surname, I., Year. Title. Place: Publisher."
  {
    name: 'Harvard (Anglia)',
    aliases: ['harvard'],
    cite: authorDate(', ', ', p. '),
    and: 'and',
    etAlFrom: 4,
    order: ORDER.AUTHOR,
    names: names(N.LAST_INITIALS, N.LAST_INITIALS, ', ', ' and ', ' and '),
    book: '⟦{names}, ⟧{year}. {title}.⟦ {pub}.⟧⟦ Available at: <{url}>.⟧',
    article: '⟦{names}, ⟧{year}. {title}. {journal}⟦, {volume}⟧⟦, pp. {pages}⟧.⟦ Available at: <{url}>.⟧',
    bibTitle: 'References',
  },
  {
    name: 'IEEE',
    aliases: ['ieee'],
    cite: number('[', ']', null),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.CITED,
    names: names(N.INITIALS_LAST, N.INITIALS_LAST, ', ', ', ', ', '),
    book: '[{n}] ⟦{names}, ⟧“{title},”⟦ {pub},⟧ {year}.⟦ {url}⟧',
    article: '[{n}] ⟦{names}, ⟧“{title},” {journal}⟦, {volume}⟧⟦, {pages}⟧, {year}.⟦ {url}⟧',
    bibTitle: 'References',
  },
  // ISO 690 first element and date: surnames in capitals, the year after the names.
  {
    name: 'ISO 690 (author-date)',
    aliases: ['iso690'],
    cite: AUTHOR_DATE,
    and: 'and',
    etAlFrom: 4,
    order: ORDER.AUTHOR,
    names: names(N.UPPER_LAST_FIRST, N.UPPER_LAST_FIRST, ', ', ' and ', ' and '),
    book: '⟦{names}, ⟧{year}. {title}.⟦ {pub}.⟧⟦ Available from: {url}⟧',
    article: '⟦{names}, ⟧{year}. {title}. {journal}⟦, {volume}⟧⟦, {pages}⟧.⟦ Available from: {url}⟧',
    bibTitle: 'References',
  },
  // ISO 690 numeric reference: numbered by first citation, the year with the imprint.
  {
    name: 'ISO 690 (numerical)',
    aliases: ['iso690num', 'iso690nmerical'],
    cite: number('(', ')', ', p. '),
    and: 'and',
    etAlFrom: 4,
    order: ORDER.CITED,
    names: names(N.UPPER_LAST_FIRST, N.UPPER_LAST_FIRST, ', ', ' and ', ' and '),
    book: '{n}. ⟦{names}. ⟧{title}.⟦ {pub},⟧ {year}.⟦ Available from: {url}⟧',
    article: '{n}. ⟦{names}. ⟧{title}. {journal}. {year}⟦, {volume}⟧⟦, {pages}⟧.⟦ Available from: {url}⟧',
    bibTitle: 'References',
  },
  {
    name: 'MLA',
    aliases: ['mla'],
    cite: AUTHOR_PAGE,
    and: 'and',
    etAlFrom: 3,
    order: ORDER.AUTHOR,
    names: names(N.LAST_FIRST, N.LAST_FIRST, ', ', ', ', ', ', {max: 1, etAl: ', et al.'}),
    book: '⟦{names}. ⟧“{title}.”⟦ {publisher},⟧ {year}.⟦ {url}⟧',
    article: '⟦{names}. ⟧“{title}.” {journal}⟦, {volume}⟧⟦, {pages}⟧, {year}.⟦ {url}⟧',
    bibTitle: 'Works Cited',
  },
  // SIST 02: numbered by first citation, full names separated by semicolons.
  {
    name: 'SIST02',
    aliases: ['sist'],
    cite: number('(', ')', ', p. '),
    and: 'and',
    etAlFrom: 3,
    order: ORDER.CITED,
    names: names(N.LAST_FIRST, N.LAST_FIRST, '; ', '; ', '; '),
    book: '{n}) ⟦{names}. ⟧{title}.⟦ {city},⟧⟦ {publisher},⟧ {year}.⟦ {url}⟧',
    article: '{n}) ⟦{names}. ⟧{title}. {journal}. {year}⟦, vol. {volume}⟧⟦, p. {pages}⟧.⟦ {url}⟧',
    bibTitle: 'References',
  },
  // Turabian: author-date citations, a bibliography with the year in the imprint.
  {
    name: 'Turabian',
    aliases: ['turabian'],
    cite: authorDate(' ', ', '),
    and: 'and',
    etAlFrom: 4,
    order: ORDER.AUTHOR,
    names: names(N.LAST_FIRST, N.FIRST_LAST, ', ', ', and ', ', and '),
    book: '⟦{names}. ⟧{title}.⟦ {pub},⟧ {year}.⟦ {url}.⟧',
    article: '⟦{names}. ⟧“{title}.” {journal}⟦ {volume}⟧ ({year})⟦: {pages}⟧.⟦ {url}.⟧',
    bibTitle: 'Bibliography',
  },
].map(st => Object.freeze({...st, aliases: Object.freeze(st.aliases)})));

/** Rust `str::trim` (White_Space at both ends). */
const trim = s => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/** Rust `eq_ignore_ascii_case`: only A–Z fold. */
const asciiLower = s => s.replace(/[A-Z]/g, c => c.toLowerCase());

/**
 * The style called `name`: one of ours (any case), or Word's style name or style-sheet file name
 * (`Harvard - Anglia`, `\GostTitle.XSL`); null when none matches (find_style).
 */
export function findStyle(name) {
  name = String(name ?? '');
  const want = asciiLower(trim(name));
  const own = STYLES.find(x => asciiLower(x.name) === want);
  if (own) return own;
  let key = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (key.endsWith('xsl')) key = key.slice(0, -3);
  // Iterator::max_by_key keeps the last of equal maxima.
  let best = null, bestLen = -1;
  for (const st of STYLES) {
    for (const a of st.aliases) {
      if (key.startsWith(a) && a.length >= bestLen) { best = st; bestLen = a.length; }
    }
  }
  return best;
}

/** The session's style; APA when the name is unknown (style). */
export function style(name) {
  return findStyle(name) ?? STYLES[0];
}

// ---------------------------------------------------------------------------------------------
// render.rs
// ---------------------------------------------------------------------------------------------

/** A source field as a string; missing reads as ''. */
const fieldOf = (src, k) => {
  const v = src?.[k];
  return v == null ? '' : String(v);
};

/** Rust `split_once`: [before, after] at the first `sep`, or null. */
function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Rust `rsplit_once`: [before, after] at the last `sep`, or null. */
function rsplitOnce(s, sep) {
  const i = s.lastIndexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * The authors of "Last, First; First Last; Name" as [last, first] pairs: a comma splits surname
 * from given names, else the last space does, else it is all surname (authors).
 */
export function authors(a) {
  return String(a ?? '')
    .split(';')
    .map(trim)
    .filter(x => x !== '')
    .map(x => {
      const comma = splitOnce(x, ',');
      if (comma) return [trim(comma[0]), trim(comma[1])];
      const space = rsplitOnce(x, ' ');
      if (space) return [trim(space[1]), trim(space[0])];
      return [x, ''];
    });
}

/** "Alex Mei" → "A. M." (`dots`), or "A M" without them (initials). */
function initials(first, dots) {
  const sep = dots ? '. ' : ' ';
  let out = first
    .split(/\p{White_Space}+/u)
    .filter(w => w !== '')
    .map(w => String.fromCodePoint(w.codePointAt(0)))
    .join(sep);
  if (dots && out !== '') out += '.';
  return out;
}

/** One author's name in a form of NAME (name). */
function name(form, last, first) {
  const join = (a, sep, b) => (a === '' || b === '' ? `${a}${b}` : `${a}${sep}${b}`);
  switch (form) {
    case NAME.LAST_FIRST: return join(last, ', ', first);
    case NAME.FIRST_LAST: return join(first, ' ', last);
    case NAME.LAST_INITIALS: return join(last, ', ', initials(first, true));
    case NAME.INITIALS_LAST: return join(initials(first, true), ' ', last);
    case NAME.LAST_SPACE_INITIALS: return join(last, ' ', initials(first, true));
    case NAME.UPPER_LAST_FIRST: return join(last.toUpperCase(), ', ', first);
    case NAME.UPPER_LAST_BARE_INITIALS: return join(last.toUpperCase(), ' ', initials(first, false));
    default: throw new Error(`unknown name form ${form}`);
  }
}

/** The author list of an entry in a style's Names (name_list). */
function nameList(au, form) {
  const shown = form.max > 0 ? au.slice(0, form.max) : au;
  const parts = shown.map(([l, f], i) => name(i === 0 ? form.first : form.rest, l, f));
  let out;
  if (parts.length === 0) out = '';
  else if (parts.length === 1) out = parts[0];
  else if (parts.length === 2) out = `${parts[0]}${form.two}${parts[1]}`;
  else out = `${parts.slice(0, -1).join(form.sep)}${form.last}${parts[parts.length - 1]}`;
  if (shown.length < au.length) out += form.etAl;
  return out;
}

/** Append `s` to `out`, dropping its leading full stop when `out` already ends with one ("M." + ". ") (push_text). */
function pushText(out, s) {
  return s.startsWith('.') && out.endsWith('.') ? out + s.slice(1) : out + s;
}

/** Fill one template segment; null when `optional` and a field in it is empty (fill_segment). */
function fillSegment(seg, field, optional) {
  let out = '';
  let rest = seg;
  for (let open = splitOnce(rest, '{'); open; open = splitOnce(rest, '{')) {
    const [before, after] = open;
    out = pushText(out, before);
    const close = splitOnce(after, '}');
    if (!close) return pushText(out, after);
    const [key, tail] = close;
    const value = field(key);
    if (value === '' && optional) return null;
    out = pushText(out, value);
    rest = tail;
  }
  return pushText(out, rest);
}

/** Fill an entry template (see STYLES) (render). */
function render(template, field) {
  let out = '';
  let rest = template;
  while (rest !== '') {
    let seg, optional, after;
    if (rest.startsWith('⟦')) {
      const group = rest.slice(1);
      const g = splitOnce(group, '⟧');
      [seg, optional, after] = g ? [g[0], true, g[1]] : [group, true, ''];
    } else {
      const i = rest.indexOf('⟦');
      [seg, optional, after] = i >= 0 ? [rest.slice(0, i), false, rest.slice(i)] : [rest, false, ''];
    }
    const text = fillSegment(seg, field, optional);
    if (text !== null) out = pushText(out, text);
    rest = after;
  }
  return out;
}

/** In-text citation for a style; `n` is the source's number in numbered styles (cite). */
export function cite(src, styleName, n, pages = '') {
  const st = style(styleName);
  pages = pages == null ? '' : String(pages);
  const lasts = authors(fieldOf(src, 'author')).map(a => a[0]);
  let who;
  if (lasts.length === 0) who = fieldOf(src, 'title');
  else if (lasts.length === 1) who = lasts[0];
  else if (lasts.length >= Math.max(st.etAlFrom, 2)) who = `${lasts[0]} et al.`;
  else if (lasts.length === 2) who = `${lasts[0]} ${st.and} ${lasts[1]}`;
  else who = `${lasts.slice(0, -1).join(', ')} ${st.and} ${lasts[lasts.length - 1]}`;
  const year = fieldOf(src, 'year');
  const c = st.cite;
  switch (c.kind) {
    case CITE.AUTHOR_PAGE: return pages === '' ? `(${who})` : `(${who} ${pages})`;
    case CITE.AUTHOR_DATE: return pages === '' ? `(${who}${c.yearSep}${year})` : `(${who}${c.yearSep}${year}${c.pagesSep}${pages})`;
    case CITE.NUMBER: return c.pagesSep != null && pages !== '' ? `${c.open}${n}${c.pagesSep}${pages}${c.close}` : `${c.open}${n}${c.close}`;
    default: throw new Error(`unknown cite kind ${c.kind}`);
  }
}

/**
 * GB/T 7714 document type code: M book, J journal article, R report, EB/OL web page, Z other;
 * "/OL" marks a source read online (gb_type).
 */
function gbType(src) {
  const kind = asciiLower(fieldOf(src, 'kind'));
  if (kind === 'website' || kind === 'web') return 'EB/OL';
  let code;
  if (fieldOf(src, 'journal') !== '') code = 'J';
  else if (kind === 'book' || kind === '') code = 'M';
  else if (kind === 'article') code = 'J';
  else if (kind === 'report') code = 'R';
  else code = 'Z';
  return fieldOf(src, 'url') === '' ? code : `${code}/OL`;
}

/** Bibliography entry for a style; `n` is the source's number in numbered styles (entry). */
export function entry(src, styleName, n) {
  const st = style(styleName);
  const au = authors(fieldOf(src, 'author'));
  const f = k => fieldOf(src, k);
  const field = key => {
    switch (key) {
      case 'n': return String(n);
      case 'names': return nameList(au, st.names);
      case 'year': return f('year') === '' ? 'n.d.' : f('year');
      case 'title': case 'city': case 'publisher': case 'journal': case 'volume': case 'pages': case 'url':
        return f(key);
      case 'pub': return [f('city'), f('publisher')].filter(x => x !== '').join(': ');
      case 'type': return gbType(src);
      default: return '';
    }
  };
  return render(f('journal') === '' ? st.book : st.article, field);
}
