// Check Accessibility as Excel's Accessibility Checker draws it: the issues found, each with the sheet and the
// object it is on; a click goes to the sheet. gridcraft's `review.checkAccessibility`
// (crates/engine/src/cmd/review.rs `accessibility`) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Rows} from './dataKit';

type Issue = {sheet: string; issue: string; object?: string; count?: number};

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const {controller} = useEngine();
  const issues = (d.values.result ?? []) as Issue[];
  const selected = Number(d.values.selected ?? -1);
  const label = (i: Issue) => `${i.issue}${i.object ? `: ${i.object}` : ''}${i.count ? ` (${i.count})` : ''}, ${i.sheet}`;
  return <div className="gd-fields">
    {issues.length ? <div className="sf" data-field-id="results" data-kind="list">
      <span className="sf-label">Inspection Results ({issues.length})</span>
      <Rows label="Accessibility issues" items={issues.map(label)} selected={selected} height={180}
        onPick={i => { setValue('selected', i); void controller.run('sheet.activate', {sheet: issues[i].sheet}, {origin: 'dialog'}).catch(e => controller.notify(toCommandError(e).message, 'error')); }}/>
    </div> : <p data-field-id="result">No accessibility issues found. People with disabilities should not have difficulty reading this workbook.</p>}
  </div>;
}

export default {Body};
