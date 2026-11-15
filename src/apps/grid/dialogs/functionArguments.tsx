// Function Arguments as Excel draws it: the function's name over one box per argument (bold when
// required), each with "= value" beside it; more boxes appear as repeating arguments are filled;
// under them the function's description, the help of the argument being edited, and
// "Formula result =". OK enters the formula in the active cell.
// Values come from the engine (core/grid/model/calc.mjs `evaluate`, gridcraft
// crates/calc/src/recalc.rs `evaluate_expr`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {functionInfo, signatureArgs} from '../../../../core/grid/lib/formulas-catalog.mjs';
import {engineFor} from '../../../../core/grid/model/calc.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {display} from '../../../../core/grid/lib/value.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

const MAX_ARGS = 255;

/** What a value looks like after "=" in the dialog ({1;2;3} for arrays, "text" quoted). */
function shown(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return `"${v}"`;
  const arr = v as {rows?: number; cols?: number; get?: (r: number, c: number) => unknown};
  if (arr && typeof arr.get === 'function' && arr.rows && arr.cols) {
    const rows: string[] = [];
    for (let r = 0; r < Math.min(arr.rows, 20); r++) {
      const row: string[] = [];
      for (let c = 0; c < Math.min(arr.cols, 20); c++) row.push(shown(arr.get(r, c)));
      rows.push(row.join(','));
    }
    return `{${rows.join(';')}${arr.rows > 20 || arr.cols > 20 ? '…' : ''}}`;
  }
  return display(v as never);
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  useSessionTick();
  const info = functionInfo(d.values.function);
  const sig = useMemo(() => signatureArgs(info?.signature ?? ''), [info]);
  const args = (Array.isArray(d.values.args) ? d.values.args : []).map(a => String(a ?? ''));
  const focus = Number(d.values.focus ?? 0);
  // Boxes: every declared argument; a repeating one adds a box once the last is filled.
  const boxes: {name: string; optional: boolean}[] = [];
  sig.forEach((a, i) => {
    boxes.push({name: a.name, optional: a.optional});
    if (a.repeat && i === sig.length - 1) {
      const base = a.name.replace(/\d+$/, '');
      const first = Number(/\d+$/.exec(a.name)?.[0] ?? 1);
      for (let k = 1; boxes.length < MAX_ARGS && (args[boxes.length - 1] ?? '') !== ''; k++) boxes.push({name: `${base}${first + k}`, optional: true});
    }
  });
  while (boxes.length < args.length) boxes.push({name: `argument${boxes.length + 1}`, optional: true});
  const ctx = controller.session.readContext(controller.docId) as {doc: any; selection: any};
  const sel = fromKernelSelection(ctx.doc, ctx.selection);
  const evaluate = (text: string) => {
    if (!text.trim()) return null;
    try { return engineFor(ctx.doc).evaluate(sel.sheet, sel.active, text); } catch { return null; }
  };
  let n = args.length;
  while (n > 0 && !args[n - 1].trim()) n--;
  const formula = info ? `${info.name}(${args.slice(0, n).map(a => a.trim()).join(',')})` : '';
  const result = info && sig.filter(a => !a.optional).every((_, i) => (args[i] ?? '').trim()) ? evaluate(formula) : null;
  const setArg = (i: number, text: string) => {
    const next = [...args];
    while (next.length <= i) next.push('');
    next[i] = text;
    setValue('args', next);
  };
  return <div className="gd-fields grid-fa">
    <fieldset className="grid-fa-box" data-field-id="args">
      <legend>{info?.name ?? ''}</legend>
      <div className="grid-fa-rows">
        {boxes.slice(0, Math.max(boxes.length, 1)).map((b, i) => <div key={i} className="grid-fa-row">
          <label htmlFor={`grid-fa-${i}`} className={b.optional ? 'grid-fa-opt' : 'grid-fa-req'}>{b.name}</label>
          <input id={`grid-fa-${i}`} className="sf-text" type="text" spellCheck={false} value={args[i] ?? ''} {...(i === 0 ? {'data-autofocus': true} : {})}
            onFocus={() => setValue('focus', i)} onChange={e => setArg(i, e.target.value)}/>
          <span className="grid-fa-val">{(args[i] ?? '').trim() ? `= ${shown(evaluate(args[i]))}` : ''}</span>
        </div>)}
      </div>
    </fieldset>
    <div className="grid-fa-val grid-fa-total">{result !== null ? `= ${shown(result)}` : ''}</div>
    <p className="grid-fa-desc" data-field-id="description">{info?.description ?? ''}</p>
    <p className="grid-fa-arg"><strong>{boxes[focus]?.name ?? ''}</strong></p>
    <div className="grid-fa-result" data-field-id="result">Formula result = {result !== null ? shown(result) : ''}</div>
  </div>;
}

export default {Body};
