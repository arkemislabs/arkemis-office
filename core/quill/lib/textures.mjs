// The textures of Shape Fill › Texture (and Page Color › Fill Effects › Texture): 24 seamless tiles drawn from seeded noise, named
// as Word names its own. Our own drawing (Word's are photographs): each tile is a small RGBA bitmap that repeats without a seam.
//
// A texture is `[id, label, kind, light, dark, seed]`; the kinds are the ways the noise is shaped: fibre (paper, papyrus, parchment),
// weave (canvas, denim, mat, mesh), speckle (sand, granite, cork), marble (veins), wood (grain), tissue (soft clouds), drops, fossil
// and bouquet. No DOM, no Node built-ins.

export const TEXTURES = Object.freeze([
  ['papyrus', 'Papyrus', 'fibre', [226, 205, 150], [190, 160, 100], 1],
  ['canvas', 'Canvas', 'weave', [226, 214, 190], [190, 175, 145], 2],
  ['denim', 'Denim', 'weave', [96, 126, 170], [58, 84, 128], 3],
  ['woven-mat', 'Woven mat', 'weave', [202, 172, 112], [150, 118, 66], 4],
  ['water-droplets', 'Water droplets', 'drops', [168, 206, 232], [88, 140, 190], 5],
  ['paper-bag', 'Paper bag', 'fibre', [200, 166, 120], [160, 124, 82], 6],
  ['fish-fossil', 'Fish fossil', 'fossil', [182, 170, 150], [118, 104, 86], 7],
  ['sand', 'Sand', 'speckle', [232, 214, 170], [196, 172, 124], 8],
  ['green-marble', 'Green marble', 'marble', [150, 196, 168], [48, 108, 84], 9],
  ['white-marble', 'White marble', 'marble', [240, 240, 238], [168, 170, 174], 10],
  ['brown-marble', 'Brown marble', 'marble', [214, 176, 136], [112, 70, 40], 11],
  ['granite', 'Granite', 'speckle', [176, 176, 176], [70, 70, 74], 12],
  ['newsprint', 'Newsprint', 'fibre', [214, 212, 206], [176, 174, 168], 13],
  ['recycled-paper', 'Recycled paper', 'fibre', [222, 218, 206], [170, 164, 146], 14],
  ['parchment', 'Parchment', 'fibre', [238, 224, 182], [204, 180, 128], 15],
  ['stationery', 'Stationery', 'tissue', [248, 246, 238], [226, 222, 208], 16],
  ['blue-tissue-paper', 'Blue tissue paper', 'tissue', [180, 206, 236], [128, 164, 214], 17],
  ['pink-tissue-paper', 'Pink tissue paper', 'tissue', [244, 190, 208], [220, 140, 170], 18],
  ['purple-mesh', 'Purple mesh', 'weave', [170, 140, 200], [88, 60, 130], 19],
  ['bouquet', 'Bouquet', 'bouquet', [236, 182, 196], [86, 140, 90], 20],
  ['cork', 'Cork', 'speckle', [204, 160, 106], [140, 98, 52], 21],
  ['walnut', 'Walnut', 'wood', [156, 112, 76], [86, 56, 34], 22],
  ['oak', 'Oak', 'wood', [214, 176, 118], [160, 118, 68], 23],
  ['medium-wood', 'Medium wood', 'wood', [196, 140, 92], [124, 80, 44], 24],
].map(Object.freeze));

export const textureInfo = id => TEXTURES.find(t => t[0] === id) ?? null;

/** A repeatable pseudo-random value in 0..1 at an integer lattice point, wrapped at `period`. */
function lattice(x, y, period, seed) {
  const px = ((x % period) + period) % period, py = ((y % period) + period) % period;
  let h = (px * 374761393 + py * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
/** Value noise that repeats every `period` lattice cells. */
function noise(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const a = lattice(x0, y0, period, seed), b = lattice(x0 + 1, y0, period, seed), c = lattice(x0, y0 + 1, period, seed), d = lattice(x0 + 1, y0 + 1, period, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const fbm = (x, y, period, seed) => (noise(x, y, period, seed) * 0.55 + noise(x * 2, y * 2, period * 2, seed + 7) * 0.3 + noise(x * 4, y * 4, period * 4, seed + 13) * 0.15);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The value 0..1 (0 light, 1 dark) of a texture's kind at pixel (x, y) of a `size` tile. */
function shade(kind, x, y, size, seed) {
  const u = x / size, v = y / size, TAU = Math.PI * 2;
  switch (kind) {
    case 'fibre': return Math.min(1, 0.55 * fbm(u * 3, v * 40, 3, seed) + 0.35 * fbm(u * 40, v * 3, 40, seed + 3) + 0.15 * lattice(x, y, size, seed));
    case 'weave': { const a = 0.5 + 0.5 * Math.sin(TAU * u * 8) * Math.sin(TAU * v * 8); return Math.min(1, a * 0.75 + 0.25 * lattice(x, y, size, seed)); }
    case 'speckle': { const s = lattice(x, y, size, seed); return s > 0.86 ? 1 : s > 0.7 ? 0.55 : fbm(u * 8, v * 8, 8, seed) * 0.35; }
    case 'marble': { const t = fbm(u * 4, v * 4, 4, seed); const vein = Math.abs(Math.sin(TAU * (u * 2 + v + t * 1.6))); return Math.pow(1 - vein, 5) * 0.9 + t * 0.2; }
    case 'wood': { const t = fbm(u * 2, v * 8, 2, seed); return 0.5 + 0.5 * Math.sin(TAU * (v * 6 + t * 3)); }
    case 'tissue': return fbm(u * 6, v * 6, 6, seed) * 0.9;
    case 'drops': { const n = fbm(u * 10, v * 10, 10, seed); return n > 0.6 ? 0.05 + (n - 0.6) * 1.5 : 0.7; }
    case 'fossil': { const t = fbm(u * 6, v * 6, 6, seed); return 0.4 * t + 0.6 * Math.max(0, Math.sin(TAU * (u * 3 + t * 0.4)) * Math.sin(TAU * (v * 2))); }
    case 'bouquet': { const n = fbm(u * 5, v * 5, 5, seed); return Math.max(0, Math.min(1, (n - 0.4) * 5)); }
    default: return fbm(u * 6, v * 6, 6, seed);
  }
}

/** A texture's tile as an RGBA bitmap `size` pixels square (default 64), or null for an unknown id. */
export function textureBitmap(id, size = 64) {
  const info = textureInfo(id);
  if (!info) return null;
  const [, , kind, light, dark, seed] = info;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = mix(light, dark, Math.max(0, Math.min(1, shade(kind, x, y, size, seed))));
      data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
    }
  }
  return {width: size, height: size, data};
}

/** The average colour of a bitmap, [r, g, b] (what stands for a texture where one colour is wanted). */
export function averageColor(b) {
  let r = 0, g = 0, bl = 0;
  const n = b.width * b.height;
  for (let i = 0; i < n; i++) { r += b.data[i * 4]; g += b.data[i * 4 + 1]; bl += b.data[i * 4 + 2]; }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] : [128, 128, 128];
}
