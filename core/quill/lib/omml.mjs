// Equations in a .docx: Office Math Markup (OMML, ECMA-376 Part 1 §22.1) written from an equation's linear text and read back into it.
//
// Reuses Slate's equation tree (core/slate/lib/equation.mjs `parse`) instead of translating wordcraft's math model (doc/src/math*.rs,
// math_linear.rs): the linear text is parsed and each node becomes the element Word writes for it (fraction `m:f`, scripts `m:sSup`
// `m:sSub` `m:sSubSup`, radical `m:rad`, n-ary operator `m:nary` with the operand that follows it, bracket `m:d`, matrix `m:m`, accent
// `m:acc` / `m:bar`, function name `m:func`, limit `m:limLow`); reading turns those elements back into linear text, which the tree
// types again. What an equation made in Word has beyond that (styles, spacing, run formatting) is kept as it was read (`omml` on the
// object, written back until the equation is changed here), so a file round-trips; a change writes the OMML below.
//
// Where it differs from wordcraft: the same equation read from OMML and written again is the tree Slate parses from its text, not
// wordcraft's math tree; elements the linear format has no form for (`m:sPre`, `m:groupChr`, `m:borderBox`, phantoms) read as their
// content. Not checked against Word's own linear-format rules (UnicodeMath).
// No DOM, no Node built-ins. `read` works on docx-read.mjs's element tree (`El`: name, attr, child, children, elList, text).

import {parse, PLACEHOLDER} from '../../slate/lib/equation.mjs';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;');
const MATH_RPR = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';
const LETTERLIKE = /^[ℂℍℕℙℚℝℤℓℏℑℜ℘ℵ]$/;
const LIMITS = new Set(['lim', 'max', 'min']);
/** Elements that stand apart from the runs beside them (a space each side keeps fractions' operands and function names apart). */
const STRUCTURES = new Set(['m:f', 'm:nary', 'm:rad', 'm:d', 'm:m', 'm:func', 'm:limLow', 'm:limUpp', 'm:eqArr', 'm:sSup', 'm:sSub', 'm:sSubSup', 'm:acc', 'm:bar']);
const asItems = c => (Array.isArray(c) ? c : [c]);

// ---------------------------------------------------------------------------------------------------------
// Writing

class Writer {
  constructor(color, normal) { this.color = color; this.normal = normal; }
  run(text, {plain = false} = {}) {
    if (text === '') return '';
    const sty = this.normal ? '<m:rPr><m:nor/></m:rPr>' : plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : '';
    const rpr = this.color ? `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:color w:val="${this.color}"/></w:rPr>` : MATH_RPR;
    return `<m:r>${sty}${rpr}<m:t xml:space="preserve">${esc(text)}</m:t></m:r>`;
  }
  /** A list of nodes: an n-ary operator takes the node after it as its operand. */
  seq(items) {
    let out = '';
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      if (n.t === 'nary') { out += this.nary(n, items[i + 1] ?? null); if (items[i + 1]) i++; } else out += this.node(n);
    }
    return out;
  }
  e(tag, items) {
    const list = asItems(items);
    if (list.length === 1 && list[0].t === 'id' && list[0].v === PLACEHOLDER) return `<m:${tag}/>`;
    return `<m:${tag}>${this.seq(list)}</m:${tag}>`;
  }
  node(n) {
    switch (n.t) {
      case 'num': return this.run(n.v, {plain: true});
      case 'id': return n.v === PLACEHOLDER ? this.run('⬚', {plain: true}) : this.run(n.v, {plain: LETTERLIKE.test(n.v)});
      case 'fn': return this.run(n.v, {plain: true});
      case 'sym': return this.run(n.v === '-' ? '−' : n.v, {plain: true});
      case 'row': return this.seq(n.items);
      case 'frac': return `<m:f>${this.e('num', n.n)}${this.e('den', n.d)}</m:f>`;
      case 'sup': return `<m:sSup>${this.e('e', n.base)}${this.e('sup', n.sup)}</m:sSup>`;
      case 'sub':
        if (n.base.t === 'fn' && LIMITS.has(n.base.v)) return `<m:func><m:fName><m:limLow>${this.e('e', n.base)}${this.e('lim', n.sub)}</m:limLow></m:fName><m:e/></m:func>`;
        return `<m:sSub>${this.e('e', n.base)}${this.e('sub', n.sub)}</m:sSub>`;
      case 'subsup': return `<m:sSubSup>${this.e('e', n.base)}${this.e('sub', n.sub)}${this.e('sup', n.sup)}</m:sSubSup>`;
      case 'sqrt': return `<m:rad><m:radPr>${n.index ? '' : '<m:degHide m:val="1"/>'}</m:radPr>${n.index ? `<m:deg>${this.run(n.index, {plain: true})}</m:deg>` : '<m:deg/>'}${this.e('e', n.arg)}</m:rad>`;
      case 'nary': return this.nary(n, null);
      case 'fenced': return this.fenced(n);
      case 'stack': return `<m:eqArr>${n.rows.map(r => this.e('e', r)).join('')}</m:eqArr>`;
      case 'matrix': return `<m:m>${n.rows.map(r => `<m:mr>${r.map(c => this.e('e', c)).join('')}</m:mr>`).join('')}</m:m>`;
      case 'accent':
        if (n.mark === '̄') return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${this.e('e', n.base)}</m:bar>`;
        return `<m:acc><m:accPr><m:chr m:val="${attr(n.mark)}"/></m:accPr>${this.e('e', n.base)}</m:acc>`;
      default: return '';
    }
  }
  nary(n, operand) {
    const pr = `<m:naryPr><m:chr m:val="${attr(n.op)}"/><m:limLoc m:val="${'∫∬∭∮'.includes(n.op) ? 'subSup' : 'undOvr'}"/>${n.sub ? '' : '<m:subHide m:val="1"/>'}${n.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`;
    return `<m:nary>${pr}${n.sub ? this.e('sub', n.sub) : '<m:sub/>'}${n.sup ? this.e('sup', n.sup) : '<m:sup/>'}${operand ? this.e('e', operand) : '<m:e/>'}</m:nary>`;
  }
  fenced(n) {
    const content = asItems(n.content);
    const pr = `<m:dPr><m:begChr m:val="${attr(n.open ?? '')}"/><m:endChr m:val="${attr(n.close ?? '')}"/></m:dPr>`;
    // (a¦b): one operand that is a stack: a fraction without its bar.
    if (content.length === 1 && content[0].t === 'stack' && content[0].rows.length === 2) {
      const [top, bottom] = content[0].rows;
      return `<m:d>${pr}<m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr>${this.e('num', top)}${this.e('den', bottom)}</m:f></m:e></m:d>`;
    }
    return `<m:d>${pr}${this.e('e', content)}</m:d>`;
  }
}

/** The OMML of an equation: `m:oMath`, or `m:oMathPara` (with `m:jc`) for a display equation. `o`: {display, jc, normalText, color (hex)}. */
export function linearToOmml(linear, o = {}) {
  const text = String(linear ?? '');
  const w = new Writer(o.color ?? null, !!o.normalText);
  let body;
  if (!text.trim()) body = '';
  else if (o.normalText) body = w.run(text);
  else {
    try { body = w.node(parse(text)); } catch { body = w.run(text); }
  }
  const math = `<m:oMath>${body}</m:oMath>`;
  if (!o.display) return math;
  const jc = ['left', 'right', 'center', 'centerGroup'].includes(o.jc) ? o.jc : null;
  return `<m:oMathPara>${jc && jc !== 'centerGroup' ? `<m:oMathParaPr><m:jc m:val="${jc}"/></m:oMathParaPr>` : ''}${math}</m:oMathPara>`;
}

// ---------------------------------------------------------------------------------------------------------
// Reading

const val = (e, n) => e?.child(n)?.attr('m:val') ?? null;
const SIMPLE = /^[\p{L}\p{N}\p{M}'′.°□]+$/u;
/** Whether `s` is one operand of the linear format already (a word, or a bracketed group). */
function isAtom(s) {
  if (SIMPLE.test(s)) return true;
  if (!/^[([{]/.test(s)) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if ('([{'.includes(s[i])) depth++;
    else if (')]}'.includes(s[i]) && --depth === 0 && i < s.length - 1) return false;
  }
  return depth === 0;
}
/** An operand for a place whose brackets the linear format drops (a fraction's part, a root's, a script's): a word as it is, else bracketed. */
const wrap = s => (s === '' || SIMPLE.test(s) ? s : `(${s})`);
/** A script's argument: one token (a letter, a number, a signed one) as it is, else bracketed. */
const group = s => (s === '' || /^[-+\u2212]?(\d+(\.\d+)?|\p{L})$/u.test(s) || [...s].length === 1 ? s : `(${s})`);
/** A base that keeps its own brackets (`(a+b)^2`): an operand of the linear format already, else bracketed. */
const base = s => (s === '' || isAtom(s) ? s : `(${s})`);
class Reader {
  constructor() { this.depth = 0; }
  /** The linear text of an element's content (its children in order). */
  kids(e) {
    if (++this.depth > 60) { this.depth--; return ''; }
    let out = '';
    for (const k of e.elList()) out += STRUCTURES.has(k.name) ? ` ${this.el(k)} ` : this.el(k);
    this.depth--;
    return out.replace(/ {2,}/g, ' ').trim();
  }
  /** The linear text of a named part (m:num, m:e, …); an empty one is the empty slot, which Word draws as a dotted box. */
  arg(e, name) {
    const c = e.child(name);
    if (!c) return '';
    return this.kids(c) || PLACEHOLDER;
  }
  el(e) {
    switch (e.name) {
      case 'm:r': return e.children('m:t').map(t => t.text()).join('').replaceAll('⬚', PLACEHOLDER);
      case 'm:t': return e.text();
      case 'm:e': case 'm:num': case 'm:den': case 'm:sub': case 'm:sup': case 'm:deg': case 'm:lim': case 'm:fName': case 'm:oMath': case 'm:box': case 'm:phant': return this.kids(e);
      case 'm:f': {
        const n = this.arg(e, 'm:num'), d = this.arg(e, 'm:den');
        if (val(e.child('m:fPr'), 'm:type') === 'noBar') return `(${n}¦${d})`;
        return `${wrap(n)}/${wrap(d)}`;
      }
      case 'm:sSup': return `${base(this.arg(e, 'm:e'))}^${group(this.arg(e, 'm:sup'))}`;
      case 'm:sSub': return `${base(this.arg(e, 'm:e'))}_${group(this.arg(e, 'm:sub'))}`;
      case 'm:sSubSup': return `${base(this.arg(e, 'm:e'))}_${group(this.arg(e, 'm:sub'))}^${group(this.arg(e, 'm:sup'))}`;
      case 'm:sPre': return `${this.arg(e, 'm:e')}`;
      case 'm:rad': {
        const hide = ['1', 'on', 'true'].includes(val(e.child('m:radPr'), 'm:degHide'));
        const deg = hide || !e.child('m:deg')?.elList().length ? '' : this.arg(e, 'm:deg').trim();
        const body = this.arg(e, 'm:e');
        const mark = deg === '3' ? '∛' : deg === '4' ? '∜' : '√';
        return `${mark}${body === '' || SIMPLE.test(body) ? body : `(${body})`}`;
      }
      case 'm:nary': {
        const op = val(e.child('m:naryPr'), 'm:chr') ?? '∫';
        const subHide = ['1', 'on', 'true'].includes(val(e.child('m:naryPr'), 'm:subHide'));
        const supHide = ['1', 'on', 'true'].includes(val(e.child('m:naryPr'), 'm:supHide'));
        const sub = subHide ? '' : this.arg(e, 'm:sub'), sup = supHide ? '' : this.arg(e, 'm:sup');
        const body = this.arg(e, 'm:e');
        return `${op}${sub ? `_${group(sub)}` : ''}${sup ? `^${group(sup)}` : ''}${body ? ` ${body}` : ''}`;
      }
      case 'm:d': {
        const pr = e.child('m:dPr');
        const open = pr?.child('m:begChr') ? val(pr, 'm:begChr') ?? '' : '(';
        const close = pr?.child('m:endChr') ? val(pr, 'm:endChr') ?? '' : ')';
        const sep = pr?.child('m:sepChr') ? val(pr, 'm:sepChr') ?? '' : '|';
        const parts = e.children('m:e').map(x => this.kids(x) || PLACEHOLDER);
        // A bracket whose operand is a fraction without its bar: the stack (a¦b).
        return `${open}${parts.join(sep === '|' ? '|' : sep)}${close}`.replace(/^\(\((.*)¦(.*)\)\)$/s, '($1¦$2)');
      }
      case 'm:m': return `■(${e.children('m:mr').map(r => r.children('m:e').map(c => this.kids(c) || PLACEHOLDER).join('&')).join('@')})`;
      case 'm:eqArr': return `■(${e.children('m:e').map(c => this.kids(c) || PLACEHOLDER).join('@')})`;
      case 'm:acc': return `${base(this.arg(e, 'm:e'))}${val(e.child('m:accPr'), 'm:chr') ?? '̂'}`;
      case 'm:bar': return `${base(this.arg(e, 'm:e'))}̄`;
      case 'm:func': {
        const name = this.arg(e, 'm:fName').trim();
        const body = this.kids(e.child('m:e') ?? e);
        return body && e.child('m:e') ? `${name} ${body}` : name;
      }
      case 'm:limLow': return `${this.arg(e, 'm:e')}_${group(this.arg(e, 'm:lim'))}`;
      case 'm:limUpp': return `${base(this.arg(e, 'm:e'))}^${group(this.arg(e, 'm:lim'))}`;
      case 'm:oMathPara': return e.children('m:oMath').map(x => this.el(x)).join(' ');
      case 'm:oMathParaPr': case 'm:rPr': case 'w:rPr': case 'm:ctrlPr': return '';
      default: return e.elList().length ? this.kids(e) : '';
    }
  }
}

/** The linear text of an OMML element (`m:oMath`, or `m:oMathPara`), on docx-read.mjs's element tree. */
export function ommlToLinear(el) {
  let s = '';
  try { s = new Reader().el(el); } catch { s = ''; }
  return s.replace(/\s+/g, ' ').trim();
}

/** The justification (`m:jc`) of an `m:oMathPara`, or null. */
export const ommlJustification = el => val(el.child?.('m:oMathParaPr'), 'm:jc');
