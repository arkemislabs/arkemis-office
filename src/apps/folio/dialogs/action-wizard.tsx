// Action Wizard (printcraft crates/ui-egui/src/workflows/actions_ui.rs at 8f16855): the actions in a list with the steps of the one chosen, Run on this document, New action,
// Edit and Delete (the actions made here; the built-in ones stay). An action is a list of steps; adding a step picks it from the steps there are, with its text where it takes
// one. Upstream runs an action over files into a folder; here it runs on the open document, as one undo step, and the log says what each step did.
import {useEffect, useState} from 'react';
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {Icon} from '../../../shell/icons/Icon';
import {useReport, Row, Box} from './_report';

type Any = any;
type Step = {id: string; arg?: string};

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const {data, error, busy, run, controller} = useReport<Any>('actions.list', {});
  const [log, setLog] = useState<Any>(null);
  const [editing, setEditing] = useState<null | {name: string; description: string; steps: Step[]; was: string | null}>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const actions: Any[] = data?.actions ?? [];
  const catalog: Any[] = data?.steps ?? [];
  const chosen = String(dialog.values.action ?? '');
  const current = actions.find(a => a.name === chosen) ?? actions[0];
  useEffect(() => { if (!chosen && actions[0]) setValue('action', actions[0].name); }, [chosen, actions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const exec = async (cmd: string, p: Record<string, unknown>) => { try { const r: Any = await controller.run(cmd, p, {origin: 'ui'}); return r?.result ?? null; } catch (e: Any) { setProblem(String(e?.message ?? e)); return null; } };
  const labelOf = (id: string) => catalog.find(x => x.id === id)?.label ?? id;
  if (editing) {
    const set = (patch: Partial<typeof editing>) => setEditing({...editing, ...patch});
    const move = (i: number, by: number) => { const s = [...editing.steps]; const j = i + by; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j], s[i]]; set({steps: s}); };
    return <div className="rp" data-testid="action-editor">
      <div className="rp-line"><label htmlFor="aw-name">Action name:</label><input id="aw-name" className="sf-text" value={editing.name} onChange={e => set({name: e.target.value})}/></div>
      <div className="rp-line"><label htmlFor="aw-desc">Description:</label><input id="aw-desc" className="sf-text" value={editing.description} onChange={e => set({description: e.target.value})}/></div>
      <Box testid="action-steps">
        {editing.steps.length ? editing.steps.map((st, i) => <div key={i} className="rp-line" data-step={st.id}><b>{i + 1}.</b> <span>{labelOf(st.id)}</span>
          {catalog.find(x => x.id === st.id)?.arg ? <input className="sf-text" aria-label={catalog.find(x => x.id === st.id).arg} placeholder={catalog.find(x => x.id === st.id).arg} value={st.arg ?? ''}
            onChange={e => set({steps: editing.steps.map((x, k) => (k === i ? {...x, arg: e.target.value} : x))})}/> : null}
          <span className="rp-spacer"/>
          <button type="button" className="gd-button" aria-label="Move up" onClick={() => move(i, -1)}><Icon id="arrow-up" size={16}/></button>
          <button type="button" className="gd-button" aria-label="Move down" onClick={() => move(i, 1)}><Icon id="arrow-down" size={16}/></button>
          <button type="button" className="gd-button" aria-label="Remove" onClick={() => set({steps: editing.steps.filter((_, k) => k !== i)})}>Remove</button></div>)
          : <span className="rp-muted">No steps yet: add one.</span>}
      </Box>
      <div className="rp-line"><label htmlFor="aw-add">Add Step</label>
        <select id="aw-add" value="" onChange={e => { if (e.target.value) set({steps: [...editing.steps, {id: e.target.value, ...(catalog.find(x => x.id === e.target.value)?.arg ? {arg: ''} : {})}]}); }}>
          <option value="">Choose a step…</option>{catalog.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
      {problem ? <small className="sf-error" role="alert">{problem}</small> : null}
      <div className="rp-actions"><span className="rp-spacer"/>
        <button type="button" className="gd-button" onClick={() => { setEditing(null); setProblem(null); }}>Cancel</button>
        <button type="button" className="gd-button" disabled={!editing.name.trim() || !editing.steps.length} onClick={async () => {
          const saved = await exec('actions.save', {name: editing.name, description: editing.description, steps: editing.steps});
          if (saved) { if (editing.was && editing.was !== editing.name.trim()) await exec('actions.delete', {name: editing.was}); await run(); setValue('action', editing.name.trim()); setEditing(null); setProblem(null); }
        }}>Save</button></div>
    </div>;
  }
  return <div className="rp" data-testid="action-wizard">
    <div className="rp-line"><label htmlFor="aw-action">Action:</label>
      <select id="aw-action" value={current?.name ?? ''} onChange={e => { setValue('action', e.target.value); setLog(null); }}>{actions.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}</select>
      <span className="rp-spacer"/>
      <button type="button" className="gd-button" onClick={() => setEditing({name: '', description: '', steps: [], was: null})}>New Action…</button>
      <button type="button" className="gd-button" disabled={!current || current.builtin} onClick={() => current && setEditing({name: current.name, description: current.description, steps: current.steps.map((x: Any) => ({id: x.id, ...(x.arg !== undefined ? {arg: x.arg} : {})})), was: current.name})}>Edit…</button>
      <button type="button" className="gd-button" disabled={!current || current.builtin} onClick={async () => { if (current && await exec('actions.delete', {name: current.name})) { await run(); setValue('action', ''); } }}>Delete</button></div>
    {current ? <div className="rp-muted">{current.description}</div> : null}
    <b>Steps</b>
    <Box testid="steps">{(current?.steps ?? []).map((st: Any, i: number) => <Row key={i} status="not-checked" label={`${i + 1}. ${st.label}${st.arg ? `: ${st.arg}` : ''}`}/>)}</Box>
    {log ? <><b>Result</b><Box testid="action-log">{log.steps.map((l: Any, i: number) => <Row key={i} status={l.status === 'done' ? 'passed' : l.status === 'skipped' ? 'not-checked' : 'failed'} label={l.step} details={l.detail ? [l.detail] : []}/>)}</Box>
      <div className={`rp-verdict${log.failed ? ' is-bad' : ''}`}>{log.message}</div></> : null}
    {error || problem ? <small className="sf-error" role="alert">{error ?? problem}</small> : null}
    <div className="rp-actions"><span className="rp-spacer"/>
      <button type="button" className="gd-button" disabled={busy || !current} onClick={async () => { setProblem(null); const r = await exec('actions.run', {action: current.name}); if (r) setLog(r); }}>Run on this document</button></div>
    <small className="rp-muted">The action runs on the open document as one undo step. Running an action over many files into a folder is not offered.</small>
  </div>;
}

const override: DialogOverride = {Body};
export default override;
