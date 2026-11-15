// Output Preview: the simulation profile, the inks (process and spot) with the pages that print them, the colour spaces in use and the colour warnings.
// Not checked against upstream (it has no Output Preview); the page itself is not simulated.
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {useReport, Row, Box} from './_report';

type Any = any;
const pagesText = (p: number[]) => (p.length ? `page${p.length === 1 ? '' : 's'} ${p.slice(0, 8).map(n => n + 1).join(', ')}${p.length > 8 ? ' …' : ''}` : '');

function Body(_: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const {data, error, busy} = useReport<Any>('standards.output_preview', {});
  return <div className="rp" data-testid="output-preview-dialog">
    <div className="rp-line"><span className="rp-muted">Simulation profile:</span><b data-testid="simulation-profile">{data?.simulationProfile ?? (busy ? 'Reading…' : '')}</b></div>
    <b>Separations</b>
    <Box testid="separations">
      {!data ? <span className="rp-muted">{error ? "Could not read the separations." : "Reading the inks…"}</span> : null}
      {data && !data.separations.length ? <span className="rp-muted">{data.colorSpaces.some((c: Any) => c.name === 'DeviceRGB') ? 'No process or spot inks: the pages are drawn in RGB.' : 'No inks found: the pages draw no colour.'}</span> : null}
      {(data?.separations ?? []).map((i: Any) => <Row key={i.name} status="passed" label={`${i.name} (${i.kind})`} details={[pagesText(i.pages)]}/>)}
    </Box>
    <b>Color spaces</b>
    <table className="rp-table"><thead><tr><th>Space</th><th>Pages</th></tr></thead><tbody>
      {(data?.colorSpaces ?? []).map((c: Any) => <tr key={c.name}><td>{c.name}</td><td>{pagesText(c.pages)}</td></tr>)}
    </tbody></table>
    <b>Color warnings</b>
    <Box testid="color-warnings">
      {data && !data.warnings.length ? <span>No color warnings.</span> : null}
      {(data?.warnings ?? []).map((w: Any, k: number) => <Row key={k} status="failed" label={w.message} details={w.page !== null ? [`Page ${w.page + 1}`] : []}/>)}
    </Box>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    {data ? <div className="rp-verdict">{data.note}</div> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
