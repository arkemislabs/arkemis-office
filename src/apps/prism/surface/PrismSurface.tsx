// Prism's editing surface (docs/architecture.md 16.3; F:prism): PowerPoint's Normal view.
//
//   ┌──────────┬─────────────────────────────────────────────┐
//   │ 1 ▭      │                                             │
//   │ 2 ▭      │          the current slide, centred         │
//   │ 3 ▭      │          (fit, or the zoom percent)         │
//   │ …        ├──────────────── drag divider ───────────────┤
//   │ + New    │ Click to add notes                          │
//   └──────────┴─────────────────────────────────────────────┘
//
// Slide thumbnails on the left (236 px, resizable; drag to reorder, Ctrl/Shift to multi-select),
// the slide canvas in the middle, the notes pane below it (52 px, resizable with the divider; shown
// unless View › Notes turned it off: `view.notes === false`). Sizes and the notes default are
// deckcraft's (crates/ui-egui/src/state.rs UiState defaults: notes true, notes_height 52,
// thumbs_width 236, at f893f6af7d36a5409fd804e81a34fd895cfefedf). The current slide and every
// selection are the kernel selection (core/prism/model/doc.mjs), so the bridge, undo and the keys
// move the same view.

import {Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {isSchema2, currentSlideIndex, currentSlideId, slideById} from '../../../../core/prism/model/doc.mjs';
import {evaluate as contextFlags} from '../../../../core/prism/context.mjs';
import {planKey, planTyping} from '../../../../core/prism/lib/keys.mjs';
import {platform} from '../../../shell/env';
import {Thumbnails} from './Thumbnails';
import {applyPicks} from '../lib/colorAt';
import {squiggleHit} from './proof-store';
import {SlideCanvas} from './SlideCanvas';
import {NotesPane} from './NotesPane';
import {SorterView, NotesPageView, OutlinePane} from './ViewModes';
import {MasterList} from './MasterView';
import './surface.css';

// The slide show covers the window while `view.show` is set (Slide Show › From Beginning / From Current Slide).
const ShowStage = lazy(() => import('../show/ShowStage'));

type Any = any;
const EMPTY: string[] = [];

function useDoc(session: SurfaceProps['controller']['session'], docId: string) {
  useSyncExternalStore(session.subscribe, () => session.tick);
  try { return session.get(docId); } catch { return null; }
}

/** A divider dragged with the pointer (pointer capture; the size is clamped by the caller). */
function useDivider(onDrag: (delta: number) => void, axis: 'x' | 'y') {
  const start = useRef<{at: number} | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => { start.current = {at: axis === 'x' ? e.clientX : e.clientY}; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); e.preventDefault(); },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      const at = axis === 'x' ? e.clientX : e.clientY;
      onDrag(at - start.current.at);
      start.current.at = at;
    },
    onPointerUp: () => { start.current = null; },
  };
}

export default function PrismSurface({controller, docId, register}: SurfaceProps) {
  const session = controller.session;
  const doc = useDoc(session, docId);
  const content: Any = doc?.file.content;
  const root = useRef<HTMLDivElement>(null);
  const [thumbsWidth, setThumbsWidth] = useState(236);
  const [notesHeight, setNotesHeight] = useState(52);

  useEffect(() => register({
    focus: () => root.current?.querySelector<HTMLTextAreaElement>('.prism-input')?.focus({preventScroll: true}),
    // Right-click on a squiggled word: its menu (suggestions, Delete Repeated Word, Ignore All, Add to Dictionary); the bridge's ui.contextMenu takes the first misspelt word of the slide.
    contextMenu: async (x: number, y: number) => {
      const it = squiggleHit(docId, x, y);
      if (!it) return null;
      try { await controller.run('review.spellingMenu', {slide: it.slide, shape: it.shape, para: it.para, start: it.start, ...(it.row !== undefined ? {row: it.row, col: it.col} : {})}, {origin: 'ui'}); } catch { return null; }
      return 'misspelled-word';
    },
    contextPrepare: async (target: string) => {
      if (target !== 'misspelled-word') return;
      if (!(session.get(docId).view as Any)?.spellMenu) await controller.run('review.spellingMenu', {}, {origin: 'ui'});
    },
    contextFlags: () => {
      try {
        const d = session.get(docId);
        const open = (d.view as Any)?.master;
        // A master view shows its own tab beside the shape tabs of what is selected.
        const flags: Record<string, boolean> = {...contextFlags(d.file.content, d.selection)};
        if (open) flags[open.kind === 'slide' ? 'slide-master' : open.kind === 'handout' ? 'handout-master' : 'notes-master'] = true;
        return flags;
      } catch { return {}; }
    },
    // deckcraft's control channel input (crates/ui-egui/src/control.rs `ui.pointer`, `ui.key`,
    // `ui.type`), ready for RendererBridge (design note F-prism--integrator--bridge-ui-input):
    // a gesture's events, one key (engine keys first, the registry's shortcuts after), typed text.
    pointer: async (p: {events: Any[]; mods?: Any; tol?: number}) => {
      const r: Any = await controller.run('surface.pointer', {events: (p?.events ?? []).map(e => ({...e, mods: e.mods ?? p.mods})), tol: p?.tol ?? 4}, {origin: 'bridge-ui'});
      // The Eyedropper's click: the colour of the slide as drawn under it.
      await applyPicks(controller, docId, r?.result?.ui);
      return r;
    },
    key: async (key: string, mods: Any = {}) => {
      const d = session.get(docId);
      const plan: Any = planKey(d.file.content, d.selection, key, mods, {mac: platform() === 'mac', drawingFreeform: !!(d.view as Any)?.toolDrag});
      if (!plan.handled) return {handled: false};
      if (plan.select) session.setSelection(docId, plan.select, {origin: 'bridge'});
      for (const st of plan.steps ?? []) await controller.run(st.command, st.params, {origin: 'bridge-ui'});
      return {handled: true, commands: (plan.steps ?? []).map((s: Any) => s.command)};
    },
    type: async (text: string) => {
      const d = session.get(docId);
      const steps: Any = planTyping(d.file.content, d.selection, text);
      if (!steps) return {handled: false};
      for (const st of steps) await controller.run(st.command, st.params, {origin: 'bridge-ui'});
      return {handled: true};
    },
  } as Any), [register, session, docId, controller]);

  // View > Move Split: the bridge's `view.moveSplit {dx, dy}` moves the bars by pixels; armed, the arrow keys do (Enter or Esc ends it).
  const splitMove = (doc?.view as Any)?.splitMove ?? null;
  const splitArmed = !!(doc?.view as Any)?.moveSplit;
  useEffect(() => {
    if (!splitMove) return;
    if (splitMove.dx) setThumbsWidth(w => Math.min(Math.max(w + splitMove.dx, 60), 1000));
    if (splitMove.dy) setNotesHeight(h => Math.min(Math.max(h - splitMove.dy, 0), 2000));
  }, [splitMove?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!splitArmed) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowLeft') setThumbsWidth(w => Math.min(Math.max(w - step, 60), 1000));
      else if (e.key === 'ArrowRight') setThumbsWidth(w => Math.min(Math.max(w + step, 60), 1000));
      else if (e.key === 'ArrowUp') setNotesHeight(h => Math.min(Math.max(h + step, 0), 2000));
      else if (e.key === 'ArrowDown') setNotesHeight(h => Math.min(Math.max(h - step, 0), 2000));
      else if (e.key === 'Enter' || e.key === 'Escape') void controller.run('view.moveSplit', {end: true}, {origin: 'ui'}).catch(() => {});
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [splitArmed]); // eslint-disable-line react-hooks/exhaustive-deps

  const thumbsDivider = useDivider(d => setThumbsWidth(w => Math.min(Math.max(w + d, 60), 1000)), 'x');
  const notesDivider = useDivider(d => setNotesHeight(h => Math.min(Math.max(h - d, 0), 2000)), 'y');

  // Presenter View (show.presenter): a second window beside the running show. The show window pushes the presentation and where
  // the show is; the presenter's Previous, Next and End Show come back as show.previous, show.next and show.end.
  const showRun = (doc?.view as Any)?.show ?? null;
  const presenterOn = !!showRun && !showRun.reading && !!(doc?.view as Any)?.presenter;
  const latest = useRef<{content: Any; status: Any; custom: string | null}>({content: null, status: null, custom: null});
  latest.current.content = doc ? (doc.file as Any).content : null;
  latest.current.custom = showRun?.custom ?? null;
  useEffect(() => {
    const api = (window as Any).studio?.presenter;
    if (!presenterOn || !api) return undefined;
    let ours = false;
    const sendAll = () => {
      api.push({type: 'content', content: latest.current.content, custom: latest.current.custom});
      if (latest.current.status) api.push({type: 'status', ...latest.current.status});
    };
    const off = api.onCommand((cmd: Any) => {
      const run = (id: string, params: Record<string, unknown> = {}) => { void controller.run(id, params, {origin: 'ui'}).catch(() => {}); };
      if (cmd.kind === 'next') run('show.next');
      else if (cmd.kind === 'previous') run('show.previous');
      else if (cmd.kind === 'end') run('show.end');
      else if (cmd.kind === 'hello') sendAll();
      else if (cmd.kind === 'drawn') run('show.presenterState', {open: true, slide: cmd.index, info: cmd.info});
      else if (cmd.kind === 'closed' && !ours) run('show.presenter', {on: false});
    });
    void api.open().then(() => sendAll()).catch(() => {});
    return () => { ours = true; off(); void api.close().catch(() => {}); void controller.run('show.presenterState', {open: false}, {origin: 'ui'}).catch(() => {}); };
  }, [presenterOn, showRun?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Animation Pane (animation.pane): the command asks, the shell opens it; a pane the person closes with its own button is reported back.
  const shellState = useSyncExternalStore(controller.subscribe, controller.getState);
  const requested = (doc?.view as Any)?.paneRequest;
  const mirrored = (doc?.view as Any)?.panes ?? {};
  useEffect(() => { if (requested) controller.setPane(requested.pane, requested.on); }, [requested?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const isOpen = (id: string) => !!shellState.panes.find(p => String(p.id).replace(/^pane./, '') === id)?.open;
    if (isOpen('animation') !== !!mirrored.animation) void controller.run('animation.pane', {on: isOpen('animation'), mirror: true}, {origin: 'ui'}).catch(() => {});
    for (const id of ['background', 'designer', 'comments', 'revisions', 'thesaurus', 'selection', 'format', 'spelling']) {
      if (isOpen(id) !== !!mirrored[id]) void controller.run('pane.toggle', {pane: id, on: isOpen(id), mirror: true}, {origin: 'ui'}).catch(() => {});
    }
  }, [shellState.panes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null;
  if (!isSchema2(content)) return <LegacyNotice/>;
  const index = currentSlideIndex(content, doc.selection);
  const view: Any = doc.view ?? {};
  // In a master view the slide is the master, layout, handout or notes master edited as one (a virtual slide).
  const slide = view.master ? slideById(content, currentSlideId(content, doc.selection)) : content.slides[index] ?? null;
  const showNotes = view.notes !== false && !view.master;
  const playing = view.show ? view.show : null;

  const mode: string = view.mode ?? 'normal';
  const openMaster: Any = view.master ?? null;
  const wide = mode === 'sorter' || mode === 'notesPage';
  return <div className={`prism-surface${view.grayscale ? ' is-grayscale' : ''}${view.blackWhite ? ' is-blackwhite' : ''}${splitArmed ? ' is-moving-split' : ''}${wide ? ' is-wide-view' : ''}`} data-view-mode={mode} ref={root} style={{['--prism-thumbs' as Any]: `${thumbsWidth}px`}}>
    {openMaster ? <MasterList controller={controller} content={content} open={openMaster}/> : wide ? null : mode === 'outline' ? <OutlinePane controller={controller} content={content} current={index}/>
      : <Thumbnails controller={controller} docId={docId} content={content} selection={doc.selection} current={index} width={thumbsWidth} folded={view.foldedSections ?? EMPTY} hideInk={!!view.hideInk}/>}
    {wide || openMaster ? null : <div className="prism-divider is-vertical" role="separator" aria-orientation="vertical" aria-label="Resize the slide pane" {...thumbsDivider}/>}
    {mode === 'sorter' && !openMaster ? <SorterView controller={controller} content={content} selection={doc.selection} current={index}/>
      : mode === 'notesPage' && slide ? <NotesPageView controller={controller} content={content} slide={slide} index={index}/> : null}
    {wide ? null : <div className="prism-main">
      {slide ? <SlideCanvas controller={controller} docId={docId} content={content} selection={doc.selection} view={view} slide={slide}
        onActivate={() => {}}/>
        : <div className="prism-empty">{controller.hasCommand('slide.new')
          ? <button type="button" className="prism-empty-add" onClick={() => { void controller.run('slide.new', {}, {origin: 'ui'}).catch(() => {}); }}>Click to add first slide</button>
          : null}</div>}
      {showNotes && slide ? <>
        <div className="prism-divider is-horizontal" role="separator" aria-orientation="horizontal" aria-label="Resize the notes pane" {...notesDivider}/>
        <div className="prism-notes-wrap" style={{height: notesHeight}}><NotesPane controller={controller} slide={slide} index={index}/></div>
      </> : null}
    </div>}
    {playing ? <Suspense fallback={null}>
      <ShowStage key={playing.n} content={content} mode="show" from={playing.from ?? 0} custom={playing.custom ?? null} command={view.showCmd ?? null}
        onStatus={s => { latest.current.status = s; (window as Any).studio?.presenter?.push({type: 'status', ...s}); void controller.run('show.report', s, {origin: 'ui'}).catch(() => {}); }}
        onKeepInk={ink => { void controller.run('show.addInk', {ink}, {origin: 'ui'}).catch(() => {}); }}
        rehearse={!!playing.rehearse}
        onExit={timings => { void controller.run(timings ? 'show.rehearsed' : 'show.end', timings ? {timings} : {}, {origin: 'ui'}).catch(() => {}); }}/>
    </Suspense> : null}
  </div>;
}

/** A schema-1 deck from the legacy editor reaches this surface only in development builds. */
function LegacyNotice() {
  return <div className="prism-legacy" role="status">
    <p><strong>This presentation was saved by the earlier Prism editor.</strong></p>
    <p>It opens here once it has been converted to the new presentation format.</p>
  </div>;
}
