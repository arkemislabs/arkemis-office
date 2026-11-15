// The PDF editing surface (docs/architecture.md 16.4; F:folio): Acrobat's document view.
//
//   ┌──────────────────────────────────────────────────────┬──────────────┐
//   │  continuous pages, centred, 14 px apart              │ side panel:  │
//   │  (only the pages near the view are mounted)          │ Page         │
//   │  text selection, comments, freehand drawing          │ thumbnails / │
//   │                                                      │ Bookmarks    │
//   └──────────────────────────────────────────────────────┴──────────────┘
//
// Translated from printcraft crates/ui-egui/src/canvas.rs (continuous layout, current page, zoom
// anchored on the page at the top of the view), panels/side_panels.rs (the side panel docked right
// of the page, 330 px, resizable 260–520), panels/pages.rs (thumbnails, the current page marked,
// a click goes to the page), panels/bookmarks.rs (the outline tree; a click goes to its page),
// tools/comments/input.rs `keys` and `nudge_keys` (Delete removes the selected comment; Escape
// steps back; arrows move it one screen pixel, ten with Shift or Ctrl) and composer.rs (a comment's
// text is edited in a composer at the comment), organize/src/view.rs (/PageMode opens the
// navigation panel) at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt).

import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {migrateContent} from '../../../../core/folio/migrate.mjs';
import {annotateState} from '../../../../core/folio/model/index.mjs';
import {cachedPageText} from '../../../../core/folio/model/page-text.mjs';
import {evaluate as contextFlags} from '../../../../core/folio/context.mjs';
import {OrganizeGrid, selectedIndices, pageSelection} from './OrganizeGrid';
import {layoutPages, visiblePages, currentPage, fitZoom, displayOf, PT, runSelection, selectionRun, movable, isMarkup, MIN_ZOOM, MAX_ZOOM} from '../../../../core/folio/lib/pageview.mjs';
import {userToView} from '../../../../core/folio/lib/geom.mjs';
import {nameAt} from '../../../../core/folio/lib/cos.mjs';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {Icon} from '../../../shell/icons/Icon';
import CombineWorkspace from './CombineWorkspace';
import {FindBar} from './FindBar';
import {PageView, measureKind, type MeasureLive, type PageApi, type TextRun} from './PageView';
import {SidePanel} from './SidePanel';
import {acquire, release, initialPanel, type PdfSource} from './pdf';
import {publish} from './metrics';
import './surface.css';

function useDoc(session: SurfaceProps['controller']['session'], docId: string) {
  useSyncExternalStore(session.subscribe, () => session.tick);
  try { return session.get(docId); } catch { return null; }
}

const annotAddress = (pageId: string, id: string) => `/pg:${encodeURIComponent(pageId)}/annot:${encodeURIComponent(id)}`;
const SIDE_WIDTH = 330, SIDE_MIN = 260, SIDE_MAX = 520;

export default function FolioSurface({controller, docId, register}: SurfaceProps) {
  const session = controller.session;
  const doc = useDoc(session, docId);
  const content: any = doc?.file.content ?? null;
  const pages: any[] = Array.isArray(content?.pages) ? content.pages : [];
  const view: any = doc?.view ?? {zoom: 100, fit: null};
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({width: 0, height: 0, top: 0});
  const [migrating, setMigrating] = useState<string | null>(null);
  const [panel, setPanel] = useState<'pages' | 'bookmarks' | null>(null);
  const [panelWidth, setPanelWidth] = useState(SIDE_WIDTH);
  // The Measure tool's gesture (the vertices placed so far); the ref holds the latest for the page views' async clicks.
  const [measure, setMeasureState] = useState<MeasureLive | null>(null);
  const measureRef = useRef<MeasureLive | null>(null);
  const setMeasure = useCallback((next: MeasureLive | null) => { measureRef.current = next; setMeasureState(next); }, []);
  const [composer, setComposer] = useState<{pageId: string; id: string; text: string} | null>(null);
  const [liveRun, setLiveRun] = useState<{pageId: string; run: TextRun} | null>(null);
  const opened = useRef(performance.now());
  const firstPaint = useRef<number | null>(null);
  const renders = useRef({count: 0, total: 0, last: 0});

  // Schema 1 → 2 on opening: the file's comments, crop boxes and form fields are read into the
  // model (core/folio/migrate.mjs) before anything is edited.
  useEffect(() => {
    if (!doc || !content || content.folio === 2 || !content.sourceBase64) return;
    let alive = true;
    setMigrating('Reading comments…');
    migrateContent(content).then(next => {
      if (!alive) return;
      try { session.reload(docId, {...doc.file, content: next} as any); } catch { /* edited meanwhile: the next open reads them */ }
      setMigrating(null);
    }).catch(e => { if (alive) { setMigrating(null); controller.notify(`The comments in this PDF could not be read: ${e?.message ?? e}`, 'error'); } });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content?.sourceBase64, content?.folio]);

  // The pdf.js document for the source.
  const base64: string = content?.sourceBase64 ?? '';
  const source = useMemo<PdfSource | null>(() => (base64 ? acquire(base64) : null), [base64]);
  useEffect(() => () => { if (source) release(source); }, [source]);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    initialPanel(source).then(p => {
      if (!alive || !p) return;
      setPanel(cur => cur ?? p);
      // The rail's toggle shows the panel the file opened (view.panel, the rail's Page thumbnails / Bookmarks).
      let shown: unknown;
      try { shown = (session.get(docId).view as any)?.panel; } catch { return; }
      if (shown === undefined) void session.execute(docId, 'view.panel', {panel: p, open: true}, {origin: 'ui'}).catch(() => {});
    });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  useEffect(() => { if (view.panel === 'pages' || view.panel === 'bookmarks') setPanel(view.panel); else if (view.panel === null) setPanel(null); }, [view.panel]);
  const closePanel = () => {
    const shown = panel;
    setPanel(null);
    if (shown) void session.execute(docId, 'view.panel', {panel: shown, open: false}, {origin: 'ui'}).catch(() => {});
  };

  // Size of the scroll area.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox(b => ({...b, width: el.clientWidth, height: el.clientHeight}));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // View rotation (View > Rotate View): the pages are shown turned; the document keeps its own rotation.
  const turn: number = view.rotation ?? 0;
  const shown = useMemo(() => (turn ? pages.map(p => ({...p, rotation: (((p.rotation ?? 0) + turn) % 360)})) : pages), [pages, turn]);
  // Zoom: a percent, or a fit mode computed from the view's size (zoom.rs fit_zoom); the page display
  // (single or two-page view, continuous scrolling, cover page, gaps) is the view's.
  const display = {layout: view.layout, continuous: view.continuous, cover: view.cover, gaps: view.gaps};
  const disp = displayOf(display);
  const viewHeight = disp.continuous ? 0 : box.height;
  const fitIndex = Math.min(Math.max(0, currentPage(layoutPages(shown, view.zoom ?? 100, box.width, {...display, viewHeight}), box.top, box.height)), Math.max(0, pages.length - 1));
  const contentBox = useMemo(() => {
    if (view.fit !== 'visible' || !content || !pages[fitIndex]) return null;
    const t = cachedPageText(content, pages[fitIndex]);
    const g = t?.glyphs ?? [];
    if (!g.length) return null;
    return g.reduce((u: number[], x: any) => [Math.min(u[0], x.rect[0]), Math.min(u[1], x.rect[1]), Math.max(u[2], x.rect[2]), Math.max(u[3], x.rect[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  }, [view.fit, content, pages, fitIndex]);
  const zoom = view.fit && box.width ? fitZoom(view.fit, shown[fitIndex], box.width, box.height, {pages: shown, current: fitIndex, ...disp, content: contentBox}) : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom ?? 100));
  const layout = useMemo(() => layoutPages(shown, zoom, box.width, {...display, viewHeight}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, zoom, box.width, viewHeight, disp.layout, disp.continuous, disp.cover, disp.gaps]);
  const range = visiblePages(layout, box.top, box.height, box.height || 800);
  const current = currentPage(layout, box.top, box.height);

  // Keep the page at the top of the view in place when the zoom changes (zoom.rs anchored_scroll).
  const anchor = useRef<{page: number; frac: number} | null>(null);
  const lastZoom = useRef(zoom);
  useEffect(() => {
    const el = scroller.current;
    if (!el || lastZoom.current === zoom) return;
    const a = anchor.current;
    lastZoom.current = zoom;
    if (a && layout.tops.length > a.page) { el.scrollTop = layout.tops[a.page] + a.frac * layout.heights[a.page] - 28; setBox(b => ({...b, top: el.scrollTop})); }
  }, [zoom, layout]);
  // Marquee zoom: once the zoom it asked for is in, the rectangle is brought to the top left of the window.
  const pendingRect = useRef<{index: number; rect: number[]; zoom: number} | null>(null);
  useEffect(() => {
    const el = scroller.current, pr = pendingRect.current;
    if (!el || !pr || Math.abs(zoom - pr.zoom) > 0.5 || pr.index >= layout.tops.length) return;
    pendingRect.current = null;
    el.scrollTop = Math.max(0, layout.tops[pr.index] + pr.rect[1] * layout.scale - 20);
    el.scrollLeft = Math.max(0, layout.left(pr.index) + pr.rect[0] * layout.scale - 20);
    setBox(b => ({...b, top: el.scrollTop}));
  }, [zoom, layout]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const p = currentPage(layout, top, el.clientHeight);
    if (layout.tops.length) anchor.current = {page: p, frac: Math.max(0, (top + 28 - layout.tops[p]) / Math.max(1, layout.heights[p]))};
    setBox(b => (b.top === top ? b : {...b, top}));
  };

  const goToPage = useCallback((i: number, record = true) => {
    const el = scroller.current;
    if (!el || !layout.tops.length) return;
    const k = Math.min(Math.max(0, i), layout.tops.length - 1);
    // The view history (navigation.rs go_to_page): the page left is what Previous view comes back to.
    if (record && k !== current) void session.execute(docId, 'view.jump', {from: current + 1}, {origin: 'ui'}).catch(() => {});
    el.scrollTop = Math.max(0, layout.slotTops[k] - (layout.display.continuous ? 28 : 0));
    el.scrollLeft = 0;
    setBox(b => ({...b, top: el.scrollTop}));
  }, [layout, current, session, docId]);

  // Find: each move to a match (step, goto, a new search) shows it: its page, and in continuous scrolling the match itself
  // a little below the top of the window (find.rs flash_match).
  const findRev: number = view.find?.rev ?? 0;
  const seenFindRev = useRef(findRev);
  useEffect(() => {
    if (seenFindRev.current === findRev) return;
    seenFindRev.current = findRev;
    const f = view.find;
    const m = f && f.current !== null && f.current !== undefined ? f.matches?.[f.current] : null;
    const el = scroller.current;
    if (!m || !el || !layout.tops.length) return;
    goToPage(m[0]);
    if (layout.display.continuous) {
      const g = content && pages[m[0]] ? cachedPageText(content, pages[m[0]])?.glyphs?.[m[1]] : null;
      if (g) { el.scrollTop = Math.max(0, layout.tops[m[0]] + g.rect[1] * layout.scale - 120); setBox(b => ({...b, top: el.scrollTop})); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findRev]);

  // Selection: the session's (bridge, commands and this view share it).
  const selection: any = doc?.selection ?? {ranges: [], primary: 0};
  const primary = selection.ranges?.[selection.primary ?? 0];
  const selectedAnnot = useMemo(() => {
    const m = /^\/pg:([^/]+)\/annot:([^/]+)$/.exec(String(primary?.anchor ?? ''));
    return m ? {pageId: decodeURIComponent(m[1]), id: decodeURIComponent(m[2])} : null;
  }, [primary?.anchor]);
  const sessionRun = useMemo(() => {
    const r = selectionRun(selection, (id: string) => { const p = pages.find(x => x.id === id); return p && content ? cachedPageText(content, p) : null; });
    return r ? {pageId: r.pageId, run: {first: r.first, last: r.last, anchor: r.anchorGlyph, head: r.headGlyph} as TextRun} : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, pages, content]);
  const textSel = liveRun ?? sessionRun;

  // A turned view only looks: comments are placed in the page's own space, which the turn changes.
  const allowed = !!content && annotateState(content).enabled && !turn;
  const exec = useCallback(async (id: string, params: Record<string, unknown>) => {
    // A gesture the bridge ran (surface.pointer) edits as the bridge: its undo labels say so and the approval gate applies.
    const origin = performance.now() < bridgeGestureUntil ? 'bridge' : 'ui';
    try { return (await session.execute(docId, id, params, {origin})).result; }
    catch (e) { controller.notify(toCommandError(e).message, 'error'); return null; }
  }, [session, docId, controller]);

  const sharedSources = useMemo(() => {
    const count = new Map<number, number>();
    for (const p of pages) count.set(p.sourceIndex, (count.get(p.sourceIndex) ?? 0) + 1);
    return count;
  }, [pages]);

  // measure_ui.rs page_input / finish: a distance and a calibration end at two points, a perimeter at two or more, an area at three or
  // more; what is finished is added (or the distance set) and the gesture starts over.
  const finishMeasure = useCallback(async (live: MeasureLive) => {
    const min = live.kind === 'area' ? 3 : 2;
    if (live.points.length < min) { controller.notify(`This measurement needs at least ${min} points.`, 'info'); return; }
    setMeasure(null);
    if (live.kind === 'calibrate') await exec('measure.calibrate', {points: [live.points[0], live.points[1]]});
    else await exec(`measure.${live.kind}`, {page: live.page, points: live.points});
  }, [exec, controller, setMeasure]);
  // The tool ends the gesture: another tool, or the measure tool again, starts over (measure_ui.rs: a tool change cancels).
  const toolNow: string | null = view.tool ?? null;
  useEffect(() => { setMeasure(null); }, [toolNow, setMeasure]);
  // The panel's Measurement information: the live reading is view state the Angle control shows.
  const readout = measure?.reading ?? null;
  const readoutKey = readout ? `${readout.label}|${readout.angle}|${readout.deltaX}|${readout.deltaY}` : '';
  useEffect(() => {
    if (!measureKind(toolNow)) return;
    const timer = setTimeout(() => { void exec('measure.options', {readout: readout ? {label: readout.label, angle: readout.angle, deltaX: readout.deltaX, deltaY: readout.deltaY, ratio: readout.ratio} : null}); }, 60);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readoutKey, toolNow]);

  // Compare files: the new file's differences, shaded on its pages (replaced blue, inserted green, deleted red; deleted text has nothing
  // to shade in the new file); the one picked in the panel stands out. The view goes to it when the pick changes (compare_action Select).
  const compare: any = view.compare ?? null;
  const compareMarks = useMemo(() => {
    if (!compare?.showText) return null;
    const out: {page: number; rect: number[]; kind: string; selected: boolean}[] = [];
    (compare.changes as any[]).forEach((ch, i) => { for (const r of ch.new.rects) out.push({page: ch.new.page, rect: r, kind: ch.kind, selected: compare.selected === i}); });
    return out;
  }, [compare?.changes, compare?.showText, compare?.selected]);
  const compareRev: number = compare?.rev ?? 0;
  const seenCompareRev = useRef(compareRev);
  useEffect(() => {
    if (seenCompareRev.current === compareRev) return;
    seenCompareRev.current = compareRev;
    const ch = compare && compare.selected !== null ? compare.changes[compare.selected] : null;
    const el = scroller.current;
    if (!ch || !el || !layout.tops.length) return;
    goToPage(ch.new.page);
    const r = ch.new.rects[0] ?? ch.new.near;
    if (layout.display.continuous && r) { el.scrollTop = Math.max(0, layout.tops[ch.new.page] + r[1] * layout.scale - 120); setBox(b => ({...b, top: el.scrollTop})); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareRev]);

  const api: PageApi = {
    docId, content, allowed, compare: compareMarks, measure, measureRef, setMeasure, finishMeasure, tool: view.tool ?? null, highlighter: !!view.highlighter, find: view.find?.matches?.length ? {matches: view.find.matches, current: view.find.current} : null,
    exec,
    form: {prepare: !!view.formPrepare, preview: !!view.formPreview, highlight: !!view.formHighlight, tool: typeof view.tool === 'string' && view.tool.startsWith('form.add.') ? view.tool : null, sel: view.formSel ?? []},
    sign: (field: string) => { try { controller.openDialog('dialog.sign-digital-id', {init: {field}}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } },
    openLink: (pageId: string, rect: number[]) => { try { controller.openDialog('dialog.link-properties', {init: {__page: pageId, __rect: rect}}); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } },
    notify: (message: string) => controller.notify(message, 'info'),
    selectText(pageId, run) {
      if (!run) { setLiveRun(null); session.setSelection(docId, {ranges: [], primary: 0}); return; }
      setLiveRun({pageId, run});
      const page = pages.find(p => p.id === pageId);
      const text = page ? cachedPageText(content, page) : null;
      if (!text) return;
      if ('column' in run) {
        const rects = text.glyphRects(text.glyphsIn(run.column));
        // A column selection is several ranges, one per line piece.
        const ids = text.glyphsIn(run.column);
        const ranges: any[] = [];
        let start = -1, prev = -2;
        for (const i of [...ids, -1]) {
          if (i !== prev + 1 || text.lineOf[i] !== text.lineOf[prev]) { if (start >= 0) ranges.push(runSelection(pageId, text, start, prev)); start = i; }
          prev = i;
        }
        if (rects.length) session.setSelection(docId, {ranges, primary: 0});
        return;
      }
      session.setSelection(docId, {ranges: [runSelection(pageId, text, run.anchor, run.head)], primary: 0});
    },
    selectComment(pageId, id) {
      setLiveRun(null);
      if (!id) { session.setSelection(docId, {ranges: [], primary: 0}); return; }
      const a = annotAddress(pageId, id);
      session.setSelection(docId, {ranges: [{anchor: a, focus: a}], primary: 0});
    },
    openComposer(pageId, id) {
      const page = pages.find(p => p.id === pageId);
      const r = page?.annots?.find((x: any) => x.id === id);
      if (!r) return;
      const c = r.dict.Contents;
      setComposer({pageId, id, text: typeof c === 'string' ? c : typeof c?.$t === 'string' ? c.$t : ''});
    },
    scrollBy(dx, dy) { const el = scroller.current; if (el) { el.scrollLeft += dx; el.scrollTop += dy; } },
    rendered(index, ms) {
      if (firstPaint.current === null) firstPaint.current = performance.now() - opened.current;
      renders.current.count++; renders.current.total += ms; renders.current.last = ms;
    },
  };
  // A live drag selection ends once the session holds it.
  useEffect(() => { if (liveRun && sessionRun && liveRun.pageId === sessionRun.pageId) setLiveRun(null); }, [sessionRun]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!primary) setLiveRun(null); }, [primary]);

  // Keys (tools/comments/input.rs keys, nudge_keys): only while no text field has focus.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || (e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
    // Prepare a form: Delete removes the selected fields, the arrows move one (Shift: ten) view points, Escape steps back.
    if (view.formPrepare && !view.formPreview && content?.fields?.length) {
      const sel: any[] = view.formSel ?? [];
      if (e.key === 'Escape') {
        if (typeof view.tool === 'string' && view.tool.startsWith('form.add.')) void exec('tool.select', {}); else if (sel.length) void exec('form.select', {fields: []});
        e.preventDefault(); return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); void exec('form.field.delete', {}); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const pid = pages[current]?.id;
        const all = content.fields.flatMap((f: any) => f.widgets.map((w: any, wi: number) => ({f, w, wi})).filter(({w}: any) => w.pageId === pid).map(({f, wi}: any) => ({name: f.name, widget: wi})));
        void exec('form.select', {fields: all}); return;
      }
      const d: Record<string, [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
      if (d[e.key] && sel.length && !e.altKey) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        void exec('form.field.set_rect', {name: sel[0].name, widget: sel[0].widget, dx: d[e.key][0] * step, dy: d[e.key][1] * step}); return;
      }
    }
    // Link tool: Delete removes the selected link (link_ui.rs).
    if ((e.key === 'Delete' || e.key === 'Backspace') && view.tool === 'edit.add_link' && view.edit?.link) { e.preventDefault(); void exec('edit.link_change', {change: 'delete'}); return; }
    // Edit text & images and Add content: Delete takes the selected image or added item off the page (content_ui.rs).
    if ((e.key === 'Delete' || e.key === 'Backspace') && (view.tool === 'edit.text_edit' || view.tool === 'edit.add_text') && (view.edit?.image || view.edit?.added) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); void exec(view.edit?.added && !view.edit?.image ? 'edit.added_change' : 'edit.image_change', {change: 'delete'}); return; }
    // Find (navigation.rs shortcuts): Ctrl+F opens the bar, Ctrl+G and Ctrl+Shift+G step the matches (while there is a search),
    // Ctrl+Shift+F opens the Search panel; Escape closes the bar (a selection or a tool goes first).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); void exec(e.shiftKey ? 'edit.advanced_search' : 'edit.find', {}); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && view.find?.matches?.length) { e.preventDefault(); void exec('find.step', {forward: !e.shiftKey}); return; }
    if (e.key === 'Escape' && view.find && !selectedAnnot && !primary && !view.tool) { e.preventDefault(); void exec('find.close', {}); return; }
    // Full screen (navigation.rs shortcuts): Escape leaves; Space and Enter turn forward, Backspace back.
    if (view.presenting) {
      if (e.key === 'Escape') { e.preventDefault(); void exec('view.full_screen', {}); return; }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void exec('view.step_page', {forward: true}); return; }
      if (e.key === 'Backspace') { e.preventDefault(); void exec('view.step_page', {forward: false}); return; }
    }
    // Page keys (navigation.rs shortcuts): the arrows, Home and End turn pages (the arrows keep moving a selected comment),
    // Page Down and Page Up turn them where the pages do not scroll (or with Ctrl); Ctrl+Shift+Plus and Minus rotate the
    // view; Alt+Left and Alt+Right (Ctrl+[ and ]) walk the view history.
    {
      const cmd = e.ctrlKey || e.metaKey;
      const selectedComment = !!selectedAnnot;
      if (cmd && e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); void exec('view.rotate.cw', {}); return; }
      if (cmd && e.shiftKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); void exec('view.rotate.ccw', {}); return; }
      if ((e.altKey && e.key === 'ArrowLeft') || (cmd && e.key === '[')) { e.preventDefault(); void exec('view.previous_view', {}); return; }
      if ((e.altKey && e.key === 'ArrowRight') || (cmd && e.key === ']')) { e.preventDefault(); void exec('view.next_view', {}); return; }
      if (!selectedComment && !e.altKey) {
        const scrolls = disp.continuous;
        if (e.key === 'Home') { e.preventDefault(); goToPage(0); return; }
        if (e.key === 'End') { e.preventDefault(); goToPage(pages.length - 1); return; }
        if (!cmd || e.key === 'PageDown' || e.key === 'PageUp') {
          const forward = e.key === 'ArrowRight' || (e.key === 'PageDown' && (cmd || !scrolls));
          const back = e.key === 'ArrowLeft' || (e.key === 'PageUp' && (cmd || !scrolls));
          if (forward || back) { e.preventDefault(); void exec('view.step_page', {forward}); return; }
        }
      }
    }
    // The Measure tool's keys (measure_ui.rs page_input): Enter finishes a perimeter or an area, Backspace takes the last vertex back,
    // Escape cancels what is drawn (a second Escape puts the tool down).
    const live = measureRef.current;
    if (measureKind(view.tool ?? null) && live?.points.length) {
      if (e.key === 'Enter' && (live.kind === 'perimeter' || live.kind === 'area')) { e.preventDefault(); void finishMeasure(live); return; }
      if (e.key === 'Backspace') { e.preventDefault(); setMeasure({...live, points: live.points.slice(0, -1)}); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMeasure({...live, points: [], reading: null}); return; }
    }
    if (e.key === 'Escape') {
      if (selectedAnnot || primary) { session.setSelection(docId, {ranges: [], primary: 0}); setLiveRun(null); }
      else if (view.tool) void exec('tool.select', {});
      e.preventDefault();
      return;
    }
    if (!selectedAnnot || !allowed) return;
    const page = pages.find(p => p.id === selectedAnnot.pageId);
    const r = page?.annots?.find((x: any) => x.id === selectedAnnot.id);
    if (!r) return;
    const addr = annotAddress(selectedAnnot.pageId, selectedAnnot.id);
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void exec('annot.delete', {annotation: addr}); return; }
    const dir: Record<string, [number, number]> = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    const d = dir[e.key];
    if (d && movable(r) && !isMarkup(nameAt(r.dict, 'Subtype'))) {
      e.preventDefault();
      const step = (e.shiftKey || e.ctrlKey || e.metaKey ? 10 : 1) / layout.scale;
      void exec('annot.move', {annotation: addr, dx: d[0] * step, dy: d[1] * step});
    }
  }

  // The shell's view handle: focus, contextual flags, page images for document.render.
  useEffect(() => register({
    focus: () => root.current?.focus({preventScroll: true}),
    contextFlags: () => {
      const d = (() => { try { return session.get(docId); } catch { return null; } })();
      // Organize Pages is a view (page.organize): its contextual tab shows while the grid is open.
      return d ? {...contextFlags(d.file.content, d.selection), 'organize-pages': !!(d as any).view?.organize, 'calculation-order': !!(d as any).view?.calcOrder,
        // Measure objects: a measure tool is picked, or its panel was opened by itself (measure.panel).
        'compare': !!(d as any).view?.compare, 'enhance-camera-image': (d as any).view?.tool === 'ocr.enhance_camera',
        'measure-objects': !!(d as any).view?.measurePanel || !!measureKind((d as any).view?.tool ?? null)} : {};
    },
    render: async (target: unknown, scale?: number) => {
      const d = session.get(docId);
      const c: any = d.file.content;
      const m = /^\/pg:([^/]+)$/.exec(String(target ?? '')) ?? /^page (\d+)$/i.exec(String(target ?? ''));
      const idx = m ? (/^\d+$/.test(m[1]) ? Number(m[1]) - 1 : c.pages.findIndex((p: any) => p.id === decodeURIComponent(m[1]))) : current;
      const el = root.current?.querySelector<HTMLCanvasElement>(`.folio-page[data-index="${idx}"] canvas`);
      if (el && !scale) return el.toDataURL('image/png');
      goToPage(idx);
      await new Promise(r => setTimeout(r, 400));
      return root.current?.querySelector<HTMLCanvasElement>(`.folio-page[data-index="${idx}"] canvas`)?.toDataURL('image/png') ?? null;
    },
    // Right-click on a field while preparing a form: the field is selected first, then its menu (canvas.rs:1930).
    contextMenu: async (cx: number, cy: number) => {
      const d = (() => { try { return session.get(docId); } catch { return null; } })() as any;
      if (!d?.view?.formPrepare || d.view.formPreview) return null;
      const el = document.elementFromPoint(cx, cy)?.closest<HTMLElement>('[data-form-widget]');
      if (!el) return null;
      const [name, widget] = (el.dataset.formWidget ?? '').split('\u0000');
      if (!name) return null;
      const sel: any[] = d.view.formSel ?? [];
      if (!sel.some(x => x.name === name && x.widget === Number(widget))) await session.execute(docId, 'form.select', {fields: [{name, widget: Number(widget)}]}, {origin: 'ui'}).catch(() => {});
      return 'form-field (Prepare a form)';
    },
    // Bridge pointer input (design note F-folio--integrator--bridge-ui-pointer): the page view's
    // own pointer handlers run, from in-page events at page view points; nothing comes from the OS.
    pointer: (p: any) => synthesize(root.current, p, goToPage, false),
    type: async (text: string) => {
      const form = document.activeElement instanceof HTMLElement && document.activeElement.matches('.ff-input') ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
      // The open paragraph of Edit text & images takes the words at its caret (a selection is replaced).
      const edit = root.current?.querySelector<HTMLTextAreaElement>('.folio-edit-input');
      const field = form ?? edit ?? root.current?.querySelector<HTMLTextAreaElement>('.folio-composer textarea');
      if (!field) throw new Error('no comment composer, paragraph editor or form field is open');
      if (edit && field === edit) {
        const from = edit.selectionStart ?? edit.value.length, to = edit.selectionEnd ?? from;
        const next = edit.value.slice(0, from) + text + edit.value.slice(to);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(edit, next);
        edit.dispatchEvent(new Event('input', {bubbles: true}));
        edit.setSelectionRange(from + text.length, from + text.length);
        return {typed: text.length};
      }
      const set = Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(field, field.value + text);
      field.dispatchEvent(new Event('input', {bubbles: true}));
      return {typed: text.length};
    },
  } as any), [register, session, docId, current, goToPage]);

  // What the bridge's surface.view query reports (src/apps/folio/ui-commands/surface.ts).
  useEffect(() => publish(docId, {
    current, first: range?.[0] ?? -1, last: range?.[1] ?? -1, pages: pages.length, zoom, scrollTop: box.top, scrollHeight: layout.height,
    // Read when asked: rasters finish between renders.
    get mounted() { return root.current?.querySelectorAll('.folio-page').length ?? 0; },
    get firstPaintMs() { return firstPaint.current; },
    get renders() { return {...renders.current}; },
    panel: view.rightPanel ? null : panel, migrating: !!migrating, goToPage, zoomToRect: (page: number, rect: number[]) => {
      // The zoom that fits the rectangle in the window (zoom.rs: a marquee fills the window, the page's side gutters kept off).
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((box.width - 80) / (rect[2] * PT), (box.height - 40) / (rect[3] * PT)) * 100));
      pendingRect.current = {index: page, rect, zoom: z};
      return z;
    }, pointer: (p: any) => synthesize(root.current, p, goToPage, true), scrollTo: (top: number) => { const el = scroller.current; if (el) { el.scrollTop = top; setBox(b => ({...b, top: el.scrollTop})); } },
  }));
  // The rail's page box and position read the page in view: re-render the chrome when it changes.
  useEffect(() => { controller.touch(); }, [current, pages.length, controller]);
  // Read mode and full screen hide the chrome around the page (the shell's own attribute, see surface.css); full screen
  // also takes the whole window.
  useEffect(() => {
    const shellEl = root.current?.closest('.shell') as HTMLElement | null;
    if (!shellEl) return;
    const screen = view.presenting ? 'presentation' : view.readMode ? 'read' : '';
    if (screen) shellEl.dataset.folioScreen = screen; else delete shellEl.dataset.folioScreen;
    return () => { delete shellEl.dataset.folioScreen; };
  }, [view.presenting, view.readMode]);
  const wasPresenting = useRef(false);
  useEffect(() => {
    if (!view.presenting && !wasPresenting.current) return;
    wasPresenting.current = !!view.presenting;
    const w = (window as any).studio?.windows;
    void w?.fullScreen?.(!!view.presenting)?.catch?.(() => {});
  }, [view.presenting]);
  // A password-protected PDF waits for its password: the dialog opens once per document, and again from the button.
  const locked = !!(content as any)?.locked;
  const asked = useRef<string | null>(null);
  const askPassword = useCallback(() => { try { controller.openDialog('prompt.password'); } catch (e) { controller.notify(toCommandError(e).message, 'error'); } }, [controller]);
  useEffect(() => {
    if (!locked || asked.current === docId) return;
    asked.current = docId;
    askPassword();
  }, [locked, docId, askPassword]);

  const commit = async () => {
    if (!composer) return;
    const c = composer;
    setComposer(null);
    await exec('annot.set_contents', {annotation: annotAddress(c.pageId, c.id), text: c.text});
    root.current?.focus({preventScroll: true});
  };
  const composerPos = useMemo(() => {
    if (!composer) return null;
    const i = pages.findIndex(p => p.id === composer.pageId);
    const r = pages[i]?.annots?.find((x: any) => x.id === composer.id);
    if (i < 0 || !r) return null;
    const rect = r.dict.Rect as number[];
    const a = userToView(shown[i], rect[0], rect[1]), b = userToView(shown[i], rect[2], rect[3]);
    return {left: layout.left(i) + Math.max(a[0], b[0]) * layout.scale + 8, top: layout.tops[i] + Math.min(a[1], b[1]) * layout.scale};
  }, [composer, pages, layout]);

  if (!content) return null;
  const empty = !pages.length;
  return <div ref={root} className="folio-surface" tabIndex={-1} onKeyDown={onKeyDown} data-tool={view.tool ?? 'tool.select'}>
    {view.organize && !empty ? <OrganizeGrid content={content} source={source} exec={exec} current={current} zoom={view.gridZoom ?? 1}
      selected={selectedIndices(selection, pages)} select={ix => session.setSelection(docId, pageSelection(pages, ix))}
      openPage={i => { void exec('page.organize', {open: false}).then(() => requestAnimationFrame(() => goToPage(i))); }}/> : null}
    <div ref={scroller} className="folio-scroll" data-snap={layout.display.continuous ? undefined : ''} onScroll={onScroll} hidden={!!view.organize && !empty}>
      {empty ? (locked
        ? <div className="folio-empty folio-locked" data-testid="locked-pdf"><Icon id="lock" size={32}/><b>This PDF is password protected</b>
            <span>{(content as any)?.sourceName ?? ''}</span><button type="button" className="is-primary" onClick={askPassword}>Enter password</button></div>
        : <div className="folio-empty">No PDF is open.</div>) : <div className="folio-canvas" style={{height: layout.height, width: layout.width}}>
        {layout.display.continuous ? null : Array.from(new Set(layout.rows.map((r: number[]) => layout.slotTops[r[0]]))).map((top: any) => <i key={top} className="folio-snap" aria-hidden="true" style={{top}}/>)}
        {range ? Array.from({length: range[1] - range[0] + 1}, (_, k) => range[0] + k).map(i => {
          const p = shown[i];
          return <PageView key={p.id} api={api} page={p} index={i} source={source} shared={(sharedSources.get(p.sourceIndex) ?? 0) > 1}
            geom={{left: layout.left(i), top: layout.tops[i], width: layout.widths[i], height: layout.heights[i], scale: layout.scale}}
            selectedId={selectedAnnot && selectedAnnot.pageId === p.id ? selectedAnnot.id : null}
            textRun={textSel && textSel.pageId === p.id ? textSel.run : null}/>;
        }) : null}
        {composer && composerPos ? <div className="folio-composer" style={composerPos} onPointerDown={e => e.stopPropagation()}>
          <textarea autoFocus value={composer.text} aria-label="Comment" onChange={e => setComposer({...composer, text: e.target.value})}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setComposer(null); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(); } }}/>
          <div><button type="button" onClick={() => setComposer(null)}>Cancel</button><button type="button" className="is-primary" onClick={() => void commit()}>Post</button></div>
        </div> : null}
      </div>}
    </div>
    {/* One right panel at a time (printcraft RightPanel): Comments or Signatures in the rail's panel hide this one. */}
    {panel && !empty && !view.rightPanel ? <SidePanel kind={panel} width={panelWidth} onWidth={w => setPanelWidth(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)))} onClose={closePanel}
      content={content} source={source} current={current} goToPage={goToPage}/> : null}
    {(view as any).combine?.open ? <CombineWorkspace/> : null}
    {view.find?.open && !view.find.inPanel && !empty ? <FindBar find={view.find} run={(id, args) => { void exec(id, args ?? {}); }}/> : null}
    {migrating ? <div className="folio-busy" role="status">{migrating}</div> : null}
  </div>;
}


const tick = (ms = 16) => new Promise(r => setTimeout(r, ms));
/** Until when edits from the page view count as the bridge's (a gesture surface.pointer ran). */
let bridgeGestureUntil = 0;

/**
 * Run a pointer gesture on a page through the page view's own handlers: `click`, `double`
 * (double click), `triple`, `drag` (from x, y to `to`, or along `path`), at page view points
 * (top-left origin) on `page` (an id, or a 1-based number). `alt` makes a column selection,
 * `shift` extends one.
 */
async function synthesize(root: HTMLElement | null, p: any, goToPage: (i: number) => void, bridge: boolean) {
  if (!root) throw new Error('the page view is not shown');
  if (bridge) bridgeGestureUntil = performance.now() + 3000;
  const find = () => {
    const all = [...root.querySelectorAll<HTMLElement>('.folio-page')];
    return typeof p.page === 'number' ? all.find(e => Number(e.dataset.index) === p.page - 1) : all.find(e => e.dataset.page === String(p.page));
  };
  let el = find();
  if (!el && typeof p.page === 'number') { goToPage(p.page - 1); await tick(120); el = find(); }
  if (!el) throw new Error(`page ${p.page} is not shown`);
  el.scrollIntoView({block: 'nearest'});
  await tick();
  // Page view points → client pixels (the page's own scale, and any CSS zoom of the window).
  const point = ([x, y]: number[]) => {
    const b = el!.getBoundingClientRect();
    const k = (b.width / Math.max(1, el!.offsetWidth)) * Number(el!.dataset.scale || 1);
    return {clientX: b.left + x * k, clientY: b.top + y * k};
  };
  const fire = (type: string, at: number[], buttons: number) => {
    const where = point(at);
    const init: any = {bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons,
      altKey: !!p.alt, shiftKey: !!p.shift, ctrlKey: !!p.ctrl, ...where};
    // The element a real pointer would hit (a form field over the page), else the page.
    const under = document.elementFromPoint(where.clientX, where.clientY);
    const target = under && el!.contains(under) ? under : el!;
    // A press outside the field being typed in takes the focus from it, as a real press does (the text is committed on blur).
    const active = document.activeElement;
    if (type === 'pointerdown' && active instanceof HTMLElement && active.matches('.ff-input') && !active.closest('.ff-w')?.contains(target)) {
      // A window that does not have the system focus (a test window) sends no blur event: send it, as the focus would have.
      const focused = document.hasFocus();
      active.blur();
      if (!focused) active.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
    }
    target.dispatchEvent(new PointerEvent(type, init));
    // A click in a form field's text box focuses it, as a real click does.
    if (type === 'pointerup' && target instanceof HTMLElement && target.matches('.ff-input')) target.focus();
    // A press and release on a form field's own control is a click on it (check boxes, radio buttons, buttons and list rows).
    if (type === 'pointerup' && target instanceof HTMLElement && target.closest('.ff-w') && !target.matches('.ff-input')) target.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ...where, ctrlKey: !!p.ctrl}));
  };
  const press = async (at: number[]) => { fire('pointerdown', at, 1); await tick(); fire('pointerup', at, 0); await tick(); };
  const at = [p.x, p.y];
  switch (p.action) {
    case 'click': await press(at); break;
    case 'double': case 'triple': {
      const n = p.action === 'double' ? 2 : 3;
      for (let i = 0; i < n; i++) await press(at);
      if (n === 2) el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, ...point(at)}));
      await tick(); break;
    }
    case 'drag': {
      const path: number[][] = Array.isArray(p.path) && p.path.length ? p.path : [at, [p.to?.x ?? p.x, p.to?.y ?? p.y]];
      fire('pointerdown', path[0], 1); await tick();
      // Intermediate points every few points, as a real drag reports them.
      for (let i = 1; i < path.length; i++) {
        const [a, b] = [path[i - 1], path[i]];
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
        for (let k = 1; k <= steps; k++) { fire('pointermove', [a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps], 1); await tick(4); }
      }
      await tick();
      fire('pointerup', path[path.length - 1], 0); await tick(40);
      break;
    }
    case 'move': fire('pointermove', at, 0); await tick(); break;
    default: throw new Error(`unknown pointer action ${p.action}`);
  }
  return {done: p.action};
}
