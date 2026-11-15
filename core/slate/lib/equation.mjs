// Equations on a page (Insert › Symbols › Equation; U:slate/insert).
//
// Slate has no ArtCraft upstream. OneNote keeps an equation as typeset math; what a person types
// is UnicodeMath's linear format ("x=(-b±√(b^2-4ac))/2a"), which Office turns into the built-up
// form. Ours stores the linear text on the page (schema node `equation`, attribute `linear`) and
// builds the typeset form from it: fractions (`a/b`, an operand is the run of letters, digits and
// scripts with no space inside it; a parenthesised operand loses its brackets), scripts (`^`, `_`),
// square and cube roots (`√`, `∛`), n-ary operators with limits (`∑_(k=0)^n`), brackets, stacks
// inside brackets (`(n¦k)` for a binomial), function names (`sin`, `cos`, ...) and the symbols
// themselves (Greek letters and operators are already characters). The typeset form is MathML,
// which the renderer draws natively; headless callers get the same string.
//
// The built-in equations are Office's Equation gallery (Insert › Equation): the nine the spec lists.
//
// No DOM, no Node built-ins.

/** Office's built-in equations: id -> {name, linear}. */
export const PRESETS = Object.freeze({
  'area-of-circle': {name: 'Area of Circle', linear: 'A=πr^2'},
  'binomial-theorem': {name: 'Binomial Theorem', linear: '(x+a)^n=∑_(k=0)^n (n¦k) x^k a^(n-k)'},
  'expansion-of-a-sum': {name: 'Expansion of a Sum', linear: '(1+x)^n=1+nx/1!+(n(n-1)x^2)/2!+⋯'},
  'fourier-series': {name: 'Fourier Series', linear: 'f(x)=a_0+∑_(n=1)^∞ (a_n cos nπx/L+b_n sin nπx/L)'},
  'pythagorean-theorem': {name: 'Pythagorean Theorem', linear: 'a^2+b^2=c^2'},
  'quadratic-formula': {name: 'Quadratic Formula', linear: 'x=(-b±√(b^2-4ac))/2a'},
  'taylor-expansion': {name: 'Taylor Expansion', linear: 'e^x=1+x/1!+x^2/2!+x^3/3!+⋯, -∞<x<∞'},
  'trig-identity-1': {name: 'Trig Identity 1', linear: 'sin α±sin β=2 sin 1/2 (α±β) cos 1/2 (α∓β)'},
  'trig-identity-2': {name: 'Trig Identity 2', linear: 'cos α+cos β=2 cos 1/2 (α+β) cos 1/2 (α-β)'},
});

export const MAX_LINEAR = 2000;
/** The empty slot of a structure (a dotted box in the typeset form). */
export const PLACEHOLDER = '□';
const FUNCTIONS = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'deg', 'dim', 'ker', 'mod'];
const NARY = new Set([...'∑∏∐∫∬∭∮⋃⋂']);
const OPEN = {'(': ')', '[': ']', '{': '}'};
const CLOSE = new Set([')', ']', '}']);

// ---------------------------------------------------------------------------------------------
// Tokens

function tokenize(text) {
  const out = [];
  const chars = [...text];
  let sp = false;
  for (let i = 0; i < chars.length;) {
    const c = chars[i];
    if (/\s/u.test(c)) { sp = true; i++; continue; }
    let tok;
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < chars.length && /\d/.test(chars[j])) j++;
      if (chars[j] === '.' && /\d/.test(chars[j + 1] ?? '')) { j++; while (j < chars.length && /\d/.test(chars[j])) j++; }
      tok = {t: 'num', v: chars.slice(i, j).join('')};
      i = j;
    } else if (/\p{L}/u.test(c)) {
      let j = i + 1;
      while (j < chars.length && /[a-zA-Z]/.test(chars[j]) && /[a-zA-Z]/.test(c)) j++;
      const run = chars.slice(i, j).join('');
      const fn = FUNCTIONS.find(f => run.startsWith(f));
      if (fn) { tok = {t: 'fn', v: fn}; i += fn.length; } else { tok = {t: 'id', v: c}; i++; }
    } else if (c === PLACEHOLDER) { tok = {t: 'id', v: c}; i++; } else { tok = {t: 'sym', v: c}; i++; }
    tok.sp = sp;
    sp = false;
    out.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parser: tokens -> tree

const row = items => (items.length === 1 ? items[0] : {t: 'row', items});

class Parser {
  constructor(tokens) { this.toks = tokens; this.i = 0; this.depth = 0; this.inMatrix = 0; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  isSym(tok, v) { return !!tok && tok.t === 'sym' && tok.v === v; }

  /** A sequence up to a closing bracket (or the end): a list of items. */
  seq(stopAtClose) {
    const items = [];
    while (this.i < this.toks.length) {
      const tok = this.peek();
      if (stopAtClose && tok.t === 'sym' && (CLOSE.has(tok.v) || tok.v === '¦')) break;
      if (this.inMatrix && tok.t === 'sym' && (tok.v === '&' || tok.v === '@')) break;
      const x = this.term();
      if (x) items.push(x);
    }
    return items;
  }

  /** A word (adjacent operands, no space between) and, after a `/`, the denominator word. */
  term() {
    const first = this.operand();
    if (!first) return null;
    // An operator or a stray symbol stands alone; words are built from operands.
    if (first.t === 'sym' && first.v !== '!' && first.v !== '°' && first.v !== '′') return first;
    if (first.t === 'nary') return first;
    const run = [first];
    while (this.i < this.toks.length) {
      const tok = this.peek();
      if (tok.sp || !this.startsOperand(tok)) break;
      run.push(this.operand());
    }
    if (this.isSym(this.peek(), '/') && !this.peek().sp) {
      this.next();
      const den = this.word();
      const unwrap = items => (items.length === 1 && items[0].t === 'fenced' && items[0].open === '(' && !Array.isArray(items[0].content) ? items[0].content : items.length === 1 && items[0].t === 'fenced' && items[0].open === '(' ? row(items[0].content) : row(items));
      return {t: 'frac', n: unwrap(run), d: unwrap(den)};
    }
    return run.length === 1 ? run[0] : {t: 'row', items: run};
  }

  word() {
    const run = [];
    const first = this.operand();
    if (first) run.push(first);
    while (this.i < this.toks.length) {
      const tok = this.peek();
      if (tok.sp || !this.startsOperand(tok)) break;
      run.push(this.operand());
    }
    return run;
  }

  startsOperand(tok) {
    if (!tok) return false;
    if (tok.t === 'num' || tok.t === 'id' || tok.t === 'fn') return true;
    if (OPEN[tok.v] || tok.v === '√' || tok.v === '∛' || tok.v === '∜' || tok.v === '■' || NARY.has(tok.v)) return true;
    return tok.v === '!' || tok.v === '°' || tok.v === '′';
  }

  /** One operand with its scripts; any other symbol is an operand of its own. */
  operand() {
    const tok = this.next();
    if (!tok) return null;
    let base;
    if (tok.t === 'num') base = {t: 'num', v: tok.v};
    else if (tok.t === 'id') base = {t: 'id', v: tok.v};
    else if (tok.t === 'fn') base = {t: 'fn', v: tok.v};
    else if (OPEN[tok.v]) base = this.group(tok.v);
    else if (tok.v === '■' && this.isSym(this.peek(), '(')) base = this.matrix();
    else if (tok.v === '√' || tok.v === '∛' || tok.v === '∜') {
      base = {t: 'sqrt', arg: this.rootArg(), ...(tok.v === '∛' ? {index: '3'} : tok.v === '∜' ? {index: '4'} : {})};
    } else if (NARY.has(tok.v)) {
      let sub = null, sup = null;
      for (let k = 0; k < 2; k++) {
        const nx = this.peek();
        if (this.isSym(nx, '_') && sub === null) { this.next(); sub = this.scriptArg(); }
        else if (this.isSym(nx, '^') && sup === null) { this.next(); sup = this.scriptArg(); }
      }
      return {t: 'nary', op: tok.v, sub, sup};
    } else base = {t: 'sym', v: tok.v};
    if (base.t === 'sym' && base.v !== '!' && base.v !== '°' && base.v !== '′') return base;
    // A combining mark right after an operand is its accent (x̄, a⃗).
    for (let nx = this.peek(); nx && !nx.sp && nx.t === 'sym' && /^\p{M}$/u.test(nx.v); nx = this.peek()) { this.next(); base = {t: 'accent', base, mark: nx.v}; }
    let sub = null, sup = null;
    while (this.i < this.toks.length) {
      const nx = this.peek();
      if (nx.sp) break;
      if (this.isSym(nx, '_') && sub === null) { this.next(); sub = this.scriptArg(); }
      else if (this.isSym(nx, '^') && sup === null) { this.next(); sup = this.scriptArg(); }
      else break;
    }
    if (sub !== null && sup !== null) return {t: 'subsup', base, sub, sup};
    if (sub !== null) return {t: 'sub', base, sub};
    if (sup !== null) return {t: 'sup', base, sup};
    return base;
  }

  /** The argument of `^` or `_`: a bracketed group (brackets dropped), or a signed single token. */
  scriptArg() {
    const tok = this.peek();
    if (!tok) return {t: 'row', items: []};
    if (tok.t === 'sym' && OPEN[tok.v]) { this.next(); return row(asItems(this.group(tok.v).content)); }
    const items = [];
    if (tok.t === 'sym' && (tok.v === '-' || tok.v === '−' || tok.v === '+')) { this.next(); items.push({t: 'sym', v: tok.v === '-' ? '−' : tok.v}); }
    const nx = this.next();
    if (nx) items.push({t: nx.t === 'sym' ? 'sym' : nx.t, v: nx.v});
    return row(items);
  }

  rootArg() {
    const tok = this.peek();
    if (this.isSym(tok, '(')) { this.next(); return row(asItems(this.group('(').content)); }
    return this.operand() ?? {t: 'row', items: []};
  }

  /** `■(a&b@c&d)`: a matrix, cells split by `&`, rows by `@` (the opening bracket is the next token). */
  matrix() {
    this.next();
    if (++this.depth > 40) throw new Error('too deeply nested');
    const rows = [[]];
    this.inMatrix++;
    for (let guard = 0; guard < 10000; guard++) {
      rows[rows.length - 1].push(row(this.seq(true)));
      const nx = this.peek();
      if (this.isSym(nx, '&')) { this.next(); continue; }
      if (this.isSym(nx, '@')) { this.next(); rows.push([]); continue; }
      break;
    }
    this.inMatrix--;
    this.depth--;
    if (this.peek()?.t === 'sym' && CLOSE.has(this.peek().v)) this.next();
    return {t: 'matrix', rows};
  }

  /** A bracket's content after its opening token; `(a¦b)` makes a stack. */
  group(open) {
    const close = OPEN[open];
    if (++this.depth > 40) throw new Error('too deeply nested');
    const parts = [this.seq(true)];
    while (this.isSym(this.peek(), '¦')) { this.next(); parts.push(this.seq(true)); }
    if (this.peek()?.t === 'sym' && CLOSE.has(this.peek().v)) this.next();
    this.depth--;
    if (parts.length > 1) return {t: 'fenced', open, close, content: [{t: 'stack', rows: parts.map(row)}]};
    return {t: 'fenced', open, close, content: parts[0]};
  }
}
const asItems = c => (Array.isArray(c) ? c : [c]);

/** Parse linear-format text into the tree (throws on input that cannot be parsed). */
export function parse(linear) {
  const text = String(linear ?? '');
  if (text.length > MAX_LINEAR) throw new Error(`An equation is at most ${MAX_LINEAR} characters`);
  return row(new Parser(tokenize(text)).seq(false));
}

// ---------------------------------------------------------------------------------------------
// MathML

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LETTERLIKE = /^\p{L}$/u;
const UNDER = new Set(['lim', 'max', 'min']);
/** Combining mark -> the spacing accent MathML draws over the operand. */
const ACCENT_MARKS = {'̇': '˙', '̈': '¨', '̂': 'ˆ', '̌': 'ˇ', '́': '´', '̀': '`', '̃': '˜', '̄': '¯', '̆': '˘', '⃗': '→'};

function mathml(n) {
  if (Array.isArray(n)) return `<mrow>${n.map(mathml).join('')}</mrow>`;
  switch (n.t) {
    case 'num': return `<mn>${esc(n.v)}</mn>`;
    case 'id': return n.v === PLACEHOLDER ? '<mspace class="eq-ph" width="0.7em" height="0.85em"></mspace>' : `<mi>${esc(n.v)}</mi>`;
    case 'fn': return `<mi mathvariant="normal">${esc(n.v)}</mi>`;
    case 'sym': {
      const v = n.v === '-' ? '−' : n.v;
      return LETTERLIKE.test(v) ? `<mi>${esc(v)}</mi>` : `<mo>${esc(v)}</mo>`;
    }
    case 'row': return `<mrow>${n.items.map(mathml).join('')}</mrow>`;
    case 'frac': return `<mfrac>${mathml(n.n)}${mathml(n.d)}</mfrac>`;
    case 'sup': return `<msup>${mathml(n.base)}${mathml(n.sup)}</msup>`;
    case 'sub': return n.base.t === 'fn' && UNDER.has(n.base.v) ? `<munder>${mathml(n.base)}${mathml(n.sub)}</munder>` : `<msub>${mathml(n.base)}${mathml(n.sub)}</msub>`;
    case 'accent': return `<mover accent="true">${mathml(n.base)}<mo>${esc(ACCENT_MARKS[n.mark] ?? n.mark)}</mo></mover>`;
    case 'matrix': return `<mtable>${n.rows.map(r => `<mtr>${r.map(c => `<mtd>${mathml(c)}</mtd>`).join('')}</mtr>`).join('')}</mtable>`;
    case 'subsup': return `<msubsup>${mathml(n.base)}${mathml(n.sub)}${mathml(n.sup)}</msubsup>`;
    case 'sqrt': return n.index ? `<mroot>${mathml(n.arg)}<mn>${n.index}</mn></mroot>` : `<msqrt>${mathml(n.arg)}</msqrt>`;
    case 'nary': {
      const op = `<mo largeop="true" movablelimits="false" stretchy="false">${esc(n.op)}</mo>`;
      if (n.sub && n.sup) return `<munderover>${op}${mathml(n.sub)}${mathml(n.sup)}</munderover>`;
      if (n.sub) return `<munder>${op}${mathml(n.sub)}</munder>`;
      if (n.sup) return `<mover>${op}${mathml(n.sup)}</mover>`;
      return op;
    }
    case 'fenced': return `<mrow><mo>${esc(n.open)}</mo>${asItems(n.content).map(mathml).join('')}<mo>${esc(n.close)}</mo></mrow>`;
    case 'stack': return `<mtable>${n.rows.map(r => `<mtr><mtd>${mathml(r)}</mtd></mtr>`).join('')}</mtable>`;
    default: return '';
  }
}

/** The typeset form of linear-format text as a MathML string (`<math>...</math>`). Empty text gives an empty string. */
export function toMathML(linear, {normalText = false} = {}) {
  const text = String(linear ?? '').trim();
  if (!text) return '';
  if (normalText) return `<math><mtext>${esc(text)}</mtext></math>`;
  let tree;
  try { tree = parse(text); } catch { return `<math><mtext>${esc(text)}</mtext></math>`; }
  return `<math>${mathml(tree)}</math>`;
}

/**
 * What an equation node shows: professional (typeset), linear (the text as typed) or, with
 * normalText, the text as plain (non-math) text. Empty text shows nothing.
 * @param {{linear?: string, format?: string, normalText?: boolean}} [o]
 */
export function typeset({linear, format = 'professional', normalText = false} = {}) {
  const text = String(linear ?? '');
  if (!text.trim()) return '';
  if (format === 'linear') return `<span class="slate-equation-linear">${esc(text)}</span>`;
  return toMathML(text, {normalText});
}

/** The kinds of structure a typeset equation has (for tests). */
export function structure(linear) {
  const found = new Set();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    found.add(n.t);
    for (const k of ['items', 'content', 'rows']) if (Array.isArray(n[k])) n[k].forEach(walk);
    for (const k of ['n', 'd', 'base', 'sub', 'sup', 'arg']) if (n[k] && typeof n[k] === 'object') walk(n[k]);
    if (Array.isArray(n.rows)) for (const r of n.rows) if (Array.isArray(r)) r.forEach(walk);
  };
  walk(parse(linear));
  return [...found].sort();
}
