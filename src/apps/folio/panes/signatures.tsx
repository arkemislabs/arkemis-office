// The Signatures panel (spec pane `signatures`): Validate All, one row per signature field with its
// verdict (valid / invalid / unknown signer, unsigned field), what changed after signing, the
// signer, time, reason and location, and Certificate Details…, Add to Trusted Certificates, Go to
// the signature.
//
// Translated from printcraft crates/ui-egui/src/tools/sign_ui/panel.rs (panel, banner,
// signature_status_style, PanelAction) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). It reads through sign.panel and writes
// through commands only.

import {useEffect, useState, type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import './comments.css';

type Any = any;

/** panel.rs `banner`: a problem first, then the certification, then all-valid. */
function banner(rows: Any[]): {kind: string; text: string} | null {
  const signed = rows.filter(r => r.signed);
  if (!signed.length) return null;
  if (signed.some(r => r.status === 'invalid')) return {kind: 'invalid', text: 'At least one signature is invalid.'};
  if (signed.some(r => r.status === 'unknown')) return {kind: 'unknown', text: 'At least one signature has problems.'};
  const cert = signed.find(r => r.certify);
  if (cert) return {kind: 'valid', text: `Certified by ${cert.signer ?? 'unknown'}.`};
  return {kind: 'valid', text: 'Signed and all signatures are valid.'};
}

export default function SignaturesPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [rows, setRows] = useState<Any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (id: string, args: Any = {}) => controller.run(id, args, {origin: 'ui'});
  const refresh = (cmd = 'sign.panel') => {
    run(cmd, cmd === 'sign.panel' ? {open: true} : {})
      .then((r: Any) => { setRows(r?.result?.signatures ?? []); setError(null); })
      .catch((e: Any) => setError(String(e?.message ?? e)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [tick]);
  const b = rows ? banner(rows) : null;
  return <div className="fs-pane">
    <div className="fs-toolbar"><button type="button" onClick={() => refresh('sign.validate')}>Validate All</button></div>
    {b ? <div className={`fs-banner is-${b.kind}`} role="status">{b.text}</div> : null}
    {error ? <div className="fs-banner is-invalid">{error}</div> : null}
    {rows && !rows.length ? <div className="shell-pane-empty">This document has no signature fields.</div> : null}
    {(rows ?? []).map((r: Any) => <article key={r.field} className="fs-row" data-field={r.field}>
      <header><span className={`fs-dot is-${r.signed ? r.status : 'none'}`}/>
        <b>{r.signed ? `Rev. ${r.revision}: Signed by ${r.signer ?? 'unknown'}` : `${r.field} (unsigned signature field)`}</b></header>
      <ul>
        <li>{r.summary}</li>
        {r.certify ? <li>Certified: {['', 'no changes allowed', 'form fill-in and digital signatures allowed', 'annotations, form fill-in and digital signatures allowed'][r.certify]}</li> : null}
        {r.details.map((d: string, i: number) => <li key={i}>{d}</li>)}
        {r.modification?.kind && r.modification.kind !== 'none' ? <li>Changes after signing: {r.modification.changes.join(', ')}</li> : null}
        {r.signingTime ? <li>Signing time: {r.signingTime}</li> : null}
        {r.reason ? <li>Reason: {r.reason}</li> : null}
        {r.location ? <li>Location: {r.location}</li> : null}
        {r.page ? <li>Field: {r.field} on page {r.page}</li> : null}
      </ul>
      {r.signed ? <div className="fs-actions">
        <button type="button" onClick={() => controller.openDialog('dialog.certificate-viewer', {init: {field: r.field}})}>Certificate Details…</button>
        <button type="button" onClick={() => { void run('sign.trust', {field: r.field}).then(() => refresh('sign.validate')).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error')); }}>Add to Trusted Certificates</button>
        {r.page ? <button type="button" onClick={() => { void run('surface.scroll', {page: r.page}).catch(() => {}); }}>Go to signature</button> : null}
      </div> : <div className="fs-actions">
        <button type="button" onClick={() => controller.openDialog('dialog.sign-digital-id', {init: {field: r.field}})}>Sign…</button>
      </div>}
    </article>)}
  </div>;
}
