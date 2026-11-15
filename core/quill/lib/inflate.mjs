// Raw DEFLATE decompression (RFC 1951), for the hyphenation dictionary: assets/hyphenation/en-us.dic is raw-deflate data, read the way
// wordcraft's proof crate reads it (miniz_oxide `decompress_to_vec_with_limit`). A small puff-style decoder so the renderer and Node need
// no library for it. No DOM, no Node built-ins.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(lengths.length);
  for (const l of lengths) count[l]++;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
  lengths.forEach((l, sym) => { if (l) symbol[offs[l]++] = sym; });
  return {count, symbol};
}

let fixed = null;
const fixedTables = () => {
  if (!fixed) {
    const l = new Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
    fixed = [huffman(l), huffman(new Array(30).fill(5))];
  }
  return fixed;
};

/** The bytes `src` (raw deflate) inflates to; throws on bad data or when more than `limit` bytes come out. */
export function inflateRaw(src, limit = 1 << 26) {
  let pos = 0, bitbuf = 0, bitcnt = 0;
  let out = new Uint8Array(Math.min(limit, Math.max(1024, src.length * 4)));
  let n = 0;
  const bits = need => {
    while (bitcnt < need) {
      if (pos >= src.length) throw new Error('inflate: out of data');
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << need) - 1);
    bitbuf >>>= need;
    bitcnt -= need;
    return v;
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  const put = b => {
    if (n >= limit) throw new Error('inflate: too large');
    if (n >= out.length) { const bigger = new Uint8Array(Math.min(limit, out.length * 2)); bigger.set(out); out = bigger; }
    out[n++] = b;
  };
  const codes = (lit, dist) => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) { put(sym); continue; }
      if (sym === 256) return;
      sym -= 257;
      if (sym >= 29) throw new Error('inflate: bad length');
      const len = LBASE[sym] + bits(LEXT[sym]);
      const ds = decode(dist);
      if (ds >= 30) throw new Error('inflate: bad distance');
      const d = DBASE[ds] + bits(DEXT[ds]);
      if (d > n) throw new Error('inflate: distance too far');
      for (let i = 0; i < len; i++) put(out[n - d]);
    }
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      if (pos + 4 > src.length) throw new Error('inflate: out of data');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('inflate: out of data');
      for (let i = 0; i < len; i++) put(src[pos++]);
    } else if (type === 1) {
      const [lit, dist] = fixedTables();
      codes(lit, dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Array(19).fill(0);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
      const lencode = huffman(lengths);
      const all = [];
      while (all.length < nlen + ndist) {
        const sym = decode(lencode);
        if (sym < 16) all.push(sym);
        else {
          let prev = 0, rep;
          if (sym === 16) { if (!all.length) throw new Error('inflate: bad repeat'); prev = all[all.length - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (all.length + rep > nlen + ndist) throw new Error('inflate: bad repeat');
          for (let i = 0; i < rep; i++) all.push(prev);
        }
      }
      codes(huffman(all.slice(0, nlen)), huffman(all.slice(nlen)));
    } else throw new Error('inflate: bad block');
  } while (!last);
  return out.slice(0, n);
}
