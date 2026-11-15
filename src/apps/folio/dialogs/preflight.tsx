// Preflight: pick a profile, Analyze, read the results (what failed, what the profile did not check) and, for the PDF/A profiles, Save as PDF/A.
// The two PDF/A profiles are printcraft's checks (crates/preflight); the others are not checked against upstream.
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {useReport, Row, Scope, Box} from './_report';

type Any = any;

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const profile = String(dialog.values.profile ?? 'pdfa-2b');
  const profiles = useReport<Any>('standards.preflight.profiles', {});
  const {data, error, busy, run, controller} = useReport<Any>('standards.preflight', {profile});
  const list: {id: string; label: string; note: string}[] = profiles.data?.profiles ?? [];
  const convert = async () => { try { await controller.run('standards.pdfa.convert', {level: profile === 'pdfa-3b' ? 'PDF/A-3b' : 'PDF/A-2b'}, {origin: 'ui'}); } catch { /* the toast says why */ } await run(); };
  return <div className="rp" data-testid="preflight-dialog">
    <div className="rp-line"><label htmlFor="pf-profile">Profile:</label>
      <select id="pf-profile" value={profile} onChange={e => setValue('profile', e.target.value)}>{list.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
    <div className="rp-muted">{list.find(p => p.id === profile)?.note}</div>
    <Box testid="preflight-results">
      {!data ? <span className="rp-muted">{busy ? 'Analyzing…' : 'Analyze to see the results.'}</span> : data.items.length === 0 ? <span>Nothing to report for this profile.</span>
        : data.items.map((i: Any, k: number) => <Row key={k} status={i.status} label={i.label} clause={i.clause} details={i.details}/>)}
    </Box>
    {data ? <div className={`rp-verdict${data.ok ? '' : ' is-bad'}`} data-testid="preflight-verdict">{data.summary}</div> : null}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    <div className="rp-actions"><span className="rp-spacer"/>
      <button type="button" className="gd-button" disabled={busy} onClick={() => void run()}>Analyze</button>
      {profile.startsWith('pdfa') ? <button type="button" className="gd-button" disabled={busy} onClick={() => void convert()}>Save as PDF/A</button> : null}</div>
    {data ? <Scope checked={data.checked} notVerified={data.notVerified}/> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
