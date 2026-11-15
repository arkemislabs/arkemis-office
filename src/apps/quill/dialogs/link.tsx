// Insert Hyperlink view (Insert › Links › Link, Ctrl+K): Link to on the left as Word draws it (an icon for each place a link can go), Text to
// display and the Address, the E-mail Address boxes or the places in this document (Top of the Document, Headings, Bookmarks) on the right,
// over core/quill/dialogs/link.mjs (wordcraft dispatch.rs `link_dialog`). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

const ICONS: Record<string, React.ReactElement> = {
  file: <><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="12" cy="15" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M8.8 15h6.4M12 11.8c1.6 1.8 1.6 4.6 0 6.4M12 11.8c-1.6 1.8-1.6 4.6 0 6.4" fill="none" stroke="currentColor" strokeWidth="1"/></>,
  place: <><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M9 13h6M9 17h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M15.5 12.5l2.5 2.5-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></>,
  email: <><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M3.5 7l8.5 6.5L20.5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></>,
};
const CHOICES: [string, string][] = [['file', 'Existing File or Web Page'], ['place', 'Place in This Document'], ['email', 'E-mail Address']];

/** A file path as the address Word keeps for a link to a file. */
const fileAddress = (path: string) => `file:///${encodeURI(path.replace(/\\/g, '/'))}`;

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const v = d.values as {places?: {value: string; label: string}[]; linkTo?: string; tip?: string};
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  // Browse for File: the system Open dialog (any file type); only the chosen path comes back.
  const browse = async () => {
    try {
      const picked = await window.studio.pickDocument?.({all: true, pathOnly: true});
      if (picked?.path) { set('linkTo', 'file'); set('address', fileAddress(picked.path)); if (!String(d.values.text ?? '').trim()) set('text', picked.name); }
    } catch (e) { fail(e); }
  };
  const pickPlace = async () => {
    try { const r = await controller.collectDialog('dialog.selectPlace', {}); if (r?.place) set('place', r.place); } catch (e) { fail(e); }
  };
  const screenTip = async () => {
    try { const r = await controller.collectDialog('dialog.screenTip', {tip: v.tip ?? ''}); if (r) set('tip', String(r.tip ?? '')); } catch (e) { fail(e); }
  };
  return <div className="gd-fields" style={{display: 'grid', gridTemplateColumns: '236px minmax(0, 1fr)', gap: 18}}>
    <div className="sf" data-field-id="linkTo" role="listbox" aria-label="Link to">
      <span className="sf-label">Link to:</span>
      <div style={{display: 'grid', gap: 4, marginTop: 4}}>
        {CHOICES.map(([k, label]) => <button key={k} type="button" role="option" aria-selected={v.linkTo === k} className={`sf-button${v.linkTo === k ? ' is-selected' : ''}`}
          style={{display: 'grid', gridTemplateColumns: '28px 1fr', alignItems: 'center', gap: 6, height: 44, padding: '0 8px', textAlign: 'left', fontSize: 12, lineHeight: 1.15,
            ...(v.linkTo === k ? {outline: '2px solid #5b9bd5', outlineOffset: -2, background: 'rgba(91,155,213,.22)'} : {})}} onClick={() => set('linkTo', k)}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">{ICONS[k]}</svg><span>{label}</span>
        </button>)}
      </div>
    </div>
    <div>
      <div style={{display: 'flex', gap: 8, alignItems: 'end'}}>
        <div style={{flex: 1, minWidth: 0}}><Field d={d} id="text" set={set}/></div>
        <button type="button" className="sf-button" data-field-id="screenTip" onClick={() => { void screenTip(); }}>ScreenTip…</button>
      </div>
      {v.linkTo === 'file' ? <>
        <div style={{marginTop: 10}}><Field d={d} id="address" set={set}/></div>
        <div style={{display: 'flex', gap: 8, marginTop: 8}}>
          <button type="button" className="sf-button" data-field-id="browse" onClick={() => { void browse(); }}>Browse for File…</button>
          <button type="button" className="sf-button" data-field-id="bookmark" onClick={() => { void pickPlace(); }}>Bookmark…</button>
        </div>
      </> : null}
      <div style={{marginTop: 10}}><Field d={d} id="email" set={set}/></div>
      <div style={{marginTop: 10}}><Field d={d} id="subject" set={set}/></div>
      <div style={{marginTop: 10}}><Field d={d} id="place" set={set} options={v.places ?? []}/></div>
      <div style={{marginTop: 10}}><Field d={d} id="removeLink" set={set}/></div>
    </div>
  </div>;
}

export default {Body};
