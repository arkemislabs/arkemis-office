// The File backstage (docs/architecture.md section 8.5): over the window, a left rail of the spec's
// backstage pages and actions, the page body from src/apps/<app>/backstage/<pageId>.tsx when the
// app overrides it, else the shell's common pages (Info, New, Open, Save As/Export, Print, Share,
// Options, Account) or a generic page of the node's actions. Esc and the back arrow return to the
// previous tab.

import {Suspense, lazy, useEffect, useMemo, useRef, type ComponentType, type LazyExoticComponent} from 'react';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import type {SpecBackstageNode} from '../../generated/spec-types';
import {useEngine} from '../engine/EngineProvider';
import {builtinPageKey, type BuiltinPage} from '../engine/ShellController';
import {useShellState} from '../engine/useCommand';
import {Glyph} from '../icons/Icon';
import {DialogBody, DialogFooter} from '../dialogs/DialogHost';
import {InfoPage, ExportPage, PrintPage, GenericPage, OptionsPage, AccountPage, NewPage, OpenPage, HomePage, SaveAsPage, SaveCopyPage, RecoverPage} from './pages';

export interface BackstagePageProps { node: SpecBackstageNode; close: () => void }
const overrides = new Map<string, LazyExoticComponent<ComponentType<BackstagePageProps>>>();

const stem = (id: string) => id.replace(/^file\./, '').replace(/^backstage\./, '');
const PAGES: Record<BuiltinPage, ComponentType<BackstagePageProps>> = {
  info: InfoPage, home: HomePage, saveCopy: SaveCopyPage, saveAs: SaveAsPage, export: ExportPage, recover: RecoverPage, print: PrintPage,
  options: OptionsPage, account: AccountPage, new: NewPage, open: OpenPage,
};
function builtin(node: SpecBackstageNode): ComponentType<BackstagePageProps> | null {
  const key = builtinPageKey(node);
  return key ? PAGES[key] : null;
}

export function Backstage() {
  const {controller} = useEngine();
  const state = useShellState();
  const ref = useRef<HTMLDivElement>(null);
  // The shell's own file pages (Home, Open, Save As, Save a Copy, Recover, Print...) count as implemented (ShellController.backstageImplemented).
  const shows = (n: SpecBackstageNode) => controller.backstageShows(n);
  const nodes = (controller.model?.backstage ?? []).filter(n => n.id !== 'file.back' && !/^back\b/i.test(n.label) && shows(n));
  const pageId = state.backstage.page;
  const dialog = pageId?.startsWith('dialog:') ? controller.dialog(pageId.slice(7)) : null;
  const node = nodes.find(n => n.id === pageId) ?? (dialog ? null : nodes.find(n => n.kind === 'page'));
  const close = () => controller.closeBackstage();
  useEffect(() => { if (state.backstage.open) ref.current?.querySelector<HTMLElement>('.bs-rail [aria-current=page], .bs-rail button')?.focus({preventScroll: true}); }, [state.backstage.open]);
  const Body = useMemo(() => {
    if (!node) return null;
    const load = controller.ui.backstage[node.id] ?? controller.ui.backstage[stem(node.id)];
    if (load) {
      if (!overrides.has(node.id)) overrides.set(node.id, lazy(async () => { const m = await load(); return {default: (m.default ?? m.Page) as ComponentType<BackstagePageProps>}; }));
      return overrides.get(node.id)!;
    }
    return builtin(node) ?? GenericPage;
  }, [node, controller]);
  if (!state.backstage.open) return null;
  const pages = nodes.filter(n => n.kind === 'page');
  const actions = nodes.filter(n => n.kind !== 'page');
  const press = (n: SpecBackstageNode) => { void controller.activateBackstage(n).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const pending = (n: SpecBackstageNode) => !controller.backstageImplemented(n);
  return <div ref={ref} className="bs" role="dialog" aria-modal="true" aria-label="File"
    onKeyDown={e => { if (e.key === 'Escape' && !dialog) { e.preventDefault(); e.stopPropagation(); close(); } }}>
    <nav className="bs-rail" aria-label="File">
      <button type="button" className="bs-back" aria-label="Back" onClick={close}><Glyph name="back" size={14}/></button>
      {pages.map(n => <button key={n.id} type="button" className={`bs-rail-item${n.id === node?.id ? ' is-active' : ''}${pending(n) ? ' is-pending' : ''}`}
        aria-current={n.id === node?.id ? 'page' : undefined} data-backstage-id={n.id} onClick={() => press(n)}>{n.label}</button>)}
      <span className="bs-rail-fill"/>
      {actions.map(n => <button key={n.id} type="button" className={`bs-rail-item is-action${pending(n) ? ' is-pending' : ''}`} data-backstage-id={n.id}
        data-tip={pending(n) ? n.label : undefined} data-tip-desc={pending(n) ? `Not translated yet: ${n.command ?? n.dialog}` : undefined} data-pending={pending(n) ? 'true' : undefined}
        onClick={() => press(n)}>{n.label}</button>)}
    </nav>
    <main className="bs-page">
      {dialog ? <section className="bs-dialog"><h1>{dialog.spec.title}</h1><DialogBody dialog={dialog}/><div className="bs-dialog-foot"><DialogFooter dialog={dialog}/></div></section>
        : node && Body ? <Suspense fallback={<div className="bs-loading">Loading…</div>}><Body node={node} close={close}/></Suspense> : null}
    </main>
  </div>;
}
