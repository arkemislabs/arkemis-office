// Icons view (Insert › Illustrations › Icons): the search box, the category chips (All and the library's), the grid of icons drawn
// from the library's path data in the ink, the selected icon's name and Insert, over core/quill/dialogs/icons.mjs. Double-clicking an
// icon inserts it. Layout from wordcraft crates/ui-egui/src/dialogs/bookmarks.rs (`icons_body`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {CATEGORIES, findIcon, parseCategory, piecesOf, searchIcons, STROKE} from '../../../../core/quill/lib/icon-lib.mjs';
import './icons.css';

type Icon = ReturnType<typeof searchIcons>[number];

/** An icon drawn live from its path data: strokes with the round pen, filled parts as polygons. */
export function IconDrawing({icon, size = 28}: {icon: Icon; size?: number}) {
  return <svg className="ic-svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
    {piecesOf(icon).map((p, i) => {
      const pts = p.points.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
      return p.fill ? <polygon key={i} points={pts} fill="currentColor" stroke="none"/> : p.closed ? <polygon key={i} points={pts}/> : <polyline key={i} points={pts}/>;
    })}
  </svg>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as {query?: string; category?: string; selected?: string};
  const category = String(v.category ?? '');
  const hits = searchIcons(String(v.query ?? ''), parseCategory(category));
  const chosen = findIcon(v.selected);
  const insert = (id: string) => {
    set('selected', id);
    void controller.submitDialog(d.key).catch((e: unknown) => controller.notify(toCommandError(e).message, 'error'));
  };
  return <div className="gd-fields ic-picker" data-dialog-page="Icons">
    <Field d={d} id="query" set={set}/>
    <div className="ic-chips" role="tablist" aria-label="Categories">
      {['', ...CATEGORIES].map(c => <button key={c || 'all'} type="button" role="tab" aria-selected={category === c} className={`ic-chip${category === c ? ' is-on' : ''}`} data-category={c || 'All'}
        onClick={() => set('category', c)}>{c || 'All'}</button>)}
    </div>
    <div className="ic-grid" role="listbox" aria-label="Icons" data-field-id="grid">
      {hits.map(i => <button key={i.id} type="button" role="option" aria-selected={i.id === v.selected} title={i.name} data-icon={i.id} className={`ic-cell${i.id === v.selected ? ' is-on' : ''}`}
        onClick={() => set('selected', i.id)} onDoubleClick={() => insert(i.id)}><IconDrawing icon={i}/></button>)}
      {hits.length ? null : <p className="ic-none">No icons match your search.</p>}
    </div>
    <div className="ic-name" aria-live="polite">{chosen?.name ?? ''}</div>
  </div>;
}

export default {Body};
