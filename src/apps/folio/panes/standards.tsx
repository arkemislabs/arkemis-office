// The Standards panel (spec pane `standards`; printcraft crates/ui-egui/src/dialogs/standards_ui.rs declared()): the standards the document declares in its XMP metadata
// (PDF/A, PDF/UA) and its output intents, with the checks one click away (PDF/A, PDF/UA, PDF/X, Preflight). Declaring a standard is the file's claim, not a verdict.
import type {ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {useRead} from './_read';
import './fields.css';
import './accessibility.css';

export default function StandardsPane(_: PaneProps): ReactElement {
  const {data, controller} = useRead<{declared: string[]; outputIntents: string[]}>('standards.read');
  const open = (id: string, args: Record<string, unknown> = {}) => { try { controller.openDialog(id, {args}); } catch { /* the dialog is not available */ } };
  return <div className="ff-pane" data-testid="standards-pane">
    <div className="ff-head"><span className="ff-count">Standards</span></div>
    <div className="sd-block"><h4>Declared in the file</h4>
      <p data-testid="declared">{data ? (data.declared.length ? data.declared.join(', ') : 'No standard is declared.') : '…'}</p>
      {data?.outputIntents.length ? <p>Output intent: {data.outputIntents.join(', ')}</p> : null}
      <small className="sd-unverified">A declared standard is what the file says about itself. It was not verified by reading it.</small></div>
    <div className="ff-foot">
      <button type="button" className="ff-action" onClick={() => open('dialog.pdfa')}><Icon id="shield-check" size={16}/>Verify PDF/A</button>
      <button type="button" className="ff-action" onClick={() => open('dialog.preflight', {profile: 'pdfua-1'})}><Icon id="accessibility" size={16}/>Check PDF/UA</button>
      <button type="button" className="ff-action" onClick={() => open('dialog.preflight', {profile: 'pdfx-4'})}><Icon id="checklist" size={16}/>Check PDF/X</button>
      <button type="button" className="ff-action" onClick={() => open('dialog.preflight')}><Icon id="list-checks" size={16}/>Preflight</button>
    </div>
  </div>;
}
