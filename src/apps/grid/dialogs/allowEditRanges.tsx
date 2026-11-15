// Allow Edit Ranges as Excel draws it: the ranges that stay editable on a protected sheet in a list with New,
// Modify, Delete and Unlock (for a range with a password), Protect Sheet, and the title, the cells and the password
// of the range being added or changed. gridcraft's form over `review.allowEditRanges`
// (crates/ui-egui/src/dialogs.rs) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {fromKernelSelection} from '../../../../core/grid/model/workbook.mjs';
import {editRangeList} from '../../../../core/grid/commands/review.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, Rows, type SetValue} from './dataKit';

interface Row { title: string; range: string; password: boolean; unlocked: boolean }

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const list = (d.values.ranges ?? []) as Row[];
  const selected = Math.min(Number(d.values.selected ?? -1), list.length - 1);
  const row = list[selected];
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');

  // The list follows the sheet: New, Modify and Delete change it from here.
  useEffect(() => session.subscribe((ev: {type?: string}) => {
    if (ev?.type !== 'doc.changed' && ev?.type !== 'view.changed') return;
    try {
      const doc = (session as any).get(docId);
      const content = doc.file.content;
      const si = fromKernelSelection(content, doc.selection).sheet;
      const next = editRangeList({...doc, doc: content, view: doc.view}, content.sheets[si]) as Row[];
      setValue('ranges', next);
      setValue('selected', Math.min(Number(d.values.selected ?? 0), next.length - 1));
    } catch { /* the document is gone */ }
  }), [session, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (params: Record<string, unknown>) => controller.run('review.allowEditRanges', params, {origin: 'dialog'}).catch(fail);
  const title = String(d.values.title ?? '').trim();
  const range = String(d.values.range ?? '').trim();
  const password = String(d.values.password ?? '');
  return <div className="gd-fields">
    <div className="data-scenarios">
      <div className="sf" data-field-id="ranges" data-kind="list">
        <span className="sf-label">Ranges unlocked by a password when sheet is protected:</span>
        <Rows label="Edit ranges" items={list.map(r => `${r.title}: ${r.range}${r.password ? (r.unlocked ? ' (password, unlocked)' : ' (password)') : ''}`)} selected={selected}
          onPick={i => { setValue('selected', i); setValue('newTitle', ''); }} height={130} empty="No ranges yet."/>
      </div>
      <div className="gd-buttons" role="group" aria-label="Range actions">
        <Btn onClick={() => void run({action: 'add', title, range, password}).then(() => { setValue('title', ''); setValue('password', ''); })}>New{'…'}</Btn>
        <Btn disabled={!row} onClick={() => void run({action: 'modify', title: row.title, newTitle: String(d.values.newTitle ?? ''), range, password: d.values.removePassword ? '' : password || undefined})}>Modify{'…'}</Btn>
        <Btn disabled={!row} onClick={() => void run({action: 'delete', title: row.title})}>Delete</Btn>
        <Btn disabled={!row || !row.password || row.unlocked} onClick={() => void run({action: 'unlock', title: row.title, password})}>Unlock</Btn>
      </div>
    </div>
    <Fld d={d} set={setValue} id="title" label="Title (for New):" kind="text"/>
    <Fld d={d} set={setValue} id="range" label="Refers to cells:" kind="text"/>
    <Fld d={d} set={setValue} id="password" label="Range password (blank for none; also for Unlock):" kind="text" masked/>
    <Fld d={d} set={setValue} id="newTitle" label="New title (for Modify):" kind="text" hidden={!row}/>
    <Fld d={d} set={setValue} id="removePassword" label="Remove the password (Modify)" kind="checkbox" hidden={!row}/>
    <div className="gd-buttons"><Btn onClick={() => { try { controller.openDialog('dialog.protectSheet', {parent: d.key}); } catch (e) { fail(e); } }}>Protect Sheet{'…'}</Btn></div>
  </div>;
}

export default {Body};
