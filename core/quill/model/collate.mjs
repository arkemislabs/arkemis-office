// Language-aware sorting of text: a small collation (table sort, index headings, sorted lists).
// Every letter has a primary weight (its place in the alphabet) and a secondary one (its
// diacritic); strings compare by primary weights, then secondary ones, so é sorts with e unless
// the language makes it a letter of its own (Polish ą after a, Swedish å ä ö after z, Czech ch
// after h, Spanish ñ after n, Hungarian cs, gy, sz...). Text without diacritics sorts as a
// case-insensitive code-point compare.
// Translated from wordcraft crates/doc/src/collate.rs at aadb077e072b7de05f724e359d8db82e151f125c
// (the DECOMP and COMPOSE tables copied from it). MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

// Diacritic marks: 1 acute, 2 grave, 3 circumflex, 4 diaeresis, 5 tilde, 6 ring, 7 caron,
// 8 cedilla, 9 ogonek, 10 dot, 11 stroke, 12 breve, 13 macron, 14 double acute, 15 comma below,
// 16 ligature, 17 dotless, 18 eth.
const DECOMP = new Map([
  ['à', ['a', 2]], ['á', ['a', 1]], ['â', ['a', 3]], ['ã', ['a', 5]], ['ä', ['a', 4]], ['å', ['a', 6]],
  ['ā', ['a', 13]], ['ă', ['a', 12]], ['ą', ['a', 9]], ['æ', ['ae', 16]], ['ç', ['c', 8]], ['ć', ['c', 1]],
  ['ĉ', ['c', 3]], ['ċ', ['c', 10]], ['č', ['c', 7]], ['ď', ['d', 7]], ['đ', ['d', 11]], ['ð', ['d', 18]],
  ['è', ['e', 2]], ['é', ['e', 1]], ['ê', ['e', 3]], ['ë', ['e', 4]], ['ē', ['e', 13]], ['ĕ', ['e', 12]],
  ['ė', ['e', 10]], ['ę', ['e', 9]], ['ě', ['e', 7]], ['ĝ', ['g', 3]], ['ğ', ['g', 12]], ['ġ', ['g', 10]],
  ['ģ', ['g', 8]], ['ĥ', ['h', 3]], ['ħ', ['h', 11]], ['ì', ['i', 2]], ['í', ['i', 1]], ['î', ['i', 3]],
  ['ï', ['i', 4]], ['ĩ', ['i', 5]], ['ī', ['i', 13]], ['ĭ', ['i', 12]], ['į', ['i', 9]], ['ı', ['i', 17]],
  ['ĳ', ['ij', 16]], ['ĵ', ['j', 3]], ['ķ', ['k', 8]], ['ĺ', ['l', 1]], ['ļ', ['l', 8]], ['ľ', ['l', 7]],
  ['ŀ', ['l', 10]], ['ł', ['l', 11]], ['ñ', ['n', 5]], ['ń', ['n', 1]], ['ņ', ['n', 8]], ['ň', ['n', 7]],
  ['ò', ['o', 2]], ['ó', ['o', 1]], ['ô', ['o', 3]], ['õ', ['o', 5]], ['ö', ['o', 4]], ['ø', ['o', 11]],
  ['ō', ['o', 13]], ['ŏ', ['o', 12]], ['ő', ['o', 14]], ['œ', ['oe', 16]], ['ŕ', ['r', 1]], ['ŗ', ['r', 8]],
  ['ř', ['r', 7]], ['ś', ['s', 1]], ['ŝ', ['s', 3]], ['ş', ['s', 8]], ['š', ['s', 7]], ['ș', ['s', 15]],
  ['ß', ['ss', 16]], ['ţ', ['t', 8]], ['ť', ['t', 7]], ['ŧ', ['t', 11]], ['ț', ['t', 15]], ['ù', ['u', 2]],
  ['ú', ['u', 1]], ['û', ['u', 3]], ['ü', ['u', 4]], ['ũ', ['u', 5]], ['ū', ['u', 13]], ['ŭ', ['u', 12]],
  ['ů', ['u', 6]], ['ű', ['u', 14]], ['ų', ['u', 9]], ['ŵ', ['w', 3]], ['ý', ['y', 1]], ['ÿ', ['y', 4]],
  ['ŷ', ['y', 3]], ['ź', ['z', 1]], ['ż', ['z', 10]], ['ž', ['z', 7]],
]);

const COMPOSE = Object.freeze([
  ['a', '\u0300', 'à'], ['a', '\u0301', 'á'], ['a', '\u0302', 'â'], ['a', '\u0303', 'ã'], ['a', '\u0304', 'ā'],
  ['a', '\u0306', 'ă'], ['a', '\u0307', 'ȧ'], ['a', '\u0308', 'ä'], ['a', '\u030a', 'å'], ['a', '\u030c', 'ǎ'],
  ['a', '\u0328', 'ą'], ['b', '\u0307', 'ḃ'], ['c', '\u0301', 'ć'], ['c', '\u0302', 'ĉ'], ['c', '\u0307', 'ċ'],
  ['c', '\u030c', 'č'], ['c', '\u0327', 'ç'], ['d', '\u0307', 'ḋ'], ['d', '\u030c', 'ď'], ['d', '\u0327', 'ḑ'],
  ['e', '\u0300', 'è'], ['e', '\u0301', 'é'], ['e', '\u0302', 'ê'], ['e', '\u0303', 'ẽ'], ['e', '\u0304', 'ē'],
  ['e', '\u0306', 'ĕ'], ['e', '\u0307', 'ė'], ['e', '\u0308', 'ë'], ['e', '\u030c', 'ě'], ['e', '\u0327', 'ȩ'],
  ['e', '\u0328', 'ę'], ['f', '\u0307', 'ḟ'], ['g', '\u0301', 'ǵ'], ['g', '\u0302', 'ĝ'], ['g', '\u0304', 'ḡ'],
  ['g', '\u0306', 'ğ'], ['g', '\u0307', 'ġ'], ['g', '\u030c', 'ǧ'], ['g', '\u0327', 'ģ'], ['h', '\u0302', 'ĥ'],
  ['h', '\u0307', 'ḣ'], ['h', '\u0308', 'ḧ'], ['h', '\u030c', 'ȟ'], ['h', '\u0327', 'ḩ'], ['i', '\u0300', 'ì'],
  ['i', '\u0301', 'í'], ['i', '\u0302', 'î'], ['i', '\u0303', 'ĩ'], ['i', '\u0304', 'ī'], ['i', '\u0306', 'ĭ'],
  ['i', '\u0308', 'ï'], ['i', '\u030c', 'ǐ'], ['i', '\u0328', 'į'], ['j', '\u0302', 'ĵ'], ['j', '\u030c', 'ǰ'],
  ['k', '\u0301', 'ḱ'], ['k', '\u030c', 'ǩ'], ['k', '\u0327', 'ķ'], ['l', '\u0301', 'ĺ'], ['l', '\u030c', 'ľ'],
  ['l', '\u0327', 'ļ'], ['m', '\u0301', 'ḿ'], ['m', '\u0307', 'ṁ'], ['n', '\u0300', 'ǹ'], ['n', '\u0301', 'ń'],
  ['n', '\u0303', 'ñ'], ['n', '\u0307', 'ṅ'], ['n', '\u030c', 'ň'], ['n', '\u0327', 'ņ'], ['o', '\u0300', 'ò'],
  ['o', '\u0301', 'ó'], ['o', '\u0302', 'ô'], ['o', '\u0303', 'õ'], ['o', '\u0304', 'ō'], ['o', '\u0306', 'ŏ'],
  ['o', '\u0307', 'ȯ'], ['o', '\u0308', 'ö'], ['o', '\u030b', 'ő'], ['o', '\u030c', 'ǒ'], ['o', '\u0328', 'ǫ'],
  ['p', '\u0301', 'ṕ'], ['p', '\u0307', 'ṗ'], ['r', '\u0301', 'ŕ'], ['r', '\u0307', 'ṙ'], ['r', '\u030c', 'ř'],
  ['r', '\u0327', 'ŗ'], ['s', '\u0301', 'ś'], ['s', '\u0302', 'ŝ'], ['s', '\u0307', 'ṡ'], ['s', '\u030c', 'š'],
  ['s', '\u0326', 'ș'], ['s', '\u0327', 'ş'], ['t', '\u0307', 'ṫ'], ['t', '\u0308', 'ẗ'], ['t', '\u030c', 'ť'],
  ['t', '\u0326', 'ț'], ['t', '\u0327', 'ţ'], ['u', '\u0300', 'ù'], ['u', '\u0301', 'ú'], ['u', '\u0302', 'û'],
  ['u', '\u0303', 'ũ'], ['u', '\u0304', 'ū'], ['u', '\u0306', 'ŭ'], ['u', '\u0308', 'ü'], ['u', '\u030a', 'ů'],
  ['u', '\u030b', 'ű'], ['u', '\u030c', 'ǔ'], ['u', '\u0328', 'ų'], ['v', '\u0303', 'ṽ'], ['w', '\u0300', 'ẁ'],
  ['w', '\u0301', 'ẃ'], ['w', '\u0302', 'ŵ'], ['w', '\u0307', 'ẇ'], ['w', '\u0308', 'ẅ'], ['w', '\u030a', 'ẘ'],
  ['x', '\u0307', 'ẋ'], ['x', '\u0308', 'ẍ'], ['y', '\u0300', 'ỳ'], ['y', '\u0301', 'ý'], ['y', '\u0302', 'ŷ'],
  ['y', '\u0303', 'ỹ'], ['y', '\u0304', 'ȳ'], ['y', '\u0307', 'ẏ'], ['y', '\u0308', 'ÿ'], ['y', '\u030a', 'ẙ'],
  ['z', '\u0301', 'ź'], ['z', '\u0302', 'ẑ'], ['z', '\u0307', 'ż'], ['z', '\u030c', 'ž'], ['е', '\u0308', 'ё'],
  ['и', '\u0306', 'й'],
]);

/** A letter (or group) a language sorts as its own: `rank` places after `after`, secondary `sec`. */
const t = (seq, after, rank, sec = 0) => ({seq, after, rank, sec});
const PL = [t('ą', 'a', 1), t('ć', 'c', 1), t('ę', 'e', 1), t('ł', 'l', 1), t('ń', 'n', 1), t('ó', 'o', 1), t('ś', 's', 1), t('ź', 'z', 1), t('ż', 'z', 2)];
const CS = [t('č', 'c', 1), t('ch', 'h', 1), t('ř', 'r', 1), t('š', 's', 1), t('ž', 'z', 1)];
const SK = [t('ä', 'a', 1), t('č', 'c', 1), t('ch', 'h', 1), t('ô', 'o', 1), t('š', 's', 1), t('ž', 'z', 1)];
const HU = [t('cs', 'c', 1), t('dz', 'd', 1), t('dzs', 'd', 2), t('gy', 'g', 1), t('ly', 'l', 1), t('ny', 'n', 1), t('ö', 'o', 1), t('ő', 'o', 1, 14),
  t('sz', 's', 1), t('ty', 't', 1), t('ü', 'u', 1), t('ű', 'u', 1, 14), t('zs', 'z', 1)];
const SV = [t('å', 'z', 1), t('ä', 'z', 2), t('æ', 'z', 2, 16), t('ö', 'z', 3), t('ø', 'z', 3, 11)];
const DA = [t('æ', 'z', 1), t('ä', 'z', 1, 4), t('ø', 'z', 2), t('ö', 'z', 2, 4), t('å', 'z', 3)];
const ES = [t('ñ', 'n', 1)];
// Russian ё shares е's primary weight; the diaeresis breaks ties (CLDR Russian standard).
const RU = [t('ё', 'е', 0, 4)];
const TR = [t('ç', 'c', 1), t('ğ', 'g', 1), t('ı', 'h', 1), t('ö', 'o', 1), t('ş', 's', 1), t('ü', 'u', 1)];
const HR = [t('č', 'c', 1), t('ć', 'c', 2), t('dž', 'd', 1), t('đ', 'd', 2), t('lj', 'l', 1), t('nj', 'n', 1), t('š', 's', 1), t('ž', 'z', 1)];
const RO = [t('ă', 'a', 1), t('â', 'a', 2), t('î', 'i', 1), t('ș', 's', 1), t('ş', 's', 1, 8), t('ț', 't', 1), t('ţ', 't', 1, 8)];
const ET = [t('š', 's', 1), t('z', 's', 2), t('ž', 's', 3), t('õ', 'w', 1), t('ä', 'w', 2), t('ö', 'w', 3), t('ü', 'w', 4)];
const LT = [t('č', 'c', 1), t('š', 's', 1), t('ž', 'z', 1)];
const LV = [t('č', 'c', 1), t('ģ', 'g', 1), t('ķ', 'k', 1), t('ļ', 'l', 1), t('ņ', 'n', 1), t('š', 's', 1), t('ž', 'z', 1)];
const IS = [t('á', 'a', 1), t('ð', 'd', 1), t('é', 'e', 1), t('í', 'i', 1), t('ó', 'o', 1), t('ú', 'u', 1), t('ý', 'y', 1), t('þ', 'z', 1),
  t('æ', 'z', 2), t('ö', 'z', 3)];

/** The primary language subtag of a BCP 47 tag (pl-PL → pl), lowercased. */
export function language(lang) {
  if (lang === null || lang === undefined) return '';
  return String(lang).split(/[-_]/)[0].trim().toLowerCase();
}

function tailoring(lang) {
  switch (language(lang)) {
    case 'pl': return PL;
    case 'cs': return CS;
    case 'sk': return SK;
    case 'hu': return HU;
    case 'sv': case 'fi': return SV;
    case 'da': case 'nb': case 'nn': case 'no': return DA;
    case 'es': case 'gl': return ES;
    case 'ru': return RU;
    case 'tr': case 'az': return TR;
    case 'hr': case 'bs': case 'sr': return HR;
    case 'ro': return RO;
    case 'et': return ET;
    case 'lt': return LT;
    case 'lv': return LV;
    case 'is': return IS;
    case 'sl': return LT;
    default: return [];
  }
}

/** `s` lowercased, each letter + combining mark that has a single-letter form composed. */
function lowerComposed(s) {
  const out = [];
  for (const c of String(s).toLowerCase()) {
    const prev = out[out.length - 1];
    const hit = prev !== undefined ? COMPOSE.find(([b, m]) => b === prev && m === c) : null;
    if (hit) out[out.length - 1] = hit[2]; else out.push(c);
  }
  return out.join('');
}

const weight = (c, rank) => Math.min(0xffffffff, c.codePointAt(0) * 16 + rank);

/** The next collation element of `rest` (lowercase) and its length in UTF-16 units. */
function nextElem(rest, rules) {
  let best = null;
  for (const r of rules) if (rest.startsWith(r.seq) && (!best || r.seq.length > best.seq.length)) best = r;
  if (best) return [{primary: [weight(best.after, best.rank)], sec: best.sec, text: rest.slice(0, best.seq.length), own: true}, best.seq.length];
  const cp = rest.codePointAt(0);
  if (cp === undefined) return null;
  const c = String.fromCodePoint(cp);
  const d = DECOMP.get(c);
  if (d) return [{primary: [...d[0]].map(b => weight(b, 0)), sec: d[1], text: c, own: false}, c.length];
  if (cp >= 0x300 && cp <= 0x36f) return [{primary: [], sec: 32 + (cp - 0x300), text: c, own: false}, c.length];
  return [{primary: [weight(c, 0)], sec: 0, text: c, own: false}, c.length];
}

/** The sort key of `s` for language `lang` (BCP 47; null sorts like English): {primary, secondary, text}. */
export function sortKey(s, lang = null) {
  const text = lowerComposed(s);
  const rules = tailoring(lang);
  const key = {primary: [], secondary: [], text};
  let i = 0;
  while (i < text.length) {
    const got = nextElem(text.slice(i), rules);
    if (!got) break;
    const [e, n] = got;
    i += Math.max(n, 1);
    if (!e.primary.length) {
      if (key.secondary.length) key.secondary[key.secondary.length - 1] = Math.min(0xffff, key.secondary[key.secondary.length - 1] + e.sec);
      continue;
    }
    e.primary.forEach((w, k) => { key.primary.push(w); key.secondary.push(k === 0 ? e.sec : 0); });
  }
  return key;
}

const cmpNums = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
/** Code point order (Rust's String order). */
export function cmpCodePoints(a, b) {
  const x = [...a].map(c => c.codePointAt(0)), y = [...b].map(c => c.codePointAt(0));
  return cmpNums(x, y);
}
/** Compare two sort keys: -1, 0 or 1. */
export const cmpSortKeys = (a, b) => cmpNums(a.primary, b.primary) || cmpNums(a.secondary, b.secondary) || cmpCodePoints(a.text, b.text);

/** Compare two strings in the order of language `lang`, ignoring case: -1, 0 or 1. */
export const collate = (a, b, lang = null) => cmpSortKeys(sortKey(a, lang), sortKey(b, lang));

/** The index heading letter `s` files under in `lang` (Ł for Łódź in Polish, L in English, Ch in Czech). */
export function headingLetter(s, lang = null) {
  const low = lowerComposed(String(s).trimStart());
  const got = nextElem(low, tailoring(lang));
  if (!got) return null;
  const [e] = got;
  let shown;
  if (e.own || e.sec === 0) shown = e.text;
  else {
    let hit = null;
    for (const [x, [base]] of DECOMP) if (e.text.startsWith(x)) { hit = base; break; }
    shown = hit !== null ? [...hit][0] : e.text;
  }
  const chars = [...shown];
  if (!chars.length) return null;
  return chars[0].toUpperCase() + chars.slice(1).join('');
}
