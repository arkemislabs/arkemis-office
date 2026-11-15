// Replace Font's fields as deckcraft draws them (crates/ui-egui/src/dialogs/body.rs `dlg_replace_fonts`
// at f893f6af7d36a5409fd804e81a34fd895cfefedf): Replace: a list of the fonts the presentation uses
// (font.used), With: a font name you type or pick from the installed families. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useEffect, useState} from 'react';
import {SelectField, FontField, type FieldProps} from '../../../shell/fields';
import {useEngine} from '../../../shell/engine/EngineProvider';

/** A presentation that names no font itself uses its theme's: the Replace list offers those. */
function themeFonts(session: any, docId: string): string[] {
  try {
    const f = session.get(docId).file.content.masters?.[0]?.theme?.fonts;
    return [...new Set([f?.major?.latin, f?.minor?.latin].filter((x: unknown): x is string => typeof x === 'string' && !!x))];
  } catch { return []; }
}

function UsedFonts(props: FieldProps) {
  const {session, docId} = useEngine();
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    Promise.resolve(session.execute(docId, 'font.used', {}, {origin: 'ui'}))
      .then((r: any) => { if (live) setUsed(Array.isArray(r?.result) && r.result.length ? r.result : themeFonts(session, docId)); })
      .catch(() => { if (live) setUsed([]); });
    return () => { live = false; };
  }, [session, docId, props.value]);
  const field = {...props.field, kind: 'select', options: used.map(f => ({value: f, label: f}))} as FieldProps['field'];
  return <SelectField {...props} field={field}/>;
}

function Installed(props: FieldProps) {
  return <FontField {...props}/>;
}

export default {fields: {from: UsedFonts, to: Installed}};
