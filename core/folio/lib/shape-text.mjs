// The order text is set in: a paragraph of mixed left-to-right and right-to-left text (Arabic, Hebrew, with Latin words and numbers among them) is cut into runs by the Unicode
// bidirectional algorithm and the runs are put in the order they are read on the page; within a run an OpenType layout engine (fontkit's `font.layout`: GSUB for joining forms,
// ligatures, conjuncts and vowel-sign reordering, GPOS for kerning and mark placement) gives the glyphs. This file is the first half (no fonts): `visualRuns(text)`.
//
// Implemented from UAX #9 (Unicode 15) for one paragraph with no explicit embeddings, overrides or isolates (the controls U+202A..U+2069 are not interpreted): W1 to W7, N1 and N2,
// I1 and I2, L1 for the trailing white space, L2 for the reordering and L4 for the mirrored brackets. Plain text typed into a text box has no such controls.
// No DOM, no Node built-ins.

/** The strong class of a character: 'L', 'R', 'AL', or a weak/neutral class. */
function classOf(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x6F0 && cp <= 0x6F9)) return 'EN';
  if ((cp >= 0x660 && cp <= 0x669) || cp === 0x66B || cp === 0x66C) return 'AN';
  if (/^[\p{Mn}\p{Me}]$/u.test(ch)) return 'NSM';
  if (cp === 0x2B || cp === 0x2D) return 'ES';
  if (cp === 0x2C || cp === 0x2E || cp === 0x3A || cp === 0x2F || cp === 0xA0 || cp === 0x60C) return 'CS';
  if (cp === 0x23 || cp === 0x24 || cp === 0x25 || (cp >= 0xA2 && cp <= 0xA5) || cp === 0xB0 || cp === 0xB1 || cp === 0x2030 || cp === 0x20AC || cp === 0x66A) return 'ET';
  if ((cp >= 0x590 && cp <= 0x5FF) || (cp >= 0x7C0 && cp <= 0x85F) || (cp >= 0xFB1D && cp <= 0xFB4F) || (cp >= 0x10800 && cp <= 0x10FFF) || cp === 0x200F) return 'R';
  if (cp === 0x61B || cp === 0x61F || (cp >= 0x600 && cp <= 0x7BF) || (cp >= 0x860 && cp <= 0x8FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) return 'AL';
  if (cp === 0x200E || /^[\p{L}\p{Nl}\p{Nd}]$/u.test(ch)) return 'L';
  if (/^\s$/u.test(ch)) return 'WS';
  return 'ON';
}

const MIRROR = {'(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹', '⁅': '⁆', '⁆': '⁅', '⟨': '⟩', '⟩': '⟨', '〈': '〉', '〉': '〈', '《': '》', '》': '《', '「': '」', '」': '「', '『': '』', '』': '『', '【': '】', '】': '【'};

/** The first block of a script that is set by its own shaper (a text is shaped one script at a time), or null for letters of no such script and for the common characters. */
const SCRIPTS = [[0x0590, 0x05FF, 'hebr'], [0x0600, 0x06FF, 'arab'], [0x0700, 0x074F, 'syrc'], [0x0750, 0x077F, 'arab'], [0x0780, 0x07BF, 'thaa'], [0x08A0, 0x08FF, 'arab'],
  [0x0900, 0x097F, 'deva'], [0x0980, 0x09FF, 'beng'], [0x0A00, 0x0A7F, 'guru'], [0x0A80, 0x0AFF, 'gujr'], [0x0B00, 0x0B7F, 'orya'], [0x0B80, 0x0BFF, 'taml'], [0x0C00, 0x0C7F, 'telu'],
  [0x0C80, 0x0CFF, 'knda'], [0x0D00, 0x0D7F, 'mlym'], [0x0D80, 0x0DFF, 'sinh'], [0x0E00, 0x0E7F, 'thai'], [0x0E80, 0x0EFF, 'laoo'], [0x0F00, 0x0FFF, 'tibt'], [0x1000, 0x109F, 'mymr'],
  [0x1780, 0x17FF, 'khmr'], [0xFB1D, 0xFB4F, 'hebr'], [0xFB50, 0xFDFF, 'arab'], [0xFE70, 0xFEFF, 'arab']];
const scriptOf = cp => { for (const [a, b, s] of SCRIPTS) if (cp >= a && cp <= b) return s; return null; };
const RTL_SCRIPTS = new Set(['hebr', 'arab', 'syrc', 'thaa']);

/** Whether a text has any character of a script read from right to left. */
export const hasRtl = text => { for (const ch of String(text ?? '')) { const c = classOf(ch); if (c === 'R' || c === 'AL') return true; } return false; };

/** The embedding level of every character of `chars` (UAX #9 W, N and I rules), and the paragraph level. */
function levelsOf(chars, base) {
  const n = chars.length;
  const t = chars.map(classOf);
  const first = t.find(c => c === 'L' || c === 'R' || c === 'AL');
  const para = base ?? (first === 'R' || first === 'AL' ? 1 : 0);
  const sos = para ? 'R' : 'L';
  // W1: a mark takes the class of the character before it.
  for (let i = 0; i < n; i++) if (t[i] === 'NSM') t[i] = i ? (t[i - 1] === 'AL' ? 'AL' : t[i - 1]) : sos;
  // W2: a European digit after an Arabic letter is an Arabic digit. W3: Arabic letters are R.
  let strong = sos;
  for (let i = 0; i < n; i++) { if (t[i] === 'L' || t[i] === 'R' || t[i] === 'AL') strong = t[i]; else if (t[i] === 'EN' && strong === 'AL') t[i] = 'AN'; }
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R';
  // W4: a single separator between two numbers of one kind joins them.
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS' && (t[i - 1] === 'EN' || t[i - 1] === 'AN') && t[i + 1] === t[i - 1]) t[i] = t[i - 1];
  }
  // W5: terminators next to a European digit are digits. W6: the other separators and terminators are neutral.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i; while (j < n && t[j] === 'ET') j++;
    const touches = (i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN');
    for (let k = i; k < j; k++) t[k] = touches ? 'EN' : 'ON';
    i = j - 1;
  }
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'CS' || t[i] === 'ET') t[i] = 'ON';
  // W7: a European digit after left-to-right text is left-to-right.
  strong = sos;
  for (let i = 0; i < n; i++) { if (t[i] === 'L' || t[i] === 'R') strong = t[i]; else if (t[i] === 'EN' && strong === 'L') t[i] = 'L'; }
  // N1 and N2: neutrals between like directions take it, else the paragraph's.
  const dirOf = c => (c === 'L' ? 'L' : c === 'R' || c === 'EN' || c === 'AN' ? 'R' : null);
  for (let i = 0; i < n; i++) {
    if (dirOf(t[i])) continue;
    let j = i; while (j < n && !dirOf(t[j])) j++;
    const before = i ? dirOf(t[i - 1]) : sos, after = j < n ? dirOf(t[j]) : sos;
    const d = before === after ? before : para ? 'R' : 'L';
    for (let k = i; k < j; k++) t[k] = d;
    i = j - 1;
  }
  // I1 and I2.
  const level = t.map(c => {
    if (para % 2 === 0) return c === 'R' ? para + 1 : c === 'AN' || c === 'EN' ? para + 2 : para;
    return c === 'L' || c === 'EN' || c === 'AN' ? para + 1 : para;
  });
  // L1: white space at the end of the line goes back to the paragraph's level.
  for (let i = n - 1; i >= 0 && /^\s$/u.test(chars[i]); i--) level[i] = para;
  return {level, para};
}

/**
 * The runs of `text` in the order they are read on the page, left to right: [{text, rtl, script}]. `rtl` runs hold their characters in logical order (the layout engine puts the
 * glyphs of a right-to-left script in visual order itself), except a run with no letter of such a script (spaces, punctuation), whose characters are already in visual order and
 * mirrored where they have a mirror. A run never holds two scripts that are set by different shapers or two levels. `base` forces the paragraph direction (0 or 1).
 */
export function visualRuns(text, base) {
  const chars = [...String(text ?? '')];
  if (!chars.length) return [];
  const {level} = levelsOf(chars, base);
  const runs = [];
  let cur = null;
  chars.forEach((ch, i) => {
    const s = scriptOf(ch.codePointAt(0));
    const brk = !cur || cur.level !== level[i] || (s && cur.script && s !== cur.script);
    if (brk) { cur = {chars: [], level: level[i], script: s}; runs.push(cur); }
    if (s && !cur.script) cur.script = s;
    cur.chars.push(ch);
  });
  // L2: from the highest level to the lowest odd one, reverse each sequence of runs at that level or above.
  const top = Math.max(...runs.map(r => r.level)), low = Math.min(...runs.filter(r => r.level % 2).map(r => r.level), top + 1);
  for (let lv = top; lv >= low && lv > 0; lv--) {
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].level < lv) continue;
      let j = i; while (j < runs.length && runs[j].level >= lv) j++;
      const part = runs.slice(i, j).reverse();
      runs.splice(i, j - i, ...part);
      i = j - 1;
    }
  }
  return runs.map(r => {
    const odd = r.level % 2 === 1;
    let list = r.chars;
    if (odd) list = list.map(c => MIRROR[c] ?? c);
    const strongRtl = odd && list.some(c => { const k = classOf(c); return k === 'R' || k === 'AL'; });
    // No letter of a right-to-left script: the layout engine would not reverse the run, so it is reversed here.
    if (odd && !strongRtl) list = list.slice().reverse();
    return {text: list.join(''), rtl: odd, script: r.script, reversed: strongRtl, level: r.level};
  });
}

export const isRtlScript = script => RTL_SCRIPTS.has(script);

/** Whether the paragraph of a text reads right to left: its first strong character is a letter of a right-to-left script. */
export function isRtlParagraph(text) {
  for (const ch of String(text ?? '')) {
    const c = classOf(ch);
    if (c === 'R' || c === 'AL') return true;
    if (c === 'L') return false;
  }
  return false;
}
