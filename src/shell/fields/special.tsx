// Fields used by dialog overrides and by the specs' special kinds: TabStopsField (Tabs dialog),
// BorderField (Borders and Shading, Format Cells Border), ShortcutField (Customize Keyboard,
// recorded without OS input: the chord comes from the field's own keydown) and GridField (a symbol
// or character grid; Symbol dialogs).

import {useState} from 'react';
import {FieldShell, type FieldProps} from './common';
import {chordFromEvent, chordText, isBareModifier} from '../keys/KeyRouter';
import {platform} from '../env';
import {formatNumber, parseNumber} from '../dialogs/dialogState';

export interface TabStop { position: number; alignment: 'left' | 'center' | 'right' | 'decimal' | 'bar'; leader: 'none' | 'dots' | 'dashes' | 'line' }

export function TabStopsField({field, value, onChange, disabled}: FieldProps) {
  const stops: TabStop[] = Array.isArray(value) ? value as TabStop[] : [];
  const [pos, setPos] = useState('');
  const [align, setAlign] = useState<TabStop['alignment']>('left');
  const [leader, setLeader] = useState<TabStop['leader']>('none');
  const [sel, setSel] = useState<number | null>(null);
  const unit = field.unit ?? 'pt';
  const set = () => {
    const n = parseNumber(pos, unit);
    if (n === null) return;
    const next = stops.filter(s => Math.abs(s.position - n) > 0.01).concat({position: n, alignment: align, leader}).sort((a, b) => a.position - b.position);
    onChange(next);
  };
  return <FieldShell field={field}>{() => <div className="sf-tabstops">
    <div className="sf-tabstops-entry">
      <input className="sf-text" aria-label="Tab stop position" value={pos} disabled={disabled} onChange={e => setPos(e.target.value)} placeholder={`0 ${unit}`}/>
      <div className="sf-list" role="listbox" aria-label="Tab stops">
        {stops.map((s, i) => <div key={i} role="option" aria-selected={sel === i} className={`sf-list-item${sel === i ? ' is-selected' : ''}`}
          onClick={() => { setSel(i); setPos(formatNumber(s.position, unit)); setAlign(s.alignment); setLeader(s.leader); }}>{formatNumber(s.position, unit)}</div>)}
      </div>
    </div>
    <fieldset className="sf-radio"><legend className="sf-label">Alignment</legend><div className="sf-radio-options">
      {(['left', 'center', 'right', 'decimal', 'bar'] as const).map(a => <label key={a}><input type="radio" checked={align === a} onChange={() => setAlign(a)}/><span className="sf-radio-dot"/><span>{a[0].toUpperCase() + a.slice(1)}</span></label>)}
    </div></fieldset>
    <fieldset className="sf-radio"><legend className="sf-label">Leader</legend><div className="sf-radio-options">
      {(['none', 'dots', 'dashes', 'line'] as const).map((l, i) => <label key={l}><input type="radio" checked={leader === l} onChange={() => setLeader(l)}/><span className="sf-radio-dot"/><span>{i + 1} {l === 'none' ? 'None' : l === 'dots' ? '.......' : l === 'dashes' ? '-------' : '_______'}</span></label>)}
    </div></fieldset>
    <div className="sf-row">
      <button type="button" className="sf-button" onClick={set} disabled={disabled}>Set</button>
      <button type="button" className="sf-button" disabled={disabled || sel === null} onClick={() => { if (sel !== null) { onChange(stops.filter((_, i) => i !== sel)); setSel(null); } }}>Clear</button>
      <button type="button" className="sf-button" disabled={disabled || !stops.length} onClick={() => { onChange([]); setSel(null); }}>Clear All</button>
    </div>
  </div>}</FieldShell>;
}

export interface Borders { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean; insideH?: boolean; insideV?: boolean }

/** Click the sides of the sample box (or the buttons around it) to apply or remove borders. */
export function BorderField({field, value, onChange, disabled}: FieldProps) {
  const b: Borders = value && typeof value === 'object' ? value as Borders : {};
  const flip = (k: keyof Borders) => !disabled && onChange({...b, [k]: !b[k]});
  const side = (k: keyof Borders, label: string) => <button type="button" className={`sf-border-btn${b[k] ? ' is-on' : ''}`} aria-pressed={!!b[k]} aria-label={label} onClick={() => flip(k)}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" strokeOpacity=".35" strokeDasharray="1.5 1.5"/>
      {k === 'top' ? <path d="M2.5 2.5h11" stroke="currentColor"/> : k === 'bottom' ? <path d="M2.5 13.5h11" stroke="currentColor"/> : k === 'left' ? <path d="M2.5 2.5v11" stroke="currentColor"/>
        : k === 'right' ? <path d="M13.5 2.5v11" stroke="currentColor"/> : k === 'insideH' ? <path d="M2.5 8h11" stroke="currentColor"/> : <path d="M8 2.5v11" stroke="currentColor"/>}</svg>
  </button>;
  return <FieldShell field={field}>{() => <div className="sf-border">
    <div className="sf-border-side">{side('top', 'Top border')}{side('insideH', 'Inside horizontal border')}{side('bottom', 'Bottom border')}</div>
    <div className="sf-border-sample" role="img" aria-label="Border preview">
      <span className="sf-border-text"/>
      <i className="t" data-on={!!b.top} onClick={() => flip('top')}/><i className="b" data-on={!!b.bottom} onClick={() => flip('bottom')}/>
      <i className="l" data-on={!!b.left} onClick={() => flip('left')}/><i className="r" data-on={!!b.right} onClick={() => flip('right')}/>
      <i className="h" data-on={!!b.insideH} onClick={() => flip('insideH')}/><i className="v" data-on={!!b.insideV} onClick={() => flip('insideV')}/>
    </div>
    <div className="sf-border-side is-row">{side('left', 'Left border')}{side('insideV', 'Inside vertical border')}{side('right', 'Right border')}</div>
  </div>}</FieldShell>;
}

/** Press a new shortcut: the field records the chord from its own keydown (no synthetic input). */
export function ShortcutField({field, value, onChange, disabled}: FieldProps) {
  return <FieldShell field={field}>{id => <input id={id} className="sf-text sf-shortcut" readOnly disabled={disabled} value={value ? String(value) : ''} placeholder="Press new shortcut key"
    onKeyDown={e => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (e.key === 'Backspace' || e.key === 'Delete') { onChange(null); return; }
      const chord = chordFromEvent(e);
      if (!chord || isBareModifier(chord)) return;
      onChange(chordText(chord, platform()));
    }}/>}</FieldShell>;
}

/** A grid of characters (Symbol dialogs): the value is the chosen character. */
export function GridField({field, value, onChange, disabled}: FieldProps) {
  const chars = field.options.length ? field.options.map(o => String(o.value)) : DEFAULT_SYMBOLS[field.id] ?? DEFAULT_SYMBOLS.symbols;
  return <FieldShell field={field}>{id => <div id={id} className="sf-grid" role="grid" aria-label={field.label}>
    {chars.map((ch, i) => <button key={i} type="button" role="gridcell" aria-selected={value === ch} className={value === ch ? 'is-selected' : undefined} disabled={disabled}
      title={`U+${ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`} onClick={() => onChange(ch)}>{ch}</button>)}
  </div>}</FieldShell>;
}

const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => String.fromCodePoint(from + i));
const DEFAULT_SYMBOLS: Record<string, string[]> = {
  symbols: [...range(0x2190, 0x2199), ...range(0x2200, 0x2211), '±', '×', '÷', '≈', '≠', '≤', '≥', '∞', '°', '©', '®', '™', '€', '£', '¥', '§', '¶', '•', '…', '—', '–'],
  punctuation: ['‘', '’', '“', '”', '‚', '„', '‹', '›', '«', '»', '¡', '¿', '·', '•', '…', '‰', '′', '″', '§', '¶', '†', '‡', '—', '–'],
};

export const unitText = (n: number, unit: string) => formatNumber(n, unit);
