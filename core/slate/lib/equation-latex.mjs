// LaTeX -> UnicodeMath linear format (Equation tab > Conversions > LaTeX; U:slate/equation).
// With LaTeX as the input syntax, what is typed in an equation (`\frac{a}{b}`, `x^{2}`,
// `\begin{pmatrix}a&b\\c&d\end{pmatrix}`) is converted to the linear format the page stores. The
// common commands of amsmath are covered: fractions, roots, scripts, Greek letters, operators and
// relations, arrows, function names, accents, binomials, matrices and text. An unknown command is
// kept as its name. No DOM, no Node built-ins.

const GREEK = {alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'};
const SYMBOLS = {pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇', in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⇔', implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  longrightarrow: '⟶', longleftarrow: '⟵', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', angle: '∠', degree: '°', prime: '′', therefore: '∴', because: '∵', perp: '⊥', parallel: '∥', top: '⊤', bot: '⊥', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', wp: '℘', triangle: '△', square: '□', '|': '‖', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: ' ', qquad: '  ', '\\': ' '};
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'deg', 'dim', 'ker', 'mod']);
const ACCENTS = {vec: '⃗', bar: '̄', overline: '̄', hat: '̂', widehat: '̂', dot: '̇', ddot: '̈', tilde: '̃', widetilde: '̃', check: '̌', breve: '̆', acute: '́', grave: '̀'};
const TEXTUAL = new Set(['text', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'operatorname', 'mbox', 'textrm', 'textbf', 'boldsymbol', 'rm']);
const MATRICES = {matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], cases: ['{', '}'], array: ['', '']};
const MAX = 8000;

/** The balanced `{...}` argument at `i` (skipping spaces), or one token; returns [text, next index]. */
function arg(s, i) {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
    }
    return [s.slice(i + 1, j), j + 1];
  }
  if (s[i] === '\\') { const m = /^\\([A-Za-z]+|.)/s.exec(s.slice(i)); return [m ? m[0] : '', i + (m ? m[0].length : 0)]; }
  return [s[i] ?? '', i + 1];
}

function convert(s, depth = 0) {
  if (depth > 30) throw new Error('too deeply nested');
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/s.exec(s.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        let a, b; [a, i] = arg(s, i); [b, i] = arg(s, i);
        out += `(${convert(a, depth + 1)})/(${convert(b, depth + 1)})`;
      } else if (name === 'binom') {
        let a, b; [a, i] = arg(s, i); [b, i] = arg(s, i);
        out += `(${convert(a, depth + 1)}¦${convert(b, depth + 1)})`;
      } else if (name === 'sqrt') {
        let index = null;
        while (s[i] === ' ') i++;
        if (s[i] === '[') { const j = s.indexOf(']', i); index = s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1; }
        let a; [a, i] = arg(s, i);
        out += `${index === '3' ? '∛' : index === '4' ? '∜' : '√'}(${convert(a, depth + 1)})`;
      } else if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg') {
        while (s[i] === ' ') i++;
        if (s[i] === '.') i++;
      } else if (name === 'begin') {
        let env; [env, i] = arg(s, i);
        const end = `\\end{${env}}`;
        const at = s.indexOf(end, i);
        let inner = s.slice(i, at < 0 ? s.length : at);
        i = at < 0 ? s.length : at + end.length;
        if (env === 'array') { const [, k] = arg(inner, 0); inner = inner.slice(k); }
        const [open, close] = MATRICES[env] ?? ['', ''];
        const rows = inner.split(/\\\\/).map(r => r.trim()).filter(Boolean).map(r => r.split('&').map(cell => convert(cell.trim(), depth + 1)).join('&'));
        out += `${open}■(${rows.join('@')})${close}`;
      } else if (TEXTUAL.has(name)) {
        let a; [a, i] = arg(s, i);
        out += name === 'mathbb' || name === 'mathcal' || name === 'mathfrak' ? convert(a, depth + 1) : a;
      } else if (Object.hasOwn(ACCENTS, name)) {
        let a; [a, i] = arg(s, i);
        out += `${convert(a, depth + 1)}${ACCENTS[name]}`;
      } else if (Object.hasOwn(GREEK, name)) out += GREEK[name];
      else if (FUNCTIONS.has(name)) out += s[i] === '^' || s[i] === '_' ? name : `${name} `;
      else if (Object.hasOwn(SYMBOLS, name)) out += SYMBOLS[name];
      else out += name;
      continue;
    }
    if (c === '^' || c === '_') {
      let a; [a, i] = arg(s, i + 1);
      const text = convert(a, depth + 1);
      out += c + ([...text].length === 1 || /^[-−+]?\d+$/.test(text) ? text : `(${text})`);
      continue;
    }
    if (c === '{') { let a; [a, i] = arg(s, i); out += convert(a, depth + 1); continue; }
    if (c === '}' || c === '$') { i++; continue; }
    if (c === '~' || c === '&') { out += ' '; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** The linear format of LaTeX text (never throws: text that cannot be converted comes back as it was). */
export function latexToLinear(tex) {
  const s = String(tex ?? '').slice(0, MAX);
  try { return convert(s).replace(/ {2,}/g, ' ').trim(); } catch { return s; }
}
