// The Form fields panel (spec pane `fields`): every field in tab order with its type, page and value,
// multi-select (Ctrl or Shift click), the tab order arrows (Order tabs manually), rename in place
// (double-click the name or F2), Properties… (Field Properties; Shared Field Properties for several).
//
// Translated from printcraft crates/ui-egui/src/panels/right.rs (fields panel: the list in tab order,
// selection mirrored on the page, tab order arrows, Properties…) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
// It reads the model's fields and writes through commands only.

import {useMemo, useState, type ReactElement} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {Icon} from '../../../shell/icons/Icon';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import './fields.css';

type Any = any;
const ICONS: Record<string, string> = {text: 'text-cursor-input', checkbox: 'check-circle-2', radio: 'circle', combo: 'chevron-down', list: 'list', pushbutton: 'square', signature: 'signature'};
const KINDS: Record<string, string> = {text: 'Text field', checkbox: 'Check box', radio: 'Radio button', combo: 'Drop-down list', list: 'List box', pushbutton: 'Button', signature: 'Digital signature'};

/** The field's place in the tab order: its first widget's rank. */
const rank = (f: Any) => Math.min(...f.widgets.map((w: Any) => w.tab ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

const valueText = (f: Any) => {
  if (f.kind === 'pushbutton' || f.kind === 'signature') return '';
  if (f.kind === 'checkbox') return f.value.length ? 'Checked' : '';
  if (f.kind === 'combo' || f.kind === 'list') return f.value.map((v: string) => f.options.find(([e]: Any) => e === v)?.[1] ?? v).join(', ');
  return f.value.join(', ');
};

export default function FieldsPane(_: PaneProps): ReactElement {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: Any = (() => { try { return session.get(docId); } catch { return null; } })();
  const content: Any = doc?.file?.content ?? null;
  const view: Any = doc?.view ?? {};
  const fields: Any[] = Array.isArray(content?.fields) ? content.fields : [];
  const sel: {name: string; widget: number}[] = (view.formSel ?? []).filter((s: Any) => fields.some(f => f.name === s.name));
  const [renaming, setRenaming] = useState<{name: string; text: string} | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const run = (id: string, args: Any = {}) => controller.run(id, args, {origin: 'ui'});
  const ordered = useMemo(() => [...fields].sort((a, b) => rank(a) - rank(b)), [fields]);
  const isSel = (f: Any) => sel.some(s => s.name === f.name);
  const pick = (f: Any, e: React.MouseEvent) => {
    let next: Any[];
    if (e.shiftKey && anchor) {
      const a = ordered.findIndex(x => x.name === anchor), b = ordered.findIndex(x => x.name === f.name);
      next = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => ({name: x.name, widget: 0}));
    } else if (e.ctrlKey || e.metaKey) {
      next = isSel(f) ? sel.filter(s => s.name !== f.name) : [...sel, {name: f.name, widget: 0}];
    } else { next = [{name: f.name, widget: 0}]; setAnchor(f.name); }
    void run('form.select', {fields: next}).catch(() => {});
    const w = f.widgets[0];
    const page = content.pages.findIndex((p: Any) => p.id === w?.pageId);
    if (!e.ctrlKey && !e.shiftKey && page >= 0) void run('surface.scroll', {page: page + 1}).catch(() => {});
  };
  const commitRename = () => {
    const r = renaming;
    setRenaming(null);
    if (!r || !r.text.trim() || r.text.trim() === r.name) return;
    void run('form.field.properties', {name: r.name, props: {name: r.text.trim()}});
  };
  const one = sel.length === 1 ? sel[0].name : null;
  const calc = view.calcOrder === true;
  return <div className="ff-pane" data-testid="fields-pane">
    <div className="ff-head">
      <span className="ff-count">{fields.length} {fields.length === 1 ? 'field' : 'fields'}{sel.length ? <small> · {sel.length} selected</small> : null}</span>
      <span className="ff-spacer"/>
      <button type="button" className="ff-icon" aria-label="Move earlier in the tab order" data-tip="Move earlier in the tab order" disabled={!one} onClick={() => void run('form.tab_order.move', {name: one, earlier: true})}><Icon id="arrow-up" size={16}/></button>
      <button type="button" className="ff-icon" aria-label="Move later in the tab order" data-tip="Move later in the tab order" disabled={!one} onClick={() => void run('form.tab_order.move', {name: one, earlier: false})}><Icon id="arrow-down" size={16}/></button>
    </div>
    <div className="ff-list" role="listbox" aria-label="Form fields" aria-multiselectable="true">
      {ordered.map(f => {
        const on = isSel(f);
        const w0 = f.widgets[0];
        const pi = content.pages.findIndex((p: Any) => p.id === w0?.pageId);
        const v = valueText(f);
        return <div key={f.id} role="option" aria-selected={on} className={`ff-row${on ? ' is-selected' : ''}`} data-field={f.name} tabIndex={0}
          onClick={e => pick(f, e)} onDoubleClick={() => setRenaming({name: f.name, text: f.name})}
          onKeyDown={e => { if (e.key === 'F2') { e.preventDefault(); setRenaming({name: f.name, text: f.name}); } else if (e.key === 'Enter') { e.preventDefault(); void run('form.field.properties', {name: f.name}); } }}>
          <span className="ff-kind" title={KINDS[f.kind]}><Icon id={ICONS[f.kind] ?? 'square'} size={16}/></span>
          <span className="ff-main">
            {renaming && renaming.name === f.name
              ? <input className="ff-rename" autoFocus value={renaming.text} aria-label={`Rename ${f.name}`} onChange={e => setRenaming({...renaming, text: e.target.value})} onBlur={commitRename}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(null); }}/>
              : <b className="ff-name" title={f.name}>{f.name}</b>}
            <small>{KINDS[f.kind]}{pi >= 0 ? ` · page ${pageLabel(content, pi)}` : ''}{f.widgets.length > 1 ? ` · ${f.widgets.length} copies` : ''}{v ? ` · ${v}` : ''}</small>
          </span>
          {f.flags & 1 ? <span className="ff-badge">Read only</span> : null}{f.flags & 2 ? <span className="ff-badge">Required</span> : null}
        </div>;
      })}
      {!fields.length ? <div className="shell-pane-empty">This document has no form fields. Choose Detect form fields, or add one with a field tool.</div> : null}
    </div>
    <div className="ff-foot">
      <button type="button" className="gd-button ff-btn" disabled={!sel.length} onClick={() => void run('form.field.properties', {})}>Properties…</button>
      <button type="button" className="gd-button ff-btn" disabled={!sel.length} onClick={() => void run('form.field.delete', {})}>Delete</button>
      {calc ? null : <button type="button" className="gd-button ff-btn" onClick={() => void run('form.detect', {})}>Detect</button>}
    </div>
  </div>;
}
