// Source Manager view (References › Manage Sources): Current List of the document's sources (tag,
// author, title, year), New…, Import… (a Word bibliography file, Sources.xml, through the system Open
// dialog), Edit…, Delete, Insert Citation, and the Preview of the selected source as the document's
// style cites it and lists it. The list follows the document (a source added in Create Source shows
// at once). Over core/quill/dialogs/sourceManager.mjs; layout from wordcraft crates/ui-egui/src/
// dialogs/dialogs_refs/sources.rs (`sources_ui`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useRef} from 'react';
import {Field, grid, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {cite, entry} from '../../../../core/quill/lib/references-cite.mjs';

type Src = Record<string, string>;

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const file = useRef<HTMLInputElement>(null);
  const ctx = session.readContext(docId) as {doc?: {sources?: Src[]; settings?: {bibStyle?: string | null}}} | null;
  const sources = ctx?.doc?.sources ?? [];
  const style = ctx?.doc?.settings?.bibStyle ?? 'APA';
  const selected = sources.find(x => x.tag === d.values.list) ?? null;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const press = (id: string) => { void controller.pressField(d.key, id).catch(fail); };
  const options = sources.map(x => ({value: x.tag, label: [x.author, x.title, x.year].filter(Boolean).join('; ') ? `${x.tag} — ${[x.author, x.title, x.year].filter(Boolean).join('; ')}` : x.tag}));
  const open = (init: Record<string, unknown>) => { try { controller.openDialog('dialog.source', {parent: d.key, init}); } catch (e) { fail(e); } };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try { await controller.run('references.sources', {importData: await f.text()}, {origin: 'dialog'}); } catch (e) { fail(e); }
  };
  return <div className="gd-fields" data-dialog-page="Sources">
    <div style={grid('minmax(0, 1fr) 120px', {alignItems: 'start'})}>
      <Field d={d} id="list" set={set} options={options}/>
      <div style={{display: 'grid', gap: 8, marginTop: 22}}>
        <button type="button" className="sf-button" data-field-id="new" onClick={() => open({cite: false, edit: false})}>New…</button>
        <button type="button" className="sf-button" data-field-id="edit" disabled={!selected} onClick={() => selected && open({...selected, cite: false, edit: true, showAll: false})}>Edit…</button>
        <button type="button" className="sf-button" data-field-id="delete" disabled={!selected} onClick={() => press('delete')}>Delete</button>
        <button type="button" className="sf-button" data-field-id="insertCitation" disabled={!selected} onClick={() => press('insertCitation')}>Insert Citation</button>
        <button type="button" className="sf-button" data-field-id="import" onClick={() => file.current?.click()}>Import…</button>
        <input ref={file} type="file" accept=".xml,text/xml,application/xml" hidden onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }}/>
      </div>
    </div>
    <div className="sf" data-field-id="preview" style={{marginTop: 10}}>
      <div className="sf-label">Preview ({style}):</div>
      <div role="note" aria-label="Preview" style={{minHeight: 60, padding: '8px 10px', background: '#fff', color: '#000', border: '1px solid var(--gd-border, #c9c9cf)', borderRadius: 4, fontSize: 12.5, lineHeight: 1.45}}>
        {selected ? <>
          <div><b>Citation:</b> {cite(selected, style, 1, '')}</div>
          <div style={{marginTop: 4}}><b>Bibliography Entry:</b></div>
          <div style={{paddingLeft: 18, textIndent: -18}}>{entry(selected, style, 1)}</div>
        </> : <span style={{color: '#77777f'}}>{sources.length ? 'Select a source to see how it is cited.' : 'No sources yet.'}</span>}
      </div>
    </div>
  </div>;
}

export default {Body};
