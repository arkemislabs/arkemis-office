// DialogHost (docs/architecture.md section 9.2): the dialog stack, each drawn from its spec fields,
// its geometry overlay and its model, inside GlassDialog. Presentations: `modal` and `full-window`
// here, `inline-bar` under the ribbon (InlineBars), `pane` in PaneHost, `backstage` as a backstage
// page. The values object the fields edit is the controller's, so `ui.dialog.*` over the bridge and
// a person's clicks drive the same dialog.

import {useEffect, useMemo, useState, type ComponentType, type ReactNode} from 'react';
import type {SpecField} from '../../generated/spec-types';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';
import {GlassDialog} from './GlassDialog';
import {fieldVisible, fieldEnabled, hasValue, changedFields, type DialogState} from './dialogState';
import {dialogTitle, resolveField, resolveText, templateSource, buttonLabel} from './templates';
import {fieldComponent, PreviewField, LabelField, MessageField, type FieldProps} from '../fields';
import {SHOW_PENDING} from '../env';

/** What an app override module (src/apps/<app>/dialogs/<id>.tsx) may export. */
export interface DialogOverride {
  Preview?: ComponentType<{values: Record<string, unknown>; preview: unknown; field: SpecField}>;
  fields?: Record<string, ComponentType<FieldProps>>;
  Body?: ComponentType<{dialog: DialogState; setValue: (field: string, value: unknown) => void}>;
}

/** The app's override for a dialog: `undefined` while its module loads (the body waits: no flash of the generic form), `null` when there is none. */
function useOverride(id: string): DialogOverride | null | undefined {
  const {controller} = useEngine();
  const [mod, setMod] = useState<DialogOverride | null | undefined>(() => (controller.dialogOverride(id) ? undefined : null));
  useEffect(() => {
    const load = controller.dialogOverride(id);
    if (!load) { setMod(null); return; }
    let alive = true;
    load().then(m => { if (alive) setMod((m?.default ?? m) as DialogOverride); }).catch(() => { if (alive) setMod(null); });
    return () => { alive = false; };
  }, [controller, id]);
  return mod;
}

export function DialogHost() {
  const state = useShellState();
  const shown = state.dialogs.filter(d => d.spec.presentation === 'modal' || d.spec.presentation === 'full-window' || !['pane', 'inline-bar', 'backstage'].includes(d.spec.presentation));
  const top = shown[shown.length - 1]?.key;
  return <>{shown.map(d => <SpecDialogView key={d.key} dialog={d} inactive={d.key !== top}/>)}</>;
}

/** Default geometry when no overlay gives one: wider for multi-tab and long dialogs. */
export function dialogWidth(d: DialogState): number {
  const layout = d.spec.layout as {width?: number} | undefined;
  if (layout?.width) return layout.width;
  const most = Math.max(...d.spec.tabs.map(t => t.fields.length), 0);
  const hasList = d.spec.tabs.some(t => t.fields.some(f => f.kind === 'list' || f.kind === 'preview'));
  if (d.spec.presentation === 'full-window') return 0;
  if (most <= 2 && !hasList) return 420;
  if (most <= 6 && d.spec.tabs.length === 1) return hasList ? 540 : 480;
  if (most <= 14) return 600;
  return 680;
}

export function SpecDialogView({dialog: d, inactive = false}: {dialog: DialogState; inactive?: boolean}) {
  const {controller} = useEngine();
  const variant = d.spec.presentation === 'full-window' ? 'sheet' : 'modal';
  const ok = () => { void controller.submitDialog(d.key).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const layout = d.spec.layout as {height?: number} | undefined;
  const title = dialogTitle(d, controller.dialogModel(d.id));
  return <GlassDialog title={title} dialogKey={d.key} dialogId={d.id} inactive={inactive} variant={variant} width={dialogWidth(d)}
    height={layout?.height ?? (d.spec.tabs.length > 1 ? 440 : undefined)} onCancel={() => controller.cancelDialog(d.key)} onOk={ok}
    className={`${d.pending ? 'is-pending' : ''}${isMessage(d) ? ' is-message' : ''}`} footer={<DialogFooter dialog={d}/>}>
    <DialogBody dialog={d}/>
  </GlassDialog>;
}

/**
 * A message box: only text (a label, a message, or a preview named `message`), at most with check boxes. Its buttons keep the order
 * the spec gives, together on the right (Yes, No / Delete, Cancel), the first affirmative one primary.
 */
const isMessage = (d: DialogState) => {
  const fields = d.spec.tabs.flatMap(t => t.fields);
  const text = (f: SpecField) => f.kind === 'label' || f.kind === 'message' || (f.kind === 'preview' && f.id === 'message');
  return d.spec.tabs.every(t => t.fields.every(f => text(f))) || (d.spec.tabs.length === 1 && fields.some(text) && fields.every(f => text(f) || f.kind === 'checkbox'));
};

/** Tabs across the top, fields in labelled sections, the preview redrawn as values change. */
export function DialogBody({dialog: d}: {dialog: DialogState}) {
  const {controller, session, docId} = useEngine();
  const override = useOverride(d.id);
  const model = controller.dialogModel(d.id);
  // The first preview is drawn with the dialog (no frame without it); later ones follow the values, debounced.
  const draw = () => { try { return model?.preview ? model.preview(session.readContext(docId) as any, d.values) : null; } catch { return null; } };
  const [preview, setPreview] = useState<unknown>(draw);
  useEffect(() => {
    if (!model?.preview) return;
    const t = setTimeout(() => { setPreview(draw()); }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, d.values, session, docId]);
  const set = (field: string, value: unknown) => {
    try { controller.setDialogValue(d.key, field, value); } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  if (override === undefined) return <div className="gd-body" aria-busy="true" style={{minHeight: 120}}/>;
  if (override?.Body) { const Body = override.Body; return <div className="gd-body"><Body dialog={d} setValue={set}/></div>; }
  const tab = d.spec.tabs[d.tab] ?? d.spec.tabs[0];
  // A dialog whose overlay says tabsSide: 'left' lists its pages as categories down the left side (Preferences).
  const side = (d.spec.layout as {tabsSide?: string} | undefined)?.tabsSide === 'left' && d.spec.tabs.length > 1;
  return <div className={`gd-body${d.spec.tabs.length > 1 ? ' has-tabs' : ''}${side ? ' has-side-tabs' : ''}`}>
    {d.pending && SHOW_PENDING ? <div className="gd-pending" role="note">Not translated yet: {d.spec.command ?? d.id}. The fields show the layout; OK stays disabled.</div> : null}
    {d.spec.tabs.length > 1 ? <div className="gd-tabs" role="tablist" aria-orientation={side ? 'vertical' : 'horizontal'} aria-label={`${d.spec.title} pages`}>
      {d.spec.tabs.map((t, i) => <button key={i} type="button" role="tab" aria-selected={i === d.tab} className={i === d.tab ? 'is-active' : undefined}
        onClick={() => controller.setDialogTab(d.key, i)}
        onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + d.spec.tabs.length) % d.spec.tabs.length; controller.setDialogTab(d.key, n); } }}>
        {resolveText(t.name, templateSource(d)) || `Page ${i + 1}`}</button>)}
    </div> : null}
    {tab ? <FieldLayout key={d.tab} dialog={d} fields={tab.fields} preview={preview} override={override} set={set}/> : null}
  </div>;
}

/** Field kinds that draw a box of their own (a tree, a palette, a spectrum, a meter, a strip of pages): each takes the full width. */
const DRAWN = ['tree', 'swatches', 'spectrum', 'meter', 'thumbnails'];

type Block = {kind: 'grid'; fields: SpecField[]; columns: number} | {kind: 'checks'; fields: SpecField[]; columns: number}
  | {kind: 'wide'; field: SpecField} | {kind: 'buttons'; fields: SpecField[]} | {kind: 'section'; title: string; blocks: Block[]};

/** The generic two-column form (section 7.3 without a dialog overlay); overlay sections when given. */
export function arrange(fields: SpecField[], wideDialog: boolean): {blocks: Block[]; previews: SpecField[]} {
  const previews = fields.filter(f => f.kind === 'preview');
  const gridCount = fields.filter(f => !['preview', 'checkbox', 'button', 'radio', 'label', 'message', 'grid', 'colorPicker', 'tabStops', 'border', ...DRAWN].includes(f.kind) && !f.multiline).length;
  const cols = gridCount <= 1 ? 1 : wideDialog && gridCount >= 6 ? 3 : 2;
  const rest = fields.filter(f => f.kind !== 'preview');
  const blocks: Block[] = [];
  let grid: SpecField[] = [], checks: SpecField[] = [], buttons: SpecField[] = [];
  const flush = () => {
    // Every grid block of a dialog uses the dialog's column count, so a lone field takes one cell, not the whole row.
    if (grid.length) blocks.push({kind: 'grid', fields: grid, columns: cols});
    if (checks.length) blocks.push({kind: 'checks', fields: checks, columns: checks.length > 8 ? 3 : checks.length > 2 ? 2 : 1});
    if (buttons.length) blocks.push({kind: 'buttons', fields: buttons});
    grid = []; checks = []; buttons = [];
  };
  for (const f of rest) {
    if (f.kind === 'checkbox') { if (grid.length || buttons.length) { const c = checks; checks = []; flush(); checks = c; } checks.push(f); continue; }
    if (f.kind === 'button') { if (grid.length || checks.length) flush(); buttons.push(f); continue; }
    const wide = f.kind === 'radio' || f.kind === 'label' || f.kind === 'message' || f.kind === 'grid' || f.kind === 'colorPicker' || f.multiline === true
      || (f.kind === 'list' && (!wideDialog || typeof f.itemsFrom === 'string')) || f.kind === 'tabStops' || f.kind === 'border' || DRAWN.includes(f.kind);
    if (wide) { flush(); blocks.push({kind: 'wide', field: f}); continue; }
    if (checks.length || buttons.length) flush();
    grid.push(f);
  }
  flush();
  return {blocks, previews};
}

function FieldLayout({dialog: d, fields, preview, override, set}: {dialog: DialogState; fields: SpecField[]; preview: unknown; override: DialogOverride | null; set: (f: string, v: unknown) => void}) {
  const {controller} = useEngine();
  const src = templateSource(d);
  // Labels, hints and notes read the dialog's values: "Unlock {name}" and Move or copy "<section>" show what they stand for.
  const visible = fields.filter(f => fieldVisible(f, d.values)).map(f => (f.kind === 'preview' ? f : resolveField(f, src)));
  const layout = d.spec.layout as {sections?: {title?: string; fields: string[]; columns?: number}[]} | undefined;
  const wide = dialogWidth(d) >= 600;
  const errorOf = (id: string) => d.errors.find(e => e.field === id)?.message ?? null;
  const disabled = d.busy;
  const press = (id: string) => { void controller.pressField(d.key, id).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const nested = (dialogId: string, fieldId: string, init: Record<string, unknown>) => {
    try { controller.openDialog(dialogId, {parent: d.key, target: {dialog: d.key, field: fieldId}, init}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const one = (f: SpecField): ReactNode => {
    if (f.kind === 'label') return <LabelField key={f.id} field={f} values={src}/>;
    if (f.kind === 'message') return <MessageField key={f.id} values={d.values}/>;
    if (f.kind === 'preview') {
      const P = override?.Preview;
      return P ? <div key={f.id} className="sf sf-preview"><P values={d.values} preview={preview} field={f}/></div> : <PreviewField key={f.id} field={f} values={d.values} preview={preview}/>;
    }
    const C = fieldComponent(f, override?.fields);
    if (!C) return null;
    return <C key={f.id} field={f} value={hasValue(f) ? d.values[f.id] : undefined} onChange={v => set(f.id, v)} error={errorOf(f.id)} disabled={disabled || !fieldEnabled(f, d.values)}
      onPress={press} onNested={nested} values={d.values} preview={preview}/>;
  };
  const render = (b: Block, i: number): ReactNode => {
    if (b.kind === 'wide') return <div key={i} className="gd-wide">{one(b.field)}</div>;
    if (b.kind === 'buttons') return <div key={i} className="gd-buttons">{b.fields.map(one)}</div>;
    if (b.kind === 'checks') return <div key={i} className="gd-checks" style={{gridTemplateColumns: `repeat(${b.columns}, minmax(0, 1fr))`}}>{b.fields.map(one)}</div>;
    if (b.kind === 'section') return <fieldset key={i} className="gd-section"><legend>{b.title}</legend>{b.blocks.map(render)}</fieldset>;
    return <div key={i} className="gd-grid" style={{gridTemplateColumns: `repeat(${b.columns}, minmax(0, 1fr))`}}>{b.fields.map(one)}</div>;
  };
  if (layout?.sections?.length) {
    const byId = new Map(visible.map(f => [f.id, f]));
    const used = new Set<string>();
    const sections = layout.sections.map(s => {
      const fs = s.fields.map(id => byId.get(id)).filter((f): f is SpecField => !!f);
      fs.forEach(f => used.add(f.id));
      return {title: s.title ?? '', ...arrange(fs, wide)};
    });
    const leftover = arrange(visible.filter(f => !used.has(f.id)), wide);
    return <div className="gd-fields">
      {sections.map((s, i) => s.title ? <fieldset key={i} className="gd-section"><legend>{s.title}</legend>{s.blocks.map(render)}</fieldset> : <div key={i}>{s.blocks.map(render)}</div>)}
      {leftover.blocks.map(render)}
      {[...sections.flatMap(s => s.previews), ...leftover.previews].map(one)}
    </div>;
  }
  const {blocks, previews} = arrange(visible, wide);
  // A message box reads its text first and then its check box ("Delete original section after merging").
  return <div className="gd-fields">{isMessage(d) ? previews.map(one) : null}{blocks.map(render)}{isMessage(d) ? null : previews.map(one)}</div>;
}

/** Buttons as the spec lists them: other buttons on the left, OK / Cancel / Apply on the right. */
export function DialogFooter({dialog: d}: {dialog: DialogState}) {
  const {controller} = useEngine();
  const press = (id: string) => { void controller.submitDialog(d.key, id).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  // A stepped dialog shows only the buttons that apply to its step (`buttonsWhen`: button id -> field -> allowed values); a button listed in
  // `promote` takes the primary place while no OK-role button is shown, so a step never shows two primary actions (Continue, then Sign).
  const lay = d.spec.layout as {buttonsWhen?: Record<string, Record<string, unknown[]>>; promote?: string[]} | undefined;
  const applies = (b: {id: string}) => Object.entries(lay?.buttonsWhen?.[b.id] ?? {}).every(([k, allowed]) => allowed.includes(d.values[k]));
  // `buttonsDisabledWhen` (button id -> field -> allowed values): the button is drawn but cannot be pressed until the values allow it (Custom Views: Show).
  const disabledWhen = (lay as {buttonsDisabledWhen?: Record<string, Record<string, unknown[]>>} | undefined)?.buttonsDisabledWhen;
  const blocked = (id: string) => Object.entries(disabledWhen?.[id] ?? {}).some(([k, allowed]) => !allowed.includes(d.values[k]));
  const shown = d.spec.buttons.filter(applies);
  const buttons = shown.map(b => (b.role === 'other' && lay?.promote?.includes(b.id) && !shown.some(o => o.role === 'ok') ? {...b, role: 'ok' as const} : b));
  const others = buttons.filter(b => b.role === 'other' || b.role === 'help');
  const main = buttons.filter(b =>b.role === 'ok' || b.role === 'apply' || b.role === 'cancel')
    .sort((a, b) => ['ok', 'apply', 'cancel'].indexOf(a.role) - ['ok', 'apply', 'cancel'].indexOf(b.role));
  const changed = useMemo(() => changedFields(d).length > 0, [d]);
  if (!main.some(b => b.role === 'cancel') && !main.some(b => b.role === 'ok')) main.push({id: 'cancel', label: 'Close', role: 'cancel', command: null});
  if (isMessage(d)) {
    // Office message boxes keep their buttons in the order given, together on the right
    // (Save, Don't Save, Cancel / Yes, No, Cancel), the default one primary.
    const buttons = d.spec.buttons.length ? d.spec.buttons : [{id: 'ok', label: 'OK', role: 'ok' as const, command: null}];
    return <>
      <div className="gd-message" role={d.message ? 'alert' : undefined}>{d.message}</div>
      <div className="gd-actions">
        <div className="gd-actions-start"/>
        <div className="gd-actions-end">
          {buttons.map(b => <button key={b.id} type="button" className={`gd-button${b.role === 'ok' ? ' gd-primary' : ''}`}
            disabled={d.busy || (b.role !== 'cancel' && d.pending)} onClick={() => press(b.id)}>{buttonLabel(b)}</button>)}
        </div>
      </div>
    </>;
  }
  return <>
    <div className="gd-message" role={d.message ? 'alert' : undefined}>{d.message}</div>
    <div className="gd-actions">
      <div className="gd-actions-start">
        {others.map(b => <button key={b.id} type="button" className="gd-button" disabled={d.busy || blocked(b.id)} onClick={() => press(b.id)}>{buttonLabel(b)}</button>)}
        {d.spec.tabs.some(t => t.fields.some(f => f.default !== undefined)) ? <button type="button" className="gd-button is-quiet" onClick={() => controller.resetDialog(d.key)}>Reset</button> : null}
      </div>
      <div className="gd-actions-end">
        {main.map(b => <button key={b.id} type="button" className={`gd-button${b.role === 'ok' ? ' gd-primary' : ''}`}
          disabled={d.busy || (b.role !== 'cancel' && d.pending) || (b.role === 'apply' && !changed) || blocked(b.id)}
          data-tip={b.role !== 'cancel' && d.pending ? buttonLabel(b) : undefined} data-tip-desc={b.role !== 'cancel' && d.pending ? `Not translated yet: ${d.spec.command ?? d.id}` : undefined}
          onClick={() => press(b.id)}>{buttonLabel(b)}</button>)}
      </div>
    </div>
  </>;
}

/** `inline-bar` dialogs: a bar under the ribbon (Find on Page). */
export function InlineBars() {
  const state = useShellState();
  const {controller} = useEngine();
  const bars = state.dialogs.filter(d => d.spec.presentation === 'inline-bar');
  if (!bars.length) return null;
  return <>{bars.map(d => <div key={d.key} className="shell-inline-bar" role="dialog" aria-label={d.spec.title} data-dialog-key={d.key}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); controller.cancelDialog(d.key); } }}>
    <strong>{d.spec.title}</strong>
    <div className="shell-inline-fields"><DialogBody dialog={d}/></div>
    <div className="shell-inline-actions"><DialogFooter dialog={d}/></div>
  </div>)}</>;
}
