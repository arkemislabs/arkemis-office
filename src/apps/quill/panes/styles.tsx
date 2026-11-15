// The Styles pane (Home › Styles launcher, Ctrl+Alt+Shift+S): Current style, New Style… / Update to
// Match / Clear, Manage Styles…, then every shown style by name with its ¶ / a mark; a click applies
// it (para.style), right-click gives Modify…, Update to Match Selection and Delete (built-in styles
// cannot be deleted). Reads through queries (format.state, the document's styles) and writes through
// commands only. Translated from wordcraft crates/ui-egui/src/panes/side.rs (`styles_pane`) at
// aadb077e072b7de05f724e359d8db82e151f125c. The Style Inspector toggle stays out until
// styles.inspector (the inspector family) is translated. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {modifyValues} from '../../../../core/quill/dialogs/modifyStyle.mjs';
import {caretStyle} from '../../../../core/quill/lib/format-dialogs.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';

type Style = {id: string; name: string; kind: string; hidden?: boolean; builtin?: boolean};

export default function StylesPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [menu, setMenu] = useState<{id: string; x: number; y: number} | null>(null);
  const ctx = session.readContext(docId) as unknown as {doc?: {styles?: {styles?: Style[]}}} | null;
  const sheet = ctx?.doc?.styles;
  const current = useMemo(() => {
    try { return caretStyle(session.readContext(docId)); } catch { return ''; }
  }, [session, docId, tick]);
  const list = useMemo(() => (sheet?.styles ?? []).filter(s => !s.hidden && s.kind !== 'table' && s.kind !== 'numbering')
    .map(s => ({id: s.id, name: s.name || s.id, char: s.kind === 'character', builtin: !!s.builtin}))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())), [sheet]);
  const currentName = list.find(s => s.id === current)?.name ?? current;
  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown> = {}) => { void controller.run(id, params, {origin: 'dialog'}).then(() => controller.focusSurface()).catch(fail); };
  const modify = (id: string) => { try { controller.openDialog('dialog.modifyStyle', {init: modifyValues(sheet, id)}); } catch (e) { fail(e); } };
  return <div className="quill-styles-pane" style={{display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0}} onClick={() => setMenu(null)}>
    <small style={{color: '#b9bac1'}} data-styles-current={current}>Current style: {currentName}</small>
    <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
      <button type="button" className="sf-button" onClick={() => { try { controller.openDialog('dialog.newStyle', {}); } catch (e) { fail(e); } }}>New Style…</button>
      <button type="button" className="sf-button" onClick={() => run('styles.updateToMatch')}>Update to Match</button>
      <button type="button" className="sf-button" onClick={() => run('format.clear')}>Clear</button>
    </div>
    <button type="button" className="sf-button" style={{alignSelf: 'flex-start'}} onClick={() => { try { controller.openDialog('dialog.manageStyles', {}); } catch (e) { fail(e); } }}>Manage Styles…</button>
    <hr style={{width: '100%', border: 0, borderTop: '1px solid rgba(255,255,255,.1)', margin: '2px 0'}}/>
    <div role="listbox" aria-label="Styles" style={{flex: 1, minHeight: 0, overflow: 'auto'}}>
      {list.map(s => <div key={s.id} role="option" aria-selected={s.id === current} data-style-id={s.id}
        className={`sf-list-item${s.id === current ? ' is-selected' : ''}`} style={{justifyContent: 'space-between', cursor: 'default'}}
        onClick={() => run('para.style', {style: s.id})}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({id: s.id, x: e.clientX, y: e.clientY}); }}>
        <span style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{s.name}</span>
        <span style={{color: '#8f9098', fontSize: 11, marginLeft: 8}}>{s.char ? 'a' : '¶'}</span>
      </div>)}
    </div>
    {menu ? <div role="menu" className="shell-menu" style={{position: 'fixed', left: menu.x, top: menu.y, zIndex: 50, minWidth: 200}} onClick={e => e.stopPropagation()}>
      <button type="button" role="menuitem" className="shell-option" onClick={() => { setMenu(null); modify(menu.id); }}>Modify…</button>
      <button type="button" role="menuitem" className="shell-option" onClick={() => { setMenu(null); run('styles.updateToMatch', {style: menu.id}); }}>Update to Match Selection</button>
      <button type="button" role="menuitem" className="shell-option" disabled={list.find(s => s.id === menu.id)?.builtin}
        onClick={() => { setMenu(null); run('styles.delete', {style: menu.id}); }}>Delete</button>
    </div> : null}
  </div>;
}
