// Set Up Show: "Custom show" picks one of the presentation's own custom shows (PowerPoint's drop-down), not a typed name.

import {SelectField, type FieldProps} from '../../../shell/fields';
import {useEngine} from '../../../shell/engine/EngineProvider';

function CustomShow(props: FieldProps) {
  const {session, docId} = useEngine();
  let names: string[] = [];
  try { names = ((session as any).get(docId).file.content.customShows ?? []).map((c: {name: string}) => c.name); } catch { names = []; }
  const field = {...props.field, kind: 'select', options: names.map(n => ({value: n, label: n}))} as FieldProps['field'];
  return <SelectField {...props} field={field}/>;
}

export default {fields: {custom: CustomShow}};
