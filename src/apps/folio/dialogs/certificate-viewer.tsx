// Certificate Viewer's body: the chain on the left (signer first, up to the root), Summary,
// Details and Trust for the certificate picked, Add to Trusted Certificates, Export….
//
// Translated from printcraft crates/ui-egui/src/tools/sign_ui/panel.rs (cert_viewer, CertTab,
// CertAction) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt). Reads sign.certificate, writes sign.trust and
// sign.certificate.export.

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';

import './signature-pad.css';

type Any = any;

/** Acrobat's Certificate Viewer tabs. Revocation, Policies and Legal Notice say what this viewer does and does not know. */
const TABS = [['summary', 'Summary'], ['details', 'Details'], ['revocation', 'Revocation'], ['trust', 'Trust'], ['policies', 'Policies'], ['legal', 'Legal Notice']] as const;
const POLICIES_OID = '2.5.29.32';

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const {controller} = useEngine();
  const v = dialog.values;
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('summary');
  const [data, setData] = useState<Any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => controller.run('sign.certificate', v.field ? {field: v.field} : {}, {origin: 'dialog'})
    .then((r: Any) => { setData(r?.result ?? null); setError(null); }).catch((e: Any) => setError(String(e?.message ?? e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [v.field]);
  const c = data?.chain?.[v.level ?? 0];
  const row = (k: string, val: Any) => <tr key={k}><th>{k}</th><td>{val ?? '—'}</td></tr>;
  return <div className="fcv">
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
    <div className="fcv-cols">
      <div className="sf-list" role="listbox" aria-label="Certificate chain">
        {(data?.chain ?? []).map((x: Any, i: number) => <div key={x.sha256} role="option" aria-selected={(v.level ?? 0) === i}
          className={`sf-list-item${(v.level ?? 0) === i ? ' is-selected' : ''}`} style={{paddingLeft: 8 + i * 10}} onClick={() => setValue('level', i)}>{x.name}</div>)}
        {!(data?.chain ?? []).length ? <div className="sf-list-empty">No certificate to show</div> : null}
      </div>
      <div className="fcv-main">
        <div className="gd-tabs" role="tablist">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-active' : undefined} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {!c && (tab === 'summary' || tab === 'details') ? <div className="fcv-trust"><p>There is no signing certificate to show. Choose a signature in the Signatures panel to see its certificate here.</p></div> : null}
        {c && tab === 'summary' ? <table className="fcv-table"><tbody>
          {row('Issued to', c?.issuedTo)}{row('Issued by', c?.issuedBy)}{row('Valid from', c?.validFrom)}{row('Valid to', c?.validTo)}
          {row('Intended usage', c?.keyUsage)}{row('Extended usage', c?.extendedKeyUsage)}
        </tbody></table> : null}
        {c && tab === 'details' ? <table className="fcv-table"><tbody>
          {row('Version', c?.version)}{row('Serial number', c?.serial)}{row('Public key', c?.publicKey)}{row('Basic constraints', c?.basicConstraints)}
          {row('Key usage', c?.keyUsage)}{row('Extended key usage', c?.extendedKeyUsage)}{row('SHA-256 digest', c?.sha256)}{row('SHA-1 digest', c?.sha1)}
          {row('Extensions', c ? c.extensions.map((e: Any) => `${e.oid}${e.critical ? ' (critical)' : ''}`).join(', ') : null)}
        </tbody></table> : null}
        {tab === 'revocation' ? <div className="fcv-trust"><p>Revocation checking (OCSP and CRL) is not done by this viewer, so it cannot say whether this certificate has been revoked.</p></div> : null}
        {tab === 'policies' ? <div className="fcv-trust"><p>{!c ? 'No certificate is shown.' : (c.extensions ?? []).some((e: Any) => e.oid === POLICIES_OID) ? 'This certificate declares certificate policies (extension 2.5.29.32); this viewer does not decode them.' : 'This certificate declares no certificate policies.'}</p></div> : null}
        {tab === 'legal' ? <div className="fcv-trust"><p>{!c ? 'No certificate is shown.' : 'This viewer does not decode the user notices of certificate policies, so no legal notice is shown.'}</p></div> : null}
        {tab === 'trust' ? <div className="fcv-trust">
          <p>{!c ? 'No certificate is shown.' : data.trusted ? 'This certificate is trusted for validating signatures.' : 'This certificate is not trusted.'}</p>
          <button type="button" className="gd-button" disabled={!c || data.trusted} onClick={() => controller.run('sign.trust', {...(v.field ? {field: v.field} : {}), level: v.level ?? 0}, {origin: 'dialog'}).then(() => load())
            .catch((e: Any) => setError(String(e?.message ?? e)))}>Add to Trusted Certificates</button>
        </div> : null}
      </div>
    </div>
  </div>;
}

const override: DialogOverride = {Body};
export default override;
