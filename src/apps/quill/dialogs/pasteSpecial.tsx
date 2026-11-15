// Paste Special drawn as upstream draws it: "Paste as:" with only the formats the clipboard holds
// (best first), "The clipboard is empty." when there are none, and the Result line for the choice.
// On opening it reads the system clipboard once (text, HTML, RTF, picture) into the dialog's payload
// values, so OK pastes what the person copied in another program; the values and OK are
// core/quill/dialogs/pasteSpecial.mjs, so the bridge drives the same dialog.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`paste_special_dialog`) at
// ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useEffect} from 'react';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {FORMATS} from '../../../../core/quill/lib/paste-content.mjs';
import {HINTS} from '../../../../core/quill/dialogs/pasteSpecial.mjs';
import './find.css';

function Body({dialog: d, setValue: set}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const {session} = useEngine() as any;
  const v = d.values;
  useEffect(() => {
    let alive = true;
    const read = session?.host?.clipboardRead;
    if (typeof read !== 'function' || d.origin === 'bridge') return;
    Promise.resolve(read()).then((got: any) => {
      if (!alive || !got) return;
      for (const k of ['text', 'html', 'rtf', 'picture']) if (typeof got[k] === 'string' && got[k] && v[k] === undefined) set(k, got[k]);
    }).catch(() => null);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const formats = Array.isArray(v.formats) ? v.formats as string[] : [];
  const label = (id: string) => FORMATS.find((x: string[]) => x[0] === id)?.[1] ?? id;
  const own = typeof v.ownText === 'string' && v.ownText ? v.ownText.replace(/s+/g, ' ').slice(0, 48) : null;
  const sel = typeof v.as === 'string' && formats.includes(v.as) ? v.as : null;
  // Word's layout: the Source line, Paste as the one way to paste, the As list of what the clipboard holds, and the Result under it.
  return <div className="qps" data-field-id="as">
    <p className="qps-head">Source: <span className="qps-src">{own ? `Quill text “${own}”` : formats.length ? 'Unknown Source' : 'nothing copied'}</span></p>
    <div className="qps-body">
      <div className="qps-radios" role="radiogroup" aria-label="Paste">
        <div className="sf sf-radio"><label><input type="radio" name="qps-mode" checked readOnly/><span className="sf-radio-dot" aria-hidden="true"/><span>Paste</span></label></div>
      </div>
      <div className="qps-as">
        <p className="qps-head">As:</p>
        <div className="sf-list" role="listbox" aria-label="As" style={{height: 132}}>
          {formats.map(id => <div key={id} role="option" aria-selected={sel === id} className={`sf-list-item${sel === id ? ' is-selected' : ''}`} style={{cursor: 'default'}} onClick={() => set('as', id)}>{label(id)}</div>)}
        </div>
      </div>
    </div>
    <div className="qps-result" data-field-id="result">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect x="7" y="4" width="20" height="26" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M11 11h12M11 15h12M11 19h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
      <div><p className="qps-head">Result</p>
        <p className="qps-hint">{sel ? (HINTS as Record<string, string>)[sel] ?? HINTS.text : 'The clipboard is empty: copy something first, then choose how to paste it.'}</p></div>
    </div>
  </div>;
}

export default {Body};
