// The Insert Zoom dialogs' checklist: the slides (or sections) of the presentation as "N. title", Select All and Select None
// (deckcraft ribbon/view.rs, the Zoom popup).

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Icon} from '../../../shell/icons/Icon';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {SlideView} from './SlideView';

type Any = any;

export function ZoomList({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {session, docId} = useEngine();
  const deck = (() => { try { return (session as Any).get(docId).file.content; } catch { return null; } })();
  const list: Any[] = Array.isArray(d.values.list) ? (d.values.list as Any[]) : [];
  const picked: number[] = Array.isArray(d.values.picked) ? (d.values.picked as number[]) : [];
  const section = d.values.kind === 'section';
  const toggle = (i: number) => setValue('picked', picked.includes(i) ? picked.filter(x => x !== i) : [...picked, i]);
  const error = d.errors.find(e => e.field === 'targets')?.message ?? null;
  return <div data-field-id="targets" style={{display: 'flex', flexDirection: 'column', gap: 10, width: 380, maxWidth: '100%', font: '12px var(--ark-font, system-ui)', color: 'var(--sh-text-1, #f2f2f3)'}}>
    <div style={{maxHeight: 300, overflow: 'auto', borderRadius: 8, background: 'rgba(0,0,0,.28)', padding: 6}} role="group" aria-label={section ? 'Sections' : 'Slides'}>
      {list.map(x => <label key={x.index} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px'}}>
        <input type="checkbox" checked={picked.includes(x.index)} onChange={() => toggle(x.index)}/>
        {!section && deck?.slides?.[x.index] ? <span className="prism-zoom-thumb"><SlideView content={deck} slide={deck.slides[x.index]}/></span> : null}
        <span>{`${x.index + 1}. ${String(x.title || '').trim() || (section ? 'Section' : '(no title)')}`}</span>
      </label>)}
      {!list.length ? <span style={{color: 'var(--sh-text-3, #85858c)'}}>{section ? 'The presentation has no sections. Add one with Home > Section.' : 'The presentation has no slides.'}</span> : null}
    </div>
    <div style={{display: 'flex', gap: 6}}>
      <button type="button" className="sf-button" style={{display: 'inline-flex', alignItems: 'center', gap: 6}} title="Select all" aria-label="Select all" disabled={!list.length} onClick={() => setValue('picked', list.map(x => x.index))}><Icon id="select-all" size={16}/> Select All</button>
      <button type="button" className="sf-button" style={{display: 'inline-flex', alignItems: 'center', gap: 6}} title="Select none" aria-label="Select none" disabled={!list.length} onClick={() => setValue('picked', [])}><Icon id="clear" size={16}/> Select None</button>
    </div>
    {error && list.length ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}
