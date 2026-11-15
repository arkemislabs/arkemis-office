// Error Checking Options: how many errors you chose to ignore and Reset Ignored Errors (the dialog's OK button runs it). Excel's other settings (which formula
// problems are flagged) have no setting here. Not in gridcraft: not checked against upstream.

import type {DialogState} from '../../../shell/dialogs/dialogState';

function Body({dialog: d}: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const ignored = (d.values.ignored ?? []) as string[];
  return <div className="gd-fields" data-error-options>
    <p className="sf-note" style={{margin: 0}}>Errors found by Error Checking are shown in the order of the workbook. Errors you ignore are not shown again.</p>
    <dl className="data-facts"><dt>Ignored errors</dt><dd>{ignored.length ? `${ignored.length}: ${ignored.slice(0, 6).join(', ')}${ignored.length > 6 ? ', ...' : ''}` : 'None'}</dd></dl>
    <small className="sf-note">Reset Ignored Errors makes every one of them show up again.</small>
  </div>;
}

export default {Body};
