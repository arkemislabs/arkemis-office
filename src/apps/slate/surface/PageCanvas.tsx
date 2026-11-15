// The page canvas (OneNote's page surface, docs/spec/slate.json panes › page-canvas; F:slate).
//
// From back to front: the page colour and rule lines or grid (View › Page Setup), the page title
// with the creation date and time beneath it, the free-form note containers (one ProseMirror
// editor for the page, see editor.ts) and the ink layer. Clicking on empty page space starts a
// note container at that point. Everything that changes the page goes through commands:
// `surface.edit` for editor steps, `surface.title` for the title, `surface.moveContainer` and
// `surface.resizeContainer` for the container handles, `surface.ink` / `surface.erase` for ink.

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {Session} from '../../../../core/kernel/session.mjs';
import type {ShellController} from '../../../shell/engine/ShellController';
import {nodeOf} from '../../../../core/slate/schema.mjs';
import {ruleDrawing} from '../../../../core/slate/model/styles.mjs';
import {createPageEditor, selectionAddresses, type PageEditor} from './editor';
import {spelling, watchSession, sessionKey} from '../../../../core/common/lib/spelling.mjs';
import {InkLayer, inkStyle, finishPoints, rulerLine, ERASER_RADIUS, type InkTool, type Stroke, type RulerPose} from './InkLayer';
import {strokeHit} from '../../../../core/slate/model/canvas.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';

type Point = {x: number; y: number};
/**
 * The canvas's own pointer and typing handlers, callable with page coordinates (px, unzoomed)
 * instead of DOM events: the bridge's ui.pointer / ui.type reach the surface through these
 * (design note F-slate--integrator--ui-pointer-type), and they run the same code paths as a
 * real click, drag or keystroke.
 */
export interface CanvasApi {
  /** A click at a page point: in a note container's text puts the caret there, elsewhere starts a container. */
  click(at: Point): Record<string, unknown>;
  /** A drag: `bar:<id>` moves a container, `width:<id>` resizes it, `ink` draws or erases with the active Draw tool. */
  drag(target: string, from: Point, to: Point, path?: number[][]): Record<string, unknown>;
  /** A click in the title area. */
  clickTitle(): Record<string, unknown>;
  /** Typing where the caret is (title or notes). */
  type(text: string): Record<string, unknown>;
  /** Give the notes the keyboard focus with the editor's own selection (false when there is no editor). */
  focus(): boolean;
  /** The page position under a window point in the notes, or null (a right-click on a misspelt word). */
  posAt(clientX: number, clientY: number): number | null;
}

export interface PageRecord {
  id: string; title: string; created: string; modified: string; color: string | null;
  rule: {pattern: string; color: string}; titleHidden: boolean; paperSize: unknown; body: unknown; ink: Stroke[];
}

/** Where a click puts the new container so the caret lands at the pointer (body padding, half a line). */
const CLICK_OFFSET = {x: 7, y: 11};
/** The title area's place on the page (OneNote: top left, above the notes). */
export const TITLE_ORIGIN = {x: 48, y: 30};

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
};
const timeText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
};

/**
 * Rule lines or grid (View › Page Setup › Rule Lines) as real 1 px lines snapped to device pixels
 * (a CSS gradient blurs every few lines at fractional display scales), over the whole page.
 */
function RuleLayer({rule, width, height}: {rule: PageRecord['rule']; width: number; height: number}) {
  const r = ruleDrawing(rule);
  if (!r || width <= 0 || height <= 0) return null;
  const s = r.spacing;
  const rows: number[] = [];
  for (let y = r.kind === 'ruled' ? r.top % s : s; y < height; y += s) rows.push(y + 0.5);
  const cols: number[] = [];
  if (r.kind === 'grid') for (let x = s; x < width; x += s) cols.push(x + 0.5);
  const d = rows.map(y => `M0 ${y}H${width}`).join('') + cols.map(x => `M${x} 0V${height}`).join('');
  return <svg className="slate-rules" width={width} height={height} aria-hidden="true" shapeRendering="crispEdges">
    <path d={d} stroke={r.color} strokeWidth={1} fill="none"/>
    {r.margin ? <path d={`M${r.margin.x + 0.5} 0V${height}`} stroke={r.margin.color} strokeWidth={1}/> : null}
  </svg>;
}

/** The guide while dragging Insert Space: the click line, the pointer line and the distance between them. */
function SpaceGuide({from, to}: {from: Point; to: Point}) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const down = Math.abs(dy) >= Math.abs(dx);
  const amount = Math.round(down ? dy : dx);
  return <>
    {down ? <>
      <div className="slate-space-line" style={{left: 0, right: 0, top: from.y}}/>
      <div className="slate-space-line is-moving" style={{left: 0, right: 0, top: from.y + amount}}/>
      <div className="slate-space-band" style={{left: 0, right: 0, top: Math.min(from.y, from.y + amount), height: Math.abs(amount)}}/>
    </> : <>
      <div className="slate-space-line is-v" style={{top: 0, bottom: 0, left: from.x}}/>
      <div className="slate-space-line is-v is-moving" style={{top: 0, bottom: 0, left: from.x + amount}}/>
      <div className="slate-space-band" style={{top: 0, bottom: 0, left: Math.min(from.x, from.x + amount), width: Math.abs(amount)}}/>
    </>}
    <div className="slate-space-label" style={down ? {left: from.x + 12, top: from.y + amount / 2 - 10} : {left: from.x + amount / 2 - 20, top: from.y + 12}}>{Math.abs(amount)} px</div>
  </>;
}

export function PageCanvas({session, controller, docId, page, selection, ranges, zoom, ink, insertSpace, touchDraw = true, ruler = false, inkToShape = false, replay = null, onLink, apiRef}: {
  session: Session; controller: ShellController; docId: string; page: PageRecord;
  selection: {anchor: string; focus: string} | null; ranges?: {anchor: string; focus: string}[]; zoom: number; ink: InkTool | null;
  /** Insert > Insert Space is on: a drag on the page pushes the notes below (to the right of) the click away. */
  insertSpace?: boolean;
  /** Draw with Touch, Ruler, Ink to Shape and Ink Replay (the Draw tab's modes, kept in the document view). */
  touchDraw?: boolean; ruler?: boolean; inkToShape?: boolean; replay?: {run: number; ids: string[]; page?: string} | null;
  /** A link on the page was clicked. */
  onLink?: (href: string) => void;
  apiRef?: {current: CanvasApi | null};
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PageEditor | null>(null);
  const sync = useRef({pending: 0, foreignDoc: false, foreignSelection: false, lastSent: ''});
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  const [extent, setExtent] = useState({width: 0, height: 0});

  // The canvas's edits, each one kernel command (one undo entry).
  const run = (id: string, params: Record<string, unknown>) => {
    void session.execute(docId, id, params, {origin: 'ui'}).catch(e => controller.notify(String(e?.message ?? e), 'error'));
  };
  const moveContainer = (id: string, x: number, y: number) => run('surface.moveContainer', {page: page.id, container: id, x, y});
  const resizeContainer = (id: string, width: number) => run('surface.resizeContainer', {page: page.id, container: id, width});
  const addStroke = (stroke: Omit<Stroke, 'id'>) => run('surface.ink', {page: page.id, stroke, ...(inkToShape ? {snap: true} : {})});
  const eraseAlong = (path: number[], radius: number, mode: 'stroke' | 'point') => run('ink.erase', {page: page.id, path, radius, mode});
  const lassoLoop = (path: number[]) => run('ink.lasso', {page: page.id, path});
  const moveInk = (dx: number, dy: number) => run('ink.move', {page: page.id, dx, dy});
  const drawShape = (shape: string, from: Point, to: Point) => run('shape.insert', {page: page.id, shape, x: Math.max(0, from.x), y: Math.max(0, from.y), x2: Math.max(0, to.x), y2: Math.max(0, to.y)});
  /** A click with the Lasso: the stroke under the point (with its shape), else the page. */
  const pickInk = (x: number, y: number) => {
    const hit = page.ink.find(s => strokeHit(s, x, y, 6));
    if (hit) run('ink.select', {page: page.id, ids: [hit.id]});
    else run('ink.lasso', {page: page.id, path: [x, y, x, y, x, y]});
    return hit?.id ?? null;
  };
  const selectedInk = useMemo(() => new Set((ranges ?? []).map(r => /^\/pg:[^/]+\/ink:([^/]+)$/.exec(r.anchor ?? '')?.[1]).filter((x): x is string => !!x).map(decodeURIComponent)), [ranges]);
  const [rulerPose, setRulerPose] = useState<RulerPose>({x: 96, y: 240, angle: 0});
  const editEquation = (id: string, linear: string) => run('equation.edit', {page: page.id, id, linear});
  /** Insert Space: one drag moves what is below (right of) the click, then the tool turns itself off (OneNote). */
  const insertSpaceBy = (from: Point, to: Point) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const down = Math.abs(dy) >= Math.abs(dx);
    const amount = Math.round(down ? dy : dx);
    const at = Math.round(down ? from.y : from.x);
    if (amount) run('insert.spaceBy', {page: page.id, axis: down ? 'down' : 'right', at, amount});
    run('insert.space', {value: false});
    return {axis: down ? 'down' : 'right', at, amount};
  };

  const kernelPage = useCallback(() => {
    try { return (session.get(docId).file.content as any).pages?.[page.id] ?? null; } catch { return null; }
  }, [session, docId, page.id]);
  const kernelSelection = useCallback(() => {
    try {
      const sel = session.get(docId).selection;
      const r = sel.ranges[sel.primary ?? 0];
      return r ?? null;
    } catch { return null; }
  }, [session, docId]);

  const pushSelection = useCallback((state = editorRef.current?.view.state) => {
    if (!state) return;
    const sel = selectionAddresses(page.id, state);
    const value = {ranges: [sel], primary: 0};
    const text = JSON.stringify(value);
    const cur = kernelSelection();
    if (cur && cur.anchor === sel.anchor && cur.focus === sel.focus) return;
    sync.current.lastSent = text;
    try { session.setSelection(docId, value, {origin: 'ui'}); } catch { /* closed */ }
  }, [session, docId, page.id, kernelSelection]);

  /** Bring the editor in line with the kernel once no edit of ours is in flight. */
  const reconcile = useCallback(() => {
    const ed = editorRef.current, s = sync.current;
    if (!ed || s.pending > 0) return;
    const kp = kernelPage();
    if (!kp) return;
    const doc = nodeOf(kp.body);
    const same = doc.eq(ed.view.state.doc);
    if (!same || s.foreignDoc || s.foreignSelection) {
      if (!same || s.foreignSelection) ed.reset(doc, kernelSelection());
    } else pushSelection();
    s.foreignDoc = false;
    s.foreignSelection = false;
  }, [kernelPage, kernelSelection, pushSelection]);

  // One editor per page.
  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const kp = kernelPage() ?? page;
    const ed = createPageEditor({
      mount, pageId: page.id, doc: nodeOf(kp.body), selection: selection,
      hooks: {
        zoom: () => zoomRef.current,
        move: moveContainer,
        resize: resizeContainer,
        select: pos => editorRef.current?.selectNode(pos),
        equation: (id, linear) => editEquation(id, linear),
        sheetCell: (id, ref, text) => run('spreadsheet.setCell', {page: page.id, id, ref, text}),
        sheetResize: (id, rows, cols) => run('spreadsheet.resize', {page: page.id, id, rows, cols}),
        diagramOpen: id => { const a = `/pg:${page.id}/media:${id}`; session.setSelection(docId, {ranges: [{anchor: a, focus: a}], primary: 0}, {origin: 'ui'}); controller.openDialog('dialog.diagram'); },
        link: href => onLinkRef.current?.(href),
        mediaStop: () => run('media.stop', {}),
        playFromNote: block => run('media.play', {fromParagraph: block}),
        tagCheck: (block, tag, checked) => run('tag.check', {paragraphId: block, pageId: page.id, tagId: tag, checked}),
      },
      onSteps(steps, state, meta) {
        const s = sync.current;
        s.pending++;
        const sel = selectionAddresses(page.id, state);
        s.lastSent = JSON.stringify({ranges: [sel], primary: 0});
        session.execute(docId, 'surface.edit', {page: page.id, steps: steps.map(st => st.toJSON()), selection: sel, typing: meta.typing, ...(meta.label ? {label: meta.label} : {})}, {origin: 'ui'})
          .catch(e => { s.foreignDoc = true; controller.notify(`That edit could not be applied: ${e?.message ?? e}`, 'error'); })
          .finally(() => { s.pending--; if (!s.pending) reconcile(); });
      },
      onSelection(state) { if (!sync.current.pending) pushSelection(state); },
      spell: (session as any).prefs?.checkSpelling === false ? undefined : {sp: spelling(), session: sessionKey((session as any).host, docId)},
    });
    editorRef.current = ed;
    return () => { ed.destroy(); if (editorRef.current === ed) editorRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Spelling: the user dictionary comes from the prefs, and the squiggles are drawn again when the service has new answers (the words of the page are looked up in a worker).
  useEffect(() => {
    const sp = spelling();
    sp.setUserWords((session as any).prefs?.userDictionary);
    watchSession(session);
    return sp.subscribe(() => editorRef.current?.refreshSpelling());
  }, [session, page.id]);

  // Select Columns / Rows / Cell: the cells the kernel selection names are drawn selected.
  const rangesKey = (ranges ?? []).map(r => r.anchor).join('|');
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const ids = (ranges ?? []).map(r => /^\/pg:[^/]+\/b:([^/]+)$/.exec(r.anchor ?? '')?.[1]).filter((x): x is string => !!x).map(decodeURIComponent);
    ed.setCells(ids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangesKey, page.body]);

  // Insert Space: Esc turns the tool off.
  useEffect(() => {
    if (!insertSpace) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') run('insert.space', {value: false}); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertSpace]);
  const [spaceDrag, setSpaceDrag] = useState<{from: Point; to: Point} | null>(null);
  const spacePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = pageRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const z = zoomRef.current;
    return {x: Math.max(0, (e.clientX - r.left) / z), y: Math.max(0, (e.clientY - r.top) / z)};
  };

  // Changes that are not this editor's own: undo, ribbon commands, the bridge.
  useEffect(() => session.subscribe((e: any) => {
    if (e.doc !== docId) return;
    const s = sync.current;
    if (e.type === 'doc.changed') {
      if (String(e.command ?? '').startsWith('surface.') && e.origin === 'ui' && s.pending) return;
      s.foreignDoc = true;
      queueMicrotask(reconcile);
    } else if (e.type === 'selection.changed') {
      if (JSON.stringify(e.selection) === s.lastSent) return;
      s.foreignSelection = true;
      queueMicrotask(reconcile);
    }
  }), [session, docId, reconcile]);

  // The page grows with its notes and ink (plus room to keep writing below and to the right).
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const measure = () => {
      let w = 0, h = 0;
      for (const c of el.querySelectorAll<HTMLElement>('.slate-container')) { w = Math.max(w, c.offsetLeft + c.offsetWidth); h = Math.max(h, c.offsetTop + c.offsetHeight); }
      for (const st of page.ink) for (let i = 0; i < st.points.length; i += 2) { w = Math.max(w, st.points[i]); h = Math.max(h, st.points[i + 1]); }
      setExtent(prev => (prev.width === w && prev.height === h ? prev : {width: w, height: h}));
    };
    measure();
    const ro = new ResizeObserver(measure);
    const mo = new MutationObserver(measure);
    ro.observe(el);
    mo.observe(el, {subtree: true, childList: true, attributes: true, attributeFilter: ['style']});
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [page.ink, page.id]);

  // Click on empty page space: a caret there, in a note container that appears when typed into.
  const startAt = useCallback((x: number, y: number) => {
    const at = {x: Math.max(0, Math.round(x - CLICK_OFFSET.x)), y: Math.max(0, Math.round(y - CLICK_OFFSET.y))};
    editorRef.current?.startContainer(at.x, at.y);
    return at;
  }, []);
  useEffect(() => {
    const root = editorRef.current?.view.dom;
    const el = pageRef.current;
    if (!root || !el) return;
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || (ink && ink.tool !== 'type')) return;
      const t = e.target as HTMLElement;
      if (t !== root) return;
      e.preventDefault();
      typing.current = 'body';
      const r = el.getBoundingClientRect();
      const z = zoomRef.current;
      startAt((e.clientX - r.left) / z, (e.clientY - r.top) / z);
    };
    root.addEventListener('mousedown', down, true);
    return () => root.removeEventListener('mousedown', down, true);
  }, [page.id, ink, startAt]);
  /** Where typing goes: the title box or the notes (the last place clicked). */
  const typing = useRef<'title' | 'body'>('body');

  // Title: typed locally, sent as `surface.title`; the kernel's title shows when it changes elsewhere.
  const [title, setTitle] = useState(page.title);
  const titleSync = useRef({focused: false, pending: 0});
  useEffect(() => { if (!titleSync.current.focused && !titleSync.current.pending) setTitle(page.title); }, [page.title]);
  useEffect(() => { setTitle(page.title); }, [page.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const sendTitle = (value: string) => {
    setTitle(value);
    titleSync.current.pending++;
    session.execute(docId, 'surface.title', {page: page.id, title: value, typing: true}, {origin: 'ui'})
      .catch(e => controller.notify(String(e?.message ?? e), 'error'))
      .finally(() => { titleSync.current.pending--; });
  };
  const titleToBody = () => {
    const ed = editorRef.current;
    if (!ed) return;
    typing.current = 'body';
    if (!ed.focusFirst()) ed.startContainer(TITLE_ORIGIN.x, TITLE_ORIGIN.y + 90);
  };
  const titleNow = useRef(title);
  titleNow.current = title;

  const fail = (message: string) => { throw new CommandError('unavailable', message); };
  const api: CanvasApi = {
    click({x, y}) {
      const el = pageRef.current, ed = editorRef.current;
      if (!el || !ed) fail('The page is not shown');
      if (ink && ink.tool === 'lasso') return {picked: pickInk(x, y)};
      if (ink && ink.tool !== 'type') fail(`The ${ink.tool} is the active tool: a click draws instead of typing`);
      typing.current = 'body';
      const r = el!.getBoundingClientRect();
      const z = zoomRef.current;
      // Inside a container's text: the caret goes there (ProseMirror's own hit test).
      const inside = [...el!.querySelectorAll<HTMLElement>('.slate-container')].find(c => x >= c.offsetLeft && x <= c.offsetLeft + c.offsetWidth
        && y >= c.offsetTop && y <= c.offsetTop + c.offsetHeight);
      if (inside && ed!.caretAt(r.left + x * z, r.top + y * z)) {
        const sel = selectionAddresses(page.id, ed!.view.state);
        return {caret: sel.focus, container: `/pg:${page.id}/c:${inside.dataset.id}`};
      }
      const at = startAt(x, y);
      return {started: {x: at.x, y: at.y}, container: null};
    },
    drag(target, from, to, path) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const [kind, id] = target.split(':');
      if (kind === 'bar' || kind === 'width') {
        const el = pageRef.current?.querySelector<HTMLElement>(`.slate-container[data-id="${CSS.escape(id ?? '')}"]`);
        if (!el) fail(`No note container ${id} on this page`);
        // ContainerView's threshold: a drag under 2 px is a click.
        if (Math.abs(dx) + Math.abs(dy) < 2) return {moved: false};
        if (kind === 'bar') {
          const x = Math.max(0, Math.round(el!.offsetLeft + dx)), y = Math.max(0, Math.round(el!.offsetTop + dy));
          moveContainer(id!, x, y);
          return {container: `/pg:${page.id}/c:${id}`, x, y};
        }
        const width = Math.max(48, Math.round(el!.offsetWidth + dx));
        resizeContainer(id!, width);
        return {container: `/pg:${page.id}/c:${id}`, width};
      }
      if (kind === 'space') {
        if (!insertSpace) fail('Turn on Insert Space on the Insert tab first');
        return insertSpaceBy(from, to);
      }
      if (kind === 'selection') {
        if (!selectedInk.size) fail('Select ink with the Lasso first');
        moveInk(Math.round(dx), Math.round(dy));
        return {moved: selectedInk.size, dx: Math.round(dx), dy: Math.round(dy)};
      }
      if (kind === 'ink') {
        const style = inkStyle(ink);
        if (!style.draws && !style.erases && !style.lasso && !style.shape && !style.pan) fail('Pick a pen, highlighter, eraser, lasso or shape on the Draw tab first');
        // The pointer path given, or a straight drag sampled every 2 px as pointermove delivers it.
        let pts: number[] = [];
        if (path && path.length) pts = path.flatMap(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
        else {
          const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
          for (let i = 0; i <= n; i++) pts.push(Math.round((from.x + (dx * i) / n) * 10) / 10, Math.round((from.y + (dy * i) / n) * 10) / 10);
        }
        if (style.draws) {
          // Along the Ruler's edge the stroke runs straight, as under a real pen.
          const line = ruler ? rulerLine(rulerPose, {x: pts[0], y: pts[1]}) : null;
          if (line) {
            const snap = (x: number, y: number): [number, number] => { const t = Math.max(0, Math.min(line.len, (x - line.ox) * line.ux + (y - line.oy) * line.uy)); return [Math.round((line.ox + t * line.ux) * 10) / 10, Math.round((line.oy + t * line.uy) * 10) / 10]; };
            pts = Array.from({length: pts.length / 2}, (_, i) => snap(pts[2 * i], pts[2 * i + 1])).flat();
          }
          addStroke({tool: style.base, color: style.color, width: style.width, points: finishPoints(pts), ...(style.fx ? {fx: style.fx} : {})});
          return {tool: style.kind, points: pts.length / 2, ruler: !!line};
        }
        if (style.shape) { drawShape(ink!.shape!, {x: pts[0], y: pts[1]}, {x: pts[pts.length - 2], y: pts[pts.length - 1]}); return {shape: ink!.shape}; }
        if (style.lasso) {
          const loop = path && path.length ? pts : [from.x, from.y, to.x, from.y, to.x, to.y, from.x, to.y];
          lassoLoop(loop);
          return {lasso: loop.length / 2};
        }
        if (style.pan) return {panned: false};
        const radius = ERASER_RADIUS[ink?.eraser ?? 'stroke'] ?? 6;
        const mode = (ink?.eraser ?? 'stroke') === 'stroke' ? 'stroke' : 'point';
        eraseAlong(pts, radius, mode);
        return {erased: mode, points: pts.length / 2};
      }
      return fail(`Unknown drag target ${target}`);
    },
    posAt(x, y) { return editorRef.current?.posAt(x, y) ?? null; },
    focus() {
      const ed = editorRef.current;
      if (!ed) return false;
      if (typing.current === 'title') return false;
      ed.view.focus();
      return true;
    },
    clickTitle() {
      if (page.titleHidden) fail('This page hides its title');
      editorRef.current?.abandon();
      typing.current = 'title';
      return {title: `/pg:${page.id}/title`};
    },
    type(text) {
      let rest = String(text);
      let typed = 0;
      if (typing.current === 'title') {
        // Enter in the title moves to the notes, as OneNote does.
        const nl = rest.search(/\r?\n/);
        const line = nl < 0 ? rest : rest.slice(0, nl);
        if (line) { sendTitle(titleNow.current + line); typed += line.length; }
        if (nl < 0) return {typed, into: 'title'};
        rest = rest.slice(nl).replace(/^\r?\n/, '');
        titleToBody();
        typed++;
      }
      const ed = editorRef.current;
      if (!ed) fail('The page is not shown');
      // Typing goes where the document's selection is (a selection set by the bridge or a command may not have reached the editor yet).
      const kp = kernelPage();
      if (kp && !sync.current.pending && !ed!.provisional()) ed!.reset(nodeOf(kp.body), kernelSelection());
      typed += ed!.typeText(rest);
      return {typed, into: 'notes'};
    },
  };
  if (apiRef) apiRef.current = api;
  useEffect(() => () => { if (apiRef && apiRef.current === api) apiRef.current = null; });

  // The page fills the canvas and grows with its notes and ink (room to keep writing below and right).
  const pageStyle = useMemo<React.CSSProperties>(() => ({
    background: page.color ?? undefined,
    minWidth: `max(100%, ${extent.width + 320}px)`, minHeight: `max(100%, ${extent.height + 360}px)`,
    zoom: zoom === 1 ? undefined : zoom,
  }), [page.color, extent, zoom]);
  const rule = ruleDrawing(page.rule);
  const [box, setBox] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el || !rule) return;
    const measure = () => setBox(prev => (prev.width === el.offsetWidth && prev.height === el.offsetHeight ? prev : {width: el.offsetWidth, height: el.offsetHeight}));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!rule, page.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`slate-page${rule ? ` has-rule is-${rule.kind}` : ''}`} ref={pageRef} style={pageStyle} data-page={page.id}>
    <RuleLayer rule={page.rule} width={box.width} height={box.height}/>
    {page.titleHidden ? null : <div className="slate-title-area" style={{left: TITLE_ORIGIN.x, top: TITLE_ORIGIN.y}}>
      <input className="slate-title" value={title} aria-label="Page title" spellCheck
        onFocus={() => { titleSync.current.focused = true; typing.current = 'title'; editorRef.current?.abandon(); }}
        onBlur={() => { titleSync.current.focused = false; if (!titleSync.current.pending) setTitle(kernelPage()?.title ?? title); }}
        onChange={e => sendTitle(e.currentTarget.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); titleToBody(); } }}/>
      <div className="slate-title-rule" aria-hidden="true"/>
      <div className="slate-datetime"><span>{dateText(page.created)}</span><span>{timeText(page.created)}</span></div>
    </div>}
    <div className="slate-editor" ref={mountRef}/>
    <InkLayer strokes={page.ink} tool={ink} zoom={zoom} selected={selectedInk} touchDraw={touchDraw} ruler={ruler ? rulerPose : null} replay={replay?.page === page.id ? replay : null}
      inkToShape={inkToShape} onStroke={addStroke} onErase={eraseAlong} onLasso={lassoLoop} onPick={pickInk} onMove={moveInk} onShape={drawShape} onRuler={setRulerPose}/>
    {insertSpace ? <div className="slate-space-tool" role="presentation" aria-label="Insert Space: drag down or right"
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } const p = spacePointer(e); if (p) setSpaceDrag({from: p, to: p}); }}
      onPointerMove={e => { const p = spacePointer(e); if (p && spaceDrag) setSpaceDrag({from: spaceDrag.from, to: p}); }}
      onPointerUp={e => { const p = spacePointer(e); const d = spaceDrag; setSpaceDrag(null); if (p && d) insertSpaceBy(d.from, p); }}
      onPointerCancel={() => setSpaceDrag(null)}>
      {spaceDrag ? <SpaceGuide from={spaceDrag.from} to={spaceDrag.to}/> : null}
    </div> : null}
  </div>;
}
