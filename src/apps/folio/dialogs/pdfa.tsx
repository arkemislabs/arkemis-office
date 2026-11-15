// PDF/A (printcraft crates/ui-egui/src/dialogs/standards_ui.rs at 8f16855): the declared conformance (with Remove), the output intent, the conformance level, the
// problems with their ISO 19005 clause and "not fixable here", Verify and Save as PDF/A. A pass lists the checks made and the ones not made.
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {useReport, Row, Scope, Box} from './_report';

type Any = any;

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const level = String(dialog.values.level ?? 'PDF/A-2b');
  const {data, error, busy, run, controller} = useReport<Any>('standards.pdfa.verify', {level});
  const decl = useReport<Any>('standards.read', {});
  const act = async (cmd: string, p: Record<string, unknown>) => { try { await controller.run(cmd, p, {origin: 'ui'}); } catch (e: Any) { /* shown by the toast */ } await run(); await decl.run(); };
  const shown = (decl.data?.declared ?? []).join(', ') || 'none';
  return <div className="rp" data-testid="pdfa-dialog">
    <div className="rp-line"><span>Declared conformance: {shown}</span>
      {decl.data?.pdfa ? <button type="button" className="gd-button" onClick={() => void act('standards.pdfa.remove_id', {})}>Remove PDF/A identification</button> : null}</div>
    {(decl.data?.outputIntents ?? []).length ? <div className="rp-muted">Output intent: {decl.data.outputIntents.join(', ')}</div> : null}
    <div className="rp-line"><label htmlFor="pdfa-level">Conformance level:</label>
      <select id="pdfa-level" value={level} onChange={e => { setValue('level', e.target.value); }}>{['PDF/A-2b', 'PDF/A-3b'].map(l => <option key={l}>{l}</option>)}</select></div>
    <Box testid="pdfa-problems">
      {!data ? <span className="rp-muted">{busy ? 'Verifying…' : 'Verify to see what the document needs.'}</span> : data.issues.length === 0
        ? <span>No problems found in the checks listed below.</span>
        : data.issues.map((i: Any, k: number) => <Row key={k} status="failed" label={`${i.message}${i.page !== null ? ` (page ${i.page + 1})` : ''}`} clause={`ISO 19005 ${i.clause}${i.fixable ? '' : '  · not fixable here'}`}/>)}
    </Box>
    {data ? <div className={`rp-verdict${data.issues.length ? ' is-bad' : ''}`} data-testid="pdfa-verdict">{data.message}</div> : null}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    <div className="rp-actions"><span className="rp-spacer"/>
      <button type="button" className="gd-button" disabled={busy} onClick={() => void run()}>Verify</button>
      <button type="button" className="gd-button" disabled={busy} onClick={() => void act('standards.pdfa.convert', {level})}>Save as PDF/A</button></div>
    {data ? <Scope checked={data.checked} notVerified={data.notVerified}/> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
