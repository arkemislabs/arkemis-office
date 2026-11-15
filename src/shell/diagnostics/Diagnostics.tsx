// Development-only diagnostics (docs/architecture.md section 13). AppHost imports this module only
// behind `process.env.ARKEMIS_DIAGNOSTICS === '1'`, which esbuild defines to "0" in production, so
// neither the panel nor this chunk exists in a production build.

import {useState} from 'react';
import {useEngine} from '../engine/EngineProvider';
import {useSessionTick, useShellState} from '../engine/useCommand';

export default function Diagnostics() {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const state = useShellState();
  const [open, setOpen] = useState(false);
  const doc = (() => { try { return session.get(docId); } catch { return null; } })();
  return <div className={`shell-diag${open ? ' is-open' : ''}`}>
    <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}>Diagnostics</button>
    {open ? <pre>{JSON.stringify({
      tick, version: doc?.version, dirty: doc?.dirty, undo: doc?.undo.labels().slice(0, 8), registry: session.registry.size,
      tab: state.tab, flags: state.flags, levels: state.levels, dialogs: state.dialogs.map(d => d.id), panes: state.panes,
      conflicts: controller.router.conflicts.map(c => `${c.scope} ${c.keys}: ${c.a.command} / ${c.b.command}`),
      journal: session.journal.slice(-8).map(j => `${j.origin} ${j.command}`),
    }, null, 2)}</pre> : null}
  </div>;
}
