// The stamp palette (spec pane `stamps`): Dynamic, Sign Here and Standard Business stamps drawn in
// their colours, the custom stamps with Create Custom Stamp… and Delete. Picking a stamp makes
// it the tool; a click on the page places it (comment.stamp {at}).
//
// Translated from printcraft crates/ui-egui/src/tools/stamps_ui.rs (groups, swatches, the custom
// stamps section) and crates/annot/src/types.rs (StampKind labels and colours) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).

import {type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {STAMPS} from '../../../../core/folio/model/types.mjs';
import './comments.css';

type Any = any;
const GROUPS: [string, string][] = [['Dynamic', 'Dynamic'], ['SignHere', 'Sign Here'], ['StandardBusiness', 'Standard Business']];
const rgb = (c: number[]) => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;

export default function StampsPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: Any = (() => { try { return session.get(docId); } catch { return null; } })();
  const current = doc?.view?.tool === 'comment.stamp' ? doc?.view?.stamp : null;
  const custom: Any[] = (session.prefs as Any)?.customStamps ?? [];
  const pick = (stamp: string | null, customId: string | null = null) => controller.run('comment.stamp', customId ? {custom: customId} : {stamp}, {origin: 'ui'})
    .catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
  return <div className="fst-pane">
    {GROUPS.map(([g, label]) => <section key={g} className="fst-group">
      <h3>{label}</h3>
      <div className="fst-grid">
        {STAMPS.filter((s: Any) => s.group === g).map((s: Any) => <button key={s.name} type="button" className={`fst-stamp${current === s.name ? ' is-on' : ''}`}
          style={{color: rgb(s.color)}} aria-pressed={current === s.name} title={s.label} onClick={() => void pick(s.name)}>{s.label}</button>)}
      </div>
    </section>)}
    <section className="fst-group">
      <h3>Custom stamps</h3>
      {custom.map((c: Any) => <div key={c.id} className="fst-custom">
        <button type="button" className={`fst-stamp${current === c.id ? ' is-on' : ''}`} onClick={() => void pick(null, c.id)}>{c.name}</button>
        <small>{c.category}</small>
        <button type="button" className="fc-icon" aria-label={`Delete stamp ${c.name}`} onClick={() => void controller.run('comment.stamp.custom.delete', {custom: c.id}, {origin: 'ui'})}>×</button>
      </div>)}
      <div className="fs-actions"><button type="button" onClick={() => controller.openDialog('dialog.create-stamp')}>Create custom stamp…</button></div>
    </section>
  </div>;
}
