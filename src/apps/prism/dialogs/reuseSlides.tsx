// Reuse Slides: Browse for a presentation, check its slides, and Keep source formatting (deckcraft dlg_reuse_slides).

import {useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Icon} from '../../../shell/icons/Icon';

type Any = any;

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {session, docId} = useEngine();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list: Any[] = Array.isArray(d.values.list) ? (d.values.list as Any[]) : [];
  const picked: number[] = Array.isArray(d.values.picked) ? (d.values.picked as number[]) : [];
  const browse = async () => {
    const studio = (window as Any).studio;
    if (!studio?.pickDocument) return;
    setBusy(true);
    setProblem(null);
    try {
      const doc = await studio.pickDocument();
      if (!doc) return;
      const out: Any = await (session as Any).execute(docId, 'slide.reuseList', {data: doc.data, name: doc.name});
      const slides: Any[] = out?.result?.slides ?? out?.slides ?? [];
      setValue('data', doc.data);
      setValue('name', doc.name);
      setValue('list', slides);
      setValue('picked', slides.map(x => x.index));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (i: number) => setValue('picked', picked.includes(i) ? picked.filter(x => x !== i) : [...picked, i]);
  const error = problem ?? d.errors.find(e => e.field === 'slides')?.message ?? null;
  return <div className="ru" data-field-id="slides" style={{display: 'flex', flexDirection: 'column', gap: 10, width: 440, maxWidth: '100%', font: '12px var(--ark-font, system-ui)', color: 'var(--sh-text-1, #f2f2f3)'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
      <button type="button" className="sf-button" title="Browse for a presentation" aria-label="Browse for a presentation" disabled={busy} onClick={browse} style={{display: 'inline-flex', alignItems: 'center', gap: 6}}><Icon id="folder" size={16}/> Browse…</button>
      <span style={{color: 'var(--sh-text-3, #85858c)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{d.values.name ? String(d.values.name) : 'No presentation chosen'}</span>
    </div>
    <div style={{height: 220, overflow: 'auto', borderRadius: 8, background: 'rgba(0,0,0,.28)', padding: 6}} role="group" aria-label="Slides">
      {list.map(x => <label key={x.index} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px'}}>
        <input type="checkbox" checked={picked.includes(x.index)} onChange={() => toggle(x.index)}/>
        <span>{`${x.index + 1}  ${String(x.title || '').trim() || '(no title)'}`}{x.hidden ? ' (hidden)' : ''}</span>
      </label>)}
      {!list.length ? <div data-reuse-empty style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', border: '1.5px dashed rgba(255,255,255,.18)', borderRadius: 8, color: 'var(--sh-text-3, #85858c)'}}>
        <Icon id="presentation" size={32}/>
        <span>No presentation open yet</span>
        <button type="button" className="sf-button" disabled={busy} onClick={browse} style={{display: 'inline-flex', alignItems: 'center', gap: 6}}><Icon id="folder" size={16}/> Browse for a presentation…</button>
      </div> : null}
    </div>
    <div style={{display: 'flex', gap: 6}}>
      <button type="button" className="sf-button" style={{display: 'inline-flex', alignItems: 'center', gap: 6}} title="Select all" aria-label="Select all" disabled={!list.length} onClick={() => setValue('picked', list.map(x => x.index))}><Icon id="select-all" size={16}/> Select All</button>
      <button type="button" className="sf-button" style={{display: 'inline-flex', alignItems: 'center', gap: 6}} title="Select none" aria-label="Select none" disabled={!list.length} onClick={() => setValue('picked', [])}><Icon id="clear" size={16}/> Select None</button>
    </div>
    <label style={{display: 'flex', alignItems: 'center', gap: 8}}><input type="checkbox" checked={!!d.values.keep} onChange={e => setValue('keep', e.target.checked)} data-field-id="keep"/>Keep source formatting</label>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
