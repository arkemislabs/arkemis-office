// The Choose a SmartArt Graphic dialog body: the categories down the left, each layout drawn as a thumbnail, and the chosen
// layout larger with its name. Pictures, not names: a layout's name is its tooltip and the caption under the preview.

import {useMemo} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {CATEGORIES, LAYOUTS, layoutName, thumb} from '../../../../core/prism/lib/smartart.mjs';
import {DiagramArt} from '../../../shell/ribbon/DiagramArt';
import './chart.css';

type Any = any;

export function SmartArtGallery({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const kind = String(d.values.kind ?? 'process');
  const category = String(d.values.category ?? 'All');
  const items = useMemo(() => Object.fromEntries(LAYOUTS.map((l: Any) => [l[0], thumb(l[0])])), []);
  const shown = LAYOUTS.filter((l: Any) => category === 'All' || l[2] === category);
  return <div className="chc chc-tall" data-field-id="kind">
    <ul className="chc-cats" role="listbox" aria-label="Category">
      {CATEGORIES.map((c: string) => <li key={c}><button type="button" role="option" aria-selected={c === category} className={c === category ? 'is-on' : ''}
        onClick={() => setValue('category', c)}><span>{c}</span></button></li>)}
    </ul>
    <div className="chc-main">
      <div className="chc-types" role="listbox" aria-label="Layout">
        {shown.map((l: Any) => <button key={l[0]} type="button" role="option" aria-selected={l[0] === kind} className={l[0] === kind ? 'is-on' : ''} title={l[1]} aria-label={l[1]}
          onClick={() => setValue('kind', l[0])}><DiagramArt items={items[l[0]]} w={160} h={100}/></button>)}
      </div>
      <div className="chc-preview" data-field-id="preview">
        <DiagramArt items={items[kind] ?? []} w={160} h={100}/>
        <div className="chc-name">{layoutName(kind)}</div>
      </div>
    </div>
  </div>;
}
