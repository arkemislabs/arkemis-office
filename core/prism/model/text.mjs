// Text bodies: body properties, paragraphs, runs, list styles.
// Translated from deckcraft crates/model/src/text.rs at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Offsets: deckcraft counts Unicode scalar values; Prism counts UTF-16 code units (the
// architecture's address rule, docs/architecture.md 5.3 and 14.4) and refuses offsets that split
// a surrogate pair. A line break run contributes one U+000B.

export const ANCHORS = Object.freeze(['top', 'middle', 'bottom', 'justified', 'distributed']);
const ANCHOR_XML = {top: 't', middle: 'ctr', bottom: 'b', justified: 'just', distributed: 'dist'};
export const anchorXml = a => ANCHOR_XML[a];
export const anchorFromXml = s => Object.entries(ANCHOR_XML).find(([, v]) => v === s)?.[0] ?? null;

export const TEXT_DIRS = Object.freeze(['horizontal', 'vertical', 'vertical270', 'stacked', 'eaVertical', 'mongolianVertical', 'stackedRtl']);
const DIR_XML = {horizontal: 'horz', vertical: 'vert', vertical270: 'vert270', stacked: 'wordArtVert', eaVertical: 'eaVert', mongolianVertical: 'mongolianVert',
  stackedRtl: 'wordArtVertRtl'};
export const textDirXml = d => DIR_XML[d];
export const textDirFromXml = s => Object.entries(DIR_XML).find(([, v]) => v === s)?.[0] ?? null;

export const ALIGNS = Object.freeze(['left', 'center', 'right', 'justify', 'justLow', 'distributed']);
const ALIGN_XML = {left: 'l', center: 'ctr', right: 'r', justify: 'just', justLow: 'justLow', distributed: 'dist'};
export const alignXml = a => ALIGN_XML[a];
export const alignFromXml = s => (s === 'thaiDist' ? 'justify' : Object.entries(ALIGN_XML).find(([, v]) => v === s)?.[0] ?? null);

const BODY_FIELDS = ['insetL', 'insetT', 'insetR', 'insetB', 'anchor', 'anchorCtr', 'wrap', 'autofit', 'vert', 'rot', 'columns', 'colSpacing', 'rtlCol',
  'upright', 'spaceFirstLast'];
/** `BodyProps::inherit`. */
export function inheritBody(b, p) {
  const out = {...b};
  for (const k of BODY_FIELDS) if (out[k] == null && p?.[k] != null) out[k] = p[k];
  if (out.warp == null && p?.warp != null) { out.warp = p.warp; out.warpAdj = [...(p.warpAdj ?? [])]; }
  return out;
}

const PARA_FIELDS = ['align', 'marginLeft', 'marginRight', 'indent', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'bullet', 'bulletFont', 'bulletColor',
  'bulletSize', 'tabs', 'defaultTab', 'rtl', 'fontAlign', 'eastAsianLineBreak', 'latinLineBreak', 'hangingPunct'];
/** `ParaProps::inherit`. */
export function inheritPara(a, p) {
  const out = {...a};
  for (const k of PARA_FIELDS) if (out[k] == null && p?.[k] != null) out[k] = p[k];
  return out;
}

export const RUN_FIELDS = Object.freeze(['font', 'fontEa', 'fontCs', 'fontSym', 'size', 'bold', 'italic', 'underline', 'underlineColor', 'strike',
  'baseline', 'caps', 'spacing', 'kern', 'fill', 'outline', 'highlight', 'link', 'hover', 'lang', 'shadow', 'innerShadow', 'glow', 'reflection',
  'softEdge', 'noProof']);
/** `RunProps::inherit`. */
export function inheritRun(r, p) {
  const out = {...r};
  for (const k of RUN_FIELDS) if (out[k] == null && p?.[k] != null) out[k] = p[k];
  return out;
}
/** Props objects compare by value; null/undefined fields are absent. */
export function propsEqual(a, b) {
  const clean = o => { const x = {}; for (const [k, v] of Object.entries(o ?? {})) if (v != null) x[k] = v; return x; };
  return stableJSON(clean(a)) === stableJSON(clean(b));
}
export function stableJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJSON).join(',')}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(',')}}`;
}

/** Can a link from a (possibly untrusted) deck be opened outside it? Only web pages and mail. */
export function safeUrl(url) {
  const u = String(url).trim();
  const i = u.indexOf(':');
  if (i < 0) return false;
  const scheme = u.slice(0, i).toLowerCase(), rest = u.slice(i + 1);
  if (scheme === 'http' || scheme === 'https') return rest.startsWith('//') && rest.length > 2;
  if (scheme === 'mailto') return rest.length > 0;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Runs, paragraphs, bodies

export const isTextRun = r => !r.kind || r.kind.kind === 'text';
export const isBreakRun = r => r.kind?.kind === 'break';
export const textRun = (text, props) => (props && Object.keys(props).length ? {text, props} : {text});
/** The characters a run contributes to its paragraph (a break is one U+000B). */
export const runContent = r => (isBreakRun(r) ? '\u000b' : r.text ?? '');
export const runLen = r => runContent(r).length;

export const paragraph = (text = '') => ({level: 0, runs: text ? [{text}] : []});
export const paraText = p => (p.runs ?? []).map(runContent).join('');
export const paraLen = p => (p.runs ?? []).reduce((n, r) => n + runLen(r), 0);
export const paraEmpty = p => paraLen(p) === 0;
/** Leading tabs are the outline level (at most 8). Returns [paragraph, consumed]. */
export function promoteLeadingTabs(p) {
  const r = p.runs?.[0];
  if (!r || !isTextRun(r)) return [p, false];
  const m = /^\t+/.exec(r.text ?? '');
  if (!m) return [p, false];
  return [{...p, level: Math.min(m[0].length, 8), runs: [{...r, text: r.text.slice(m[0].length)}, ...p.runs.slice(1)]}, true];
}
/** Merge adjacent text runs with identical properties; drop empty text runs (returns a new paragraph). */
export function normalizeParagraph(p) {
  const out = [];
  for (const r of p.runs ?? []) {
    if (isTextRun(r) && !(r.text ?? '')) continue;
    const last = out[out.length - 1];
    if (last && isTextRun(last) && isTextRun(r) && propsEqual(last.props, r.props)) { out[out.length - 1] = {...last, text: last.text + r.text}; continue; }
    out.push(r);
  }
  return {...p, runs: out};
}

export const emptyBody = () => ({body: {}, paragraphs: []});
/** `TextBody::from_text`. */
export function bodyFromText(text) {
  const t = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {body: {}, paragraphs: t.split('\n').map(paragraph)};
}
/** Plain text with `\n` between paragraphs. */
export const bodyText = b => (b?.paragraphs ?? []).map(paraText).join('\n');
export const bodyEmpty = b => (b?.paragraphs ?? []).every(paraEmpty);
/** Total characters (UTF-16), counting one separator between paragraphs. */
export const bodyLen = b => (b?.paragraphs ?? []).reduce((n, p) => n + paraLen(p), 0) + Math.max(0, (b?.paragraphs?.length ?? 0) - 1);

/** ListStyle level `l` (0-based) or null. */
export const listLevel = (ls, l) => ls?.levels?.[l] ?? null;
export function listSet(ls, l, s) {
  const i = Math.min(l, 8);
  const levels = [...(ls?.levels ?? [])];
  while (levels.length <= i) levels.push(null);
  levels[i] = s;
  return {levels};
}
export const listEmpty = ls => (ls?.levels ?? []).every(x => !x);

// ---------------------------------------------------------------------------------------------
// Offsets: text-body offset (one `\n` between paragraphs) <-> (paragraph, offset)

/** (paragraph, offset) of body offset `n`, clamped to the body. */
export function posOf(body, n) {
  const ps = body?.paragraphs ?? [];
  let rest = Math.max(0, n);
  for (let i = 0; i < ps.length; i++) {
    const len = paraLen(ps[i]);
    if (rest <= len) return [i, rest];
    rest -= len + 1;
  }
  const last = Math.max(0, ps.length - 1);
  return [last, ps.length ? paraLen(ps[last]) : 0];
}
/** Body offset of (paragraph, offset). */
export function offsetOf(body, [pi, ch]) {
  const ps = body?.paragraphs ?? [];
  let n = 0;
  for (let i = 0; i < Math.min(pi, ps.length); i++) n += paraLen(ps[i]) + 1;
  return n + ch;
}
