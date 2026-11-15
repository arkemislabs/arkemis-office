// The Restrict Editing pane (Review › Protect › Restrict Editing): 1. Formatting restrictions
// (Limit formatting to a selection of styles, Settings… with the allowed styles), 2. Editing
// restrictions (Only allow this kind of editing: No changes, Tracked changes, Comments, Filling in
// forms; Exceptions: Everyone), 3. Start Enforcing Protection (password and confirmation); while
// enforced: what is allowed, Find Next Editable Region and Stop Protection (password). Writes
// through review.restrict only. Translated from wordcraft crates/ui-egui/src/dialogs/
// dialogs_review.rs (`RestrictPane`, `EDIT_MODES`, `listed_styles`, `restrict_pane`, `setup_ui`,
// `passwords`, `enforced_ui`, `stop`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {Document} from '../../../../core/quill/model/document.mjs';
import {isQuill2} from '../../../../core/quill/model/content.mjs';
import {author as authorOf} from '../../../../core/quill/lib/caret-session.mjs';
import {protectState} from '../../../../core/quill/lib/review-protect.mjs';

const EDIT_MODES: [string, string][] = [['readOnly', 'No changes (read only)'], ['trackedChanges', 'Tracked changes'], ['comments', 'Comments'], ['forms', 'Filling in forms']];
const WHAT: Record<string, string> = {
  readOnly: 'The document is read only, except for regions marked editable.', comments: 'Only comments can be added, except in regions marked editable.',
  trackedChanges: 'Every change is recorded as a tracked change.', forms: 'Only form fields can be filled in.', none: 'Only the allowed styles can be applied.',
};
type State = {protection: string | null; formatting: boolean; password: boolean; lockedStyles: string[]; exceptions: number; regions: {start: string; end: string}[]; formFields: number};
type Style = {id: string; name?: string; kind: string; hidden?: boolean; locked?: boolean};

const head = (t: string) => <b style={{fontSize: 12.5, marginTop: 6}}>{t}</b>;

export default function RestrictEditingPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const ctx = session.readContext(docId) as unknown as {doc?: {settings?: {protection?: string | null; protectHash?: unknown[]}; styles?: {styles?: Style[]}}; selection?: unknown} | null;
  const styles = useMemo(() => (ctx?.doc?.styles?.styles ?? []).filter(s => (s.kind === 'paragraph' || s.kind === 'character') && !s.hidden)
    .map(s => ({id: s.id, name: s.name || s.id, locked: !!s.locked})).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())), [ctx?.doc?.styles]);
  const [formatting, setFormatting] = useState(false);
  const [showStyles, setShowStyles] = useState(false);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState('readOnly');
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  // What review.restrict reports, read straight from the document.
  const state = useMemo(() => {
    try { const doc = (session.get(docId) as any).file.content; return isQuill2(doc) ? protectState(new Document(doc), authorOf((session as any).prefs)) as State : null; } catch { return null; }
  }, [session, docId, tick]);
  const allowedIds = allowed ?? styles.filter(s => !s.locked).map(s => s.id);
  const run = async (params: Record<string, unknown>) => {
    try { await controller.run('review.restrict', params, {origin: 'bridge-ui'}); setMessage(''); return true; } catch (e) { setMessage(toCommandError(e).message); return false; }
  };
  const enforced = ctx?.doc?.settings?.protection ?? null;
  const field = (label: string, value: string, set: (v: string) => void) => <label style={{display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12}}>
    {label}<input className="sf-text" type="password" autoComplete="new-password" value={value} onChange={e => set(e.target.value)} style={{maxWidth: 220}}/>
  </label>;
  if (enforced) {
    const regions = (state?.exceptions ?? 0) + (state?.formFields ?? 0);
    return <div className="quill-restrict-pane" data-protection={enforced} style={{display: 'flex', flexDirection: 'column', gap: 8}}>
      <span>Editing in this document is restricted.</span>
      <small style={{color: '#b9bac1'}}>{WHAT[enforced] ?? WHAT.none}</small>
      {regions > 0 ? <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} onClick={() => run({next: true})}>Find Next Editable Region</button> : null}
      {!asking ? <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} data-pane-action="stop-protection"
        onClick={async () => { if (state?.password) { setAsking(true); setMessage(''); } else await run({stop: true}); }}>Stop Protection</button>
        : <>
          <small style={{color: '#b9bac1'}}>Type the password to stop the protection.</small>
          {field('Password:', password, setPassword)}
          <div style={{display: 'flex', gap: 6}}>
            <button type="button" className="sf-button" onClick={async () => { const ok = await run({stop: true, password}); setPassword(''); if (ok) setAsking(false); }}>OK</button>
            <button type="button" className="sf-button" onClick={() => { setAsking(false); setPassword(''); }}>Cancel</button>
          </div>
        </>}
      {message ? <small role="alert" style={{color: '#ff8a80'}}>{message}</small> : null}
    </div>;
  }
  const exceptionRange = (() => {
    const sel = ctx?.selection as {ranges?: {anchor: string; focus: string}[]} | undefined;
    const r = sel?.ranges?.[0];
    return r && r.anchor !== r.focus;
  })();
  return <div className="quill-restrict-pane" data-protection="" style={{display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflow: 'auto'}}>
    {head('1. Formatting restrictions')}
    <label className="sf-check"><input type="checkbox" checked={formatting} onChange={e => setFormatting(e.target.checked)}/> Limit formatting to a selection of styles</label>
    {formatting ? <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} onClick={() => setShowStyles(v => !v)}>Settings…</button> : null}
    {formatting && showStyles ? <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
      <small>Checked styles are allowed:</small>
      <div style={{display: 'flex', gap: 6}}>
        <button type="button" className="sf-button" onClick={() => setAllowed(styles.map(s => s.id))}>All</button>
        <button type="button" className="sf-button" onClick={() => setAllowed([])}>None</button>
      </div>
      <div style={{maxHeight: 160, overflow: 'auto', display: 'flex', flexDirection: 'column'}}>
        {styles.map(s => <label key={s.id} className="sf-check"><input type="checkbox" checked={allowedIds.includes(s.id)}
          onChange={e => setAllowed(e.target.checked ? [...allowedIds, s.id] : allowedIds.filter(x => x !== s.id))}/> {s.name}</label>)}
      </div>
    </div> : null}
    {head('2. Editing restrictions')}
    <label className="sf-check"><input type="checkbox" checked={editing} onChange={e => setEditing(e.target.checked)}/> Only allow this kind of editing:</label>
    <select className="sf-select" aria-label="Kind of editing" disabled={!editing} value={mode} onChange={e => setMode(e.target.value)} style={{maxWidth: 220}}>
      {EDIT_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
    {editing && (mode === 'readOnly' || mode === 'comments') ? <>
      <small style={{marginTop: 4}}>Exceptions (optional)</small>
      <small style={{color: '#b9bac1'}}>Select text, then tick who can still edit it.</small>
      <label className="sf-check"><input type="checkbox" disabled={!exceptionRange && !(state?.exceptions)} checked={false}
        onChange={() => run({exception: exceptionRange ? 'add' : 'remove'})}/> Everyone</label>
    </> : null}
    {head('3. Start enforcement')}
    {!asking ? <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} disabled={!formatting && !editing} data-pane-action="start-enforcing"
      onClick={() => { setAsking(true); setMessage(''); }}>Start Enforcing Protection</button>
      : <>
        <small style={{color: '#b9bac1'}}>The password is optional; without it anyone can stop the protection.</small>
        {field('Password:', password, setPassword)}
        {field('Confirm password:', confirm, setConfirm)}
        <div style={{display: 'flex', gap: 6}}>
          <button type="button" className="sf-button" onClick={async () => {
            if (password !== confirm) { setMessage("The passwords don't match."); setConfirm(''); return; }
            const p: Record<string, unknown> = {mode: editing ? mode : 'none', formatting};
            if (password) p.password = password;
            if (formatting) p.lockedStyles = styles.filter(s => !allowedIds.includes(s.id)).map(s => s.id);
            const ok = await run(p);
            setPassword(''); setConfirm('');
            if (ok) setAsking(false);
          }}>OK</button>
          <button type="button" className="sf-button" onClick={() => { setAsking(false); setPassword(''); setConfirm(''); }}>Cancel</button>
        </div>
      </>}
    {message ? <small role="alert" style={{color: '#ff8a80'}}>{message}</small> : null}
  </div>;
}
