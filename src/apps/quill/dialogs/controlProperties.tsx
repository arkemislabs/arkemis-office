// Content Control Properties view (Developer › Controls › Properties), laid out as Word's dialog is, over
// core/quill/dialogs/controlProperties.mjs: General (Title, Tag, Show as, Color, Use a style with Style and New Style…,
// Remove content control when contents are edited), Locking, and the properties of the control's type: Drop-Down List / Combo Box
// (a list with Display Name and Value columns, Add…, Modify…, Remove, Move Up, Move Down), Date Picker (display format, Locale,
// Calendar type, Store XML contents as), Check Box (Checked and Unchecked symbols, Change…), Plain Text (Allow carriage returns).
// MIT, see assets/third-party-licenses/artcraft-reference.txt (wordcraft dialogs_controls.rs for the fields it has).

import {useEffect, useMemo} from 'react';
import {Field, Group, grid, useStyleOptions, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Glyph} from '../../../shell/icons/Icon';
import {DATE_FORMATS} from '../../../../core/quill/dialogs/field.mjs';
import {formatDate} from '../../../../core/quill/commands/insert.mjs';
import {LOCALES, CALENDARS, STORE_AS, APPEARANCES} from '../../../../core/quill/dialogs/controlProperties.mjs';
import './controlProperties.css';

type Entry = {display: string; value: string};
const opts = (list: readonly (readonly string[])[]) => list.map(([label]) => ({value: label, label}));
const TITLES: Record<string, string> = {dropDown: 'Drop-Down List Properties', comboBox: 'Combo Box Properties', date: 'Date Picker Properties', checkBox: 'Check Box Properties', plainText: 'Plain Text Properties'};

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as Record<string, any>;
  const kind = String(v.kind ?? 'richText');
  const styles = useStyleOptions(['character'], null);
  // Ticking Use a style picks the first character style until another is chosen.
  useEffect(() => { if (v.useStyle && !v.style && styles.length) set('style', styles[0].value); }, [v.useStyle, v.style, styles]);  // eslint-disable-line react-hooks/exhaustive-deps
  const entries: Entry[] = Array.isArray(v.entries) ? v.entries : [];
  const sel = Number(v.entry ?? -1);
  const today = Date.now();
  const formats = useMemo(() => DATE_FORMATS.slice(0, 14).map((f: string) => ({value: f, label: formatDate(f, today)})), []);  // eslint-disable-line react-hooks/exhaustive-deps

  const setEntries = (next: Entry[], at: number) => { set('entries', next); set('entry', next.length ? Math.max(0, Math.min(at, next.length - 1)) : -1); };
  const ask = async (id: 'dialog.addChoice' | 'dialog.modifyChoice', init: Record<string, unknown>) => { try { return await controller.collectDialog(id, init); } catch { return null; } };
  const add = async () => {
    const r = await ask('dialog.addChoice', {display: '', value: '', _typed: false});
    if (r) setEntries([...entries.slice(0, sel + 1), {display: String(r.display), value: String(r.value)}, ...entries.slice(sel + 1)], sel + 1);
  };
  const modify = async () => {
    const e = entries[sel];
    if (!e) return;
    const r = await ask('dialog.modifyChoice', {display: e.display, value: e.value, _typed: true});
    if (r) setEntries(entries.map((x, i) => (i === sel ? {display: String(r.display), value: String(r.value)} : x)), sel);
  };
  const remove = () => { if (entries[sel]) setEntries(entries.filter((_, i) => i !== sel), sel); };
  const move = (by: number) => {
    const to = sel + by;
    if (!entries[sel] || to < 0 || to >= entries.length) return;
    const next = entries.slice();
    [next[sel], next[to]] = [next[to], next[sel]];
    setEntries(next, to);
  };
  const change = async (which: 'checked' | 'unchecked') => {
    try {
      const r = await controller.collectDialog('dialog.symbol', {font: v[`${which}Font`] || '(normal text)', grid: (v[`${which}Symbol`] as string)?.codePointAt(0) ?? 0x2612});
      if (!r || typeof r.grid !== 'number') return;
      const font = String(r.font ?? '');
      set(`${which}Symbol`, String.fromCodePoint(r.grid));
      set(`${which}Font`, font && font !== '(normal text)' ? font : '');
    } catch { /* the Symbol dialog is not available */ }
  };
  const symbolBox = (which: 'checked' | 'unchecked', label: string) => <div className="cc-symbol">
    <span className="sf-label">{label}</span>
    <span className="cc-glyph" style={{fontFamily: v[`${which}Font`] ? `"${v[`${which}Font`]}", "Segoe UI Symbol", sans-serif` : undefined}} aria-label={label}>{v[`${which}Symbol`] || ' '}</span>
    <button type="button" className="sf-button" onClick={() => { void change(which); }}>Change…</button>
  </div>;

  return <div className="gd-fields cc-props" data-dialog-page="Content Control Properties">
    <Group title="General">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="title" set={set}/>
        <Field d={d} id="tag" set={set}/>
        <Field d={d} id="appearance" set={set} options={APPEARANCES.map(([label]) => ({value: label, label}))}/>
        <Field d={d} id="color" set={set}/>
      </div>
      <div className="cc-style">
        <Field d={d} id="useStyle" set={set}/>
        <div className="cc-style-row">
          <div className="sf" data-field-id="style" data-kind="select"><div className="sf-control"><span className="sf-select">
            <select aria-label="Style" data-field-id="style" disabled={!v.useStyle} value={String(v.style || styles[0]?.value || '')} onChange={e => set('style', e.target.value)}>
              {!v.style || styles.some((o: {value: string}) => o.value === v.style) ? null : <option value={String(v.style ?? '')}>{String(v.style ?? '')}</option>}
              {styles.map((o: {value: string; label: string}) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <Glyph name="chevron-down" size={10}/>
          </span></div></div>
          <button type="button" className="sf-button" onClick={() => { try { controller.openDialog('dialog.newStyle'); } catch { /* no New Style here */ } }}>New Style…</button>
        </div>
      </div>
      <Field d={d} id="temporary" set={set}/>
    </Group>
    <Group title="Locking">
      <Field d={d} id="lockDelete" set={set}/>
      <Field d={d} id="lockEdit" set={set}/>
    </Group>
    {TITLES[kind] ? <Group title={TITLES[kind]}>
      {kind === 'plainText' ? <Field d={d} id="multiLine" set={set}/> : null}
      {kind === 'dropDown' || kind === 'comboBox' ? <div className="cc-list-row">
        <div className="cc-table" role="listbox" aria-label="Choices" data-field-id="entries">
          <div className="cc-head" role="presentation"><span>Display Name</span><span>Value</span></div>
          {entries.map((e, i) => <div key={i} role="option" aria-selected={i === sel} className={`cc-row${i === sel ? ' is-selected' : ''}`} data-option={e.display}
            onClick={() => set('entry', i)} onDoubleClick={() => { set('entry', i); void modify(); }}><span>{e.display}</span><span>{e.value}</span></div>)}
        </div>
        <div className="cc-buttons">
          <button type="button" className="sf-button" onClick={() => { void add(); }}>Add…</button>
          <button type="button" className="sf-button" disabled={!entries[sel]} onClick={() => { void modify(); }}>Modify…</button>
          <button type="button" className="sf-button" disabled={!entries[sel]} onClick={remove}>Remove</button>
          <button type="button" className="sf-button" disabled={!entries[sel] || sel === 0} onClick={() => move(-1)}>Move Up</button>
          <button type="button" className="sf-button" disabled={!entries[sel] || sel === entries.length - 1} onClick={() => move(1)}>Move Down</button>
        </div>
      </div> : null}
      {kind === 'date' ? <>
        <Field d={d} id="dateFormat" set={set} options={formats}/>
        <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
          <Field d={d} id="locale" set={set} options={opts(LOCALES)}/>
          <Field d={d} id="calendar" set={set} options={opts(CALENDARS)}/>
        </div>
        <Field d={d} id="storeAs" set={set} options={opts(STORE_AS)}/>
      </> : null}
      {kind === 'checkBox' ? <div className="cc-symbols">{symbolBox('checked', 'Checked symbol:')}{symbolBox('unchecked', 'Unchecked symbol:')}</div> : null}
    </Group> : null}
  </div>;
}

export default {Body};
