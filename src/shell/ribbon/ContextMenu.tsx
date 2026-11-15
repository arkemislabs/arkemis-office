// Right-click menus (Office's context menus; the spec's `contextMenus`): opened at the pointer, or
// at the selection with Shift+F10 or the Menu key, for whatever was clicked: a cell, a row or
// column header, a sheet tab, text, a picture, a slide thumbnail, a PDF comment... Entries are
// shell controls, so they run, enable, check and hide exactly as the ribbon's menu items do.

import {useRef} from 'react';
import type {AppId} from '../../generated/spec-types';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';
import {Flyout} from '../common/Flyout';
import {MenuList, RibbonControl} from './controls';

/**
 * The element under the pointer that names its own menu: `data-context` anywhere, else the app's
 * parts outside the editing surface (sheet tabs, slide thumbnails, page thumbnails, page tabs).
 */
const SELECTORS: Partial<Record<AppId, [string, string][]>> = {
  grid: [['.grid-tab-nav', 'sheetNavigator'], ['.grid-tab, .grid-tabs', 'sheetTab'], ['.shell-statusbar', 'statusBar']],
  prism: [['.prism-thumb-section', 'section-header'], ['.prism-thumbs', 'slide-thumbnail']],
  folio: [['.folio-thumbs', 'page-thumbnail']],
  slate: [['.slate-page-tab, .slate-pages', 'page-tab'], ['.slate-tab, .slate-tab-strip', 'section-tab'], ['.slate-title-area, .slate-title', 'page-title']],
};

export function contextTargetAt(kind: AppId, el: Element | null): string | null {
  if (!el) return null;
  const own = el.closest<HTMLElement>('[data-context]');
  if (own?.dataset.context) return own.dataset.context;
  for (const [sel, target] of SELECTORS[kind] ?? []) {
    const hit = el.closest<HTMLElement>(sel);
    if (hit) {
      // Office acts on the tab or thumbnail you right-click: make it the current one first.
      if (hit.matches('[role=tab]:not([aria-selected=true]), .grid-tab:not(.is-current)')) hit.click();
      return target;
    }
  }
  return null;
}

/** The menu for the editing surface when the surface doesn't answer itself, from what is selected. */
export function defaultContext(kind: AppId, flags: Record<string, boolean>): string | null {
  switch (kind) {
    case 'quill': return flags['picture-format'] ? 'picture' : flags['shape-format'] ? 'shape' : flags['table-design'] || flags['table-layout'] ? 'table'
      : flags.equation ? 'equation' : 'selection';
    case 'grid': return 'cell';
    case 'prism': return flags['picture-format'] || flags['shape-format'] || flags['chart-design'] || flags['table-design'] || flags['video-format'] ? 'shape' : 'slide-canvas';
    case 'slate': return 'page-canvas';
    case 'folio': return flags.annotation ? 'comment' : 'page (no object)';
    default: return null;
  }
}

/** Word's mini toolbar above the text menu: the formatting buttons used most, which run exactly as the ribbon's do. */
const MINI_BAR = ['home.font.bold', 'home.font.italic', 'home.font.underline', 'home.font.text-highlight-color', 'home.font.font-color', 'home.paragraph.bullets', 'home.paragraph.numbering'];

function MiniToolbar({onDone}: {onDone: () => void}) {
  const {controller} = useEngine();
  const ids = MINI_BAR.filter(id => { const c = controller.model?.controls.get(id); return !!c && controller.shows(c); });
  if (!ids.length) return null;
  return <div className="shell-minibar" role="toolbar" aria-label="Mini toolbar" onClick={e => { if ((e.target as Element).closest('button') && !(e.target as Element).closest('[aria-haspopup]')) onDone(); }}>
    {ids.map(id => <RibbonControl key={id} c={controller.model!.controls.get(id)!} size="small"/>)}
  </div>;
}

export function ContextMenu() {
  const {controller, kind} = useEngine();
  const state = useShellState();
  const anchor = useRef<HTMLSpanElement>(null);
  const open = state.contextMenu;
  const close = () => controller.closeContextMenu();
  return <>
    <span ref={anchor} className="shell-context-anchor" aria-hidden="true" style={{left: open?.x ?? 0, top: open?.y ?? 0}}/>
    {open ? <Flyout anchor={anchor} open onClose={close} label="Context menu" className="is-context">
      {kind === 'quill' && open.target === 'selection' ? <MiniToolbar onDone={close}/> : null}
      <MenuList entries={controller.contextEntries(open.target)} onDone={close}/>
    </Flyout> : null}
  </>;
}
