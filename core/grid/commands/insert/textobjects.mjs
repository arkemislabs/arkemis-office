// Insert > Text > WordArt and Signature Line, Insert > Symbols > Equation: text objects that float over the sheet.
// Not checked against upstream (gridcraft has none of them); built after Excel:
//   WordArt         a text box whose letters take one of the gallery's styles (core/grid/lib/wordart.mjs), "Your text here" to start.
//   Signature Line  the line Excel draws for a signer: an X, the line, then the signer's name and title beneath; Excel's Signature Setup
//                   (suggested signer, title, e-mail, instructions, whether the signer may add comments, show the sign date). The
//                   line is a drawing for a signature to be given on paper or by the signer; no digital signature is made here.
//   Equation        a text box holding an equation in Excel's linear form (`a^2+b^2=c^2`); drawn in the maths font.
// U:grid/insert. The objects are shapes of kind wordArt, signature and equation (stored on the sheet with the other shapes).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetSheet, cellParamOn, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {baseDoc} from '../../lib/data-common.mjs';
import {nextObjectId, objectSelection, topZ, ANCHOR_MODES} from '../../lib/objects.mjs';
import {DEFAULT_THEME} from '../../model/style.mjs';
import {WORDART_STYLES, WORDART_IDS, DEFAULT_WORDART, artEffects} from '../../lib/wordart.mjs';

const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

/** Excel's built-in equations (Insert > Equation gallery), in the linear form this sheet draws. */
export const BUILT_IN_EQUATIONS = Object.freeze([
  ['Area of Circle', 'A = πr²'],
  ['Binomial Theorem', '(x + a)ⁿ = ∑_(k=0)^n (n k) x^k a^(n−k)'],
  ['Expansion of a Sum', '(1 + x)ⁿ = 1 + nx/1! + n(n−1)x²/2! + …'],
  ['Fourier Series', 'f(x) = a₀/2 + ∑_(n=1)^∞ (aₙ cos(nπx/L) + bₙ sin(nπx/L))'],
  ['Pythagorean Theorem', 'a² + b² = c²'],
  ['Quadratic Formula', 'x = (−b ± √(b² − 4ac))/2a'],
  ['Taylor Expansion', 'e^x = 1 + x/1! + x²/2! + x³/3! + …, −∞ < x < ∞'],
  ['Trig Identity 1', 'sin α ± sin β = 2 sin ½(α ± β) cos ½(α ∓ β)'],
  ['Trig Identity 2', 'cos α + cos β = 2 cos ½(α + β) cos ½(α − β)'],
].map(Object.freeze));

/** MathML of each built-in equation (the Equation gallery draws these). */
export const EQUATION_MATHML = Object.freeze({
  "Area of Circle": "<math display=\"block\"><mi>A</mi><mo>=</mo><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></math>",
  "Binomial Theorem": "<math display=\"block\"><msup><mrow><mo>(</mo><mi>x</mi><mo>+</mo><mi>a</mi><mo>)</mo></mrow><mi>n</mi></msup><mo>=</mo><munderover><mo>∑</mo><mrow><mi>k</mi><mo>=</mo><mn>0</mn></mrow><mi>n</mi></munderover><mrow><mo>(</mo><mfrac linethickness=\"0\"><mi>n</mi><mi>k</mi></mfrac><mo>)</mo></mrow><msup><mi>x</mi><mi>k</mi></msup><msup><mi>a</mi><mrow><mi>n</mi><mo>−</mo><mi>k</mi></mrow></msup></math>",
  "Expansion of a Sum": "<math display=\"block\"><msup><mrow><mo>(</mo><mn>1</mn><mo>+</mo><mi>x</mi><mo>)</mo></mrow><mi>n</mi></msup><mo>=</mo><mn>1</mn><mo>+</mo><mfrac><mrow><mi>n</mi><mi>x</mi></mrow><mrow><mn>1</mn><mo>!</mo></mrow></mfrac><mo>+</mo><mfrac><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>−</mo><mn>1</mn><mo>)</mo><msup><mi>x</mi><mn>2</mn></msup></mrow><mrow><mn>2</mn><mo>!</mo></mrow></mfrac><mo>+</mo><mo>…</mo></math>",
  "Fourier Series": "<math display=\"block\"><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo>=</mo><mfrac><msub><mi>a</mi><mn>0</mn></msub><mn>2</mn></mfrac><mo>+</mo><munderover><mo>∑</mo><mrow><mi>n</mi><mo>=</mo><mn>1</mn></mrow><mo>∞</mo></munderover><mo>(</mo><msub><mi>a</mi><mi>n</mi></msub><mi>cos</mi><mfrac><mrow><mi>n</mi><mi>π</mi><mi>x</mi></mrow><mi>L</mi></mfrac><mo>+</mo><msub><mi>b</mi><mi>n</mi></msub><mi>sin</mi><mfrac><mrow><mi>n</mi><mi>π</mi><mi>x</mi></mrow><mi>L</mi></mfrac><mo>)</mo></math>",
  "Pythagorean Theorem": "<math display=\"block\"><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></math>",
  "Quadratic Formula": "<math display=\"block\"><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>",
  "Taylor Expansion": "<math display=\"block\"><msup><mi>e</mi><mi>x</mi></msup><mo>=</mo><mn>1</mn><mo>+</mo><mfrac><mi>x</mi><mrow><mn>1</mn><mo>!</mo></mrow></mfrac><mo>+</mo><mfrac><msup><mi>x</mi><mn>2</mn></msup><mrow><mn>2</mn><mo>!</mo></mrow></mfrac><mo>+</mo><mfrac><msup><mi>x</mi><mn>3</mn></msup><mrow><mn>3</mn><mo>!</mo></mrow></mfrac><mo>+</mo><mo>…</mo></math>",
  "Trig Identity 1": "<math display=\"block\"><mi>sin</mi><mi>α</mi><mo>±</mo><mi>sin</mi><mi>β</mi><mo>=</mo><mn>2</mn><mi>sin</mi><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>(</mo><mi>α</mi><mo>±</mo><mi>β</mi><mo>)</mo><mi>cos</mi><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>(</mo><mi>α</mi><mo>∓</mo><mi>β</mi><mo>)</mo></math>",
  "Trig Identity 2": "<math display=\"block\"><mi>cos</mi><mi>α</mi><mo>+</mo><mi>cos</mi><mi>β</mi><mo>=</mo><mn>2</mn><mi>cos</mi><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>(</mo><mi>α</mi><mo>+</mo><mi>β</mi><mo>)</mo><mi>cos</mi><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>(</mo><mi>α</mi><mo>−</mo><mi>β</mi><mo>)</mo></math>"
});

/** Stores a new shape at `at` (default the active cell) of the sheet and selects it. */
function addShape(ctx, p, build, size) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const at = cellParamOn(ctx, p, 'at', si) ?? gridSel(ctx).active;
  const id = nextObjectId(content);
  const shape = {id, ...topZ(sheet), ...build(),
    anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: p.width ?? size[0], height: p.height ?? size[1], mode: ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveAndSize'}};
  setIn(ctx.change, ['sheets', si, 'shapes'], [...(sheet.shapes ?? []), shape]);
  ctx.setSelection(objectSelection(sheet, 'shape', id));
  return {shape: id};
}

const BOX = {at: s.optional(s.string({max: 100})), sheet: SHEET, width: s.optional(s.number({min: 20, max: 10000})), height: s.optional(s.number({min: 10, max: 10000})), mode: s.optional(s.enum(ANCHOR_MODES))};

function wordArt(ctx, p) {
  const style = WORDART_IDS.includes(p.style) ? p.style : DEFAULT_WORDART;
  return addShape(ctx, p, () => ({kind: 'wordArt', wordArt: style, fill: 'auto', line: 'auto', text: p.text ?? 'Your text here', format: {fontSize: 36, bold: true, noLine: true, align: 'center', anchor: 'middle'}}), [420, 80]);
}

/** The lines under a signature line: the signer, then the title. */
export const signatureCaption = sig => [sig.signer, sig.title].filter(Boolean).join('\n');

function signatureLine(ctx, p) {
  const signature = {signer: String(p.signer ?? ''), title: String(p.title ?? ''), email: String(p.email ?? ''), instructions: String(p.instructions ?? ''), comments: p.comments === true, showDate: p.showDate !== false};
  return addShape(ctx, p, () => ({kind: 'signature', signature, fill: 'auto', line: 'auto', text: signatureCaption(signature), format: {noLine: true}}), [220, 72]);
}

function equation(ctx, p) {
  const built = p.builtIn ? BUILT_IN_EQUATIONS.find(([name]) => name.toLowerCase() === String(p.builtIn).toLowerCase()) : null;
  return addShape(ctx, p, () => ({kind: 'equation', fill: 'auto', line: 'auto', text: p.text ?? built?.[1] ?? '', format: {noLine: true, align: 'center', anchor: 'middle', font: 'Cambria Math', italic: true, fontSize: 16}}), [240, 56]);
}

const themeColors = ctx => (ctx.doc.theme ?? DEFAULT_THEME).colors;

export default defineCommands({
  family: 'insert/textobjects',
  app: 'grid',
  upstream: {repo: 'office', files: ['Excel Insert > Text > WordArt', 'Excel Insert > Text > Signature Line', 'Excel Insert > Symbols > Equation']},
  commands: [
    {id: 'insert.wordArt', label: 'WordArt', risk: 'edit',
      description: `Insert WordArt: a text box whose letters take a style of the gallery (${WORDART_IDS.join(', ')}); \`text\` (default "Your text here"), \`at\`, \`width\`, \`height\`.`,
      params: s.object({style: s.optional(s.enum(WORDART_IDS)), text: s.optional(s.string({max: 1000})), ...BOX}),
      state: ctx => {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        const theme = themeColors(ctx);
        return {...st, value: WORDART_STYLES.map(([id, label]) => ({id, label, value: id, art: {kind: 'wordArt', effects: artEffects(id, theme)}, iconOnly: true}))};
      },
      run: wordArt},
    {id: 'insert.signatureLine', label: 'Signature Line', risk: 'edit', dialog: 'dialog.signatureSetup',
      description: 'Insert a signature line (Signature Setup): `signer` (suggested signer), `title`, `email`, `instructions`, `comments` (the signer may add comments), `showDate` (show the sign date in the signature line, default true).',
      params: s.object({signer: s.optional(s.string({max: 255})), title: s.optional(s.string({max: 255})), email: s.optional(s.string({max: 255})), instructions: s.optional(s.string({max: 2000})),
        comments: s.optional(s.boolean()), showDate: s.optional(s.boolean()), ...BOX}),
      state: hasDoc, run: signatureLine},
    {id: 'insert.equation', label: 'Equation', risk: 'edit',
      description: 'Insert an equation: a text box holding `text` in the linear form (`a^2+b^2=c^2`; empty starts blank), drawn in the maths font; `builtIn` names one of the built-in gallery (Pythagorean Theorem, Quadratic Formula...).',
      params: s.object({text: s.optional(s.string({max: 2000})), builtIn: s.optional(s.string({max: 100})), ...BOX}),
      state: ctx => {
        const st = hasDoc(ctx);
        return st.enabled ? {...st, value: BUILT_IN_EQUATIONS.map(([name]) => ({id: name, label: name, value: name, mathml: EQUATION_MATHML[name], group: 'Built-In', ...(name.length > 14 ? {long: true} : {})}))} : st;
      },
      run: equation},
  ],
});
