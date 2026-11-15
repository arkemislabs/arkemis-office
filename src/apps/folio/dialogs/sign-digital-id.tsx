// Sign with a Digital ID, step by step: Choose (the IDs with issuer and expiry; Remove; Configure
// New Digital ID) ▸ Configure (use an ID from a .pfx/.p12 file, or create a self-signed one saved
// to a password-protected file) ▸ Sign as (appearance labels, graphic, reason, location,
// permitted actions when certifying, the ID's password). Back / Continue are here; Sign and
// Cancel are the dialog's buttons.
//
// Translated from printcraft crates/ui-egui/src/tools/sign_ui/dialog.rs (dialog: the three steps,
// what each shows, Continue creating or importing the ID) and sign_ui.rs (KEY_ALGORITHMS,
// create_digital_id, import_digital_id, remove_digital_id) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).

import {useEffect, useRef, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {DialogOverride} from '../../../shell/dialogs/DialogHost';

import './signature-pad.css';

type Any = any;
const ALGS: [string, string][] = [['2048-bit RSA', 'rsa2048'], ['3072-bit RSA', 'rsa3072'], ['4096-bit RSA', 'rsa4096'], ['256-bit ECDSA (P-256)', 'p256']];
const LABELS: [string, string][] = [['name', 'Name'], ['date', 'Date'], ['reason', 'Reason'], ['location', 'Location'], ['dn', 'Distinguished name'], ['labels', 'Labels']];
const GRAPHICS: [string, string][] = [['name', "Signer's name"], ['fillsign', 'Fill & Sign signature'], ['image', 'Image'], ['none', 'None']];
const PERMITTED = ['No changes allowed', 'Form fill-in and digital signatures', 'Annotations, form fill-in, and digital signatures'];

function Text({id, label, value, set, secret = false}: {id: string; label: string; value: Any; set: (v: string) => void; secret?: boolean}) {
  return <div className="sf"><label className="sf-label" htmlFor={`sd-${id}`}>{label}</label>
    <div className="sf-control"><input id={`sd-${id}`} className="sf-input" type={secret ? 'password' : 'text'} value={value ?? ''} onChange={e => set(e.target.value)}/></div></div>;
}

function Body({dialog, setValue}: {dialog: Any; setValue: (f: string, v: unknown) => void}) {
  const {controller} = useEngine();
  const v = dialog.values;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: string, args: Any) => { const r: Any = await controller.run(id, args, {origin: 'dialog'}); return r?.result; };
  const refreshIds = async (select: string | null) => {
    const r = await run('sign.id.list', {});
    const ids = r?.ids ?? [];
    setValue('ids', ids);
    setValue('selected', select ? ids.findIndex((x: Any) => x.fingerprint === select) : ids.length ? 0 : -1);
  };
  const cont = async () => {
    setError(null); setBusy(true);
    try {
      if (v.step === 'choose') { if (v.selected < 0) throw new Error('Choose a digital ID.'); setValue('step', 'sign'); return; }
      if (v.step === 'configure') {
        let made: Any;
        if (v.kind === 'file') made = await run('sign.id.import', {...(v.file ? {path: v.file} : {}), password: v['file-password']});
        else made = await run('sign.id.create', {name: v.name, unit: v.ou, organization: v.org, email: v.email, country: v.country, algorithm: v.alg, password: v.password, confirm: v.confirm});
        if (!made || made.canceled) return;
        await refreshIds(made.fingerprint);
        setValue('step', 'sign');
      }
    } catch (e: Any) { setError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  // Back and Continue are the dialog's footer buttons (one row with Sign and Cancel): they ask this body to go on or back.
  const latest = useRef({v, cont, busy});
  latest.current = {v, cont, busy};
  useEffect(() => {
    const on = (e: Event) => {
      const {v: now, cont: go, busy: working} = latest.current;
      const what = (e as CustomEvent).detail;
      if (what === 'continue' && now.step !== 'sign' && !working) void go();
      else if (what === 'back' && now.step !== 'choose' && (now.ids ?? []).length) setValue('step', 'choose');
    };
    window.addEventListener('folio:sign-step', on);
    return () => window.removeEventListener('folio:sign-step', on);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const show = new Set<string>(v.show ?? []);
  return <div className="fsd">
    <ol className="fsd-steps"><li className={v.step === 'choose' ? 'is-on' : ''}>Choose ID</li><li className={v.step === 'configure' ? 'is-on' : ''}>Configure</li><li className={v.step === 'sign' ? 'is-on' : ''}>Sign as</li></ol>
    {v.step === 'choose' ? <>
      <p className="sf-label">Choose the digital ID that you want to use for signing:</p>
      <div className="sf-list" role="listbox" aria-label="Digital IDs">
        {(v.ids ?? []).map((id: Any, i: number) => <div key={id.fingerprint} role="option" aria-selected={v.selected === i} className={`sf-list-item${v.selected === i ? ' is-selected' : ''}`} onClick={() => setValue('selected', i)}>
          <b>{id.name}</b><small> Issued by: {id.issuer}, Expires: {id.expires}</small></div>)}
      </div>
      <div className="fsd-row">
        <button type="button" className="gd-button" disabled={v.selected < 0} onClick={async () => { try { await run('sign.id.remove', {digitalId: v.ids[v.selected].fingerprint}); await refreshIds(null); } catch (e: Any) { setError(String(e?.message ?? e)); } }}>Remove</button>
        <button type="button" className="gd-button" onClick={() => setValue('step', 'configure')}>Configure New Digital ID</button>
      </div>
    </> : null}
    {v.step === 'configure' ? <>
      <div className="sf"><div className="sf-control" role="radiogroup" aria-label="Digital ID">
        <label><input type="radio" checked={v.kind === 'file'} onChange={() => setValue('kind', 'file')}/> Use a Digital ID from a file</label>
        <label><input type="radio" checked={v.kind !== 'file'} onChange={() => setValue('kind', 'create')}/> Create a new Digital ID</label>
      </div></div>
      {v.kind === 'file' ? <>
        <Text id="file" label="File (.p12, .pfx); leave empty to browse" value={v.file} set={x => setValue('file', x)}/>
        <Text id="file-password" label="Password" value={v['file-password']} set={x => setValue('file-password', x)} secret/>
      </> : <>
        <Text id="name" label="Name" value={v.name} set={x => setValue('name', x)}/>
        <Text id="ou" label="Organizational Unit" value={v.ou} set={x => setValue('ou', x)}/>
        <Text id="org" label="Organization Name" value={v.org} set={x => setValue('org', x)}/>
        <Text id="email" label="Email Address" value={v.email} set={x => setValue('email', x)}/>
        <Text id="country" label="Country/Region (two letters)" value={v.country} set={x => setValue('country', x.toUpperCase().slice(0, 2))}/>
        <div className="sf"><label className="sf-label" htmlFor="sd-alg">Key Algorithm</label><div className="sf-control">
          <select id="sd-alg" className="sf-input" value={v.alg} onChange={e => setValue('alg', e.target.value)}>{ALGS.map(([l, k]) => <option key={k} value={k}>{l}</option>)}</select></div></div>
        <Text id="password" label="Password (at least 8 characters)" value={v.password} set={x => setValue('password', x)} secret/>
        <Text id="confirm" label="Confirm Password" value={v.confirm} set={x => setValue('confirm', x)} secret/>
      </>}
    </> : null}
    {v.step === 'sign' ? <>
      <p className="sf-label">Sign as “{v.ids?.[v.selected]?.name ?? ''}”</p>
      {v.rect || v.field ? <>
        <div className="sf"><span className="sf-label">Appearance: show</span><div className="sf-control fsd-checks">
          {LABELS.map(([k, l]) => <label key={k}><input type="checkbox" checked={show.has(k)} onChange={() => { const s = new Set(show); if (s.has(k)) s.delete(k); else s.add(k); setValue('show', [...s]); }}/> {l}</label>)}
        </div></div>
        <div className="sf"><span className="sf-label">Graphic</span><div className="sf-control fsd-checks" role="radiogroup">
          {GRAPHICS.map(([k, l]) => <label key={k}><input type="radio" checked={v.graphic === k} onChange={() => setValue('graphic', k)}/> {l}</label>)}
        </div></div>
        {v.graphic === 'image' ? <button type="button" className="gd-button" onClick={async () => { const p: Any = await (window as Any).studio?.pickImage?.(); const url = typeof p === 'string' ? p : p?.dataUrl; if (url) setValue('image', url.replace(/^data:[^,]+,/, '')); }}>{v.image ? 'Change image…' : 'Choose image…'}</button> : null}
      </> : <p className="sf-note">Invisible signature.</p>}
      {v.certify ? <div className="sf"><label className="sf-label" htmlFor="sd-perm">Permitted actions after certifying</label><div className="sf-control">
        <select id="sd-perm" className="sf-input" value={v.permitted} onChange={e => setValue('permitted', Number(e.target.value))}>{PERMITTED.map((l, i) => <option key={i} value={i + 1}>{l}</option>)}</select></div></div> : null}
      <Text id="reason" label="Reason" value={v.reason} set={x => setValue('reason', x)}/>
      <Text id="location" label="Location" value={v.location} set={x => setValue('location', x)}/>
      <Text id="id-password" label="Digital ID password" value={v['id-password']} set={x => setValue('id-password', x)} secret/>
    </> : null}
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

const override: DialogOverride = {Body};
export default override;
