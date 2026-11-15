// The Equation tab's galleries: Symbols (eight categories) and Structures (eleven galleries of
// templates), and the tiles each draws (U:slate/equation). Slate has no ArtCraft upstream; the
// categories and structure names are docs/spec/slate.json `equation.symbols.*` and
// `equation.structures.*`; the contents are Office's Equation Tools galleries as far as the linear
// renderer can typeset them (core/slate/lib/equation.mjs).
//
// A structure is linear-format text with `□` for each empty slot, which the typeset form draws as a
// dotted box. Every tile is drawn from its own MathML (never a text label): `tiles()` returns the
// gallery items the shell draws ({id, label, value, mathml, iconOnly}); the label is only the tooltip.
//
// No DOM, no Node built-ins.

import {PLACEHOLDER, PRESETS, toMathML} from './equation.mjs';

const chars = text => [...text.replace(/\s+/g, '')];

/** Symbol categories: id -> {name, symbols: [char]}. */
export const SYMBOLS = Object.freeze({
  'basic-math': {name: 'Basic Math', symbols: chars('±∓×÷∙∘∗≠≤≥≪≫≈≅≡∝∞∂∇√∛∜∑∏∫∮∈∉∋⊂⊃⊆⊇∪∩∅∀∃¬∧∨→←↔⇒⇔∴∵′″°⋯⋮⋱ℵ')},
  'greek-letters': {name: 'Greek Letters', symbols: chars('αβγδεζηθικλμνξοπρστυφχψωϵϑϰϱςϕΓΔΘΛΞΠΣΥΦΨΩ')},
  'letter-like-symbols': {name: 'Letter-Like Symbols', symbols: chars('ℂℍℕℙℚℝℤℓℏℑℜ℘ℵℶℷℸℯⅅⅆⅇⅈⅉ℃℉№™')},
  operators: {name: 'Operators', symbols: chars('±∓×÷⋅∘∗⊕⊖⊗⊘⊙⊛⊝∪∩⊎⊓⊔∧∨⊻⋀⋁⋂⋃∖⋆⋄⋈⋉⋊⊲⊳∙†‡⊥⊤⊢⊣⊨')},
  arrows: {name: 'Arrows', symbols: chars('←→↑↓↔↕↖↗↘↙⇐⇒⇑⇓⇔⇕↦↤↩↪↼⇀⇌⇄⇆⟵⟶⟷⟸⟹⟺⟼↝↭↣↠↢↞⇝⇜')},
  'negated-relations': {name: 'Negated Relations', symbols: chars('≠≢≁≄≉≇≭≮≯≰≱≴≵⊀⊁⊄⊅⊈⊉∉∌∤∦⊬⊭⊮⊯≨≩⊊⊋⋢⋣')},
  scripts: {name: 'Scripts', symbols: chars('𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀')},
  geometry: {name: 'Geometry', symbols: chars('∠∡∢⊾⊿△▽◁▷□◇○●■▲▼⊥∥∦≅∼≃⌒◯◬')},
});
export const SYMBOL_CATEGORIES = Object.freeze(Object.keys(SYMBOLS));

const P = PLACEHOLDER;
const v = (id, name, linear) => ({id, name, linear});

/** Structures: id -> {name, variants: [{id, name, linear}]}. */
export const STRUCTURES = Object.freeze({
  fraction: {name: 'Fraction', variants: [v('stacked', 'Stacked Fraction', `${P}/${P}`), v('dy-dx', 'Differential', 'dy/dx'), v('delta-y-x', 'Delta', 'Δy/Δx'),
    v('partial', 'Partial Differential', '∂y/∂x'), v('pi-over-2', 'Pi over 2', 'π/2')]},
  script: {name: 'Script', variants: [v('superscript', 'Superscript', `${P}^${P}`), v('subscript', 'Subscript', `${P}_${P}`), v('subsuperscript', 'Subscript-Superscript', `${P}_${P}^${P}`),
    v('exponential', 'Exponential', 'e^(-iωt)'), v('index', 'Indexed Power', 'Y_1^n')]},
  radical: {name: 'Radical', variants: [v('square-root', 'Square Root', `√${P}`), v('cube-root', 'Cube Root', `∛${P}`), v('fourth-root', 'Fourth Root', `∜${P}`),
    v('quadratic-formula', 'Quadratic Formula', 'x=(-b±√(b^2-4ac))/2a'), v('root-of-sum', 'Square Root of a Sum', '√(a^2+b^2)')]},
  integral: {name: 'Integral', variants: [v('integral', 'Integral', `∫${P}`), v('definite', 'Integral with Limits', `∫_${P}^${P} ${P}`), v('double', 'Double Integral', `∬${P}`),
    v('triple', 'Triple Integral', `∭${P}`), v('contour', 'Contour Integral', `∮${P}`), v('example', 'Definite Integral', '∫_a^b f(x)dx')]},
  'large-operator': {name: 'Large Operator', variants: [v('sum', 'Summation', `∑${P}`), v('sum-limits', 'Summation with Limits', `∑_(${P}=${P})^${P} ${P}`), v('product', 'Product', `∏${P}`),
    v('coproduct', 'Coproduct', `∐${P}`), v('union', 'Union', `⋃${P}`), v('intersection', 'Intersection', `⋂${P}`), v('sum-example', 'Sum of the First Terms', '∑_(k=1)^n k')]},
  bracket: {name: 'Bracket', variants: [v('parentheses', 'Parentheses', `(${P})`), v('square', 'Square Brackets', `[${P}]`), v('curly', 'Curly Braces', `{${P}}`), v('binomial', 'Binomial', `(${P}¦${P})`)]},
  function: {name: 'Function', variants: [v('sin', 'Sine', `sin ${P}`), v('cos', 'Cosine', `cos ${P}`), v('tan', 'Tangent', `tan ${P}`), v('sec', 'Secant', `sec ${P}`),
    v('csc', 'Cosecant', `csc ${P}`), v('cot', 'Cotangent', `cot ${P}`), v('sin-theta', 'Sine Theta', 'sin θ')]},
  accent: {name: 'Accent', variants: [['dot', 'Dot', '̇'], ['diaeresis', 'Double Dot', '̈'], ['hat', 'Hat', '̂'], ['check', 'Check', '̌'], ['acute', 'Acute', '́'], ['grave', 'Grave', '̀'],
    ['tilde', 'Tilde', '̃'], ['bar', 'Bar', '̄'], ['breve', 'Breve', '̆'], ['vector', 'Vector', '⃗']].map(([id, name, mark]) => v(id, name, `${P}${mark}`))},
  'limit-and-log': {name: 'Limit and Log', variants: [v('limit', 'Limit', `lim_(${P}→${P}) ${P}`), v('log', 'Logarithm', `log_${P} ${P}`), v('ln', 'Natural Logarithm', `ln ${P}`),
    v('max', 'Maximum', `max_${P} ${P}`), v('min', 'Minimum', `min_${P} ${P}`), v('limit-example', 'Limit Example', 'lim_(n→∞) (1+1/n)^n')]},
  operator: {name: 'Operator', variants: [v('colon-equal', 'Colon Equal', `${P}≔${P}`), v('equal-equal', 'Equal Equal', `${P}⩵${P}`), v('defined-as', 'Defined As', `${P}≝${P}`),
    v('delta-equal', 'Delta Equal', `${P}≜${P}`), v('measured-by', 'Measured By', `${P}≞${P}`), v('yields', 'Yields', `${P}⟶${P}`)]},
  matrix: {name: 'Matrix', variants: [v('empty-2x2', 'Empty 2 by 2 Matrix', `■(${P}&${P}@${P}&${P})`), v('empty-2x3', 'Empty 2 by 3 Matrix', `■(${P}&${P}&${P}@${P}&${P}&${P})`),
    v('empty-3x3', 'Empty 3 by 3 Matrix', `■(${P}&${P}&${P}@${P}&${P}&${P}@${P}&${P}&${P})`), v('parentheses-2x2', '2 by 2 with Parentheses', `(■(${P}&${P}@${P}&${P}))`),
    v('brackets-2x2', '2 by 2 with Brackets', `[■(${P}&${P}@${P}&${P})]`), v('identity-2x2', '2 by 2 Identity Matrix', '[■(1&0@0&1)]'), v('identity-3x3', '3 by 3 Identity Matrix', '[■(1&0&0@0&1&0@0&0&1)]')]},
});
export const STRUCTURE_IDS = Object.freeze(Object.keys(STRUCTURES));

const hex = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const wrap = inner => `<math>${inner}</math>`;

/** The symbol tiles of a category, or of every category (grouped by category, the first one in the strip). */
export function symbolTiles(category = null) {
  const cats = category ? [category] : SYMBOL_CATEGORIES;
  return cats.flatMap((id, n) => SYMBOLS[id].symbols.map(ch => ({id: `${id}:${ch}`, label: `${ch} ${hex(ch)}`, value: ch, iconOnly: true,
    mathml: wrap(/^\p{L}$/u.test(ch) || /^\p{L}\p{M}*$/u.test(ch) ? `<mi>${ch}</mi>` : `<mo>${ch}</mo>`),
    ...(category ? {} : {group: SYMBOLS[id].name, ...(n > 0 ? {inline: false} : {})})})));
}

/** The variant tiles of a structure. */
export const structureTiles = structure => (STRUCTURES[structure]?.variants ?? []).map(x => ({id: x.id, label: x.name, value: x.id, iconOnly: true, mathml: toMathML(x.linear)}));

/** The tiles of the Equation gallery: the built-in equations. */
export const presetTiles = () => Object.entries(PRESETS).map(([id, p]) => ({id, label: p.name, value: id, iconOnly: true, mathml: toMathML(p.linear)}));

export const structureVariant = (structure, variant) => {
  const s = STRUCTURES[structure];
  return s ? (variant ? s.variants.find(x => x.id === variant) : s.variants[0]) ?? null : null;
};
