// The window's side of the document file lifecycle (docs/behaviour-fidelity.md, File > Save):
// the document's binding to its real file (name, path, AutoSave) for the title bar; the close
// button and quitting asking "Do you want to save changes to …?" through the registered Save
// Changes message box; AutoSave writing the document's own file a few seconds after each change;
// Document Recovery marking a recovered document unsaved; File pages the commands ask for
// (Ctrl+P shows File › Print); and the message boxes of a lossy Save As.
// Behaviour translated from wordcraft crates/ui-egui/src/app/files.rs (close_requested,
// answer_save_changes, autosave_tick, AutoSave failure) at aadb077e072b7de05f724e359d8db82e151f125c.

import {useCallback, useEffect, useState, useSyncExternalStore} from 'react';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {AUTOSAVE_DELAY_MS, autosaveBlock} from '../../../core/common/commands/file.mjs';
import type {FileBinding, MessageBoxRequest, StudioFiles} from '../../types';
import {useEngine} from '../engine/EngineProvider';
import type {ShellController} from '../engine/ShellController';
import {MessageBoxHost, openMessageBox} from '../dialogs/MessageBox';

/** window.studio.files, when the app runs in Electron with the file service. */
export const studioFiles = (): StudioFiles | null => {
  const s = typeof window === 'undefined' ? null : (window as unknown as {studio?: {files?: StudioFiles}}).studio;
  return s?.files ?? null;
};

// The preload's values cross the context bridge as fresh copies on every call: keep one object per
// document while its content is the same, so React sees a stable snapshot.
const stable = new Map<string, {key: string; value: FileBinding}>();
function stableBinding(files: StudioFiles, doc: string): FileBinding | null {
  const b = files.binding(doc);
  if (!b) { stable.delete(doc); return null; }
  const key = JSON.stringify(b);
  const prev = stable.get(doc);
  if (prev && prev.key === key) return prev.value;
  stable.set(doc, {key, value: b});
  return b;
}

/** The document's binding to its file, kept current (null without a file service, or for Slate). */
export function useFileBinding(): FileBinding | null {
  const {docId, kind} = useEngine();
  const files = studioFiles();
  const subscribe = useCallback((fn: () => void) => (files ? files.onBinding(b => { if (b.doc === docId) fn(); }) : () => {}), [files, docId]);
  const snapshot = useCallback(() => (files && kind !== 'slate' ? stableBinding(files, docId) : null), [files, kind, docId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Which File page a command asked for ("print", "open", "recover") -> the app's backstage node. */
function pageNode(controller: ShellController, page: string): string | null {
  const nodes = (controller.model?.backstage ?? []).filter(n => n.kind === 'page');
  const stem = (id: string) => id.replace(/^(file|backstage)\./, '').toLowerCase().replace(/[^a-z]/g, '');
  const wanted = page === 'recover' ? ['recover', 'open'] : [page];
  // Labels as the spec words them: "Print", "Print…" (PDF), "Recover", "Open".
  const named = (x: {label: string}) => x.label.toLowerCase().replace(/[.…]+$/, '').trim();
  for (const w of wanted) { const n = nodes.find(x => stem(x.id) === w || named(x) === w) ?? nodes.find(x => stem(x.id).startsWith(w)); if (n) return n.id; }
  return null;
}

/** Wait for the Save Changes prompt `key` to be answered: true once the document closed, false when it stays. */
function answered(controller: ShellController, key: string): Promise<boolean> {
  const {session, docId} = controller;
  return new Promise(resolve => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; offSession(); offShell(); resolve(v); };
    const offSession = session.subscribe(e => { if (e.type === 'document.closed' && e.doc === docId) finish(true); });
    const offShell = controller.subscribe(() => {
      if (!session.docs.has(docId)) finish(true);
      else if (!controller.getState().dialogs.some(d => d.key === key)) finish(false);
    });
  });
}

/** Mounted once by the title bar: the lifecycle glue between this window's document and main. */
export function FileLifecycle() {
  const {controller, session, docId, kind} = useEngine();
  const files = studioFiles();
  const [, setTick] = useState(0);

  // Adopt the document (main learns this window holds it; a document made by the Start screen gets
  // its Document1 name) and refresh command state whenever its binding changes.
  useEffect(() => {
    if (!files || kind === 'slate') return;
    // The vault is AutoRecover only: an echo of its snapshot must never mark the document saved
    // (EngineProvider cleans a document on the echo while the legacy app-wide AutoSave pref is on).
    session.prefs = {...session.prefs, autosave: false};
    let alive = true;
    const refresh = () => { try { session.activate(docId); } catch { /* closed */ } controller.touch(); setTick(t => t + 1); };
    const off = files.onBinding(b => { if (b.doc === docId) refresh(); });
    files.adopt(docId).then(b => {
      if (!alive) return;
      // Document Recovery: the snapshot has work its file does not have.
      if (b?.recovered) {
        try { session.get(docId).dirty = true; } catch { /* closed */ }
        controller.notify(`${b.name} was recovered. It has changes that are not in its file yet: save it to keep them.`);
      }
      refresh();
    }).catch(() => {});
    return () => { alive = false; off(); };
  }, [files, kind, docId, session, controller]);

  // The close button, Alt+F4 and quitting ask here (the registered Save Changes box: the bridge can answer it too).
  useEffect(() => {
    if (!files) return;
    return files.onCloseRequest(async () => {
      if (!session.docs.has(docId)) return true;
      const doc = session.get(docId);
      if (kind === 'slate' || !doc.dirty) {
        if (kind !== 'slate') await files.closed(docId, {discard: false}).catch(() => {});
        return true;
      }
      controller.closeBackstage();
      const key = controller.promptSave();
      return answered(controller, key);
    });
  }, [files, kind, docId, session, controller]);

  // File pages a command asked for (Ctrl+P: File › Print; Open Recent; Recover Unsaved Documents).
  useEffect(() => {
    if (!files) return;
    return files.onShow(page => { const id = pageNode(controller, page); controller.openBackstage(id); });
  }, [files, controller]);

  // Message boxes for this window (lossy Save As warnings): Office's buttons, keyboard accessible.
  useEffect(() => {
    if (!files) return;
    return files.onMessageBox((req: MessageBoxRequest) => openMessageBox(req));
  }, [files]);

  // AutoSave (wordcraft autosave_tick): write the document's own file a few seconds after the last
  // change; a failure says why, turns AutoSave off, and the next Save turns it back on.
  useEffect(() => {
    if (!files || kind === 'slate') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const due = () => {
      const b = files.binding(docId);
      return !!b?.autosave && !autosaveBlock(kind, b) && session.docs.has(docId) && session.get(docId).dirty;
    };
    const tick = async () => {
      timer = null;
      if (running || !due()) return;
      if (controller.getState().dialogs.length) { timer = setTimeout(tick, AUTOSAVE_DELAY_MS); return; }
      running = true;
      try {
        await session.execute(docId, 'file.save', {}, {origin: 'ui'});
      } catch (e) {
        await files.setAutosave(docId, false).catch(() => {});
        controller.notify(`AutoSave failed: ${toCommandError(e).message}. Save the document to turn AutoSave back on.`, 'error');
      } finally { running = false; }
    };
    const off = session.subscribe(e => {
      if (e.type !== 'doc.changed' || e.doc !== docId) return;
      if (timer) clearTimeout(timer);
      if (due()) timer = setTimeout(tick, AUTOSAVE_DELAY_MS);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [files, kind, docId, session, controller]);

  return <MessageBoxHost/>;
}
