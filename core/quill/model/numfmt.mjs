// Number formats for list labels, page numbers and note marks (ECMA-376 §17.18.59
// ST_NumberFormat). Translated from wordcraft crates/doc/src/section.rs (`NumFormat`, `roman`,
// `letters`, `russian_letters`, `cardinal_text`, `ordinal_text`, `chicago`) and
// crates/doc/src/cjk_numbers.rs at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// A format is its serialized name, which is also its OOXML name ('decimal', 'upperRoman', ...).
// No DOM, no Node built-ins.

/** Every format, in ST_NumberFormat order (also the binary .doc number format codes up to 0x27). */
export const NUM_FORMATS = Object.freeze([
  'decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter', 'ordinal', 'cardinalText', 'ordinalText',
  'hex', 'chicago', 'ideographDigital', 'japaneseCounting', 'aiueo', 'iroha', 'decimalFullWidth', 'decimalHalfWidth',
  'japaneseLegal', 'japaneseDigitalTenThousand', 'decimalEnclosedCircle', 'decimalFullWidth2', 'aiueoFullWidth',
  'irohaFullWidth', 'decimalZero', 'bullet', 'ganada', 'chosung', 'decimalEnclosedFullstop', 'decimalEnclosedParen',
  'decimalEnclosedCircleChinese', 'ideographEnclosedCircle', 'ideographTraditional', 'ideographZodiac',
  'ideographZodiacTraditional', 'taiwaneseCounting', 'ideographLegalTraditional', 'taiwaneseCountingThousand',
  'taiwaneseDigital', 'chineseCounting', 'chineseLegalSimplified', 'chineseCountingThousand', 'koreanDigital',
  'koreanCounting', 'koreanLegal', 'koreanDigital2', 'vietnameseCounting', 'russianLower', 'russianUpper', 'none',
  'numberInDash', 'hebrew1', 'hebrew2', 'arabicAlpha', 'arabicAbjad', 'hindiVowels', 'hindiConsonants', 'hindiNumbers',
  'hindiCounting', 'thaiLetters', 'thaiNumbers', 'thaiCounting', 'bahtText', 'dollarText',
]);
const FORMAT_SET = new Set(NUM_FORMATS);
export const isNumFormat = f => FORMAT_SET.has(f);

/** The OOXML name (the same string). */
export const numFormatOoxml = f => f;
/** The format an ST_NumberFormat value names; unknown values (and `custom`) are decimal. */
export const numFormatFromOoxml = s => (FORMAT_SET.has(s) ? s : 'decimal');

const u32 = n => Math.max(0, Math.min(Math.floor(Number(n) || 0), 0xffffffff));
const rep = (c, k) => c.repeat(Math.max(0, k));

/** Chicago Manual of Style note marks: *, †, ‡, §, then doubled and so on. */
function chicago(n) {
  const MARKS = ['*', '†', '‡', '§'];
  if (n === 0) return '';
  const i = n - 1;
  const k = Math.min(Math.floor(i / 4) + 1, 10);
  return rep(MARKS[i % 4] ?? '*', k);
}

function ordinalSuffix(n) {
  const a = n % 10, b = n % 100;
  if (b >= 11 && b <= 13) return 'th';
  return a === 1 ? 'st' : a === 2 ? 'nd' : a === 3 ? 'rd' : 'th';
}

/** Lowercase roman numerals (0 → empty; values above 3999 use repeated `m`). */
export function roman(n) {
  const T = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  n = Math.min(u32(n), 50_000);
  for (const [v, r] of T) while (n >= v) { s += r; n -= v; }
  return s;
}

/** Word-style letters: a..z, aa..zz, aaa.. (repeated letter, not base-26). */
export function letters(n) {
  n = u32(n);
  if (n === 0) return '';
  n = Math.min(n, 780);
  const k = Math.floor((n - 1) / 26) + 1;
  return rep(String.fromCharCode(97 + ((n - 1) % 26)), k);
}

const RUSSIAN_LETTERS = [...'абвгдежзиклмнопрстуфхцчшщыэюя'];
export function russianLetters(n) {
  n = u32(n);
  if (n === 0) return '';
  const len = RUSSIAN_LETTERS.length;
  n = Math.min(n, len * 30);
  const k = Math.floor((n - 1) / len) + 1;
  return rep(RUSSIAN_LETTERS[(n - 1) % len] ?? 'а', k);
}

const ARABIC_ALPHA = [...'أبتثجحخدذرزسشصضطظعغفقكلمنهوي'];
const ARABIC_ABJAD = [...'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ'];
function repeatedLetter(alphabet, n) {
  if (!alphabet.length) return String(n);
  if (n === 0) return '';
  const len = alphabet.length;
  n = Math.min(n, len * 30);
  const k = Math.floor((n - 1) / len) + 1;
  return rep(alphabet[(n - 1) % len] ?? alphabet[0], k);
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function capitalize(s) {
  let out = '', up = true;
  for (const c of s) { out += up ? c.toUpperCase() : c; up = c === '-' || c === ' '; }
  return out;
}

/** English cardinal words, capitalised (`Twenty-One`). */
export function cardinalText(n) {
  const words = n => {
    if (n <= 19) return ONES[n] ?? '';
    if (n <= 99) { const t = TENS[Math.floor(n / 10)] ?? ''; return n % 10 === 0 ? t : `${t}-${ONES[n % 10] ?? ''}`; }
    if (n <= 999) { const h = `${words(Math.floor(n / 100))} hundred`; return n % 100 === 0 ? h : `${h} ${words(n % 100)}`; }
    const th = `${words(Math.floor(n / 1000))} thousand`;
    return n % 1000 === 0 ? th : `${th} ${words(n % 1000)}`;
  };
  return capitalize(words(Math.min(u32(n), 999_999)));
}

/** English ordinal words (`Twenty-First`). */
export function ordinalText(n) {
  const c = cardinalText(n).toLowerCase();
  const i = Math.max(c.lastIndexOf('-'), c.lastIndexOf(' '));
  const head = i >= 0 ? c.slice(0, i + 1) : '';
  const last = i >= 0 ? c.slice(i + 1) : c;
  const fixed = {one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth'};
  const tail = fixed[last] ?? (last.endsWith('y') ? `${last.replace(/y+$/, '')}ieth` : `${last}th`);
  return capitalize(head + tail);
}

// --- cjk_numbers.rs -------------------------------------------------------------------------

const CN_DIGITS = [...'〇一二三四五六七八九'];
function counting({digits, units, myriads, zero, omitOne}) {
  return n => {
    if (n === 0) return zero ?? '〇';
    const groups = [Math.floor(n / 100_000_000), Math.floor(n / 10_000) % 10_000, n % 10_000];
    let out = '';
    let zeroPending = false;
    groups.forEach((g, gi) => {
      if (g === 0) { zeroPending ||= out.length > 0; return; }
      const ds = [Math.floor(g / 1000), Math.floor(g / 100) % 10, Math.floor(g / 10) % 10, g % 10];
      ds.forEach((d, pos) => {
        if (d === 0) { zeroPending ||= out.length > 0; return; }
        if (zeroPending && zero) out += zero;
        zeroPending = false;
        const unit = pos === 0 ? units[2] : pos === 1 ? units[1] : pos === 2 ? units[0] : null;
        const omit = d === 1 && unit && (omitOne === 'never' ? false : omitOne === 'leadingTen' ? pos === 2 && out.length === 0 : true);
        if (!omit) out += digits[d] ?? '?';
        if (unit) out += unit;
      });
      zeroPending = false;
      if (gi === 0) out += myriads[1];
      else if (gi === 1) out += myriads[0];
    });
    return out;
  };
}
const CHINESE = counting({digits: CN_DIGITS, units: ['十', '百', '千'], myriads: ['万', '亿'], zero: '零', omitOne: 'leadingTen'});
const TAIWANESE = counting({digits: CN_DIGITS, units: ['十', '百', '千'], myriads: ['萬', '億'], zero: '零', omitOne: 'leadingTen'});
const CHINESE_LEGAL = counting({digits: [...'零壹贰叁肆伍陆柒捌玖'], units: ['拾', '佰', '仟'], myriads: ['万', '亿'], zero: '零', omitOne: 'never'});
const TRADITIONAL_LEGAL = counting({digits: [...'零壹貳參肆伍陸柒捌玖'], units: ['拾', '佰', '仟'], myriads: ['萬', '億'], zero: '零', omitOne: 'never'});
const JAPANESE = counting({digits: CN_DIGITS, units: ['十', '百', '千'], myriads: ['万', '億'], zero: null, omitOne: 'units'});
const JAPANESE_LEGAL = counting({digits: [...'〇壱弐参四伍六七八九'], units: ['拾', '百', '阡'], myriads: ['萬', '億'], zero: null, omitOne: 'never'});
const KOREAN_DIGITS = [...'영일이삼사오육칠팔구'];
const KOREAN = counting({digits: KOREAN_DIGITS, units: ['십', '백', '천'], myriads: ['만', '억'], zero: null, omitOne: 'units'});

const digitsOf = (n, set) => [...String(n)].map(d => set[d.charCodeAt(0) - 48] ?? '?').join('');

export const chineseCounting = n => (n < 100 ? CHINESE(n) : digitsOf(n, CN_DIGITS));
export const chineseCountingThousand = n => CHINESE(n);
export const chineseLegalSimplified = n => CHINESE_LEGAL(n);
export const ideographLegalTraditional = n => TRADITIONAL_LEGAL(n);
export const taiwaneseCounting = n => (n < 100 ? TAIWANESE(n) : digitsOf(n, CN_DIGITS));
export const taiwaneseCountingThousand = n => TAIWANESE(n);
export const japaneseCounting = n => JAPANESE(n);
export const japaneseLegal = n => JAPANESE_LEGAL(n);
export function japaneseDigitalTenThousand(n) {
  const groups = [[Math.floor(n / 100_000_000), '億'], [Math.floor(n / 10_000) % 10_000, '万'], [n % 10_000, '']];
  let out = '';
  for (const [g, mark] of groups) {
    const s = digitsOf(g, CN_DIGITS);
    if (!out) { if (g === 0 && mark) continue; } else out += rep('〇', 4 - [...s].length);
    out += s + mark;
  }
  return out;
}
export const koreanCounting = n => KOREAN(n);
export const koreanDigital = n => digitsOf(n, KOREAN_DIGITS);
const KO_ONES = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉'];
const KO_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
export const koreanLegal = n => (n === 0 || n > 99 ? String(n) : (KO_TENS[Math.floor(n / 10)] ?? '') + (KO_ONES[n % 10] ?? ''));
export const ideographDigital = n => digitsOf(n, CN_DIGITS);

const STEMS = [...'甲乙丙丁戊己庚辛壬癸'];
const BRANCHES = [...'子丑寅卯辰巳午未申酉戌亥'];
const nth = (set, n) => (n >= 1 && n <= set.length ? set[n - 1] : String(n));
export const ideographTraditional = n => nth(STEMS, n);
export const ideographZodiac = n => nth(BRANCHES, n);
export const ideographZodiacTraditional = n => (n >= 1 && n <= 60 ? STEMS[(n - 1) % 10] + BRANCHES[(n - 1) % 12] : String(n));
const enclosed = (n, first, count) => (n >= 1 && n <= count ? String.fromCodePoint(first + n - 1) : String(n));
export const decimalEnclosedCircle = n => enclosed(n, 0x2460, 20);
export const decimalEnclosedCircleChinese = n => enclosed(n, 0x2460, 10);
export const decimalEnclosedFullstop = n => enclosed(n, 0x2488, 20);
export const decimalEnclosedParen = n => enclosed(n, 0x2474, 20);
export const ideographEnclosedCircle = n => enclosed(n, 0x3280, 10);
export const decimalFullWidth = n => [...String(n)].map(c => String.fromCodePoint(0xff10 + (c.charCodeAt(0) - 48))).join('');

export const AIUEO = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
export const AIUEO_HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
export const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス';
export const IROHA_HALF = 'ｲﾛﾊﾆﾎﾍﾄﾁﾘﾇﾙｦﾜｶﾖﾀﾚｿﾂﾈﾅﾗﾑｳヰﾉｵｸﾔﾏｹﾌｺｴﾃｱｻｷﾕﾒﾐｼヱﾋﾓｾｽ';
const GANADA = '가나다라마바사아자차카타파하';
const CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const nthOf = (set, n) => nth([...set], n);
export const aiueo = n => nthOf(AIUEO_HALF, n);
export const aiueoFullWidth = n => nthOf(AIUEO, n);
export const iroha = n => nthOf(IROHA_HALF, n);
export const irohaFullWidth = n => nthOf(IROHA, n);
export const ganada = n => nthOf(GANADA, n);
export const chosung = n => nthOf(CHOSUNG, n);

/**
 * Format `n` (1-based) in `format`. Formats WordCraft doesn't draw yet (Hebrew, Hindi, Thai,
 * Vietnamese, text amounts) show decimal, as do values past a sequence's end.
 */
export function formatNumber(format, n) {
  n = u32(n);
  switch (format) {
    case 'decimalZero': return String(n).padStart(2, '0');
    case 'upperRoman': return roman(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerLetter': return letters(n);
    case 'russianUpper': return russianLetters(n).toUpperCase();
    case 'russianLower': return russianLetters(n);
    case 'arabicAlpha': return repeatedLetter(ARABIC_ALPHA, n);
    case 'arabicAbjad': return repeatedLetter(ARABIC_ABJAD, n);
    case 'ordinal': return `${n}${ordinalSuffix(n)}`;
    case 'cardinalText': return cardinalText(n);
    case 'ordinalText': return ordinalText(n);
    case 'bullet': case 'none': return '';
    case 'chicago': return chicago(n);
    case 'numberInDash': return `- ${n} -`;
    case 'ideographDigital': case 'koreanDigital2': case 'taiwaneseDigital': return ideographDigital(n);
    case 'japaneseCounting': return japaneseCounting(n);
    case 'japaneseLegal': return japaneseLegal(n);
    case 'japaneseDigitalTenThousand': return japaneseDigitalTenThousand(n);
    case 'aiueo': return aiueo(n);
    case 'aiueoFullWidth': return aiueoFullWidth(n);
    case 'iroha': return iroha(n);
    case 'irohaFullWidth': return irohaFullWidth(n);
    case 'decimalFullWidth': case 'decimalFullWidth2': return decimalFullWidth(n);
    case 'decimalEnclosedCircle': return decimalEnclosedCircle(n);
    case 'decimalEnclosedCircleChinese': return decimalEnclosedCircleChinese(n);
    case 'decimalEnclosedFullstop': return decimalEnclosedFullstop(n);
    case 'decimalEnclosedParen': return decimalEnclosedParen(n);
    case 'ideographEnclosedCircle': return ideographEnclosedCircle(n);
    case 'ideographTraditional': return ideographTraditional(n);
    case 'ideographZodiac': return ideographZodiac(n);
    case 'ideographZodiacTraditional': return ideographZodiacTraditional(n);
    case 'ideographLegalTraditional': return ideographLegalTraditional(n);
    case 'taiwaneseCounting': return taiwaneseCounting(n);
    case 'taiwaneseCountingThousand': return taiwaneseCountingThousand(n);
    case 'chineseCounting': return chineseCounting(n);
    case 'chineseCountingThousand': return chineseCountingThousand(n);
    case 'chineseLegalSimplified': return chineseLegalSimplified(n);
    case 'koreanCounting': return koreanCounting(n);
    case 'koreanDigital': return koreanDigital(n);
    case 'koreanLegal': return koreanLegal(n);
    case 'ganada': return ganada(n);
    case 'chosung': return chosung(n);
    default: return String(n);
  }
}
