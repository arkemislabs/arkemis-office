// Bidirectional text helpers (UAX #9 rules P2 and P3: paragraph base direction detection).
// Translated from deckcraft crates/model/src/bidi.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

const RTL = [[0x0590, 0x05ff], [0x0600, 0x06ff], [0x0700, 0x074f], [0x0750, 0x077f], [0x0780, 0x07bf], [0x0870, 0x089f], [0x08a0, 0x08ff],
  [0xfb1d, 0xfb4f], [0xfb50, 0xfdff], [0xfe70, 0xfefe]];

/** Does a character belong to a standard right-to-left Unicode block? */
export function isRtlScript(c) {
  const v = c.codePointAt(0) ?? 0;
  return RTL.some(([a, b]) => v >= a && v <= b);
}

/** Does the first strong directional character in `text` belong to a right-to-left script? */
export function firstStrongIsRtl(text) {
  for (const c of String(text)) {
    if (c === '‏') return true;
    if (c === '‎') return false;
    if (/^\p{Alphabetic}$/u.test(c)) return isRtlScript(c);
  }
  return false;
}
