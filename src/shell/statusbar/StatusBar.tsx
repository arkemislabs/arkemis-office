// The status bar (docs/architecture.md section 10), from the spec's normalized statusBar: each item
// reads a query command (its state().value fills the label's {placeholders}) and may run one when
// clicked. Items upstream reads from the view (the page in view, the word count: wordcraft
// crates/ui-egui/src/chrome.rs `status_bar`) take their value from the surface's
// `SurfaceHandle.status()` instead, re-read on every session or shell tick (a surface calls
// `controller.touch()` when only its view moved). The zoom cluster (Zoom Out, slider, Zoom In,
// percent opening the Zoom dialog) runs the common view.zoom* commands and shows the zoom the
// person sees (`SurfaceHandle.zoom()` in a fit mode); in Read Mode it sizes the reading text
// (view.readTextSize, 75–150%) as upstream's chrome.rs does. Before it, Word's Focus button and view
// buttons (Read Mode, Print Layout, Web Layout) when the app has those commands (status.focus,
// status.views). The save state on the right follows the document's file (Word shows nothing for a
// document that was never saved).

import {toCommandError} from '../../../core/kernel/errors.mjs';
import {maxZoom, minZoom} from '../../../core/common/commands/view.mjs';
import type {SpecStatusItem} from '../../generated/spec-types';
import {useEngine} from '../engine/EngineProvider';
import {useSessionTick, useShellState} from '../engine/useCommand';
import {useFileBinding} from '../chrome/FileLifecycle';
import {Glyph, Icon} from '../icons/Icon';
import {SHOW_PENDING} from '../env';

const fill = (text: string, value: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (m, k) => (value[k] === undefined || value[k] === null ? m : String(value[k])));

/** "Page {page} of {pages}" with values from the item's command state or the surface; null when nothing to show. */
export function itemText(item: SpecStatusItem, value: unknown): string | null {
  if (value === undefined && /\(transient\)|indicator/i.test(String(item.label))) return null;
  // Spec labels describe the item for translators ("Word count of page or selection (Arkemis extension)"): keep the name.
  const alternatives = String(item.label).split(' / ').map(a => a.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*;.*$/, '').trim()).filter(Boolean);
  const label = alternatives[0] ?? '';
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.label === 'string') return v.label || null;
    // The alternative whose placeholders the value fills, preferring the one that uses most of it
    // ("{words} words" vs "{selected} of {words} words" with a selection).
    const keys = (a: string) => [...a.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    const filled = alternatives.filter(a => keys(a).every(k => v[k] !== undefined && v[k] !== null));
    const best = filled.sort((a, b) => new Set(keys(b)).size - new Set(keys(a)).size)[0];
    return best ? fill(best, v) : fill(label, v);
  }
  if (typeof value === 'string' || typeof value === 'number') return /\{\w+\}/.test(label) ? label.replace(/\{\w+\}/, String(value)) : `${label.replace(/:.*$/, '')}: ${value}`;
  if (value === false || value === null) return null;
  if (/\{\w+\}|<\w+>|\(transient\)|indicator/i.test(label)) return null;
  return label;
}

const clickCommand = (item: SpecStatusItem) => {
  if (item.command) return item.command;
  const m = /([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.-]+)/.exec(String(item.click ?? ''));
  return m && !/^ui\.dialog/.test(m[1]) ? m[1] : null;
};
/** `ui.dialog{name:goto}` -> dialog.goto */
const clickDialog = (item: SpecStatusItem) => {
  const m = /ui\.dialog\{name:\s*([A-Za-z0-9_.-]+)\}/.exec(String(item.click ?? ''));
  return m ? (m[1].startsWith('dialog.') ? m[1] : `dialog.${m[1]}`) : null;
};

/**
 * What the save-state item says (the title bar's rule): with a file service, nothing for a document
 * that was never saved (Word), "Saved" / "Saving…" with AutoSave on, "Saved to this PC" once the
 * file has every change; without one (the vault only), the working copy's state.
 */
export function saveStateText({saving, dirty, path, autosave, hasFiles}: {saving?: boolean; dirty: boolean; path: string | null; autosave: boolean; hasFiles: boolean}): string | null {
  if (!hasFiles) return saving ? 'Saving…' : dirty && !autosave ? null : 'Saved';
  if (autosave) return dirty ? 'Saving…' : 'Saved';
  if (!path) return null;
  return dirty ? null : 'Saved to this PC';
}

/** The status bar ids of Excel's sheet views, their icons, labels and commands. */
const SHEET_VIEWS: [string, string, string, string][] = [['viewNormal', 'view-normal', 'Normal', 'view.normal'], ['viewPageLayout', 'view-page-layout', 'Page Layout', 'view.pageLayout'], ['viewPageBreakPreview', 'view-page-break', 'Page Break Preview', 'view.pageBreakPreview']];

export function StatusBar({saving}: {saving?: boolean}) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  useShellState();
  const binding = useFileBinding();
  const items = controller.model?.spec.statusBar ?? [];
  const doc = (() => { try { return session.get(docId); } catch { return null; } })();
  const zoom = doc?.view.zoom ?? 100;
  const shown = (() => {
    if (!doc?.view.fit) return zoom;
    try { const z = controller.view?.zoom?.(); return typeof z === 'number' && Number.isFinite(z) && z > 0 ? z : zoom; } catch { return zoom; }
  })();
  const surfaceStatus = (() => { try { return controller.view?.status?.() ?? {}; } catch { return {}; } })();
  const has = (id: string) => controller.hasCommand(id);
  const run = (id: string, args: Record<string, unknown> | null = null) => { void controller.run(id, args).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const openDialog = (id: string) => { try { controller.openDialog(id); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } };
  // Zoom items are drawn by the zoom cluster on the right, and so are the view buttons.
  const left = items.filter(i => i.side !== 'right' && !SHEET_VIEWS.some(v => v[0] === i.id) && !/^view\.zoom/.test(String(i.command ?? '')) && !/^zoom/i.test(String(i.label)) && i.id !== 'status.views' && i.id !== 'status.focus').map(item => {
    const cmd = item.command && has(item.command) ? item.command : null;
    const click = clickCommand(item);
    const dialog = clickDialog(item);
    const fromSurface = Object.hasOwn(surfaceStatus, item.id);
    const value = cmd ? session.state(docId, cmd).value : fromSurface ? surfaceStatus[item.id] : undefined;
    const text = itemText(item, value);
    const pending = !cmd && !fromSurface && !(click && has(click));
    if (!text || (pending && !SHOW_PENDING)) return null;
    if (pending && /\{|\}|<|>/.test(String(item.label))) return null;
    if (pending && item.when) return null;              // a conditional item shows only when its query says so
    const onClick = click && has(click) ? () => run(click) : dialog && controller.dialogImplemented(dialog) ? () => openDialog(dialog) : null;
    return {item, text, onClick, pending};
  }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 6);
  const autosaveOn = has('file.autosave') && !!session.state(docId, 'file.autosave').checked;
  const save = saveStateText({saving, dirty: !!doc?.dirty, path: binding?.path ?? null, autosave: autosaveOn, hasFiles: !!binding});
  // Read Mode: the slider and the buttons size the reading text (chrome.rs status_bar), never the zoom.
  const reading = !!(doc?.view as any)?.readMode && has('view.readTextSize');
  const readPct = Math.round(((doc?.view as any)?.readZoom ?? 1) * 100);
  const min = reading ? 75 : minZoom(controller.kind), max = reading ? 150 : maxZoom(controller.kind);
  const pct = reading ? readPct : shown;
  const views: [string, string, string][] = [['view.readMode', 'readMode', 'Read Mode'], ['view.printLayout', 'printLayout', 'Print Layout'], ['view.webLayout', 'webLayout', 'Web Layout']];
  const viewButtons = items.some(i => i.id === 'status.views') && views.every(([id]) => has(id));
  // Excel's sheet views (Normal, Page Layout, Page Break Preview): icons beside the zoom slider; one whose command is not translated is left out.
  const sheetViews = SHEET_VIEWS.filter(([sid, , , cmd]) => items.some(i => i.id === sid) && has(cmd));
  return <footer className="shell-status" aria-label="Status bar">
    <div className="shell-status-items">
      {left.map(({item, text, onClick, pending}) => onClick
        ? <button key={item.id} type="button" className="shell-status-item" data-status-id={item.id} onClick={onClick}>{text}</button>
        : <span key={item.id} className={`shell-status-item${pending ? ' is-pending' : ''}`} data-status-id={item.id} data-tip={pending ? text : undefined}
          data-tip-desc={pending ? `Not translated yet: ${item.id}` : undefined} data-pending={pending ? 'true' : undefined}>{text}</span>)}
    </div>
    <div className="shell-status-end">
      {save ? <span className="shell-status-item is-quiet" aria-live="polite" data-status-id="status.saveState">{save}</span> : null}
      {items.some(i => i.id === 'status.focus') && has('view.focus') ? <button type="button" className="shell-status-focus" data-status-id="status.focus"
        aria-pressed={!!session.state(docId, 'view.focus').checked} data-tip="Focus" data-tip-desc="Hide the ribbon and everything around the page"
        onClick={() => run('view.focus')}><Icon id="focus" size={16}/><span>Focus</span></button> : null}
      {viewButtons ? <div className="shell-status-views" role="group" aria-label="Views" data-status-id="status.views">
        {views.map(([id, icon, label]) => <button key={id} type="button" className="shell-status-view" aria-label={label} data-tip={label} data-command={id}
          aria-pressed={!!session.state(docId, id).checked} onClick={() => run(id)}><Icon id={icon} size={16}/></button>)}
      </div> : null}
      {sheetViews.length ? <div className="shell-status-views" role="group" aria-label="Views" data-status-id="status.sheetViews">
        {sheetViews.map(([sid, icon, label, id]) => <button key={sid} type="button" className="shell-status-view" aria-label={label} data-tip={label} data-command={id}
          aria-pressed={!!session.state(docId, id).checked} onClick={() => run(id)}><Icon id={icon} size={16}/></button>)}
      </div> : null}
      {has('view.zoom') ? <div className="shell-zoom" role="group" aria-label={reading ? 'Text Size' : 'Zoom'}>
        <button type="button" aria-label={reading ? 'Smaller text' : 'Zoom Out'} data-tip="Zoom Out"
          disabled={reading ? readPct <= 75 : !has('view.zoomOut') || !session.state(docId, 'view.zoomOut').enabled}
          onClick={() => (reading ? run('view.readTextSize', {value: Math.max(75, readPct - 10)}) : run('view.zoomOut'))}>−</button>
        <input type="range" min={min} max={max} step={1} value={Math.min(max, Math.max(min, pct))} aria-label={reading ? 'Text size' : 'Zoom level'}
          onChange={e => (reading ? run('view.readTextSize', {value: Number(e.target.value)}) : run('view.zoom', {value: Number(e.target.value)}))}/>
        <button type="button" aria-label={reading ? 'Larger text' : 'Zoom In'} data-tip="Zoom In"
          disabled={reading ? readPct >= 150 : !has('view.zoomIn') || !session.state(docId, 'view.zoomIn').enabled}
          onClick={() => (reading ? run('view.readTextSize', {value: Math.min(150, readPct + 10)}) : run('view.zoomIn'))}>+</button>
        <button type="button" className="shell-zoom-value" aria-label={reading ? `Text size ${pct}%` : `Zoom ${Math.round(shown)}%: open the Zoom dialog`} data-tip="Zoom" data-tip-desc="Choose a zoom level"
          disabled={reading} onClick={() => openDialog('dialog.zoom')}>{Math.round(pct)}%{reading ? null : <Glyph name="chevron-up" size={8}/>}</button>
      </div> : null}
    </div>
  </footer>;
}
