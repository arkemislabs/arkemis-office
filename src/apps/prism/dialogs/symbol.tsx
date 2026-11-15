// Symbol as PowerPoint draws it: the Subset (a Unicode block, or deckcraft's six groups) over a 16-column grid of its
// characters, the chosen one large beside its code, and Insert / Close. Clicking a cell picks the character (the dialog's
// `text` value); a double click inserts it. The groups are deckcraft's `dlg_symbol` (crates/ui-egui/src/dialogs/body.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf), the blocks the same list Word's Symbol dialog uses. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {SelectField} from '../../../shell/fields';
import {GROUPS, chars} from '../../../../core/prism/dialogs/symbol.mjs';
import {SUBSETS, isControl} from '../../../../core/quill/dialogs/symbol.mjs';

const COLS = 16;
const field = (options: {value: string; label: string}[]) => ({id: 'subset', label: 'Subset:', kind: 'select', options}) as any;

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {controller} = useEngine();
  const subsets: [string, number[]][] = [
    ...(GROUPS as [string, string, string][]).map(([, name, s]): [string, number[]] => [name, chars(s).map(c => c.codePointAt(0)!)]),
    ...(SUBSETS as [string, number, number][]).map(([name, a, b]): [string, number[]] => {
      const list: number[] = [];
      for (let cp = a; cp <= b && list.length < COLS * 48; cp++) if (!isControl(cp)) list.push(cp);
      return [name, list];
    }),
  ];
  const [subset, setSubset] = useState('Basic Latin');
  const list = subsets.find(([n]) => n === subset)?.[1] ?? [];
  const current = typeof d.values.text === 'string' ? d.values.text : '';
  const cp = current ? current.codePointAt(0)! : null;
  const code = cp === null ? '' : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const error = d.errors.find(e => e.field === 'text')?.message ?? null;
  return <div className="gd-fields" data-field-id="text">
    <SelectField field={field(subsets.map(([n]) => ({value: n, label: n})))} value={subset} onChange={v => setSubset(String(v))}/>
    <div role="grid" aria-label="Symbols" style={{display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, maxHeight: 250, overflowY: 'auto', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, background: 'rgba(0,0,0,.2)'}}>
      {list.map(c => <button key={c} type="button" role="gridcell" aria-selected={cp === c} title={`U+${c.toString(16).toUpperCase().padStart(4, '0')}`}
        onClick={() => setValue('text', String.fromCodePoint(c))} onDoubleClick={() => { setValue('text', String.fromCodePoint(c)); void controller.submitDialog(d.key).catch(() => {}); }}
        style={{height: 30, fontSize: 17, border: 0, color: 'inherit', cursor: 'default', background: cp === c ? 'var(--prism-accent, #e8774e)' : 'transparent'}}>{String.fromCodePoint(c)}</button>)}
    </div>
    <div style={{display: 'flex', alignItems: 'center', gap: 14, minHeight: 56}}>
      <div style={{width: 56, height: 56, display: 'grid', placeItems: 'center', fontSize: 34, borderRadius: 8, background: 'rgba(255,255,255,.92)', color: '#111'}} aria-label="Chosen symbol">{current || ''}</div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--sh-text-2, #b4b4ba)'}}>
        <span>{current ? `Character code: ${code}` : 'Choose a symbol.'}</span>
        <span style={{fontSize: 11, color: 'var(--sh-text-3, #85858c)'}}>Double-click a symbol to insert it.</span>
      </div>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
