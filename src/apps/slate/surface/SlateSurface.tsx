// Slate's editing surface (docs/architecture.md 16.5; F:slate). OneNote's window below the
// ribbon, in its classic layout (View › Tabs Layout › Horizontal Tabs):
//
//   [notebook name] [section tab] [section tab] [section group] [+]
//   ┌──────────────────────────────────────────────┬──────────────┐
//   │ page title                                   │ + Add Page    │
//   │ Thursday, October 29, 2026   12:00 PM        │ page          │
//   │                                              │   subpage     │
//   │        note containers, ink, rule lines      │ page          │
//   └──────────────────────────────────────────────┴──────────────┘
//
// The current section and page are the document selection (core/slate/model/notebook.mjs), so
// the bridge's selection.set, undo and Ctrl+Page Down all move the same view. Clicking a section
// tab opens the page last viewed in it (OneNote remembers it per section, for this window);
// clicking a section group tab shows the group's sections with a tab back to the parent.

import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {isNotebook} from '../../../../core/slate/schema.mjs';
import {currentLocation, parentOf, selectPage, selectSection} from '../../../../core/slate/model/notebook.mjs';
import {evaluate as contextFlags} from '../../../../core/slate/context.mjs';
import {PageList, type PageRow} from './PageList';
import {TabStrip} from './TabStrip';
import {PageCanvas, type PageRecord, type CanvasApi} from './PageCanvas';
import {HistoryPane, type Pane} from './HistoryPane';
import {SpellingPane} from './SpellingPane';
import {AccessibilityPane, HelpPane, SearchPane, type RestPane} from './RestPanes';
import {VersionView} from './VersionView';
import {findVersion} from '../../../../core/slate/lib/history.mjs';
import type {ShellController, SurfaceHandle} from '../../../shell/engine/ShellController';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import type {InkTool} from './InkLayer';
import {useNotebookFolder} from './notebookFolder';
import {watchActivity} from '../../../../core/slate/lib/autolock.mjs';
import {watchNavigation} from '../../../../core/slate/lib/nav-history.mjs';
import {DARK_PAGE_PREF, TABS_LAYOUT_PREF, panesOf, readerOf} from '../../../../core/slate/commands/view.mjs';
import {TOUCH_PREF} from '../../../../core/slate/commands/rest-panes.mjs';
import {ImmersiveReader} from './ImmersiveReader';
import {getMediaService} from '../../../shell/engine/mediaService';
import './surface.css';

function useDoc(session: SurfaceProps['controller']['session'], docId: string) {
  useSyncExternalStore(session.subscribe, () => session.tick);
  try { return session.get(docId); } catch { return null; }
}

/** The tab strip's items at one level: sections and groups of the notebook root or of a group. */
function levelItems(content: any, level: string | null): string[] {
  return level ? content.groups[level]?.items ?? [] : content.tree;
}

export default function SlateSurface({controller, docId, register}: SurfaceProps) {
  const session = controller.session;
  const doc = useDoc(session, docId);
  const content: any = doc?.file.content;
  const notebook = isNotebook(content);
  const loc = notebook ? currentLocation(content, doc!.selection) : {sectionId: null, pageId: null};
  const lastPage = useRef(new Map<string, string>());
  if (loc.sectionId && loc.pageId) lastPage.current.set(loc.sectionId, loc.pageId);
  const homeLevel = notebook && loc.sectionId ? parentOf(content, loc.sectionId)?.parent ?? null : null;
  const [navLevel, setNavLevel] = useState<string | null | undefined>(undefined);
  useEffect(() => { setNavLevel(undefined); }, [loc.sectionId]);
  const level = navLevel === undefined ? homeLevel : navLevel;
  const surfaceRef = useRef<HTMLDivElement>(null);
  useNotebookFolder(session, docId, controller);
  // View > Zoom > Page Width: the zoom at which the page's notes fill the window (a percent, so it stays until changed).
  const fit = (doc?.view as any)?.fit;
  useEffect(() => {
    if (fit !== 'pageWidth' || !notebook || !loc.pageId) return;
    const box = surfaceRef.current?.querySelector<HTMLElement>('.slate-page-scroll');
    const body = content.pages[loc.pageId]?.body;
    if (!box || !body) return;
    const right = Math.max(560, ...((body.content ?? []) as any[]).map(c => (c.attrs?.x ?? 0) + (c.attrs?.width ?? 520)));
    const percent = Math.max(10, Math.min(500, Math.floor((box.clientWidth / (right + 60)) * 100)));
    void controller.run('view.zoom', {value: percent}, {origin: 'ui'});
  }, [fit, loc.pageId]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Audio & Video: a recording that has played to its end stops (back to its start); See Playback lights the note being played.
  const seePlayback = (doc?.view as any)?.seePlayback === true && (doc?.view as any)?.playback?.playing === true ? (doc!.view as any).playback.id as string : null;
  useEffect(() => {
    const svc = getMediaService();
    svc.onEnded = id => { try { if ((session.get(docId).view as any)?.playback?.id === id) void controller.run('media.stop', {}, {origin: 'ui'}); } catch { /* closed */ } };
    return () => { svc.onEnded = null; };
  }, [session, docId, controller]);
  useEffect(() => {
    if (!seePlayback) { surfaceRef.current?.querySelectorAll('.is-playing-note').forEach(n => n.classList.remove('is-playing-note')); return; }
    const timer = setInterval(async () => {
      const pos = (await getMediaService().position(seePlayback))?.t ?? 0;
      const notes = [...(surfaceRef.current?.querySelectorAll<HTMLElement>(`[data-audio-media="${CSS.escape(seePlayback)}"]`) ?? [])];
      let current: HTMLElement | null = null;
      for (const n of notes) if (Number(n.dataset.audioAt) <= pos && (!current || Number(n.dataset.audioAt) >= Number(current.dataset.audioAt))) current = n;
      for (const n of notes) n.classList.toggle('is-playing-note', n === current);
    }, 250);
    return () => clearInterval(timer);
  }, [seePlayback]);
  // Format Painter: once it has picked up a format, selecting text applies it (OneNote paints the next selection).
  useEffect(() => session.subscribe((e: any) => {
    if (e.doc !== docId || e.type !== 'selection.changed') return;
    try {
      const d = session.get(docId);
      const r = d.selection.ranges[d.selection.primary ?? 0];
      if ((d.view as any)?.painter && r && r.anchor !== r.focus) void controller.run('clipboard.formatPainter', {}, {origin: 'ui'});
    } catch { /* closed */ }
  }), [session, docId, controller]);
  // Protected sections lock by themselves: after the Password Options time with nothing done in them, or on leaving them.
  useEffect(() => {
    const off = watchActivity(session, docId, () => Date.now());
    const offNav = watchNavigation(session, docId);
    const tick = () => { try { if (session.state(docId, 'password.autoLock').enabled) void session.execute(docId, 'password.autoLock', {}, {origin: 'ui'}).catch(() => {}); } catch { /* closed */ } };
    const timer = setInterval(tick, 10_000);
    return () => { off(); offNav(); clearInterval(timer); };
  }, [session, docId]);

  const canvas = useRef<CanvasApi | null>(null);
  /** The surface's pointer targets outside the page (tabs, page list); refreshed every render. */
  const chrome = useRef<{openSection(id: string): void; openPage(id: string): void; addPage(): void; addSection(): void} | null>(null);

  useEffect(() => register({
    focus: () => {
      // ProseMirror's own focus writes its selection to the DOM first; a bare element focus lets the browser
      // put the caret at the start, which the editor then takes as the person's click (after a ribbon command or dialog).
      if (canvas.current?.focus()) return;
      surfaceRef.current?.querySelector<HTMLElement>('.slate-editor-root')?.focus();
    },
    contextFlags: () => {
      try { const d = session.get(docId); return contextFlags(d.file.content, d.selection, session.prefs, d.view); } catch { return {}; }
    },
    // Right-click: the part of the page under the pointer names its menu (OneNote's): text, a picture, an equation,
    // a table cell, a link, a note's top bar, ink; the empty page its own.
    contextMenu: (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      if (el.closest('.slate-equation')) return 'equation';
      if (el.closest('img')) return 'picture';
      if (el.closest('[data-attachment]')) return 'file-attachment';
      if (el.closest('a[href]')) return 'link';
      if (el.closest('td, th')) return 'table-cell';
      if (el.closest('.slate-container-bar')) return 'note-container';
      if (el.closest('.slate-stroke')) return 'ink';
      if (el.closest('.slate-editor-root p, .slate-editor-root li')) {
        // A squiggled word: its suggestions, Ignore All and Add to Dictionary lead the menu (the caret goes into the word first, as OneNote does).
        const word = el.closest('.slate-misspelt');
        const pos = word ? canvas.current?.posAt(x, y) ?? null : null;
        void controller.run('review.spellingMenu', pos === null ? {none: true} : {from: pos}, {origin: 'ui'}).catch(() => {});
        return 'text-selection';
      }
      return 'page-canvas';
    },
    // The menu opened without a pointer (the bridge's ui.contextMenu, the Menu key): the word the caret is in.
    contextPrepare: async (target: string) => {
      if (target === 'text-selection') { try { await controller.run('review.spellingMenu', {}, {origin: 'ui'}); } catch { /* no word */ } }
    },
    // ui.pointer / ui.type (design note F-slate--integrator--ui-pointer-type): the same
    // handlers a click, drag or keystroke runs, addressed by page coordinates or surface parts.
    pointer: (p: {action?: string; x?: number; y?: number; to?: {x: number; y: number}; target?: string; path?: number[][]}) => {
      const target = String(p.target ?? '');
      const [kind, id] = target.split(/:(.*)/s);
      const c = chrome.current;
      const need = <T,>(v: T | null | undefined, what: string): T => { if (!v) throw new CommandError('unavailable', what); return v; };
      if (kind === 'section') { need(c, 'No notebook is shown').openSection(id); return {section: `/sec:${id}`}; }
      if (kind === 'page') { need(c, 'No notebook is shown').openPage(id); return {page: `/pg:${id}`}; }
      if (target === 'addPage') { need(c, 'No notebook is shown').addPage(); return {ran: 'page.new'}; }
      if (target === 'addSection') { need(c, 'No notebook is shown').addSection(); return {ran: 'section.new'}; }
      const api = need(canvas.current, 'No page is shown');
      if (target === 'title') return api.clickTitle();
      // `path` is the pointer's samples ([[x, y], ...]); it stands in for x, y and `to`.
      const path = Array.isArray(p.path) && p.path.length >= 1 && p.path.every((q: any) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])) ? p.path : null;
      const at = path && p.x === undefined ? {x: path[0][0], y: path[0][1]} : {x: Number(p.x), y: Number(p.y)};
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new CommandError('invalid_params', 'x and y are page coordinates in px');
      if (p.action === 'drag' || p.action === 'stroke') {
        const first = path ? {x: path[0][0], y: path[0][1]} : at;
        const last = path ? {x: path[path.length - 1][0], y: path[path.length - 1][1]} : p.to && Number.isFinite(p.to.x) && Number.isFinite(p.to.y) ? p.to : null;
        return api.drag(target || 'ink', first, need(last, 'A drag needs `to` or a `path`'), path ?? undefined);
      }
      return api.click(at);
    },
    type: (text: string) => {
      if (!canvas.current) throw new CommandError('unavailable', 'No page is shown');
      return canvas.current.type(String(text ?? ''));
    },
  } as SurfaceHandle), [register, session, docId]);

  const rows: PageRow[] = useMemo(() => {
    if (!notebook || !loc.sectionId) return [];
    return content.sections[loc.sectionId].pages.map((e: any) => ({id: e.id, level: e.level, title: content.pages[e.id].title, unread: content.pages[e.id].unread === true}));
  }, [notebook, content?.sections, content?.pages, loc.sectionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null;
  if (!notebook) return <LegacyNotice/>;

  const section = loc.sectionId ? content.sections[loc.sectionId] : null;
  const page: PageRecord | null = loc.pageId ? content.pages[loc.pageId] : null;
  const view: any = doc.view ?? {};
  const pane: Pane | null = view.pane && typeof view.pane.kind === 'string' ? view.pane : null;
  // A saved version of the current page, read-only (History › Page Versions).
  let viewing: any = null;
  if (view.versionView && view.versionView.page === loc.pageId) { try { viewing = findVersion(content, view.versionView.version, loc.pageId).version; } catch { viewing = null; } }
  // View tab: Full Page View and the navigation panes, the tabs layout, the dark page, the Immersive Reader.
  const panes = panesOf(view);
  const fullPage = view.fullPage === true;
  const showTabs = !fullPage && panes.navigation;
  const showPageList = !fullPage && panes.navigation && panes.pages;
  const vertical = session.prefs?.[TABS_LAYOUT_PREF] === 'vertical';
  const touch = session.prefs?.[TOUCH_PREF] === 'touch';
  const dark = session.prefs?.[DARK_PAGE_PREF] === true;
  const reader = view.immersive?.on === true && page ? readerOf(view) : null;
  const zoom = Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom / 100 : 1;
  const ink: InkTool | null = view.ink && typeof view.ink.tool === 'string' ? view.ink : null;
  const canAddPage = session.state(docId, 'page.new').enabled;
  const canAddSection = session.state(docId, 'section.new').enabled;
  const go = (sel: any) => { try { session.setSelection(docId, sel, {origin: 'ui'}); } catch { /* closed */ } };
  const openSection = (sid: string) => {
    const remembered = lastPage.current.get(sid);
    const pages = content.sections[sid].pages;
    const target = remembered && pages.some((e: any) => e.id === remembered) ? remembered : pages[0]?.id;
    go(target ? selectPage(target) : selectSection(sid));
  };
  const items = levelItems(content, level);
  const parentLevel = level ? parentOf(content, level)?.parent ?? null : null;
  const addPage = () => { void controller.run('page.new', loc.sectionId ? {sectionId: loc.sectionId} : {}, {origin: 'ui'}); };
  const addSection = () => { void controller.run('section.new', level ? {groupId: level} : {}, {origin: 'ui'}); };
  /** A link on the page: a page or section of this notebook is opened, a web address goes to the system. */
  const openLink = (href: string) => {
    const m = /^slate:(page|section)\/([^#]+)(?:#(.+))?$/.exec(href);
    if (!m) {
      const w = (window as any).studio;
      if (typeof w?.openExternal === 'function') void w.openExternal(href).catch((e: any) => controller.notify(String(e?.message ?? e), 'error'));
      else controller.notify(`Opening ${href} is not available here`, 'error');
      return;
    }
    const id = decodeURIComponent(m[2]);
    if (m[1] === 'page') {
      if (!content.pages[id]) { controller.notify('That page is no longer in this notebook', 'error'); return; }
      const block = m[3] ? decodeURIComponent(m[3]) : null;
      go(block ? {ranges: [{anchor: `/pg:${id}/b:${block}/t:0`, focus: `/pg:${id}/b:${block}/t:0`}], primary: 0} : selectPage(id));
    } else if (content.sections[id]) openSection(id);
    else controller.notify('That section is no longer in this notebook', 'error');
  };
  chrome.current = {
    openSection: id => { if (!content.sections[id]) throw new CommandError('not_found', `No section ${id}`); openSection(id); },
    openPage: id => { if (!content.pages[id]) throw new CommandError('not_found', `No page ${id}`); go(selectPage(id)); },
    addPage: () => { if (!canAddPage || !section) throw new CommandError('disabled', 'Add Page is not available here'); addPage(); },
    addSection: () => { if (!canAddSection) throw new CommandError('disabled', 'New Section is not available here'); addSection(); },
  };

  const nameChip = panes.notebooks ? (
    <div className="slate-notebook-name" title={content.notebook.path ?? content.notebook.name}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="10" height="12" rx="1.5" fill={content.notebook.color ?? '#7f6fd1'}/><path d="M5.5 2v12" stroke="#fff" strokeOpacity=".7" strokeWidth="1"/></svg>
        <span>{content.notebook.name}</span>
    </div>) : null;
  const upButton = level ? (
      <button type="button" className="slate-tab is-up" onClick={() => setNavLevel(parentLevel)} title="Navigate to Parent Section Group" aria-label="Navigate to Parent Section Group">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-8M4.5 7.5 8 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>) : null;
  const addTab = canAddSection ? (
    <button type="button" className="slate-tab is-add" title="Create a New Section (Ctrl+T)" aria-label="Create a New Section" onClick={addSection}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    </button>) : null;
  const sectionTabs = items.map((id: string) => {
          const s = content.sections[id];
          if (s) {
            const unread = view.showUnread !== false && s.pages.some((e: any) => content.pages[e.id]?.unread === true);
            return <button key={id} data-tab={id} type="button" role="tab" aria-selected={id === loc.sectionId} className={`slate-tab${id === loc.sectionId ? ' is-current' : ''}${unread ? ' has-unread' : ''}${s.locked === true ? ' is-locked' : ''}`}
              style={{['--tab' as any]: s.color ?? '#b0b0b0'}} onClick={() => openSection(id)} title={s.locked === true ? `${s.name} (locked)` : s.name}>
              {s.protection ? <svg className="slate-tab-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.4" fill={s.locked === true ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3"/><path d={s.locked === true ? 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7' : 'M5.5 7V5.2a2.5 2.5 0 0 1 4.6-1.4'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg> : null}
              <span>{s.name}</span></button>;
          }
          const g = content.groups[id];
          return <button key={id} data-tab={id} type="button" className="slate-tab is-group" onClick={() => setNavLevel(id)} title={g.name}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
            <span>{g.name}</span>
          </button>;
  });

  return <div className={`slate-surface${vertical ? ' is-vertical' : ''}${dark ? ' is-dark' : ''}${fullPage ? ' is-full-page' : ''}${touch ? ' is-touch' : ''}`} ref={surfaceRef} style={{['--slate-section' as any]: section?.color ?? '#b0b0b0'}}>
    {showTabs && !vertical ? <div className="slate-tabs" role="tablist" aria-label="Sections">
      {nameChip}{upButton}
      <TabStrip current={loc.sectionId}
        entries={items.map((id: string) => content.sections[id] ? {id, name: content.sections[id].name, color: content.sections[id].color}
          : {id, name: content.groups[id].name, group: true})}
        onOpen={e => (e.group ? setNavLevel(e.id) : openSection(e.id))}
        after={addTab}>
        {sectionTabs}
      </TabStrip>
    </div> : null}
    <div className="slate-main">
      {showTabs && vertical ? <nav className="slate-vtabs" role="tablist" aria-orientation="vertical" aria-label="Sections">{nameChip}{upButton}{sectionTabs}{addTab}</nav> : null}
    <div className="slate-body">
      {viewing ? <VersionView version={viewing} hideAuthors={view.hideAuthors === true} onRestore={() => void controller.run('history.restoreVersion', {versionId: viewing.id}, {origin: 'ui'})}
        onBack={() => void controller.run('history.viewVersion', {versionId: null}, {origin: 'ui'})}/> : null}
      <div className="slate-page-scroll" hidden={!!viewing}>
        {page ? <PageCanvas key={page.id} session={session} controller={controller} docId={docId} page={page}
          selection={doc.selection.ranges[doc.selection.primary ?? 0] ?? null} ranges={doc.selection.ranges} zoom={zoom} ink={ink}
          insertSpace={view.insertSpace === true} touchDraw={view.touchDraw !== false} ruler={view.ruler === true} inkToShape={view.inkToShape === true}
          replay={view.replay && Array.isArray(view.replay.ids) ? {run: view.replay.run, ids: view.replay.ids, page: view.replay.page} as any : null} onLink={openLink} apiRef={canvas}/>
          : section?.locked === true ? <LockedSection name={section.name} color={section.color} onUnlock={() => { void controller.run('password.unlock', {sectionId: section.id}, {origin: 'ui'}); }}/>
          : <div className="slate-no-page">{section ? <p>This section has no pages.</p> : <p>This notebook has no sections.</p>}</div>}
      </div>
      {pane?.kind === 'spelling' ? <SpellingPane controller={controller} docId={docId}/> : (pane?.kind as string) === 'search' ? <SearchPane content={content} pane={pane as unknown as RestPane} controller={controller} onOpen={id => { go(selectPage(id)); }}/> : (pane?.kind as string) === 'accessibility' ? <AccessibilityPane content={content} pane={pane as unknown as RestPane} controller={controller}/> : (pane?.kind as string) === 'help' ? <HelpPane pane={pane as unknown as RestPane} controller={controller}/> : pane ? <HistoryPane content={content} pane={pane} view={view} controller={controller} now={Date.now()} onOpen={id => { go(selectPage(id)); }}/> : null}
      {showPageList ? <PageList touch={touch} rows={view.showUnread === false ? rows.map(r => ({...r, unread: false})) : rows} current={loc.pageId} color={section?.color ?? null} canAdd={canAddPage && !!section && section.locked !== true}
        onSelect={id => go(selectPage(id))} onAdd={addPage}/> : null}
    </div>
    {(view.recording ?? null) ? <RecordingBanner rec={view.recording} controller={controller}/> : null}
    {reader && page ? <ImmersiveReader page={page} reader={reader} controller={controller}/> : null}
    </div>
  </div>;
}

/** Shown on the page for as long as a recording runs (OneNote's recording indicator): a red dot, the kind, the time, Pause and Stop. */
function RecordingBanner({rec, controller}: {rec: {id: string; kind: string; start: number; paused?: boolean; pausedFor?: number; pausedAt?: number}; controller: ShellController}) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 500); return () => clearInterval(t); }, []);
  const ms = (rec.paused && rec.pausedAt ? rec.pausedAt : Date.now()) - rec.start - (rec.pausedFor ?? 0);
  const s = Math.max(0, Math.floor(ms / 1000));
  const run = (c: string) => { void controller.run(c, {}, {origin: 'ui'}); };
  return <div className={`slate-recording${rec.paused ? ' is-paused' : ''}`} role="status" aria-live="off" data-recording={rec.kind}>
    <i className="slate-rec-dot" aria-hidden="true"/>
    <b>{rec.paused ? 'Recording paused' : rec.kind === 'video' ? 'Recording video' : 'Recording audio'}</b>
    <span className="slate-rec-time">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
    <button type="button" aria-label={rec.paused ? 'Resume recording' : 'Pause recording'} title={rec.paused ? 'Resume' : 'Pause'} onClick={() => run(rec.paused ? 'media.play' : 'media.pause')}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">{rec.paused ? <path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/> : <path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</svg></button>
    <button type="button" className="is-stop" aria-label="Stop recording" title="Stop recording" onClick={() => run('media.stop')}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg></button>
  </div>;
}

/** A locked, password-protected section: its pages are not in the notebook until the password unlocks them. */
function LockedSection({name, color, onUnlock}: {name: string; color: string | null; onUnlock: () => void}) {
  return <div className="slate-locked" role="status" data-locked-section>
    <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="9" y="21" width="30" height="21" rx="4.5" fill={color ?? '#b0b0b0'} fillOpacity=".25" stroke="currentColor" strokeWidth="2.4"/>
      <path d="M16 21v-6a8 8 0 0 1 16 0v6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><circle cx="24" cy="31" r="2.6" fill="currentColor"/><path d="M24 33v4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>
    <p><strong>{name}</strong> is password protected.</p>
    <p>Its pages are locked until you enter the password.</p>
    <button type="button" className="slate-locked-button" onClick={onUnlock}>Enter Password</button>
  </div>;
}

/** A schema-1 page from the legacy editor reaches this surface only in development builds. */
function LegacyNotice() {
  return <div className="slate-legacy" role="status">
    <p><strong>This note was saved by the earlier Slate editor.</strong></p>
    <p>It opens here once it has been converted into a notebook.</p>
  </div>;
}
