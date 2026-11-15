// Error Checking as Excel draws it: "Error in cell Sheet1!A3", the formula, the error's title and
// what it means on the left; Show Calculation Steps… and Edit in Formula Bar on the right;
// Previous / Next walk the cells with errors (selecting each); Circular references are listed
// after the errors. "The error check is complete for the entire sheet." when there is none.
// The list is gridcraft's `formulas.errorChecking` (crates/engine/src/cmd/formulas.rs:772) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {useState} from 'react';
import {ERROR_HELP, ERROR_FIX} from '../../../../core/grid/dialogs/errorChecking.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import './insertFunction.css';

type Hit = {sheet: string; cell: string; error: string; formula: string | null};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const [help, setHelp] = useState(false);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const result = (d.values.result ?? {errors: [], circular: []}) as {errors: Hit[]; circular: string[]};
  const hits: Hit[] = [...result.errors, ...result.circular.map(ref => {
    const i = ref.lastIndexOf('!');
    return {sheet: ref.slice(0, i).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"), cell: ref.slice(i + 1), error: '#CIRC!', formula: null};
  })];
  const index = Math.min(Number(d.values.index ?? 0), Math.max(0, hits.length - 1));
  const hit = hits[index] ?? null;
  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    setValue('index', i);
    void controller.run('selection.set', {range: h.cell, sheet: h.sheet}, {origin: 'dialog'}).catch(fail);
  };
  const ignore = async () => {
    if (!hit) return;
    try {
      await controller.run('formulas.ignoreError', {cell: `${hit.sheet.includes(' ') ? `'${hit.sheet}'` : hit.sheet}!${hit.cell}`}, {origin: 'dialog'});
      const r: any = await session.execute(docId, 'formulas.errorChecking', {}, {origin: 'ui'});
      setValue('result', r?.result ?? {errors: [], circular: []});
      const next = Math.min(index, Math.max(0, ((r?.result?.errors?.length ?? 0) + (r?.result?.circular?.length ?? 0)) - 1));
      setValue('index', next);
      setHelp(false);
    } catch (e) { fail(e); }
  };
  if (!hit) return <div className="gd-fields grid-ec"><p className="grid-ec-done">The error check is complete for the entire sheet.</p></div>;
  const [title, help_] = ERROR_HELP[hit.error as keyof typeof ERROR_HELP] ?? ['Error', ''];
  const ref = `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(hit.sheet) ? hit.sheet : `'${hit.sheet.replace(/'/g, "''")}'`}!${hit.cell}`;
  return <div className="gd-fields grid-ec">
    <div className="grid-ec-main" data-field-id="cell">
      <div className="grid-ec-where">Error in cell {ref}</div>
      <div className="grid-ec-formula">{hit.formula ?? ''}</div>
      <div className="grid-ec-title" data-field-id="message">{title}</div>
      <p className="grid-ec-help">{help_}</p>
      {help ? <p className="grid-ec-help" data-field-id="helpText">{ERROR_FIX[hit.error as keyof typeof ERROR_FIX] ?? 'Check the formula and the cells it refers to.'}</p> : null}
    </div>
    <div className="grid-ec-side">
      <button type="button" className="gd-button" data-field-id="help" aria-pressed={help} onClick={() => setHelp(!help)}>Help on this Error</button>
      <button type="button" className="gd-button" data-field-id="steps" disabled={!hit.formula} onClick={() => {
        void controller.run('selection.set', {range: hit.cell, sheet: hit.sheet}, {origin: 'dialog'}).then(() => {
          try { controller.openDialog('dialog.evaluateFormula', {parent: d.key}); } catch (e) { fail(e); }
        }).catch(fail);
      }}>Show Calculation Steps…</button>
      <button type="button" className="gd-button" data-field-id="ignore" onClick={() => void ignore()}>Ignore Error</button>
      <button type="button" className="gd-button" data-field-id="edit" onClick={() => {
        void controller.run('selection.set', {range: hit.cell, sheet: hit.sheet}, {origin: 'dialog'}).then(() => controller.cancelDialog(d.key)).catch(fail);
      }}>Edit in Formula Bar</button>
      <button type="button" className="gd-button" data-field-id="options" onClick={() => { try { controller.openDialog('dialog.errorCheckingOptions', {parent: d.key}); } catch (e) { fail(e); } }}>Options{'…'}</button>
      <span className="grid-ec-spacer"/>
      <div className="grid-ec-nav">
        <button type="button" className="gd-button" data-field-id="previous" disabled={index <= 0} onClick={() => go(index - 1)}>Previous</button>
        <button type="button" className="gd-button" data-field-id="next" disabled={index >= hits.length - 1} onClick={() => go(index + 1)}>Next</button>
      </div>
    </div>
  </div>;
}

export default {Body};
