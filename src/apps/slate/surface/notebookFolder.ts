// Autosave of a notebook into its folder on disk (F:slate surface; the OneNote way: every change
// is saved, no Save step).
//
// ISOLATED ADAPTER. The main process does not yet expose folder access to the renderer; the
// request is design note F-slate--integrator--notebook-folders. Until `window.studio.
// notebookFolder` exists, a notebook lives in its vault document only (the shell's autosave) and
// this hook does nothing. When it exists, every committed change is written into the notebook's
// folder (`content.notebook.path`) 650 ms after the last one, through
// core/slate/lib/notebook-folder.mjs, which rewrites only the files that changed.

import {useEffect} from 'react';
import type {Session} from '../../../../core/kernel/session.mjs';
import type {ShellController} from '../../../shell/engine/ShellController';
import {isNotebook} from '../../../../core/slate/schema.mjs';
import {saveNotebook} from '../../../../core/slate/lib/notebook-folder.mjs';
import {hasProtected, sealForDisk} from '../../../../core/slate/lib/protect.mjs';

/** The file access core/slate/lib/notebook-folder.mjs needs (paths joined with '/'). */
export interface FolderFs {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  list(path: string): Promise<{name: string; dir: boolean}[]>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The preload API the integrator request asks for (absent today). */
export interface NotebookFolderApi extends FolderFs {
  pick(mode: 'new' | 'open', suggestedName?: string): Promise<string | null>;
}

export function notebookFolderApi(): NotebookFolderApi | null {
  const api = typeof window === 'undefined' ? null : (window as any).studio?.notebookFolder;
  return api && typeof api.writeText === 'function' && typeof api.rename === 'function' ? api as NotebookFolderApi : null;
}

const DEBOUNCE_MS = 650;

export function useNotebookFolder(session: Session, docId: string, controller: ShellController) {
  useEffect(() => {
    const api = notebookFolderApi();
    if (!api) return;
    let saved: any = null;
    let onDisk: any = null;   // `saved` as it was written: protected sections locked, their pages encrypted
    try { const c = session.get(docId).file.content; if (isNotebook(c)) { saved = c; onDisk = c; } } catch { return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<void> = Promise.resolve();
    const flush = () => {
      timer = null;
      running = running.then(async () => {
        let next: any;
        try { next = session.get(docId).file.content; } catch { return; }
        const root = next?.notebook?.path;
        if (!isNotebook(next) || !root || next === saved) return;
        try {
          // A protected section is written as its encrypted blob only, never as pages.
          const sealed = hasProtected(next) ? await sealForDisk(next) : next;
          await saveNotebook(api, root, saved?.notebook?.path === root ? onDisk : null, sealed);
          saved = next; onDisk = sealed;
        } catch (e: any) {
          controller.notify(`The notebook could not be saved to its folder: ${e?.message ?? e}`, 'error');
        }
      });
    };
    const off = session.subscribe((e: any) => {
      if (e.doc !== docId || e.type !== 'doc.changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });
    return () => { off(); if (timer) { clearTimeout(timer); flush(); } };
  }, [session, docId, controller]);
}
