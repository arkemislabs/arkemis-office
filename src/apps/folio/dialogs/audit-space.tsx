// Space Audit: "What takes up the space in this file, by kind of content." with Description, Bytes and Percentage for each kind that uses bytes and a Total row
// (printcraft crates/ui-egui/src/workflows/optimize_ui.rs audit_table at 8f16855).
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import {useReport} from './_report';

type Any = any;

function Body(_: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const {data, error, busy} = useReport<Any>('optimize.audit', {});
  return <div className="rp" data-testid="space-audit">
    <div className="rp-muted">What takes up the space in this file, by kind of content.</div>
    <table className="rp-table"><thead><tr><th>Description</th><th className="num">Bytes</th><th className="num">Percentage</th></tr></thead>
      <tbody>{(data?.rows ?? []).map((r: Any) => <tr key={r.category}><td>{r.category}</td><td className="num">{r.bytes}</td><td className="num">{r.percent.toFixed(2)}%</td></tr>)}
        {data ? <tr><td><b>Total</b></td><td className="num"><b>{data.total}</b></td><td className="num"/></tr> : <tr><td colSpan={3} className="rp-muted">{busy ? 'Measuring…' : ''}</td></tr>}</tbody></table>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
