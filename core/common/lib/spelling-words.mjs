// The words of a piece of text, as a spelling checker reads them (Office's defaults): words are runs
// of letters with apostrophes inside, hyphenated words are checked part by part, and some things are
// never checked: words in ALL CAPS, words with numbers (or underscores), and internet and file
// addresses (http://…, www.…, name@host, C:\folder\file, \\server\share, /usr/lib/file, ~/notes).
// Pure: no DOM, no Node built-ins, no dictionary. Offsets are UTF-16 code units of `text`.

const APOSTROPHES = /[’‘`´]/g;
const LETTER = /[\p{L}\p{M}]/u;
const INSIDE = /[\p{L}\p{M}'’‘`´\-\u2010\u2011]/u;

/** The word as the dictionary spells it: curly apostrophes made straight. */
export const normalizeWord = word => String(word ?? '').replace(APOSTROPHES, "'");

/** Is `chunk` (text between spaces, outer punctuation trimmed) an internet or file address? */
export function isAddress(chunk) {
  const c = String(chunk ?? '');
  if (c.length < 3) return false;
  if (/^[a-z][a-z0-9+.-]{1,15}:\/\//i.test(c)) return true; // http://, https://, ftp://, file://
  if (/^(www\.|ftp\.)/i.test(c)) return true;
  if (/^mailto:/i.test(c)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return true; // name@host.tld
  if (/^[a-z]:[\\/]/i.test(c)) return true; // C:\folder, C:/folder
  if (/^\\\\[^\\\s]/.test(c)) return true; // \\server\share
  if (/^(~|\.{1,2})?\/[^\s/]+(\/|\.[a-z0-9]{1,8}$)/i.test(c)) return true; // /usr/lib/file, ~/notes.txt, ./a.txt
  if (/^[^\s/\\]+\.[a-z]{2,6}(\/\S*)?$/i.test(c) && /\.(com|org|net|io|edu|gov|co|uk|us|de|fr|in|dev|app|ai|info|biz|me|tv)(\/|$)/i.test(c)) return true; // example.com/page
  if (/[\\/][^\s\\/]+\.[a-z0-9]{1,5}$/i.test(c) && /[\\/]/.test(c)) return true; // folder\file.ext
  return false;
}

/** ALL CAPS (two or more letters, none lower case): acronyms, shouted words; Office skips them by default. */
export const isAllCaps = word => {
  const w = String(word ?? '');
  const letters = w.match(/\p{L}/gu);
  return !!letters && letters.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase();
};

/** Does the word hold a digit or an underscore (a code, a part number, a name_with_parts)? */
export const hasDigit = word => /[\p{N}_]/u.test(String(word ?? ''));

/** Is a single word one Office skips (all caps, with numbers, one letter, no letters)? */
export function isSkipped(word) {
  const w = String(word ?? '');
  if (!w || !LETTER.test(w)) return true;
  if ([...w].filter(c => LETTER.test(c)).length < 2) return true;
  return hasDigit(w) || isAllCaps(w);
}

const TRIM_LEAD = /^[\s"'“”‘’([{<«]+/;
const TRIM_TRAIL = /[\s"'“”‘’)\]}>»,.;:!?…]+$/;

/**
 * The words to check in `text`: [{start, end, text}] (`text` is `text.slice(start, end)`, one part of a
 * hyphenated word each). Addresses, ALL CAPS words, words with numbers and one-letter words are left out.
 */
export function wordsOf(text) {
  const s = String(text ?? '');
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i += 1;
    const from = i;
    while (i < n && !/\s/.test(s[i])) i += 1;
    if (i === from) break;
    const chunk = s.slice(from, i);
    const lead = chunk.match(TRIM_LEAD)?.[0].length ?? 0;
    const core = chunk.slice(lead);
    const tail = core.match(TRIM_TRAIL)?.[0].length ?? 0;
    const body = core.slice(0, core.length - tail);
    if (!body) continue;
    const base = from + lead;
    if (isAddress(body) || /[\\/]/.test(body) && /[\p{N}_]/u.test(body)) continue;
    // Split the chunk into words at everything that is not a letter, a mark, an apostrophe or a hyphen.
    let j = 0;
    while (j < body.length) {
      if (!INSIDE.test(body[j])) { j += 1; continue; }
      const a = j;
      while (j < body.length && INSIDE.test(body[j])) j += 1;
      // A run of word characters: trim hyphens and apostrophes off its ends.
      let x = a, y = j;
      while (x < y && !LETTER.test(body[x])) x += 1;
      while (y > x && !LETTER.test(body[y - 1])) y -= 1;
      if (x >= y) continue;
      // A word stuck to digits or underscores ("abc123", "name_x") is one code: skipped whole.
      const before = body[a - 1], after = body[j];
      if ((before !== undefined && /[\p{N}_]/u.test(before)) || (after !== undefined && /[\p{N}_]/u.test(after))) continue;
      // Hyphenated words are checked part by part.
      let k = x;
      for (const part of body.slice(x, y).split(/[-\u2010\u2011]/)) {
        if (part && !isSkipped(part)) out.push({start: base + k, end: base + k + part.length, text: part});
        k += part.length + 1;
      }
    }
  }
  return out;
}
