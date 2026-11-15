// The text shaper interface Quill layout measures text with, and a deterministic metrics stub.
//
// Upstream: wordcraft crates/layout shapes with `wordcraft_fonts` (rustybuzz over the installed
// faces; ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c, `para/builder.rs`
// `Builder::style` and `Builder::shape_with`). Architecture 16.1 replaces that shaper with an
// interface: in the renderer it is backed by Canvas2D `measureText` (`shaper-canvas.mjs`), in Node
// tests by the stub below. Layout asks for two things only:
//
//   metrics(font)        -> {ascent, descent}   line ascent/descent in points at font.size
//   advance(text, font)  -> number              advance width in points of `text` (one cluster)
//
// `font` is {family, size, bold, italic}. A shaper may also have `key` (a string naming its
// measurements: a cached layout made with another shaper is thrown away).
//
// Word measures each character with its own advance unless Kerning for fonts covers the run's
// size (upstream turns the `kern` feature off otherwise), so measuring cluster by cluster matches
// Word's default; ligatures are not formed (each letter keeps its advance, as upstream's
// `split_ligature_advances` evens them out anyway).

/** @typedef {{family: string, size: number, bold?: boolean, italic?: boolean}} FontSpec */
/** @typedef {{key?: string, metrics(font: FontSpec): {ascent: number, descent: number}, advance(text: string, font: FontSpec): number}} Shaper */

const WIDE = c => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
  || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
const MARK = c => (c >= 0x0300 && c <= 0x036f) || (c >= 0x0591 && c <= 0x05bd) || (c >= 0x064b && c <= 0x065f) || c === 0x200b || c === 0x200c
  || c === 0x200d || c === 0xfe0f || c === 0x00ad;

/**
 * A deterministic shaper for tests and headless layout: every font has an ascent of `ascent` em
 * and a descent of `descent` em; a character advances `space` em (spaces), `wide` em (CJK and
 * fullwidth), 0 (combining marks, joiners, soft hyphen) or `char` em (everything else). Bold adds
 * `boldExtra` em. With the defaults a 10 pt line of text is 10 pt high and "abc" is 15 pt wide.
 */
export function createMetricsShaper(o = {}) {
  const ascent = o.ascent ?? 0.8, descent = o.descent ?? 0.2;
  const ch = o.char ?? 0.5, sp = o.space ?? 0.25, wide = o.wide ?? 1, boldExtra = o.boldExtra ?? 0;
  const per = o.advances ?? null;
  return {
    key: `metrics:${ascent}:${descent}:${ch}:${sp}:${wide}:${boldExtra}:${per ? JSON.stringify(per) : ''}`,
    metrics(font) { return {ascent: font.size * ascent, descent: font.size * descent}; },
    advance(text, font) {
      let w = 0;
      for (const s of text) {
        const c = s.codePointAt(0);
        let em;
        if (per && per[s] !== undefined) em = per[s];
        else if (c === 0x20 || c === 0xa0 || c === 0x2007 || c === 0x202f) em = sp;
        else if (c === 0x3000) em = wide;
        else if (MARK(c)) em = 0;
        else if (WIDE(c)) em = wide;
        else em = ch;
        w += em * font.size + (font.bold && em > 0 ? boldExtra * font.size : 0);
      }
      return w;
    },
  };
}

let defaultShaper = createMetricsShaper();
/** The shaper layout uses when its options name none (the stub until a renderer installs Canvas). */
export const getDefaultShaper = () => defaultShaper;
/** Install the shaper layouts use by default (the page view installs the Canvas2D one). */
export function setDefaultShaper(s) { defaultShaper = s || createMetricsShaper(); }

/** The CSS-like key of a font spec, for caches. */
export const fontKey = f => `${f.bold ? 'b' : ''}${f.italic ? 'i' : ''}|${f.size}|${f.family}`;
