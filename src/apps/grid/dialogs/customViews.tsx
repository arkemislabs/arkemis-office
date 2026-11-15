// Custom Views as Excel draws it: the saved views in a list, with Show, Add (under the name typed) and Delete.
// Excel's dialog over gridcraft's `view.customViews` (crates/engine/src/cmd/extra/window.rs) at fb1e59f.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {viewNames} from '../../../../core/grid/dialogs/customViews.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Rows, type SetValue} from './dataKit';

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller, session, docId} = useEngine();
  const list = (d.values.views ?? []) as string[];
  const selected = Math.min(Number(d.values.selected ?? -1), list.length - 1);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');

  // The list follows the workbook: Add and Delete change it from here.
  useEffect(() => session.subscribe((ev: {type?: string}) => {
    if (ev?.type !== 'doc.changed') return;
    try {
      const next = viewNames((session as any).get(docId).file.content);
      setValue('views', next);
      setValue('hasViews', next.length > 0);
      setValue('selected', Math.min(Number(d.values.selected ?? 0), next.length - 1));
    } catch { /* the document is gone */ }
  }), [session, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="gd-fields">
    <div className="data-scenarios">
      <div className="sf" data-field-id="views" data-kind="list">
        <span className="sf-label">Views:</span>
        <Rows label="Views" items={list} selected={selected} onPick={i => setValue('selected', i)} height={150} empty="No custom views yet."
          onDouble={i => { setValue('selected', i); void controller.run('view.customViews', {show: list[i]}).catch(fail); }}/>
      </div>
      <div className="gd-buttons" role="group" aria-label="View actions">
        <Btn onClick={() => { try { controller.openDialog('dialog.addView', {parent: d.key}); } catch (e) { fail(e); } }}>Add{'…'}</Btn>
        <Btn disabled={selected < 0} onClick={() => void controller.run('view.customViews', {delete: list[selected]}).catch(fail)}>Delete</Btn>
      </div>
    </div>
  </div>;
}

export default {Body};
