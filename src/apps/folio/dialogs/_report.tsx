// Shared parts of the report dialogs (PDF/A, Preflight, Output Preview, Space Audit): run a read command when the dialog opens or the person asks, show its rows with a
// status icon, and always list what the check did not verify (a pass is never a statement of conformance).
import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {Icon} from '../../../shell/icons/Icon';
import './report.css';

type Any = any;

/** Run `command` with `params` (when `auto`), keep its result; `run` runs it again, with other params if given. */
export function useReport<T = Any>(command: string, params: Record<string, unknown>, auto = true) {
  const {controller} = useEngine();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(params);
  const run = useCallback(async (cmd = command, p: Record<string, unknown> = params) => {
    setBusy(true);
    try { const r: Any = await controller.run(cmd, p, {origin: 'ui'}); setData(r?.result ?? null); setError(null); return r?.result ?? null; }
    catch (e: Any) { setError(String(e?.message ?? e)); return null; }
    finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, command, key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (auto) void run(); }, [key]);
  return {data, setData, error, busy, run, controller};
}

const ICON: Record<string, string> = {passed: 'check-circle-2', failed: 'x-mark', 'not-checked': 'circle', manual: 'circle-help'};

export function Row({status, label, details, clause}: {status: string; label: string; details?: string[]; clause?: string}) {
  return <div className={`rp-row is-${status}`} data-status={status}>
    <Icon id={ICON[status] ?? 'circle'} size={16}/>
    <div className="rp-text"><span>{label}</span>{clause ? <small>{clause}</small> : null}{(details ?? []).slice(0, 8).map((d, i) => <small key={i}>{d}</small>)}{(details ?? []).length > 8 ? <small>… and {(details ?? []).length - 8} more</small> : null}</div>
  </div>;
}

/** What was and was not checked: shown for every pass and every failure alike. */
export function Scope({checked, notVerified}: {checked?: string[]; notVerified?: string[]}) {
  return <details className="rp-scope" data-testid="report-scope">
    <summary>What was checked and what was not</summary>
    {checked?.length ? <><b>Checked</b><ul>{checked.map(c => <li key={c}>{c}</li>)}</ul></> : null}
    {notVerified?.length ? <><b>Not verified</b><ul>{notVerified.map(c => <li key={c}>{c}</li>)}</ul></> : null}
  </details>;
}

export function Box({children, testid}: {children: ReactNode; testid?: string}) { return <div className="rp-box" data-testid={testid}>{children}</div>; }
