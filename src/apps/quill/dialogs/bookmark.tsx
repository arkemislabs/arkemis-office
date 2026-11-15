// Bookmark view (Insert › Links › Bookmark): the name box over the list, Delete and Go To beside
// them, Sort by and Hidden bookmarks below, as Word (#1236), over core/quill/dialogs/bookmark.mjs
// (wordcraft bookmarks.rs). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, grid, type BodyProps} from './font';
import {bookmarkNames} from '../../../../core/quill/dialogs/bookmark.mjs';

// Word's list is simply empty when the document has no bookmarks (no text inside it).
const EMPTY = {note: ''};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {marks?: [string][]; sortBy?: string; hidden?: boolean};
  const names = bookmarkNames(v.marks ?? [], v.sortBy === 'location', !!v.hidden).map((n: string) => ({value: n, label: n}));
  return <div className="gd-fields">
    <div style={grid('minmax(0, 1fr) 110px', {alignItems: 'start'})}>
      <div><Field d={d} id="name" set={set}/><div style={{marginTop: 6}}><Field d={d} id="list" set={set} options={names} patch={EMPTY}/></div></div>
      <div style={{display: 'grid', gap: 8, marginTop: 22}}><Field d={d} id="delete" set={set}/><Field d={d} id="goTo" set={set}/></div>
    </div>
    <div style={{display: 'grid', gap: 8, marginTop: 10}}>
      <Field d={d} id="sortBy" set={set}/>
      <Field d={d} id="hidden" set={set}/>
    </div>
  </div>;
}

export default {Body};
