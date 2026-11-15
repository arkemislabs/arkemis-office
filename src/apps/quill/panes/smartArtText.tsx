// The SmartArt Text Pane (SmartArt Design › Text Pane): the selected graphic's items as bullet rows, one line per item. Typing changes an
// item (when the row is left or Enter is pressed), Enter adds an item after, Tab and Shift+Tab demote and promote, Backspace on an empty row
// removes it. Reads smartArt.outline and writes through smartArt.items, smartArt.addShape, smartArt.promote, smartArt.demote and
// smartArt.removeItem; the row the person is on is smartArt.focus, so Add Shape and the other ribbon buttons work on it.
// Shape of wordcraft's pane (dialogs_smart_art.rs: one line per item, Enter adds an item, Add, Promote, Demote, Remove) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Icon} from '../../../shell/icons/Icon';

type Any = any;

export default function SmartArtTextPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [outline, setOutline] = useState<Any>(null);
  const [draft, setDraft] = useState<{index: number; text: string} | null>(null);
  useEffect(() => {
    let live = true;
    session.execute(docId, 'smartArt.outline', {}, {origin: 'ui'}).then((r: Any) => { if (live) setOutline(r.result); }).catch(() => { if (live) setOutline(null); });
    return () => { live = false; };
  }, [session, docId, tick]);
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (command: string, params: Any = {}) => controller.run(command, params, {origin: 'ui'}).catch(fail);
  if (!outline) return <div className="quill-smartart-pane"><small>Select a SmartArt graphic to edit its text here.</small></div>;
  const items: Any[] = outline.items;
  const commit = (index: number) => {
    if (draft && draft.index === index && draft.text !== items[index]?.text) {
      void run('smartArt.items', {items: items.map((it, i) => ({...it, text: i === index ? draft.text : it.text}))});
    }
    setDraft(null);
  };
  const key = (e: React.KeyboardEvent, index: number) => {
    const text = draft?.index === index ? draft.text : items[index].text;
    if (e.key === 'Enter') { e.preventDefault(); commit(index); void run('smartArt.addShape', {index, position: 'after'}); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(index); void run(e.shiftKey ? 'smartArt.promote' : 'smartArt.demote', {index}); }
    else if (e.key === 'Backspace' && text === '' && items.length > 1) { e.preventDefault(); void run('smartArt.removeItem', {index}); }
  };
  return <div className="quill-smartart-pane" data-pane="smartArtText" style={{display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0}}>
    <small>Type your text here</small>
    <ul style={{listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto'}}>
      {items.map((n, i) => <li key={i} style={{display: 'flex', alignItems: 'center', gap: 6, paddingLeft: n.level * 18}}>
        <span aria-hidden="true">{'\u2022'}</span>
        <input className="sf-text" aria-label={`Item ${i + 1}`} style={{flex: 1, minWidth: 0}} value={draft?.index === i ? draft.text : n.text}
          onFocus={() => { setDraft({index: i, text: n.text}); void run('smartArt.focus', {index: i}); }} onChange={e => setDraft({index: i, text: e.target.value})}
          onBlur={() => commit(i)} onKeyDown={e => key(e, i)}/>
      </li>)}
    </ul>
    <div style={{display: 'flex', gap: 6}}>
      <button type="button" className="sf-button" title="Add" aria-label="Add" onClick={() => void run('smartArt.addShape', {index: outline.active, position: 'after'})}><Icon id="plus" size={16}/></button>
      <button type="button" className="sf-button" title="Remove" aria-label="Remove" disabled={items.length < 2} onClick={() => void run('smartArt.removeItem', {index: outline.active})}><Icon id="trash" size={16}/></button>
    </div>
  </div>;
}
