// The renderer engine (docs/architecture.md sections 4.1, 4.3, 4.4): builds the app's registry from
// the generated core index plus the app's view-only ui-commands, creates the renderer Host and a
// Session, opens the document (a schema-1 file converted with its app's migrate.mjs first, as Word
// converts an older format when it opens it), and keeps the session and useWorkspace persistence in
// step: every change sends the content with its `schema`, so the converted document is what is kept.

import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {buildRegistry} from '../../../core/kernel/registry.mjs';
import {createSession, type Session} from '../../../core/kernel/session.mjs';
import {createHost, type Host} from '../../../core/kernel/host.mjs';
import {CommandError} from '../../../core/kernel/errors.mjs';
import type {CommandFamily} from '../../../core/kernel/command.mjs';
import type {DialogModel} from '../../../core/kernel/dialog.mjs';
import {appUi, appSpec} from '../../generated/apps';
import type {AppId, SpecModel} from '../../generated/spec-types';
import {buildShellModel} from '../model';
import {ShellController, storedPrefs, type UiIndex} from './ShellController';
import {attachController} from '../bridge/RendererBridge';
import {migrateOnOpen} from '../../../core/kernel/open-migrate.mjs';
import {getMediaService} from './mediaService';

type Loaded<T> = () => Promise<T>;
const COMMANDS: Record<AppId, Loaded<{modules: CommandFamily[]; sources: string[]}>> = {
  quill: () => import('../../../core/generated/quill.commands.mjs') as any,
  grid: () => import('../../../core/generated/grid.commands.mjs') as any,
  prism: () => import('../../../core/generated/prism.commands.mjs') as any,
  folio: () => import('../../../core/generated/folio.commands.mjs') as any,
  slate: () => import('../../../core/generated/slate.commands.mjs') as any,
};
const DIALOGS: Record<AppId, Loaded<{dialogs: Record<string, DialogModel>}>> = {
  quill: () => import('../../../core/generated/quill.dialogs.mjs') as any,
  grid: () => import('../../../core/generated/grid.dialogs.mjs') as any,
  prism: () => import('../../../core/generated/prism.dialogs.mjs') as any,
  folio: () => import('../../../core/generated/folio.dialogs.mjs') as any,
  slate: () => import('../../../core/generated/slate.dialogs.mjs') as any,
};

/** The document as useWorkspace holds it (schema 1 or 2). */
export interface HostFile { id: string; kind: string; title: string; revision: number; content: unknown; [key: string]: unknown }

export interface EngineValue {
  kind: AppId;
  session: Session;
  docId: string;
  controller: ShellController;
  spec: SpecModel | null;
  ui: UiIndex;
}

const EngineContext = createContext<EngineValue | null>(null);
export function useEngine(): EngineValue {
  const v = useContext(EngineContext);
  if (!v) throw new Error('useEngine() outside <EngineProvider>');
  return v;
}

export interface EngineProviderProps {
  kind: AppId;
  file: HostFile;
  /** Persist a new version of the document (useWorkspace.update: debounced autosave). */
  onChange: (patch: {content: unknown; title: string; [key: string]: unknown}) => void;
  /** Write now (useWorkspace.flush) and return the stored file. */
  onSave: () => Promise<HostFile | null | undefined>;
  /** The document closed (file.close): back to the library. */
  onClose: () => void;
  /** Export a copy (Save As / Export with a format): the main process asks for the path. */
  onExport?: (file: HostFile, format: string) => Promise<string | null>;
  children: ReactNode;
  fallback?: ReactNode;
}

function canvasMeasure() {
  let ctx: CanvasRenderingContext2D | null = null;
  return (font: {family: string; size: number; weight?: number | string; style?: string}, text: string) => {
    ctx ??= document.createElement('canvas').getContext('2d');
    if (!ctx) return {width: 0};
    ctx.font = `${font.style ?? 'normal'} ${font.weight ?? 400} ${font.size}px "${font.family}"`;
    const m = ctx.measureText(text);
    return {width: m.width, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent};
  };
}

/** The renderer Host: window.studio services, Canvas2D metrics, dialogs through the shell. */
function rendererHost(ref: {controller: ShellController | null; props: EngineProviderProps; pending?: Promise<unknown>}): Host {
  return createHost('renderer', {
    fonts: async () => {
      try { return (await window.studio.fonts()).families.map(family => ({family})); } catch { return []; }
    },
    measureText: canvasMeasure(),
    pickImage: () => window.studio.pickImage(),
    profileName: () => (window.studio.profileName ? window.studio.profileName() : null),
    // Recording and playback (Slate's Audio & Video): the microphone and camera only from a click, never the screen.
    media: getMediaService() as any,
    pickDocument: opts => (window.studio.pickDocument ? window.studio.pickDocument(opts) : Promise.resolve(null)),
    captureClip: () => import('./screenClip').then(m => m.captureClip()),
    printoutPages: file => import('../../apps/slate/lib/printout').then(m => m.printoutPages(file)),
    ocrImage: (image: string) => import('../../apps/slate/lib/ocrImage').then(m => m.ocrImage(image)),
    renderSlides: (doc: unknown, indices: number[], width: number) => import('../../apps/prism/lib/slideImage').then(m => m.slideImages(doc, indices, width)),
    renderVideo: (doc: unknown, req: any) => import('../../apps/prism/lib/videoExport').then(m => m.renderVideo(doc, req)),
    renderRange: (doc: unknown, si: number, range: unknown, scale?: number) => import('../../apps/grid/lib/rangeImage').then(m => m.rangeImage(doc, si, range as any, scale)),
    peerStyles: {list: () => (window.studio as any).peerStyles?.list() ?? Promise.resolve([]), get: (id: string) => (window.studio as any).peerStyles?.get(id) ?? Promise.resolve([])},
    decodeImage: (bytes: Uint8Array) => import('../../apps/prism/lib/decodeImage').then(m => m.decodeImage(bytes)),
    encodeImage: (img: {width: number; height: number; data: Uint8ClampedArray}, type: string, quality?: number) => import('../../apps/prism/lib/decodeImage').then(m => m.encodeImage(img, type, quality)),
    pickSound: () => (window.studio.pickSound ? window.studio.pickSound() : Promise.resolve(null)),
    pickMedia: req => (window.studio.pickMedia ? window.studio.pickMedia(req) : Promise.resolve(null)),
    clipboardRead: () => window.studio.clipboardRead(),
    clipboardWrite: data => window.studio.clipboardWrite({text: data.text ?? '', html: data.html ?? ''}),
    openDialog: (id, init) => (ref.controller ? ref.controller.collectDialog(id, init as Record<string, unknown>) : Promise.resolve(null)),
    save: async (file: any, opts = {}) => {
      if (opts.path || opts.format) {
        const format = opts.format ?? String(opts.path).split('.').pop() ?? '';
        if (!ref.props.onExport) throw new CommandError('unavailable', 'Exporting is not available here');
        const path = await ref.props.onExport(file, format);
        if (!path) throw new CommandError('failed', 'Export was cancelled');
        return {path};
      }
      await ref.pending;   // a notebook with protected sections is still being encrypted for the store
      const saved = await ref.props.onSave();
      return {revision: saved?.revision ?? file.revision};
    },
    close: async () => { ref.props.onClose(); },
    savePrefs: async prefs => { try { localStorage.setItem(`arkemis.prefs.${ref.props.kind}`, JSON.stringify(prefs)); } catch { /* storage unavailable */ } },
  });
}

export function EngineProvider(props: EngineProviderProps) {
  const {kind, file} = props;
  const [value, setValue] = useState<EngineValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<{controller: ShellController | null; props: EngineProviderProps; pending?: Promise<unknown>}>({controller: null, props});
  // What was last sent to the store when it differs from the session's content (Slate: the notebook with its protected sections encrypted).
  const sealedSent = useRef<unknown>(null);
  // The contents this window posted for saving most recently (references: no copy). A save comes back a moment after it was posted, and by then
  // the person may have edited on: that echo is ours, not another process's write.
  const recentSent = useRef<unknown[]>([]);
  ref.current.props = props;
  const sent = useRef<{content: unknown; revision: number}>({content: file.content, revision: file.revision});

  // Build the session once per document.
  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    (async () => {
      const [commands, dialogs, ui, spec, apps] = await Promise.all([
        COMMANDS[kind](), DIALOGS[kind](), appUi[kind](), appSpec[kind](), import('../../../core/generated/apps.mjs') as Promise<any>,
      ]);
      const uiCommands = (ui.uiCommands ?? []) as CommandFamily[];
      const registry = buildRegistry([...commands.modules, ...uiCommands], {
        app: kind, sources: [...commands.sources, ...uiCommands.map(f => `src/apps/${kind}/ui-commands/${f.family}.ts`)],
      });
      const host = rendererHost(ref.current);
      const foundation = apps.apps?.[kind] ?? {};
      const session = createSession({app: kind, registry, host, foundation, prefs: storedPrefs(kind)});
      const opened = await migrateOnOpen(foundation, structuredClone(file) as any);
      if (!alive) return;
      const docId = session.open(opened.file as any);
      const uiIndex: UiIndex = {manifest: ui.manifest, uiCommands, dialogs: ui.dialogs, panes: ui.panes, backstage: ui.backstage, extensions: ui.extensions};
      const controller = new ShellController({
        kind, session, docId, model: spec ? buildShellModel(spec) : null, ui: uiIndex, coreDialogs: dialogs.dialogs,
        onClose: () => ref.current.props.onClose(),
      });
      ref.current.controller = controller;
      // Session -> persistence: every committed change goes to useWorkspace (650 ms autosave), with
      // the schema, so a document converted on opening (or by its surface) is stored as schema 2.
      // Slate: a notebook with password-protected sections is stored with their pages encrypted
      // (core/slate/lib/protect.mjs sealForDisk), so what reaches the vault is never the plain text of an unlocked section.
      const protect: any = kind === 'slate' ? await import('../../../core/slate/lib/protect.mjs') : null;
      let sealSeq = 0;
      const persist = () => {
        const d = session.get(docId);
        sent.current = {content: d.file.content, revision: sent.current.revision};
        recentSent.current = [...recentSent.current.slice(-11), d.file.content];
        const {content, title, starred, properties, schema} = d.file as any;
        const post = (stored: unknown) => ref.current.props.onChange({content: stored, title, ...(schema !== undefined ? {schema} : {}),
          ...(starred !== undefined ? {starred} : {}), ...(properties !== undefined ? {properties} : {})});
        if (!protect?.hasProtected(content)) { sealSeq++; sealedSent.current = null; post(content); return; }
        const mine = ++sealSeq;
        ref.current.pending = protect.sealForDisk(content).then((stored: unknown) => {
          if (mine !== sealSeq) return;
          sealedSent.current = stored;
          post(stored);
        }).catch((e: any) => { controller.notify(`The notebook could not be saved: ${e?.message ?? e}`, 'error'); });
      };
      const kept = {schema: (opened.file as any).schema, folio: (opened.file as any).content?.folio};
      const off = session.subscribe(e => {
        if (e.type !== 'doc.changed' || e.doc !== docId) return;
        const f = session.get(docId).file as any;
        // Another window of this document (View › New Window) keeps it: that window persists its own change.
        if ((e as any).origin === 'mirror') return;
        if ((e as any).origin === 'store') {
          // A reload from the store is the stored file; a surface that converts the document itself
          // (session.reload with the migrated file) changes its schema: keep that conversion.
          if (f.schema === kept.schema && f.content?.folio === kept.folio) return;
          kept.schema = f.schema; kept.folio = f.content?.folio;
          persist();
          void ref.current.props.onSave();
          return;
        }
        persist();
      });
      if (opened.migrated) {
        // Written at once, before any edit: the file service then knows this write is only the
        // conversion (store.cjs afterSave: the document is not "modified" by it).
        persist();
        void ref.current.props.onSave();
      }
      // View › New Window: this document's other windows get every committed change, undo, redo and
      // save (electron/preload.cjs windows.sync), and theirs are applied here, so all of them show one
      // document with one undo history.
      const wins = (window as any).studio?.windows;
      const offOut = wins?.sync ? session.onCommit(m => { if (m.doc === docId) { try { wins.sync(m); } catch { /* main is gone */ } } }) : () => {};
      const offIn = wins?.onSync ? wins.onSync((m: any) => { if (m?.doc === docId && session.docs.has(docId)) void session.mirror(docId, m).catch(() => {}); }) : () => {};
      const detach = attachController(controller);
      cleanup = () => { off(); offOut(); offIn(); detach(); controller.dispose(); ref.current.controller = null; };
      if (!alive) { cleanup(); return; }
      setValue({kind, session, docId, controller, spec, ui: uiIndex});
      if (opened.error) controller.notify(`This document could not be converted for the new editor: ${opened.error}`, 'error');
    })().catch(e => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; cleanup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, file.id]);

  // Persistence -> session: our own save echoes mark the document clean (AutoSave); a write from
  // another process reloads a clean document and raises the conflict banner on a dirty one.
  useEffect(() => {
    if (!value || file.revision === sent.current.revision) return;
    const {session, docId, controller} = value;
    let doc;
    try { doc = session.get(docId); } catch { return; }
    const sealed = sealedSent.current;
    const ours = file.content === doc.file.content || (!!sealed && file.content === sealed) || JSON.stringify(file.content) === JSON.stringify(doc.file.content)
      || (!!sealed && JSON.stringify(file.content) === JSON.stringify(sealed));
    // An earlier save of ours arriving after later edits: the document stays as edited (and dirty); nothing else wrote it.
    if (!ours && recentSent.current.length > 1) {
      let json: string | null = null;
      const older = recentSent.current.some(c => { if (c === file.content) return true; json ??= JSON.stringify(file.content); return JSON.stringify(c) === json; });
      if (older) { sent.current = {content: sent.current.content, revision: file.revision}; doc.storeRevision = file.revision; (doc.file as any).revision = file.revision; controller.touch(); return; }
    }
    sent.current = {content: doc.file.content, revision: file.revision};
    if (ours) {
      doc.storeRevision = file.revision;
      (doc.file as any).revision = file.revision;
      if (session.prefs.autosave !== false) doc.dirty = false;
      controller.touch();
      return;
    }
    if (doc.dirty) { controller.notify('This document was changed elsewhere. Save a copy or reload the saved version.', 'error'); return; }
    // Another process wrote it (possibly an older editor, as schema 1): convert it as on opening.
    const foundation = (session as any).foundation ?? {};
    void migrateOnOpen(foundation, structuredClone(file) as any).then(r => { if (session.docs.has(docId)) session.reload(docId, r.file as any); });
  }, [file.revision, file.content, value]);

  const ctx = useMemo(() => value, [value]);
  if (error) return <div className="shell-loading" role="alert"><strong>This document could not open in the new editor.</strong><span>{error}</span></div>;
  if (!ctx) return <>{props.fallback ?? <div className="shell-loading" aria-busy="true">Opening…</div>}</>;
  return <EngineContext.Provider value={ctx}>{props.children}</EngineContext.Provider>;
}
