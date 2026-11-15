// Text to Columns: splitting a text at delimiters or at fixed positions.
// Translated from gridcraft crates/engine/src/cmd/data/tools.rs (`split_delimited`, and the fixed-width
// branch of `text_to_columns`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

/** Splits `text` at the delimiters; a text qualifier keeps delimiters inside quotes (`""` is a quote); consecutive delimiters can count as one. */
export function splitDelimited(text, delims, consecutive, quote) {
  const out = [];
  let cur = '';
  let inQ = false, lastDelim = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quote && c === quote) {
      if (inQ && chars[i + 1] === quote) { cur += quote; i++; } else inQ = !inQ;
      continue;
    }
    if (!inQ && delims.includes(c)) {
      if (consecutive && lastDelim) continue;
      out.push(cur); cur = ''; lastDelim = true;
      continue;
    }
    lastDelim = false;
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Splits `text` at fixed character positions (positions 0 and past the end are ignored); parts are trimmed. */
export function splitFixed(text, widths) {
  const chars = [...text];
  const breaks = [...new Set(widths.filter(w => w > 0 && w < chars.length))].sort((a, b) => a - b);
  const cuts = [0, ...breaks, chars.length];
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) out.push(chars.slice(cuts[i], cuts[i + 1]).join('').trim());
  return out;
}

