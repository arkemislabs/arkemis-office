// The SmartArt Text Pane: the selected graphic's outline as bullet rows. Typing changes a node (when the row is left or Enter is
// pressed), Enter adds a node after, Tab and Shift+Tab demote and promote, Backspace on an empty row removes it.
// Translated from deckcraft crates/ui-egui/src/panels/smartart.rs at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Icon} from '../../../shell/icons/Icon';
import {selectedShapeIds, currentSlideId, slideById} from '../../../../core/prism/model/doc.mjs';
import {findShape} from '../../../../core/prism/model/presentation.mjs';
import {syncText} from '../../../../core/prism/lib/smartart.mjs';
import './review.css';

type Any = any;

/** The SmartArt group a shape is, or is inside. */
function diagramGroup(shapes: Any[] | undefined, id: string): Any {
  for (const sh of shapes ?? []) {
    if (sh.diagram && (sh.id === id || findShape(sh.kind?.children, id))) return sh;
    if (sh.kind?.type === 'group') { const g = diagramGroup(sh.kind.children, id); if (g) return g; }
  }
  return null;
}

export default function SmartArtPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [draft, setDraft] = useState<{index: number; text: string} | null>(null);
  const graphic: Any = useMemo((): Any => {
    try {
      const d: Any = session.get(docId);
      const sl = slideById(d.file.content, currentSlideId(d.file.content, d.selection));
      const g: Any = selectedShapeIds(d.file.content, d.selection).map((id: string) => diagramGroup(sl?.shapes, id)).find(Boolean) ?? null;
      // Text typed straight into a diagram shape shows here as well.
      return g ? {...g, diagram: {...g.diagram, nodes: syncText(g.diagram, g.kind?.children)}} : null;
    } catch { return null; }
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (command: string, params: Any) => controller.run(command, {id: graphic?.id, ...params}, {origin: 'ui'}).catch(fail);
  if (!graphic) return <div className="rv"><small className="rv-empty">Select a SmartArt graphic to edit its text here.</small></div>;
  const nodes: Any[] = graphic.diagram.nodes;
  const commit = (index: number) => {
    if (draft && draft.index === index && draft.text !== nodes[index]?.text) void run('smartArt.setNodes', {index, text: draft.text});
    setDraft(null);
  };
  const key = (e: React.KeyboardEvent, index: number) => {
    const text = draft?.index === index ? draft.text : nodes[index].text;
    if (e.key === 'Enter') { e.preventDefault(); commit(index); void run('smartArt.addNode', {index, position: 'after'}); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(index); void run(e.shiftKey ? 'smartArt.promote' : 'smartArt.demote', {index}); }
    else if (e.key === 'Backspace' && text === '' && nodes.length > 1) { e.preventDefault(); void run('smartArt.removeNode', {index}); }
  };
  return <div className="rv" data-pane="smartart">
    <small className="rv-faint">Type your text here</small>
    <ul style={{listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4}}>
      {nodes.map((n, i) => <li key={i} style={{display: 'flex', alignItems: 'center', gap: 6, paddingLeft: n.level * 18}}>
        <span aria-hidden="true" style={{color: 'var(--sh-text-3, #85858c)'}}>•</span>
        <input className="rv-input" aria-label={`Node ${i + 1}`} value={draft?.index === i ? draft.text : n.text}
          onFocus={() => setDraft({index: i, text: n.text})} onChange={e => setDraft({index: i, text: e.target.value})} onBlur={() => commit(i)} onKeyDown={e => key(e, i)}/>
      </li>)}
    </ul>
    <div className="rv-bar">
      <button type="button" className="sf-button rv-small rv-icon" title="Add" aria-label="Add" onClick={() => void run('smartArt.addNode', {position: 'after'})}><Icon id="plus" size={16}/></button>
      <button type="button" className="sf-button rv-small rv-icon" title="Remove" aria-label="Remove" disabled={nodes.length < 2} onClick={() => void run('smartArt.removeNode', {index: nodes.length - 1})}><Icon id="trash" size={16}/></button>
    </div>
  </div>;
}
