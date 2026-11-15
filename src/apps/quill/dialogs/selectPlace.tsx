// Select Place in Document view (Insert Hyperlink › Bookmark…): the top of the document, its headings (indented by level) and its
// bookmarks in one list, over core/quill/dialogs/selectPlace.mjs. A double-click picks one.

import {Field, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const places = ((d.values.places as {value: string; label: string}[]) ?? []);
  return <div className="gd-fields" data-dialog-page="Select Place in Document" style={{width: 340}}
    onDoubleClick={e => { if ((e.target as Element).closest('[role=option]')) void controller.submitDialog(d.key).catch(err => controller.notify(toCommandError(err).message, 'error')); }}>
    <Field d={d} id="place" set={set} options={places} patch={{height: 3 + 8 * 24 + 3}}/>
  </div>;
}

export default {Body};
