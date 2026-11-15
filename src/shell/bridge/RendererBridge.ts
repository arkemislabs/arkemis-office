// The renderer side of the bridge (docs/architecture.md section 15.4, docs/bridge-protocol.md §3).
//
// main's rpc-router sends `studio:rpc` requests for documents that are live in this window; the
// preload hands them to `handle()` and replies with whatever it resolves or throws. Session-only
// methods go through the shared core/kernel/rpc-methods.mjs (the headless host answers the same
// way); the `ui.*` methods, `documents.close` and `document.render` go to the ShellController, so
// a bridge-driven window and a person-driven one run identical code. `ui.pointer`, `ui.type` and
// `ui.keys` go to the mounted surface's SurfaceHandle (the same code its own pointer and keyboard
// handlers run); `ui.key` asks KeyRouter and the surface in the order a keystroke takes.

import {createRpcMethods, type RpcMethods} from '../../../core/kernel/rpc-methods.mjs';
import {CommandError, toCommandError} from '../../../core/kernel/errors.mjs';
import type {ShellController} from '../engine/ShellController';
import {snapshot} from '../dialogs/dialogState';
import {isControl} from '../model';
import {DEV_HOOKS} from '../env';

export interface RpcRequest { id: string | null; method: string; params: Record<string, unknown>; origin?: 'bridge' }

const UI_METHODS = ['documents.close', 'document.render', 'ui.inspect', 'ui.tab', 'ui.activate', 'ui.menu', 'ui.contextMenu', 'ui.dialog.open', 'ui.dialog.get',
  'ui.dialog.set', 'ui.dialog.submit', 'ui.dialog.cancel', 'ui.pane', 'ui.key', 'ui.keys', 'ui.pointer', 'ui.type', 'ui.toast'] as const;
const SESSION_METHODS = ['engine.commands', 'engine.execute', 'engine.batch', 'document.inspect', 'document.read', 'document.find',
  'document.anchor', 'selection.get', 'selection.set'] as const;
export const RENDERER_METHODS: readonly string[] = [...SESSION_METHODS, ...UI_METHODS];

interface Live { controller: ShellController; methods: RpcMethods; off: () => void; lastDialogs: string[] }
const live = new Map<string, Live>();
let active: string | null = null;
let installed = false;

const studio = () => (typeof window === 'undefined' ? null : (window as any).studio ?? null);
const notify = (message: unknown) => { try { studio()?.rpcNotify?.(message); } catch { /* main may be gone */ } };

function liveDocs() {
  return [...live.values()].map(({controller}) => {
    const d = controller.session.get(controller.docId);
    return {doc: d.id, kind: controller.kind, title: d.file.title, version: d.version, dirty: !!d.dirty, storeRevision: d.storeRevision};
  });
}
let lastDocs = '';
function sendDocuments(force = false) {
  let docs: ReturnType<typeof liveDocs> = [];
  try { docs = liveDocs(); } catch { /* a document closed mid-way */ }
  const text = JSON.stringify({docs: docs.map(d => [d.doc, d.title, d.dirty]), active});
  if (!force && text === lastDocs) return;
  lastDocs = text;
  notify({type: 'documents', docs, active});
}

/** Register a live document's controller (EngineProvider calls this); returns the detach function. */
export function attachController(controller: ShellController): () => void {
  installRendererBridge();
  const docId = controller.docId;
  const methods = createRpcMethods(controller.session, {viewAvailable: true});
  const forward = new Set(['doc.changed', 'doc.saved', 'selection.changed', 'document.opened', 'document.closed']);
  const offSession = controller.session.subscribe(e => {
    if (forward.has(e.type)) notify({type: 'event', event: e});
    if (e.type === 'doc.changed' || e.type === 'doc.saved' || e.type === 'document.closed') sendDocuments();
  });
  const entry: Live = {controller, methods, off: () => {}, lastDialogs: []};
  const offShell = controller.subscribe(() => {
    const ids = controller.getState().dialogs.map(d => d.key);
    const version = (() => { try { return controller.session.get(docId).version; } catch { return 0; } })();
    for (const d of controller.getState().dialogs) if (!entry.lastDialogs.includes(d.key)) notify({type: 'event', event: {type: 'dialog.opened', doc: docId, version, dialog: d.id}});
    for (const key of entry.lastDialogs) if (!ids.includes(key)) notify({type: 'event', event: {type: 'dialog.closed', doc: docId, version, dialog: key.split('#')[0]}});
    entry.lastDialogs = ids;
    sendDocuments();
  });
  entry.off = () => { offSession(); offShell(); };
  live.set(docId, entry);
  active = docId;
  sendDocuments(true);
  return () => {
    entry.off();
    if (live.get(docId) === entry) live.delete(docId);
    if (active === docId) active = live.keys().next().value ?? null;
    sendDocuments(true);
  };
}

function target(params: Record<string, unknown>): Live {
  const doc = typeof params.doc === 'string' ? params.doc : null;
  const entry = doc ? live.get(doc) : (active ? live.get(active) : live.values().next().value);
  if (!entry) throw new CommandError('unavailable', doc ? `Document ${doc} is not open in this window` : 'No document is open in this window', {hint: 'documents.open'});
  return entry;
}
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v) throw new CommandError('invalid_params', `${name} is required`, {path: `/${name}`});
  return v;
};

/** Resolves once the UI has painted the change (so a following ui.capture shows it); never waits long. */
function afterPaint(): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 150);
  });
}
const SETTLE = new Set(['ui.tab', 'ui.activate', 'ui.menu', 'ui.contextMenu', 'ui.dialog.open', 'ui.dialog.set', 'ui.dialog.submit', 'ui.dialog.cancel', 'ui.pane', 'ui.key',
  'ui.keys', 'ui.pointer', 'ui.type']);

/** JSON-safe copy of what a surface handler returned (selections, ids, counts). */
const plain = (v: unknown) => { try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } };
/** The surface's input params: everything but the routing keys. */
function surfaceParams(params: Record<string, unknown>) {
  const {doc: _doc, approval: _approval, ...rest} = params;
  return rest;
}
const MODIFIERS = new Set(['shift', 'ctrl', 'alt', 'meta']);

/** Answer one request (also the dev-only test hook `window.__arkemisRpc(method, params)`). */
export async function handle(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const result = await answer(method, params);
  if (SETTLE.has(method)) await afterPaint();
  return result;
}

async function answer(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'ui.toast') {
    for (const {controller} of live.values()) controller.notify(String(params.text ?? ''), 'info');
    return null;
  }
  if ((SESSION_METHODS as readonly string[]).includes(method)) {
    const entry = target(params);
    return entry.methods.call(method, params.doc === undefined ? {...params, doc: entry.controller.docId} : params);
  }
  const {controller: c} = target(params);
  switch (method) {
    case 'documents.close': {
      const save = params.save === true;
      await c.session.execute(c.docId, 'file.close', save ? {save: true} : {force: true}, {origin: 'bridge', approval: params.approval as any});
      return {closed: true};
    }
    case 'document.render': {
      if (!c.view?.render) throw new CommandError('unavailable', 'This app cannot render a page image yet');
      const url = await c.view.render(params.target, typeof params.scale === 'number' ? params.scale : undefined);
      if (!url) throw new CommandError('not_found', 'Nothing to render at that target');
      const png = String(url).replace(/^data:image\/png;base64,/, '');
      return {png};
    }
    case 'ui.inspect': return c.inspect();
    case 'ui.tab': {
      const id = str(params.id ?? params.tab, 'id');
      if (/^file$/i.test(id)) { c.openBackstage(); return {tab: 'file'}; }
      // 'tab/group' also opens that group as its own panel (an app chrome's tool panel: 'all-tools/comment').
      c.setTab(id);
      return {tab: c.activeTab()?.id ?? id, panel: c.getState().panel};
    }
    case 'ui.activate': {
      const result = await c.activate(str(params.control, 'control'), {value: params.value, origin: 'bridge', approval: params.approval as any});
      return result ?? {opened: c.dialog()?.id ?? c.getState().menu ?? null};
    }
    case 'ui.menu': {
      // Opens (or with open: false closes) a drop-down, split or gallery control's menu, as its arrow does.
      const id = str(params.control, 'control');
      const ctl = c.model?.controls.get(id);
      if (!ctl) throw new CommandError('not_found', `No control ${id}`);
      if (params.open === false) { if (c.getState().menu === id) c.setMenu(null); }
      else if (ctl.items?.length || ctl.type === 'gallery') {
        // A control nested in a menu: its top-level menu opens, with this control's own flyout open in it.
        let top = id;
        for (let p = c.model?.parent.get(top); p; p = c.model?.parent.get(top)) top = p;
        c.setMenu(top, top === id ? null : id);
      }
      else throw new CommandError('invalid_params', `${id} has no menu`);
      return {menu: c.getState().menu};
    }
    case 'ui.contextMenu': {
      // A right-click menu by its spec target (cell, rowHeader, slide-thumbnail, text-selection...).
      if (params.open === false) { c.closeContextMenu(); return {contextMenu: null}; }
      const target = str(params.target, 'target');
      const x = Number.isFinite(params.x) ? Number(params.x) : 240, y = Number.isFinite(params.y) ? Number(params.y) : 240;
      try { await c.view?.contextPrepare?.(target); } catch { /* the menu opens without its dynamic entries */ }
      if (!c.openContextMenu(target, x, y)) throw new CommandError('not_found', `No right-click menu with entries for ${target}`);
      const open = c.getState().contextMenu!;
      const items = c.contextEntries(open.target).filter(isControl).map(e => ({id: e.id, label: e.label, command: e.command ?? null, dialog: e.dialog ?? null, submenu: (e.items ?? []).some(isControl)}));
      return {target: open.target, items};
    }
    case 'ui.dialog.open': {
      const key = c.openDialog(str(params.id, 'id'), {origin: 'bridge', args: (params.args as any) ?? null});
      return snapshot(c.dialog(key)!);
    }
    case 'ui.dialog.get': {
      const d = c.dialog((params.id as string) ?? null);
      if (!d) throw new CommandError('not_found', params.id ? `Dialog ${params.id} is not open` : 'No dialog is open');
      return snapshot(d);
    }
    case 'ui.dialog.set': {
      const id = (params.id as string) ?? null;
      if (typeof params.tab === 'string' || typeof params.tab === 'number') c.setDialogTab(id, params.tab as any);
      if (params.field !== undefined) c.setDialogValue(id, str(params.field, 'field'), params.value);
      if (params.values && typeof params.values === 'object') for (const [k, v] of Object.entries(params.values as object)) c.setDialogValue(id, k, v);
      return snapshot(c.dialog(id)!);
    }
    case 'ui.dialog.submit': {
      const id = (params.id as string) ?? null;
      if (typeof params.field === 'string') return (await c.pressField(id, params.field)) ?? {pressed: params.field};
      const r = await c.submitDialog(id, (params.button as string) ?? null, {origin: 'bridge', approval: params.approval as any});
      if (!r.ok) throw new CommandError('invalid_params', String((r.errors as any)?.[0]?.message ?? 'The dialog could not be submitted'), {fields: r.errors ?? []});
      return r.result ?? {submitted: true};
    }
    case 'ui.dialog.cancel': { c.cancelDialog((params.id as string) ?? null); return {cancelled: true}; }
    case 'ui.pane': {
      const id = str(params.id, 'id');
      c.setPane(id, typeof params.open === 'boolean' ? params.open : undefined);
      // `width` resizes a pane the way its grip does (clamped by the shell).
      if (Number.isFinite(params.width)) c.resizePane(c.paneSpec(id)?.id ?? id, Number(params.width));
      const p = c.getState().panes.find(x => x.id === id || x.id === `pane.${id}`);
      return {id: p?.id ?? id, open: !!p?.open};
    }
    case 'ui.key': {
      // KeyRouter and the surface's own keys, in the order a keystroke takes (ShellController.keyWithSurface).
      const results = await c.keyWithSurface(str(params.keys, 'keys'));
      const last = results[results.length - 1];
      return {handled: results.some(r => r.handled), command: last?.command ?? null, scope: last?.scope ?? null, by: last?.by ?? null};
    }
    case 'ui.keys': {
      // One key straight to the surface (navigation and editing keys that are not shortcuts).
      const key = str(params.key, 'key');
      const modifiers = params.modifiers === undefined ? [] : params.modifiers;
      if (!Array.isArray(modifiers) || modifiers.some(m => typeof m !== 'string' || !MODIFIERS.has(m.toLowerCase()))) {
        throw new CommandError('invalid_params', 'modifiers is a list of shift, ctrl, alt and meta', {path: '/modifiers'});
      }
      const mods = modifiers.map(m => String(m).toLowerCase());
      const view = c.view;
      if (typeof view?.keys === 'function') return plain(await view.keys(key, mods));
      if (typeof view?.key === 'function') {
        const on = (m: string) => mods.includes(m);
        return plain(await view.key(key, {shift: on('shift'), ctrl: on('ctrl'), alt: on('alt'), meta: on('meta'), cmd: on('ctrl') || on('meta')}));
      }
      throw new CommandError('unavailable', `The ${c.kind} surface has no key handler; use ui.key for shortcuts`);
    }
    case 'ui.pointer': {
      if (typeof params.action !== 'string' && !Array.isArray(params.events)) {
        throw new CommandError('invalid_params', 'action (click, doubleClick, drag...) or events is required', {path: '/action'});
      }
      if (typeof c.view?.pointer !== 'function') throw new CommandError('unavailable', `The ${c.kind} surface does not take pointer gestures over the bridge`);
      if (c.getState().backstage.open) throw new CommandError('unavailable', 'The File tab covers the document; close it first (ui.key Escape)');
      return plain(await c.view.pointer(surfaceParams(params)));
    }
    case 'ui.type': {
      if (typeof params.text !== 'string') throw new CommandError('invalid_params', 'text is required', {path: '/text'});
      if (params.text.length > 1_000_000) throw new CommandError('too_large', 'Type at most 1,000,000 characters per request', {path: '/text'});
      if (typeof c.view?.type !== 'function') throw new CommandError('unavailable', `The ${c.kind} surface does not take typing over the bridge`);
      if (c.getState().backstage.open) throw new CommandError('unavailable', 'The File tab covers the document; close it first (ui.key Escape)');
      return plain(await c.view.type(params.text));
    }
    default: throw new CommandError('not_found', `Unknown method ${method}`);
  }
}

/** Mount once per window: register the RPC handler and say hello (section 3.1 of the protocol). */
export function installRendererBridge(): () => void {
  if (installed) return () => {};
  installed = true;
  const api = studio();
  let off = () => {};
  if (api?.onRpc) {
    off = api.onRpc(async (req: RpcRequest) => {
      if (!req || typeof req.method !== 'string') throw new CommandError('invalid_params', 'method is required');
      // A plain object, not an Error: the context bridge copies an Error's message only, and the
      // code and data (an approval nonce, a field path, a conflict's version) must reach the client.
      try { return await handle(req.method, req.params ?? {}); } catch (e) { throw toCommandError(e).toJSON(); }
    });
    notify({type: 'hello', protocol: 2, methods: RENDERER_METHODS});
    sendDocuments(true);
  }
  // Development builds only: the same handler as a page-level hook for the shell render test.
  if (DEV_HOOKS) (window as any).__arkemisRpc = (method: string, params?: Record<string, unknown>) => handle(method, params ?? {}).then(
    result => ({ok: true, result: JSON.parse(JSON.stringify(result ?? null))}),
    error => ({ok: false, error: toCommandError(error).toJSON()}));
  const bye = () => notify({type: 'bye'});
  window.addEventListener('beforeunload', bye);
  return () => { off(); bye(); window.removeEventListener('beforeunload', bye); installed = false; };
}
