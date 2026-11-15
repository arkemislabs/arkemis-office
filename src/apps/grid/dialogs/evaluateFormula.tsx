// Evaluate Formula as Excel draws it: Reference and Evaluation side by side, the part the next
// press evaluates underlined; Evaluate (Restart at the end) steps; the note under the box says
// what the next press does.
// Frames from core/grid/lib/formulas-evaluate.mjs (gridcraft crates/engine/src/cmd/formulas.rs
// `evaluate_formula`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {cellAt} from '../../../../core/grid/model/store.mjs';
import {parseCell, colToLetters, quoteSheet} from '../../../../core/grid/lib/addr.mjs';
import {evaluationFrames} from '../../../../core/grid/lib/formulas-evaluate.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

type Frame = {text: string; underline: [number, number] | null};
type Level = {frames: Frame[]; step: number; reference: string};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {session, docId} = useEngine();
  // Step In goes into the cell the underlined reference names, when it holds a formula; Step Out comes back.
  const [nested, setNested] = useState<Level[]>([]);
  const base: Level = {frames: (Array.isArray(d.values.frames) ? d.values.frames : []) as Frame[], step: Number(d.values.step ?? 0), reference: String(d.values.reference ?? '')};
  const level = nested.length ? nested[nested.length - 1] : base;
  const frames = level.frames;
  const step = Math.min(level.step, Math.max(0, frames.length - 1));
  const f = frames[step] ?? null;
  const last = !!f && step >= frames.length - 1;
  const setStep = (n: number) => { if (nested.length) setNested(nested.map((l, i) => (i === nested.length - 1 ? {...l, step: n} : l))); else setValue('step', n); };
  const under = f?.underline ? f.text.slice(f.underline[0], f.underline[1]) : '';
  // The cell a Step In would go into: a single reference (maybe with a sheet) to a cell with a formula.
  const target = (() => {
    const m = /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(under.trim());
    if (!m) return null;
    try {
      const content = (session.get(docId) as any).file.content;
      const name = (m[1] ? m[1].replace(/''/g, "'") : m[2]) ?? null;
      const si = name === null ? content.sheets.findIndex((x: any) => x.name === String(base.reference).replace(/!.*$/, '').replace(/^'(.*)'$/, '$1').replace(/''/g, "'")) : content.sheets.findIndex((x: any) => x.name.toLowerCase() === name.toLowerCase());
      const at = parseCell(m[3] + m[4]);
      const c = si >= 0 && at ? cellAt(content.sheets[si], at.row, at.col) : null;
      if (!at || !c || c.f === undefined) return null;
      return {frames: evaluationFrames(content, si, at, c.f) as Frame[], reference: `${quoteSheet(content.sheets[si].name)}!$${colToLetters(at.col)}$${at.row + 1}`};
    } catch { return null; }
  })();
  const text = f ? (f.underline ? <>{f.text.slice(0, f.underline[0])}<u className="grid-ef-next">{under}</u>{f.text.slice(f.underline[1])}</> : f.text) : null;
  const stepIn = () => { if (target) setNested([...nested, {frames: target.frames, step: 0, reference: target.reference}]); };
  const stepOut = () => {
    // The inner formula is finished off and the outer one goes on past the reference.
    const rest = nested.slice(0, -1);
    const parent = rest.length ? rest[rest.length - 1] : base;
    const next = Math.min(parent.step + 1, Math.max(0, parent.frames.length - 1));
    if (rest.length) setNested(rest.map((l, i) => (i === rest.length - 1 ? {...l, step: next} : l))); else { setNested([]); setValue('step', next); }
  };
  return <div className="gd-fields grid-ef">
    <div className="grid-ef-cols">
      <div className="grid-ef-ref" data-field-id="reference"><span className="sf-label">Reference:</span><div className="grid-ef-box">{level.reference}</div></div>
      <div className="grid-ef-eval" data-field-id="evaluation"><span className="sf-label">Evaluation:</span>
        <div className="grid-ef-box grid-ef-formula" aria-live="polite">{text ?? String(d.values.message ?? '')}</div>
      </div>
    </div>
    <p className="grid-ef-note">{f ? (last ? 'The formula is now fully evaluated. To start over, press Restart.' : 'To show the result of the underlined expression, click Evaluate. The most recent result appears italicized.') : ''}</p>
    <div className="gd-buttons grid-ef-buttons">
      <button type="button" className="gd-button" data-field-id="stepIn" disabled={!target || last} onClick={stepIn}>Step In</button>
      <button type="button" className="gd-button" data-field-id="stepOut" disabled={!nested.length} onClick={stepOut}>Step Out</button>
      <button type="button" className="gd-button gd-primary" data-field-id="evaluate" data-autofocus disabled={!f}
        onClick={() => setStep(last ? 0 : step + 1)}>{last ? 'Restart' : 'Evaluate'}</button>
    </div>
  </div>;
}

export default {Body};
