// The Attachments panel (spec pane `attachments`; printcraft crates/ui-egui/src/panels/right.rs RightPanel::Attachments at 8f16855): the files attached to the
// document and to its comments, each with its size, the page it is on and its description; Save attachment… on each, and delete for those of the
// document itself. Attach a file is Edit's (edit.attach).

import type {ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import {useRead} from './_read';
import './fields.css';

const size = (n: number | null) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

export default function AttachmentsPane(_: PaneProps): ReactElement {
  const {data, content, controller} = useRead<{attachments: any[]}>('attachments.read');
  const list = data?.attachments ?? [];
  const run = (id: string, args: Record<string, unknown>) => void controller.run(id, args, {origin: 'ui'});
  return <div className="ff-pane" data-testid="attachments-pane">
    <div className="ff-head"><span className="ff-count">{list.length} {list.length === 1 ? 'attachment' : 'attachments'}</span><span className="ff-spacer"/>
      <button type="button" className="ff-action" data-tip="Attach a file to the document" onClick={() => run('edit.attach', {})}><Icon id="plus" size={16}/>Add</button></div>
    <div className="ff-list" role="list" aria-label="Attachments">
      {list.map(a => {
        const meta = [size(a.size), a.source.kind === 'annotation' ? `on page ${pageLabel(content, a.source.page)}` : '', a.description ?? ''].filter(Boolean).join('  ·  ');
        return <div key={a.key} role="listitem" className="ff-row" data-attachment={a.key}>
          <span className="ff-kind"><Icon id="paperclip" size={16}/></span>
          <span className="ff-main"><b className="ff-name" title={a.name}>{a.name}</b><small>{meta}</small></span>
          <span className="ff-actions">
            <button type="button" className="ff-action" aria-label={`Save ${a.name}`} data-tip="Save attachment…" onClick={() => run('attachments.save', {key: a.key})}><Icon id="file-down" size={16}/>Save</button>
            {a.source.kind === 'document' ? <button type="button" className="ff-action is-danger" aria-label={`Delete ${a.name}`} data-tip="Delete attachment" onClick={() => run('attachments.delete', {key: a.key})}><Icon id="trash-2" size={16}/>Delete</button> : null}
          </span>
        </div>;
      })}
      {data && !list.length ? <div className="shell-pane-empty">This document has no attachments.</div> : null}
    </div>
  </div>;
}
