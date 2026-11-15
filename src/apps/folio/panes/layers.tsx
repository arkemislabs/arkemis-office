// The Layers panel (spec pane `layers`; printcraft crates/ui-egui/src/panels/right.rs RightPanel::Layers at 8f16855): the document's layers, an eye and a name
// each; a click shows or hides the layer (layers.set). Reads through layers.read.

import type {ReactElement} from 'react';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {useRead} from './_read';
import './fields.css';

export default function LayersPane(_: PaneProps): ReactElement {
  const {data, controller} = useRead<{layers: {id: string; name: string; visible: boolean}[]}>('layers.read');
  const layers = data?.layers ?? [];
  return <div className="ff-pane" data-testid="layers-pane">
    <div className="ff-head"><span className="ff-count">{layers.length} {layers.length === 1 ? 'layer' : 'layers'}</span></div>
    <div className="ff-list" role="list" aria-label="Layers">
      {layers.map(l => <button key={l.id} type="button" role="listitem" aria-pressed={l.visible} className={`ff-row${l.visible ? '' : ' is-off'}`} data-layer={l.id}
        data-tip={l.visible ? 'Hide layer' : 'Show layer'} onClick={() => void controller.run('layers.set', {id: l.id, visible: !l.visible}, {origin: 'ui'})}>
        <span className="ff-kind"><Icon id={l.visible ? 'eye' : 'eye-off'} size={16}/></span>
        <span className="ff-main"><b className="ff-name" title={l.name}>{l.name}</b><small>{l.visible ? 'Shown' : 'Hidden'}</small></span>
        <span className="ff-action" aria-hidden="true">{l.visible ? 'Hide' : 'Show'}</span>
      </button>)}
      {data && !layers.length ? <div className="shell-pane-empty">This document has no layers.</div> : null}
    </div>
  </div>;
}
