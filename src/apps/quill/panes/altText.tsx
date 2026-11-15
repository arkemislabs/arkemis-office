// The Alt Text pane (Picture Format and Shape Format › Accessibility › Alt Text): the selected picture, shape, text box,
// group or chart's description, with Mark as decorative (a decorative object has no description). Reads the object through
// object.info and writes through object.altText (picture.altText for a picture).
//
// Translated from wordcraft crates/ui-egui/src/a11y_pane.rs (`alt_text_pane`: description text, Mark as decorative) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt. Not translated:
// Generate alt text for me (needs an online service).

import {useEffect, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';

type Info = {type: string; alt: string; title: string; decorative: boolean};

export default function AltTextPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const st = session.state(docId, 'object.info') as {enabled: boolean; reason?: string; value?: Info};
  const info = st.enabled ? st.value ?? null : null;
  const [text, setText] = useState(info?.alt ?? '');
  const [message, setMessage] = useState('');
  useEffect(() => setText(info?.alt ?? ''), [info?.alt, info?.type]);
  const run = async (params: Record<string, unknown>) => {
    try { await controller.run('object.altText', params, {origin: 'bridge-ui'}); setMessage(''); } catch (e) { setMessage(toCommandError(e).message); }
  };
  if (!info) return <div className="quill-alt-pane" style={{fontSize: 12, color: '#b9bac1'}}>{st.reason ?? 'Select a picture or shape.'}</div>;
  return <div className="quill-alt-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5}}>
    <small style={{color: '#b9bac1'}}>Write a description of this {info.type === 'image' ? 'picture' : 'object'} for people who cannot see it.</small>
    <textarea className="sf-textarea" aria-label="Alt text description" rows={5} value={info.decorative ? '' : text} disabled={info.decorative}
      onChange={e => setText(e.target.value)} onBlur={() => { if (text !== info.alt) void run({text}); }}/>
    <label style={{display: 'inline-flex', gap: 6, alignItems: 'center'}}>
      <input type="checkbox" checked={info.decorative} onChange={e => run({decorative: e.target.checked})} style={{position: 'static', opacity: 1, width: 'auto'}}/>Mark as decorative
    </label>
    {message ? <small role="alert" style={{color: '#ff9d9d'}}>{message}</small> : null}
  </div>;
}
