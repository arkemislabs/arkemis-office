// The Photo Album dialog body: the pictures and text boxes of the album as a list of thumbnails, the buttons that add,
// remove, move, turn and correct them, and the layout, frame, caption and black-and-white options. Buttons are icons
// with names as tooltips. Translated from deckcraft crates/ui-egui/src/dialogs/photo_album.rs (one picture is added per
// click: the system picker returns one file at a time).

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Icon} from '../../../shell/icons/Icon';
import {LAYOUT_KEYS, FRAMES, MAX_ITEMS} from '../../../../core/prism/lib/album.mjs';
import './photo-album.css';

type Any = any;
type SetValue = (field: string, value: unknown) => void;

const LAYOUT_LABEL: Record<string, string> = {fit: 'Fit to slide', 1: '1 picture', 2: '2 pictures', 4: '4 pictures', '1title': '1 picture with title', '2title': '2 pictures with title', '4title': '4 pictures with title'};
const FRAME_LABEL: Record<string, string> = {none: 'None', rect: 'Rectangle', rounded: 'Rounded rectangle', simple: 'Simple frame, white'};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export function PhotoAlbumBody({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const items: Any[] = Array.isArray(d.values.items) ? (d.values.items as Any[]) : [];
  const sel = clamp(Number(d.values.selected ?? 0) || 0, 0, Math.max(0, items.length - 1));
  const cur = items[sel];
  const set = (next: Any[], selected = sel) => { setValue('items', next); setValue('selected', clamp(selected, 0, Math.max(0, next.length - 1))); };
  const patch = (p: Any) => set(items.map((it, i) => (i === sel ? {...it, ...p} : it)));
  const add = async () => {
    const studio = (window as Any).studio;
    const url: string | null = studio?.pickImage ? await studio.pickImage() : null;
    if (!url) return;
    const m = /^data:([^;,]*);base64,(.*)$/.exec(url);
    set([...items, {kind: 'picture', name: `Picture ${items.length + 1}.${(m?.[1] ?? 'image/png').split('/').pop()?.replace('jpeg', 'jpg') ?? 'png'}`, data: m ? m[2] : url, rot: 0, brightness: 0, contrast: 0}], items.length);
  };
  const addText = () => set([...items, {kind: 'text', text: 'Text Box'}], items.length);
  const remove = () => items.length && set(items.filter((_, i) => i !== sel), sel);
  const move = (by: number) => {
    const j = sel + by;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[sel], next[j]] = [next[j], next[sel]];
    set(next, j);
  };
  const pic = cur?.kind === 'picture';
  const err = d.errors.find(e => e.field === 'items')?.message ?? null;
  const btn = (icon: string, label: string, on: () => void, enabled = true) =>
    <button type="button" className="sf-button pa-btn" title={label} aria-label={label} disabled={!enabled} onClick={on}><Icon id={icon} size={16}/><span>{label}</span></button>;
  return <div className="pa" data-field-id="items">
    <div className="pa-left">
      <ol className="pa-list" role="listbox" aria-label="Pictures in album">
        {items.map((it, i) => <li key={i}><button type="button" role="option" aria-selected={i === sel} className={i === sel ? 'is-on' : ''} onClick={() => setValue('selected', i)}
          title={it.kind === 'text' ? it.text : it.name}>
          {it.kind === 'text' ? <span className="pa-thumb pa-text"><Icon id="text-box" size={20}/></span>
            : <img className="pa-thumb" alt="" src={`data:image/*;base64,${it.data}`} style={{transform: `rotate(${it.rot ?? 0}deg)`, filter: `brightness(${1 + (it.brightness ?? 0)}) contrast(${1 + (it.contrast ?? 0)})`}}/>}
          <span className="pa-n">{i + 1}</span>
        </button></li>)}
        {!items.length ? <li className="pa-empty"><Icon id="picture" size={32}/><strong>No pictures yet</strong><span>Choose Add Picture to start the album, or New text box for a caption slide.</span></li> : null}
      </ol>
      <div className="pa-bar">
        {btn('picture', 'Add Picture', add, items.length < MAX_ITEMS)}
        {btn('text-box', 'New text box', addText, items.length < MAX_ITEMS)}
        {btn('trash', 'Remove', remove, !!cur)}
        {btn('move-up', 'Up', () => move(-1), sel > 0)}
        {btn('move-down', 'Down', () => move(1), sel < items.length - 1)}
      </div>
    </div>
    <div className="pa-right">
      <div className="pa-edit">
        {cur?.kind === 'text'
          ? <input className="pa-input" aria-label="Text box text" value={cur.text ?? ''} onChange={e => patch({text: e.target.value})}/>
          : <>
            <div className="pa-bar">
              {btn('rotate-ccw', 'Rotate Left', () => patch({rot: ((cur.rot ?? 0) + 270) % 360}), pic)}
              {btn('rotate-cw', 'Rotate Right', () => patch({rot: ((cur.rot ?? 0) + 90) % 360}), pic)}
              {btn('contrast-half', 'Contrast −', () => patch({contrast: clamp(round2((cur.contrast ?? 0) - 0.1), -1, 1)}), pic)}
              {btn('plus', 'Contrast +', () => patch({contrast: clamp(round2((cur.contrast ?? 0) + 0.1), -1, 1)}), pic)}
              {btn('arrow-down', 'Brightness −', () => patch({brightness: clamp(round2((cur.brightness ?? 0) - 0.1), -1, 1)}), pic)}
              {btn('arrow-up', 'Brightness +', () => patch({brightness: clamp(round2((cur.brightness ?? 0) + 0.1), -1, 1)}), pic)}
            </div>
            {pic ? <div className="pa-prev"><img alt="Preview" src={`data:image/*;base64,${cur.data}`} style={{transform: `rotate(${cur.rot ?? 0}deg)`, filter: `brightness(${1 + (cur.brightness ?? 0)}) contrast(${1 + (cur.contrast ?? 0)})`}}/></div> : null}
            {pic ? <div className="pa-sum" data-field-id="preview">{`Rotation ${cur.rot ?? 0}°, brightness ${round2(cur.brightness ?? 0)}, contrast ${round2(cur.contrast ?? 0)}`}</div> : null}
          </>}
      </div>
      <fieldset className="pa-opts">
        <label>Picture layout
          <select value={String(d.values.layout ?? '1')} onChange={e => setValue('layout', e.target.value)} data-field-id="layout">
            {LAYOUT_KEYS.map((k: string) => <option key={k} value={k}>{LAYOUT_LABEL[k] ?? k}</option>)}
          </select></label>
        <label>Frame shape
          <select value={String(d.values.frame ?? 'none')} onChange={e => setValue('frame', e.target.value)} data-field-id="frame">
            {FRAMES.map((k: string) => <option key={k} value={k}>{FRAME_LABEL[k] ?? k}</option>)}
          </select></label>
        <label className="pa-check"><input type="checkbox" checked={!!d.values.captions} onChange={e => setValue('captions', e.target.checked)} data-field-id="captions"/>Captions below ALL pictures</label>
        <label className="pa-check"><input type="checkbox" checked={!!d.values.grayscale} onChange={e => setValue('grayscale', e.target.checked)} data-field-id="grayscale"/>ALL pictures black and white</label>
      </fieldset>
    </div>
    {err ? <small className="sf-error pa-err" role="alert">{err}</small> : null}
  </div>;
}
