// Custom Shows (Slide Show > Custom Slide Show): the shows with Show, Edit, Copy and Remove, then the
// definition of one: its name, the slides of the presentation and the slides in the show with Add,
// Remove, Move Up and Move Down. Buttons are drawn icons. Save (the dialog's own button) runs
// show.customShow; Show, Copy and Remove run at once. Translated from deckcraft dialogs/body.rs
// `dlg_custom_show` at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Icon} from '../../../shell/icons/Icon';
import {slideTitle} from '../../../../core/prism/model/presentation.mjs';

type Any = any;
const box: React.CSSProperties = {maxHeight: 150, minHeight: 90, overflow: 'auto', borderRadius: 8, background: 'rgba(0,0,0,.28)', padding: 4, flex: 1};
const row = (on: boolean): React.CSSProperties => ({display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px', border: 0, borderRadius: 4, color: 'inherit', font: 'inherit', background: on ? 'rgba(232,119,78,.28)' : 'transparent'});

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [pickA, setPickA] = useState<number | null>(null);
  const [pickC, setPickC] = useState<number | null>(null);
  const [pickShow, setPickShow] = useState<string | null>(null);
  void tick;
  const content: Any = (session.get(docId) as Any).file.content;
  const slides: Any[] = content.slides ?? [];
  const shows: Any[] = content.customShows ?? [];
  const chosen: number[] = Array.isArray(d.values.chosen) ? (d.values.chosen as number[]) : [];
  const label = (i: number) => `${i + 1}  ${String(slideTitle(slides[i]) || '').trim() || '(no title)'}`;
  const run = (id: string, params: Record<string, unknown>) => (session as Any).execute(docId, id, params, {origin: 'ui'}).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
  const sync = () => setValue('existing', ((session.get(docId) as Any).file.content.customShows ?? []).map((c: Any) => c.name));
  const idx = (c: Any) => (c.slides ?? []).map((id: string) => slides.findIndex(s => s.id === id)).filter((i: number) => i >= 0);
  const icon = (id: string, title: string, onClick: () => void, disabled = false) =>
    <button type="button" className="sf-button" title={title} aria-label={title} disabled={disabled} onClick={onClick} style={{padding: '3px 9px', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-start', minWidth: 96}}><Icon id={id} size={16}/>{title.replace('Remove from show', 'Remove')}</button>;
  const error = d.errors[0]?.message ?? null;
  const cur = shows.find(c => c.name === pickShow) ?? null;
  const move = (by: number) => {
    if (pickC === null) return;
    const to = pickC + by;
    if (to < 0 || to >= chosen.length) return;
    const next = [...chosen];
    [next[pickC], next[to]] = [next[to], next[pickC]];
    setValue('chosen', next);
    setPickC(to);
  };
  return <div className="cs" style={{display: 'flex', flexDirection: 'column', gap: 10, width: 660, maxWidth: '100%', font: '12px var(--ark-font, system-ui)', color: 'var(--sh-text-1, #f2f2f3)'}}>
    <div style={{display: 'flex', gap: 8}}>
      <div style={box} role="listbox" aria-label="Custom shows" data-field-id="shows">
        {shows.length ? shows.map(c => <button key={c.name} type="button" role="option" aria-selected={c.name === pickShow} style={row(c.name === pickShow)} onClick={() => setPickShow(c.name)}>{`${c.name} (${(c.slides ?? []).length} slides)`}</button>)
          : <span style={{color: 'var(--sh-text-3, #85858c)', padding: 4}}>No custom shows yet.</span>}
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
        {icon('play', 'Show', () => { if (cur) { void run('show.start', {custom: cur.name}).then(() => controller.cancelDialog(d.key)); } }, !cur)}
        {icon('rename', 'Edit', () => { if (cur) { setValue('name', cur.name); setValue('orig', cur.name); setValue('chosen', idx(cur)); setPickC(null); } }, !cur)}
        {icon('copy', 'Copy', () => { if (cur) void run('show.customShow', {name: `${cur.name} (2)`, slides: idx(cur)}).then(sync); }, !cur)}
        {icon('trash', 'Remove', () => { if (cur) { void run('show.customShow', {name: cur.name, delete: true}).then(() => { setPickShow(null); sync(); }); } }, !cur)}
      </div>
    </div>
    <label style={{display: 'flex', alignItems: 'center', gap: 8}}>Slide show name:
      <input data-field-id="name" aria-label="Slide show name" value={String(d.values.name ?? '')} onChange={e => setValue('name', e.target.value)}
        style={{flex: 1, height: 24, padding: '0 6px', border: 0, borderRadius: 6, background: 'rgba(0,0,0,.28)', color: 'inherit', font: 'inherit', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.1)'}}/>
    </label>
    <div style={{display: 'flex', gap: 8, alignItems: 'stretch'}}>
      <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 4}}>
        <span style={{color: 'var(--sh-text-2, #b4b4ba)'}}>Slides in presentation</span>
        <div style={box} role="listbox" aria-label="Slides in presentation">
          {slides.map((_, i) => <button key={i} type="button" role="option" aria-selected={pickA === i} style={row(pickA === i)} onClick={() => setPickA(i)} onDoubleClick={() => setValue('chosen', [...chosen, i])}>{label(i)}</button>)}
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center'}}>
        {icon('arrow-right', 'Add', () => { if (pickA !== null) setValue('chosen', [...chosen, pickA]); }, pickA === null)}
        {icon('arrow-left', 'Remove from show', () => { if (pickC !== null) { setValue('chosen', chosen.filter((_, k) => k !== pickC)); setPickC(null); } }, pickC === null)}
      </div>
      <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 4}}>
        <span style={{color: 'var(--sh-text-2, #b4b4ba)'}}>Slides in custom show</span>
        <div style={box} role="listbox" aria-label="Slides in custom show" data-field-id="chosen">
          {chosen.map((i, k) => <button key={k} type="button" role="option" aria-selected={pickC === k} style={row(pickC === k)} onClick={() => setPickC(k)}>{label(i)}</button>)}
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center'}}>
        {icon('arrow-up', 'Move Up', () => move(-1), pickC === null || pickC === 0)}
        {icon('arrow-down', 'Move Down', () => move(1), pickC === null || pickC >= chosen.length - 1)}
      </div>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
