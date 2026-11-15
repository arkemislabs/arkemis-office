// Symbol as Excel draws it: a grid of characters by subset (Symbols), the Special Characters list,
// a box with the chosen character's code, and the recently used symbols. Insert puts the character
// at the end of the active cell's text (gridcraft insert.symbol).
// Excel's Symbol dialog over gridcraft's cmd/insert.rs `insert_symbol` at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Tabs, Rows, type SetValue} from './dataKit';

const range = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => String.fromCodePoint(a + i));
const SUBSETS: Record<string, string[]> = {
  'Currency Symbols': [...'€£¥¢₹₽₩₪₫₺₴₱฿₡₦'],
  'Latin-1 Supplement': range(0xA1, 0xFF).filter(c => c !== '­'),
  'Greek and Coptic': range(0x391, 0x3A9).concat(range(0x3B1, 0x3C9)).filter(c => c.codePointAt(0) !== 0x3A2),
  'Mathematical Operators': [...'±×÷≠≤≥≈∞∑∏√∫∂∆∇∈∉∩∪⊂⊃⊆⊇∧∨¬∀∃∅∝∠∥⊥≡≪≫'],
  Arrows: [...'←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓⇔↩↪↺↻➔➜➡⬅⬆⬇'],
  'Geometric Shapes': [...'■□▪▫▲△▶▷▼▽◀◁◆◇○●◎◐◑★☆'],
  'Letterlike Symbols': [...'℃℉№™℗®©℠ℓ℮Ω℧ℵ'],
  'General Punctuation': [...'–—‘’“”‚„†‡•…‰′″‹›‼⁄'],
};
const SPECIAL: [string, string, string][] = [
  ['Em Dash', '—', ''], ['En Dash', '–', ''], ['Copyright', '©', 'Alt+Ctrl+C'], ['Registered', '®', 'Alt+Ctrl+R'], ['Trademark', '™', 'Alt+Ctrl+T'],
  ['Section', '§', ''], ['Paragraph', '¶', ''], ['Ellipsis', '…', 'Alt+Ctrl+.'], ['Single Opening Quote', '‘', ''], ['Single Closing Quote', '’', ''],
  ['Double Opening Quote', '“', ''], ['Double Closing Quote', '”', ''], ['Nonbreaking Space', ' ', 'Ctrl+Shift+Space'],
];
const hex = (c: string) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
const FROM = ['Unicode (hex)', 'ASCII (decimal)', 'ASCII (hex)'];

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const [tab, setTab] = useState(0);
  const subset = String(d.values.subset ?? 'Currency Symbols');
  const chars = SUBSETS[subset] ?? [];
  const chosen = String(d.values.char ?? '');
  const recent = (Array.isArray(d.values.recent) ? d.values.recent : []) as string[];
  const [from, setFrom] = useState(0);
  const code = chosen ? (from === 0 ? hex(chosen) : from === 1 ? String(chosen.codePointAt(0)) : hex(chosen).replace(/^0+(?=.)/, '')) : '';
  const typeCode = (t: string) => {
    const n = from === 1 ? parseInt(t, 10) : parseInt(t, 16);
    if (Number.isFinite(n) && n > 0 && n <= 0x10FFFF) setValue('char', String.fromCodePoint(n));
  };
  const error = d.errors.find(e => e.field === 'char')?.message ?? null;
  const pick = (c: string) => setValue('char', c);
  const special = SPECIAL.findIndex(([, c]) => c === chosen);
  return <div className="gd-fields insert-symbol">
    <Tabs names={['Symbols', 'Special Characters']} current={tab} onPick={setTab} label="Symbol dialog"/>
    {tab === 0 ? <>
      <label className="sf sf-select" data-field-id="subset"><span className="sf-label">Subset:</span>
        <select value={subset} onChange={e => setValue('subset', e.target.value)}>{Object.keys(SUBSETS).map(k => <option key={k}>{k}</option>)}</select></label>
      <div className="insert-symbol-grid" role="listbox" aria-label="Symbols" data-field-id="char">
        {chars.map(c => <button key={c} type="button" role="option" aria-selected={c === chosen} className={`insert-symbol-cell${c === chosen ? ' is-on' : ''}`} title={`U+${hex(c)}`}
          onClick={() => pick(c)} onDoubleClick={() => pick(c)}>{c}</button>)}
      </div>
      {recent.length ? <div className="insert-symbol-recent"><span className="sf-label">Recently used symbols:</span>
        <div>{recent.map(c => <button key={c} type="button" className="insert-symbol-cell" onClick={() => pick(c)}>{c}</button>)}</div></div> : null}
    </> : <Rows label="Special characters" height={230} selected={special} onPick={i => pick(SPECIAL[i][1])}
      items={SPECIAL.map(([name, c, keys]) => <span key={name} className="insert-special"><b>{name}</b><i>{keys}</i><span className="insert-special-char">{c.trim() ? c : '␣'}</span></span>)}/>}
    <div className="data-row">
      <label className="sf" data-field-id="charCode"><span className="sf-label">Character code:</span>
        <input className="sf-text" value={code} onChange={e => typeCode(e.target.value)} aria-label="Character code"/></label>
      <label className="sf sf-select" data-field-id="from"><span className="sf-label">from:</span>
        <select value={FROM[from]} onChange={e => setFrom(FROM.indexOf(e.target.value))}>{FROM.map(k => <option key={k}>{k}</option>)}</select></label>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
