// Scenario Manager as Excel draws it: the scenarios of the sheet in a list with Add, Delete, Edit,
// Summary and Show, and the changing cells and comment of the one picked.
// Excel's dialog over gridcraft's cmd/whatif/scenarios.rs at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {sheetScenarios} from '../../../../core/grid/dialogs/scenarioManager.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Rows, type SetValue} from './dataKit';

interface Scenario { name: string; sheet: string; changing: string; values: unknown[]; comment?: string }

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const list = (d.values.scenarios ?? []) as Scenario[];
  const selected = Math.min(Number(d.values.selected ?? -1), list.length - 1);
  const sc = list[selected];
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');

  // The list follows the workbook: Add, Edit and Delete change it from here or from a nested dialog.
  useEffect(() => session.subscribe((ev: {type?: string; doc?: string}) => {
    if (ev?.type !== 'doc.changed') return;
    try {
      const doc = (session as any).get(docId);
      const next = sheetScenarios(doc.file.content, fromKernelSelection(doc.file.content, doc.selection).sheet) as Scenario[];
      setValue('scenarios', next);
      setValue('selected', Math.min(Number(d.values.selected ?? 0), next.length - 1));
    } catch { /* the document is gone */ }
  }), [session, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string, init?: Record<string, unknown>) => { try { controller.openDialog(id, {parent: d.key, init}); } catch (e) { fail(e); } };
  return <div className="gd-fields">
    <div className="data-scenarios">
      <div className="sf" data-field-id="scenarios" data-kind="list">
        <span className="sf-label">Scenarios:</span>
        <Rows label="Scenarios" items={list.map(x => x.name)} selected={selected} onPick={i => setValue('selected', i)} height={170}
          empty={'No Scenarios defined. Choose Add to add scenarios.'} onDouble={i => { setValue('selected', i); void controller.run('data.scenarioShow', {name: list[i].name}).catch(fail); }}/>
      </div>
      <div className="gd-buttons" role="group" aria-label="Scenario actions">
        <Btn onClick={() => open('dialog.addScenario')}>Add{'…'}</Btn>
        <Btn disabled={!sc} onClick={() => void controller.run('data.scenarioDelete', {name: sc.name}).catch(fail)}>Delete</Btn>
        <Btn disabled={!sc} onClick={() => open('dialog.addScenario', {name: sc.name, changing: sc.changing, comment: sc.comment ?? '', vals: sc.values.map(v => (v === null || v === undefined ? '' : String(v))), edit: sc.name})}>Edit{'…'}</Btn>
        <Btn disabled={!list.length} onClick={() => open('dialog.scenarioSummary')}>Summary{'…'}</Btn>
        <Btn disabled={!sc} onClick={() => void controller.run('data.scenarioShow', {name: sc.name}).catch(fail)}>Show</Btn>
      </div>
    </div>
    <dl className="data-facts">
      <dt>Changing cells:</dt><dd>{sc ? sc.changing : ''}</dd>
      <dt>Comment:</dt><dd>{sc ? sc.comment : ''}</dd>
    </dl>
  </div>;
}

export default {Body};
