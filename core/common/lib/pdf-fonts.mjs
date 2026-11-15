// Fonts for text that a person typed, in the PDFs the application writes (Excel's Export as PDF, Word's): a system font with Unicode coverage,
// read from the operating system's font folder at export time (nothing is bundled), embedded as a subset through @pdf-lib/fontkit, and for
// each run of text the first font lacks, the first system font that has the glyphs. Only a character that no installed font has prints as "?".
// With no readable system font (a host with no file system, a machine without the fonts), the PDF standard faces are used and the characters
// they lack print as "?", as before.
//
//   const set = await systemFonts(pdf);          // registers fontkit on `pdf`
//   await set.prepare(allTheTexts);              // finds and embeds the fonts those characters need
//   const face = set.face({bold, italic});       // a Face: widthOfTextAtSize, heightAtSize, clean, runs, draw (all synchronous); a run is {pdfFont, font (fontkit's, for its layout), text}
//   face.draw(page, 'text', {x, y, size, color}) // pdf-lib drawText options, one call per run
//
// Segoe UI and Arial come first (Windows), then Arial (macOS) and DejaVu (Linux); the scripts they lack come from Segoe UI Historic and Symbol,
// Nirmala UI (Indic), Microsoft YaHei, Yu Gothic, Microsoft JhengHei and Malgun Gothic (CJK, Korean) and the macOS and Noto equivalents.
// U:common/pdf-fonts. pdf-lib and fontkit are allowed in core (architecture 5.3); the file system is reached only through a dynamic import
// that a host without one lacks.

import {StandardFonts} from 'pdf-lib';
// fontkit's build calls the global regeneratorRuntime (for one generator); tesseract.js already brings the package, so it is loaded first.
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';

const MAX_FONT_BYTES = 60 * 1024 * 1024;
const WIN = ['C:/Windows/Fonts/', 'C:/WINNT/Fonts/'];

/** Font files by family, in the order they are tried: files are [regular, bold, italic, bold italic]; a style a family lacks uses its regular file. */
const FAMILIES = [
  {dirs: WIN, files: ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf']},
  {dirs: WIN, files: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf']},
  {dirs: ['/System/Library/Fonts/Supplemental/'], files: ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf']},
  {dirs: ['/usr/share/fonts/truetype/dejavu/', '/usr/share/fonts/dejavu/'], files: ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSans-BoldOblique.ttf']},
  // Scripts and symbols the first ones lack.
  {dirs: WIN, files: ['seguisym.ttf']},
  {dirs: WIN, files: ['seguihis.ttf']},
  {dirs: WIN, files: ['Nirmala.ttc', 'NirmalaB.ttc']},
  {dirs: WIN, files: ['msyh.ttc', 'msyhbd.ttc']},
  {dirs: WIN, files: ['YuGothR.ttc', 'YuGothB.ttc']},
  {dirs: WIN, files: ['msjh.ttc', 'msjhbd.ttc']},
  {dirs: WIN, files: ['malgun.ttf', 'malgunbd.ttf']},
  {dirs: WIN, files: ['LeelawUI.ttf', 'LeelaUIb.ttf']},
  {dirs: WIN, files: ['tahoma.ttf', 'tahomabd.ttf']},
  {dirs: WIN, files: ['simsun.ttc']},
  {dirs: ['/System/Library/Fonts/'], files: ['Helvetica.ttc']},
  // Thai in macOS's own Thai design before Arial Unicode (seen on GitHub's Mac runners). Apple's fonts position marks
  // with their own (AAT) tables, which the PDF engine doesn't apply: a mark sits where the design puts it.
  {dirs: ['/System/Library/Fonts/'], files: ['Thonburi.ttc']},
  {dirs: ['/System/Library/Fonts/Supplemental/'], files: ['Arial Unicode.ttf']},
  // PingFang and Hiragino are CFF collections the PDF library can't embed ("Not a CFF Font"): only after Arial Unicode.
  {dirs: ['/System/Library/Fonts/'], files: ['PingFang.ttc']},
  {dirs: ['/System/Library/Fonts/'], files: ['Hiragino Sans GB.ttc']},
  {dirs: ['/System/Library/Fonts/Supplemental/'], files: ['Devanagari Sangam MN.ttc']},
  {dirs: ['/usr/share/fonts/opentype/noto/', '/usr/share/fonts/noto-cjk/'], files: ['NotoSansCJK-Regular.ttc', 'NotoSansCJK-Bold.ttc']},
  {dirs: ['/usr/share/fonts/truetype/noto/'], files: ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSans-BoldItalic.ttf']},
  {dirs: ['/usr/share/fonts/truetype/noto/'], files: ['NotoSansThai-Regular.ttf', 'NotoSansThai-Bold.ttf']},
];

/** fontkit that also takes a TrueType collection (.ttc): its first font is used. */
const kit = {create: (bytes, name) => { const f = fontkit.create(bytes, name); return f && f.fonts ? f.fonts[0] : f; }};

const SPACE = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]/;
const CONTROL = /[\r\n\t]+/g;
const dropped = cp => cp < 32 || cp === 0x00AD || (cp >= 0x200B && cp <= 0x200D) || cp === 0xFEFF;
const styleOf = ({bold = false, italic = false} = {}) => (bold ? 1 : 0) + (italic ? 2 : 0);

let fsPromise;
async function fileSystem() {
  if (!fsPromise) {
    // A variable specifier keeps bundlers from pulling the module into a window's bundle; a host without Node refuses it.
    const spec = 'node:fs/promises';
    fsPromise = import(/* @vite-ignore */ spec).catch(() => null);
  }
  return fsPromise;
}

/**
 * A window has no file system: it asks its host for a system font (window.studio.files.readSystemFont, electron/system-fonts.cjs: only the operating system's font folders).
 * What the host gave is kept for the next export, so a font is read across the bridge once.
 */
const hostReader = () => (typeof globalThis.studio?.files?.readSystemFont === 'function' ? globalThis.studio.files.readSystemFont.bind(globalThis.studio.files) : null);
const hostCaches = new WeakMap();   // one cache of fonts read for each host reader
const hostCache = () => { const key = globalThis.studio.files.readSystemFont; if (!hostCaches.has(key)) hostCaches.set(key, new Map()); return hostCaches.get(key); };

/** Reads and parses one font file: {bytes, font} or false. */
async function loadFile(path) {
  try {
    const host = hostReader();
    if (host) {
      const hostLoaded = hostCache();
      if (!hostLoaded.has(path)) {
        hostLoaded.set(path, (async () => {
          const raw = await host(path);
          if (!raw || !raw.length || raw.length > MAX_FONT_BYTES) return false;
          const bytes = new Uint8Array(raw);
          const font = kit.create(bytes);
          return font && typeof font.hasGlyphForCodePoint === 'function' ? {bytes, font} : false;
        })().catch(() => false));
      }
      return await hostLoaded.get(path);
    }
    const fs = await fileSystem();
    const st = fs ? await fs.stat(path) : null;
    if (!st?.isFile() || st.size > MAX_FONT_BYTES) return false;
    const bytes = new Uint8Array(await fs.readFile(path));
    const font = kit.create(bytes);
    return font && typeof font.hasGlyphForCodePoint === 'function' ? {bytes, font} : false;
  } catch { return false; }
}

/** The fonts of a PDF being written (registers fontkit on it). */
export async function systemFonts(pdf) {
  pdf.registerFontkit(kit);
  const files = new Map();
  const file = path => { if (!files.has(path)) files.set(path, loadFile(path)); return files.get(path); };
  const embedded = new Map();
  const embed = (path, loaded) => {
    if (!embedded.has(path)) embedded.set(path, pdf.embedFont(loaded.bytes, {subset: true}).then(pdfFont => ({pdfFont, font: loaded.font})));
    return embedded.get(path);
  };
  const standard = [];
  const std = style => (standard[style] ??= pdf.embedFont([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique][style])
    .then(f => ({pdfFont: f, has: new Set(f.getCharacterSet())})));
  const stdDone = [null, null, null, null];
  const chains = [];
  const chainOf = style => (chains[style] ??= FAMILIES.flatMap(fam => fam.dirs.map(dir => ({path: dir + (fam.files[style] ?? fam.files[0]), regular: dir + fam.files[0]}))));
  const picked = [new Map(), new Map(), new Map(), new Map()];

  /** The font a code point is set in, in a style: {pdfFont}, or null when no font has it. */
  const fontFor = async (cp, style) => {
    const memo = picked[style];
    if (memo.has(cp)) return memo.get(cp);
    let found = null;
    for (const cand of chainOf(style)) {
      let path = cand.path, loaded = await file(path);
      if (!loaded && cand.path !== cand.regular) { path = cand.regular; loaded = await file(path); }
      if (loaded && loaded.font.hasGlyphForCodePoint(cp)) { found = await embed(path, loaded); break; }
    }
    if (!found) { const s = await std(style); if (s.has.has(cp)) found = s; }
    memo.set(cp, found);
    return found;
  };

  /**
   * Finds, embeds and remembers the font of every character of `texts` in the styles asked ({bold, italic}; default all four), so the
   * faces can measure and draw synchronously. Call it with every text the PDF will print before measuring.
   */
  const prepare = async (texts, styles = [{}, {bold: true}, {italic: true}, {bold: true, italic: true}]) => {
    const cps = new Set([32, 63, 72]);
    for (const text of texts) for (const ch of String(text ?? '')) cps.add(ch.codePointAt(0));
    for (const st of styles) {
      const style = styleOf(st);
      stdDone[style] = await std(style);
      for (const cp of cps) if (!dropped(cp)) await fontFor(cp, style);
    }
  };

  const face = opts => {
    const style = styleOf(opts);
    const lookup = cp => { const f = picked[style].get(cp); return f === undefined ? null : f; };
    /** The runs of a text: [{pdfFont, text}], each character in the first font that has it, "?" where none does. */
    const runs = raw => {
      const out = [];
      let prev = null;
      for (const ch of String(raw ?? '').replace(CONTROL, ' ')) {
        const cp = ch.codePointAt(0);
        if (dropped(cp)) continue;
        let f, text = ch;
        if (SPACE.test(ch)) { f = prev ?? lookup(32) ?? stdDone[style]; text = ' '; } else {
          f = lookup(cp);
          if (!f) { f = lookup(63) ?? stdDone[style]; text = '?'; }
        }
        if (!f) throw new Error('pdf-fonts: prepare() was not given this text');
        if (prev === f && out.length) out[out.length - 1].text += text; else out.push({pdfFont: f.pdfFont, font: f.font, text});
        prev = f;
      }
      return out;
    };
    return {
      runs,
      /** Width of a text at a size, in points. */
      widthOfTextAtSize(text, size) { let w = 0; for (const r of runs(text)) w += r.pdfFont.widthOfTextAtSize(r.text, size); return w; },
      heightAtSize(size) { const f = lookup(72) ?? lookup(32) ?? stdDone[style]; return f ? f.pdfFont.heightAtSize(size) : size * 1.2; },
      /** What draw prints, as a string: spaces normal, "?" where no font has the character. */
      clean(text) { return runs(text).map(r => r.text).join(''); },
      /** drawText for each run in turn along the baseline (or the rotated one): `options` are pdf-lib drawText's. */
      draw(page, text, options = {}) {
        let {x, y} = options;
        const rot = options.rotate;
        const th = rot ? (rot.angle ?? 0) * (rot.type === 'radians' ? 1 : Math.PI / 180) : 0;
        const size = options.size ?? 12;
        for (const r of runs(text)) {
          page.drawText(r.text, {...options, x, y, font: r.pdfFont});
          const w = r.pdfFont.widthOfTextAtSize(r.text, size);
          x += w * Math.cos(th); y += w * Math.sin(th);
        }
      },
    };
  };
  const charsets = new WeakMap();
  const setOf = f => { let s = charsets.get(f); if (!s) { s = new Set(f.getCharacterSet()); charsets.set(f, s); } return s; };
  /**
   * Text in a standard face where it can encode the character, in a system font where it cannot: {runs(text), widthOfTextAtSize(text, size)}.
   * `std` is a pdf-lib standard font, `opts` the style ({bold, italic}) of the system font that stands in. The text is made ready with prepare().
   */
  const mixed = (std, opts) => {
    const uni = face(opts), has = setOf(std);
    /** [{pdfFont, text}] with the document's own standard face for what it encodes. */
    const runs = raw => {
      const out = [];
      let pending = '';
      const flush = () => { if (pending) { for (const r of uni.runs(pending)) out.push({pdfFont: r.pdfFont, text: r.text}); pending = ''; } };
      for (const c of String(raw ?? '').replace(CONTROL, ' ')) {
        const cp = c.codePointAt(0);
        if (dropped(cp)) continue;
        if (has.has(cp) || c === ' ') {
          flush();
          if (out.length && out[out.length - 1].pdfFont === std) out[out.length - 1].text += c; else out.push({pdfFont: std, text: c});
        } else pending += c;
      }
      flush();
      return out;
    };
    return {runs, widthOfTextAtSize: (text, size) => runs(text).reduce((w, r) => w + r.pdfFont.widthOfTextAtSize(r.text, size), 0)};
  };
  return {face, prepare, mixed};
}

/** The strings a document model holds that could be printed: every string value but pictures' data and very long ones, for prepare(). */
export function textsOf(node, out = [], depth = 0) {
  if (depth > 40 || out.length > 200_000) return out;
  if (typeof node === 'string') { if (node.length <= 4000 && !node.startsWith('data:')) out.push(node); } else if (Array.isArray(node)) for (const x of node) textsOf(x, out, depth + 1);
  else if (node && typeof node === 'object') for (const x of Object.values(node)) textsOf(x, out, depth + 1);
  return out;
}
