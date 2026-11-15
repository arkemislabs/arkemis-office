// Find text and redact, Patterns: phone numbers, email addresses, credit card numbers, US Social
// Security numbers and dates. Each matcher works on a page's text as characters and returns character
// ranges; callers map them to glyphs and areas. Also the word list (Multiple words or phrases) and the
// redaction code sets (Redaction Tool Properties > Redaction code).
//
// Translated from printcraft crates/redact/src/patterns.rs (phone, email, credit_card, luhn, ssn,
// month, date, find, word_list) and crates/redact/src/codes.rs (CODE_SETS, overlay) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.

export const PATTERNS = Object.freeze([
  {id: 'phone', label: 'Phone Numbers'}, {id: 'email', label: 'Email Addresses'}, {id: 'credit-card', label: 'Credit Cards'},
  {id: 'ssn', label: 'Social Security Numbers'}, {id: 'date', label: 'Dates'}]);
export const patternById = id => PATTERNS.find(p => p.id === id) ?? null;
export const patternOfLabel = label => PATTERNS.find(p => p.label === label || p.label.replace('Credit Cards', 'Credit Card Numbers') === label) ?? null;

const isDigit = c => c !== undefined && c >= '0' && c <= '9';
const isAlnum = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isAlpha = c => c !== undefined && /\p{L}/u.test(c);
const word = c => isAlnum(c);

/** Digits and the separators allowed between them, from `start`: [end, digit count]. */
function digitRun(s, start, seps, maxLen) {
  let i = start;
  let n = 0;
  while (i < s.length && i - start < maxLen) {
    const c = s[i];
    if (isDigit(c)) n++;
    else if (!((seps.includes(c) && (isDigit(s[i + 1]) || s[i + 1] === '(')
      // A slash only ever joins two digits ("0426/123456").
      && (c !== '/' || (isDigit(s[i + 1]) && isDigit(s[i - 1])))) || ((c === '(' || c === ')') && seps.includes(c)))) break;
    i++;
  }
  // Never end on a separator.
  while (i > start && !isDigit(s[i - 1])) i--;
  return [i, n];
}

/** Whether the separated digit run goes on past `k` in direction `step` (1 or -1), through separators only. */
function runContinues(s, k, step, seps) {
  let j = k;
  for (;;) {
    j += step;
    const c = s[j];
    if (c === undefined) return false;
    if (isDigit(c)) return true;
    if (!seps.includes(c)) return false;
  }
}

/** Words that label the number after them as a phone number, lowercased. */
const PHONE_LABELS = ['tel', 'tél', 'tele', 'telefon', 'telefono', 'teléfono', 'telephone', 'téléphone', 'phone', 'ph', 'cell', 'cel', 'cellulare', 'cellphone',
  'mobile', 'mob', 'mobil', 'móvil', 'movil', 'handy', 'fax', 'tlf', 'telf', 'gsm'];

/** Whether the text before `i` is a phone label, with one to four spaces, colons or dots between. */
function labelled(s, i) {
  const before = k => (k >= 1 ? s[k - 1] : undefined);
  let j = i;
  while (i - j < 4 && [' ', ':', '.', ' '].includes(before(j))) j--;
  const end = j;
  while (end - j < 12 && isAlpha(before(j))) j--;
  if (end === i || isAlnum(before(j))) return false;
  const label = s.slice(j, end).join('').toLowerCase();
  return PHONE_LABELS.includes(label);
}

function phone(s, i) {
  const SEPS = [' ', '-', '.', '(', ')'];
  // A slash joins the area code to the number in Italian and German landlines ("0426/123456").
  const RUN_SEPS = [' ', '-', '.', '(', ')', '/'];
  const startOk = (s[i] === '+' && isDigit(s[i + 1])) || (s[i] === '(' && isDigit(s[i + 1])) || isDigit(s[i]);
  if (!startOk || word(s[i - 1]) || s[i - 1] === '+') return null;
  // A phone number is a whole run of digit groups. The tail of a longer one is not a phone number.
  if (runContinues(s, i, -1, SEPS)) return null;
  const plus = s[i] === '+';
  const first = plus ? i + 1 : i;
  const [end, n] = digitRun(s, first, RUN_SEPS, 28);
  const run = s.slice(first, end);
  const seps = run.filter(c => !isDigit(c)).length;
  // Grouped by at least one separator, or labelled, so plain numbers never match; nor does the head of a run too long to be a phone number.
  if ((seps === 0 && !labelled(s, i)) || isDigit(s[end]) || runContinues(s, end - 1, 1, SEPS)) return null;
  const slash = run.includes('/');
  // Italian geographic numbers retain their initial 0 after +39; AGCOM's plan gives them 6 to 11 national digits.
  let slashRun = run;
  if (plus && slash) {
    if (!labelled(s, i) || n < 8 || n > 13) return null;
    if (!(run[0] === '3' && run[1] === '9')) return null;
    const national = run.slice(2);
    slashRun = national[0] === ' ' ? national.slice(1) : national;
  }
  // Only an area code beginning with 0 takes a slash, and only one, right after it.
  if (run.filter(c => c === '/').length > 1
    || (slash && (slashRun[0] !== '0' || !isDigit(slashRun[1]) || !slashRun.slice(0, slashRun.indexOf('/') < 0 ? slashRun.length : slashRun.indexOf('/')).every(isDigit)))) return null;
  let ok;
  if (plus) ok = n >= 8 && n <= 15;   // E.164
  else {
    // North American: 10 digits, 11 with a country code.
    const nanp = n >= 10 && n <= 11 && !slash;
    // National with a trunk 0 and 6 to 14 more digits; the first group needs two digits so decimals don't match.
    const digits = run.slice(run.findIndex(isDigit));
    const trunkZero = digits[0] === '0';
    let lead = 0;
    while (lead < digits.length && isDigit(digits[lead])) lead++;
    const trunk = trunkZero && n >= 7 && n <= 15 && lead >= 2 && date(s, i) === null;
    ok = nanp || trunk;
  }
  return ok ? end - i : null;
}

/** Scripts written without spaces between words: their letters never count as part of an address. */
function spaceless(c) {
  const u = c.codePointAt(0);
  return (u >= 0x0E00 && u <= 0x0EFF) || (u >= 0x1000 && u <= 0x109F) || (u >= 0x1100 && u <= 0x11FF) || (u >= 0x1780 && u <= 0x17FF) || (u >= 0x2E80 && u <= 0x9FFF)
    || (u >= 0xA960 && u <= 0xA97F) || (u >= 0xAC00 && u <= 0xD7FF) || (u >= 0xF900 && u <= 0xFAFF) || (u >= 0xFF00 && u <= 0xFFEF) || (u >= 0x20000 && u <= 0x3FFFF);
}
const addressChar = c => c !== undefined && (/[A-Za-z0-9]/.test(c) || (isAlnum(c) && !spaceless(c)));

function email(s, i) {
  const local = c => c !== undefined && (addressChar(c) || '._%+-'.includes(c));
  if (!local(s[i]) || local(s[i - 1])) return null;
  let j = i;
  while (j < s.length && local(s[j])) j++;
  if (s[j] !== '@' || !s.slice(i, j).some(addressChar)) return null;
  const d0 = j + 1;
  let k = d0;
  while (k < s.length && (addressChar(s[k]) || s[k] === '-' || (s[k] === '.' && addressChar(s[k + 1])))) k++;
  const domain = s.slice(d0, k).join('');
  const tld = domain.split('.').pop() ?? '';
  return domain.includes('.') && Array.from(tld).length >= 2 && Array.from(tld).every(isAlpha) ? k - i : null;
}

function luhn(digits) {
  let sum = 0;
  for (let k = 0; k < digits.length; k++) {
    const d = digits[digits.length - 1 - k];
    if (k % 2 === 1) { const x = d * 2; sum += x > 9 ? x - 9 : x; } else sum += d;
  }
  return sum % 10 === 0;
}

function creditCard(s, i) {
  if (!isDigit(s[i]) || isDigit(s[i - 1])) return null;
  // Room for the longest card (19 digits in groups, 23 characters) and a tail of up to four digits.
  const [end, n] = digitRun(s, i, [' ', '-'], 29);
  // A run longer than that is some other, longer number.
  if (end === i || runContinues(s, end - 1, 1, [' ', '-'])) return null;
  // The longest run may carry a trailing number (an expiry, a year, a CVV), so try it and then each shorter run ending at a group boundary.
  let count = n;
  for (let e = end; e >= i + 1; e--) {
    if (n - count > 4) break;
    if (!isDigit(s[e - 1])) continue;
    const boundary = e === end ? !isDigit(s[end]) : s[e] === ' ' || s[e] === '-';
    if (boundary && count >= 13 && count <= 19) {
      const digits = s.slice(i, e).filter(isDigit).map(Number);
      if (luhn(digits)) return e - i;
    }
    count = Math.max(0, count - 1);
  }
  return null;
}

function ssn(s, i) {
  if (isDigit(s[i - 1])) return null;
  const g = (from, n) => { for (let k = from; k < from + n; k++) if (!isDigit(s[k])) return false; return true; };
  const sep = k => s[k] === '-' || s[k] === ' ';
  if (!(g(i, 3) && sep(i + 3) && g(i + 4, 2) && sep(i + 6) && g(i + 7, 4)) || isDigit(s[i + 11])) return null;
  const area = s.slice(i, i + 3).join('');
  return area !== '000' && area !== '666' && !area.startsWith('9') ? 11 : null;
}

const MONTHS = [
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'],
  ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
].flat();
const MONTH_ABBREVIATIONS = [
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  ['oca', 'şub', 'mar', 'nis', 'may', 'haz', 'tem', 'ağu', 'eyl', 'eki', 'kas', 'ara'],
].flat();

/** One lowercase character for `c`, Turkish dotted and dotless i the same as i. */
const fold = c => (c === 'I' || c === 'İ' || c === 'ı' ? 'i' : (Array.from(c.toLowerCase())[0] ?? c));

/** Characters `name` covers at `i`, when it stands there as a whole word (any case). */
function wordAt(s, i, name) {
  let n = 0;
  for (const c of name) {
    if (s[i + n] === undefined || fold(s[i + n]) !== fold(c)) return null;
    n++;
  }
  return isAlpha(s[i + n]) ? null : n;
}

/** A month name or its abbreviation (optionally with a full stop) at `i`. */
function month(s, i) {
  if (word(s[i - 1])) return null;
  let best = null;
  for (const m of MONTHS) { const n = wordAt(s, i, m); if (n !== null && (best === null || n > best)) best = n; }
  if (best !== null) return best;
  for (const m of MONTH_ABBREVIATIONS) {
    const n = wordAt(s, i, m);
    if (n !== null) return s[i + n] === '.' ? n + 1 : n;
  }
  return null;
}

function number(s, i, min, max) {
  let n = 0;
  for (let k = Math.min(i, s.length); k < s.length && n < max + 1 && isDigit(s[k]); k++) n++;
  return n >= min && n <= max ? n : null;
}

function date(s, i) {
  if (word(s[i - 1])) return null;
  const spaces = k => { let n = 0; for (let j = Math.min(k, s.length); j < s.length && s[j] === ' '; j++) n++; return n; };
  // Numeric: m/d/yy(yy), m-d-yyyy, d.m.yyyy, yyyy-mm-dd.
  const a = number(s, i, 1, 4);
  if (a !== null) {
    const sep = s[i + a];
    if (sep !== undefined && sep >= '-' && sep <= '/') {
      const b = number(s, i + a + 1, 1, 2);
      if (b !== null && s[i + a + 1 + b] === sep) {
        const c = number(s, i + a + b + 2, a === 4 ? 1 : 2, a === 4 ? 2 : 4);
        if (c !== null && (a <= 2 || a === 4) && !isDigit(s[i + a + b + 2 + c])) return a + b + c + 2;
      }
    }
    // "5 January 2024", "5 Ekim 2024", "5. Oktober 2024".
    const day = i + a + (s[i + a] === '.' ? 1 : 0);
    if (a <= 2) {
      const k = day + spaces(day);
      if (k > day) {
        const m = month(s, k);
        if (m !== null) {
          const k2 = k + m + spaces(k + m);
          const y = number(s, k2, 4, 4);
          if (y !== null) return k2 + y - i;
        }
      }
    }
    return null;
  }
  // "January 5, 2024" / "Jan. 5 2024".
  const m = month(s, i);
  if (m === null) return null;
  const k = i + m + spaces(i + m);
  const d = number(s, k, 1, 2);
  if (d === null) return null;
  let k2 = k + d;
  if (s[k2] === ',') k2++;
  k2 += spaces(k2);
  const y = number(s, k2, 4, 4);
  return y === null ? null : k2 + y - i;
}

const MATCHERS = {phone, email, 'credit-card': creditCard, ssn, date};

/** Character ranges [start, end) of `text` (an array of characters) matching the pattern id. */
export function find(patternId, text) {
  const f = MATCHERS[patternId];
  if (!f) throw new Error(`unknown pattern ${patternId}`);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const n = f(text, i);
    if (n !== null && n > 0) { out.push([i, i + n]); i += n; } else i++;
  }
  return out;
}

/** The most entries a word list keeps, and the most characters an entry keeps. */
export const MAX_WORDS = 1000;
export const MAX_WORD_CHARS = 256;

/** A word list from text with one word or phrase per line: trimmed, no empty lines or repeats, in order, bounded. */
export function wordList(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split(/\r\n|\n|\r/)) {
    const w = Array.from(line.trim()).slice(0, MAX_WORD_CHARS).join('');
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** The built-in redaction code sets (the U.S. FOIA and Privacy Act exemptions). */
export const CODE_SETS = Object.freeze([
  {id: 'foia', name: 'U.S. FOIA', codes: ['(b)(1)(A)', '(b)(1)(B)', '(b)(2)', '(b)(3)(A)', '(b)(3)(B)', '(b)(4)', '(b)(5)', '(b)(6)', '(b)(7)(A)', '(b)(7)(B)', '(b)(7)(C)',
    '(b)(7)(D)', '(b)(7)(E)', '(b)(7)(F)', '(b)(8)', '(b)(9)']},
  {id: 'privacy-act', name: 'U.S. Privacy Act', codes: ['(d)(5)', '(j)(1)', '(j)(2)', '(k)(1)', '(k)(2)', '(k)(3)', '(k)(4)', '(k)(5)', '(k)(6)', '(k)(7)']},
]);

/** The overlay text for the picked codes: in the set's order, once each, joined by ", ". Throws for a code the set lacks. */
export function codesOverlay(set, picked) {
  const bad = picked.find(p => !set.codes.includes(p));
  if (bad !== undefined) throw new Error(`${bad} is not a code of ${set.name}`);
  return set.codes.filter(c => picked.includes(c)).join(', ');
}
