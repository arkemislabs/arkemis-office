// Slate notebooks as folders on disk (design note F-slate--integrator--notebook-folders).
//
// OneNote keeps a notebook in a folder the person chooses and saves every change into it with no
// Save step. The folder format, the incremental save and the reader are the Slate foundation's
// (core/slate/lib/notebook-folder.mjs: writeNotebook, saveNotebook, loadNotebook); core/ never
// touches a file system, so this module gives them one, in the main process:
//
//   * pick(mode, suggestedName): the system folder dialog. 'new' is a Save dialog titled
//     "New Notebook" whose chosen name becomes the notebook's folder (created here; an existing
//     non-empty folder is refused); 'open' is an Open dialog for a folder, titled "Open Notebook".
//   * fs: readText, writeText (atomic: temp file + rename), list, mkdir (recursive), rename,
//     remove (recursive), each restricted to a folder `pick` returned in this session or the recent
//     notebooks list (picks of earlier sessions). A document's own `content.notebook.path` never grants
//     access (security audit M1).
//   * create('new' | 'open', {path?}): a schema-2 Slate document for the notebook (New Notebook
//     writes the new notebook's folder; Open Notebook reads the folder, or brings forward the
//     document that already holds it), and the folder goes to the recent notebooks list.
//   * recent(): the recent notebooks (folders), most recent first.
//
// Electron-agnostic: main.cjs passes the dialogs in, the tests pass scripted ones.

const fsp = require('node:fs/promises');
const path = require('node:path');

const RECENT_LIMIT = 50;
const fail = (code, message, data) => Object.assign(new Error(message), {code, ...(data !== undefined ? {data} : {})});
const posix = p => path.resolve(p).split(path.sep).join('/');
const keyOf = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const within = (p, root) => { const a = keyOf(p), b = keyOf(root); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

/**
 * @param {{store: {list(): Promise<object[]>, save(file: object): Promise<object>},
 *   askFolder: (req: {mode: 'new'|'open', title: string, defaultPath: string, win?: unknown}) => Promise<string|null>,
 *   defaultFolder?: () => Promise<string>, recentFile?: string|null, now?: () => number}} deps
 */
function createNotebookFolders({store, askFolder, defaultFolder = async () => require('node:os').homedir(), recentFile = null, now = Date.now}) {
  const grants = new Map();          // keyOf(root) -> posix root
  const grant = root => { grants.set(keyOf(root), posix(root)); return posix(root); };
  const core = {
    folder: () => import('../core/slate/lib/notebook-folder.mjs'),
    model: () => import('../core/model.mjs'),
    schema: () => import('../core/slate/schema.mjs'),
  };

  /** Notebook documents in the vault: [{doc, path}] for every schema-2 Slate file with a folder. */
  async function notebookDocs() {
    const out = [];
    for (const f of await store.list().catch(() => [])) {
      const p = f?.kind === 'slate' && f.schema === 2 ? f.content?.notebook?.path : null;
      if (typeof p === 'string' && p) out.push({doc: f.id, path: p, file: f});
    }
    return out;
  }

  /**
   * The granted root that holds `p`. A folder is granted only by what main itself saw the person choose: the folder dialog
   * (`pick`) this session, or the recent notebooks list those picks wrote. A notebook document's own `content.notebook.path`
   * is the document's word (an imported .ark can say anything), so it never grants access.
   */
  async function rootFor(p) {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) throw fail('invalid_params', 'An absolute path inside the notebook folder is required', {path: '/path'});
    for (const root of grants.values()) if (within(p, root)) return root;
    for (const r of await readRecent()) if (within(p, r.path)) return grant(r.path);
    throw fail('invalid_params', 'That path is not inside a notebook folder this window opened', {path: '/path'});
  }
  const guard = async p => { await rootFor(p); return path.resolve(p); };

  const fs = {
    async readText(p) { return fsp.readFile(await guard(p), 'utf8'); },
    async writeText(p, text) {
      if (typeof text !== 'string') throw fail('invalid_params', 'text must be a string', {path: '/text'});
      const target = await guard(p);
      const tmp = `${target}.${process.pid}.${now().toString(36)}.tmp`;
      try { await fsp.writeFile(tmp, text, 'utf8'); await fsp.rename(tmp, target); }
      catch (e) { await fsp.rm(tmp, {force: true}).catch(() => {}); throw e; }
    },
    async list(p) { return (await fsp.readdir(await guard(p), {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})); },
    async mkdir(p) { await fsp.mkdir(await guard(p), {recursive: true}); },
    async rename(from, to) {
      const a = await guard(from), b = await guard(to);
      if (await rootFor(from) !== await rootFor(to)) throw fail('invalid_params', 'A rename stays inside one notebook folder', {path: '/to'});
      await fsp.rename(a, b);
    },
    async remove(p) {
      const target = await guard(p);
      if (grants.has(keyOf(target))) throw fail('invalid_params', 'The notebook folder itself is not removed this way', {path: '/path'});
      await fsp.rm(target, {recursive: true, force: true});
    },
  };

  // ---- recent notebooks -----------------------------------------------------------------------
  let recentCache = null;
  async function readRecent() {
    if (recentCache) return recentCache;
    let list = [];
    if (recentFile) try { const j = JSON.parse(await fsp.readFile(recentFile, 'utf8')); if (Array.isArray(j?.recent)) list = j.recent; } catch { /* none yet */ }
    recentCache = list.filter(r => r && typeof r.path === 'string');
    return recentCache;
  }
  async function touchRecent(root, name) {
    const list = (await readRecent()).filter(r => keyOf(r.path) !== keyOf(root));
    list.unshift({path: posix(root), name, openedAt: new Date(now()).toISOString()});
    recentCache = list.slice(0, RECENT_LIMIT);
    if (recentFile) {
      const tmp = `${recentFile}.${process.pid}.tmp`;
      await fsp.mkdir(path.dirname(recentFile), {recursive: true});
      await fsp.writeFile(tmp, JSON.stringify({version: 1, recent: recentCache}, null, 1));
      await fsp.rename(tmp, recentFile);
    }
  }
  async function recent() {
    const out = [];
    for (const r of await readRecent()) {
      let missing = false;
      try { missing = !(await fsp.stat(r.path)).isDirectory(); } catch { missing = true; }
      out.push({path: r.path, name: r.name ?? path.basename(r.path), folder: posix(path.dirname(r.path)), kind: 'slate', missing, openedAt: r.openedAt ?? null});
    }
    return out;
  }

  // ---- dialogs ---------------------------------------------------------------------------------
  /** The system folder dialog; returns the folder (posix separators) granted for this session, or null. */
  async function pick(mode, suggestedName, win) {
    if (mode !== 'new' && mode !== 'open') throw fail('invalid_params', "mode is 'new' or 'open'", {path: '/mode'});
    const base = await defaultFolder();
    const name = typeof suggestedName === 'string' && suggestedName.trim() ? suggestedName.trim() : 'My Notebook';
    const chosen = await askFolder({mode, win, title: mode === 'new' ? 'New Notebook' : 'Open Notebook', defaultPath: mode === 'new' ? path.join(base, name) : base});
    if (!chosen) return null;
    const full = path.resolve(chosen);
    if (mode === 'new') {
      let stat = null;
      try { stat = await fsp.stat(full); } catch { /* new folder */ }
      if (stat && !stat.isDirectory()) throw fail('conflict', `A file named ${path.basename(full)} already exists there. Choose another name for the notebook.`, {path: full});
      if (stat && (await fsp.readdir(full)).length) throw fail('conflict', `The folder ${path.basename(full)} is not empty. Choose another name for the notebook.`, {path: full});
      await fsp.mkdir(full, {recursive: true});
    } else {
      let stat = null;
      try { stat = await fsp.stat(full); } catch { /* reported below */ }
      if (!stat?.isDirectory()) throw fail('not_found', `Sorry, we couldn't find the notebook folder ${full}.`, {path: full});
    }
    return grant(full);
  }

  /**
   * New Notebook / Open Notebook: the document for the notebook (saved in the vault), or null when
   * the person cancelled the dialog. `path` (Open only) reopens a folder from the recent list.
   * @returns {Promise<{doc: string, path: string, name: string, alreadyOpen: boolean, warnings: string[]}|null>}
   */
  async function create(mode, {path: given = null, name = null, win} = {}) {
    if (mode !== 'new' && mode !== 'open') throw fail('invalid_params', "mode is 'new' or 'open'", {path: '/mode'});
    const {writeNotebook, loadNotebook} = await core.folder();
    const model = await core.model();
    let root;
    if (mode === 'open' && given) {
      // Only a folder the recent list holds (written by earlier dialog picks): never a path from the renderer or a document.
      const known = (await readRecent()).some(r => keyOf(r.path) === keyOf(given));
      if (!known) throw fail('invalid_params', 'That folder is not in the recent notebooks list', {path: '/path'});
      let stat = null;
      try { stat = await fsp.stat(given); } catch { /* below */ }
      if (!stat?.isDirectory()) throw fail('not_found', `Sorry, we couldn't find the notebook folder ${given}. Is it possible it was moved, renamed or deleted?`, {path: given});
      root = grant(given);
    } else {
      root = await pick(mode, name, win);
      if (!root) return null;
    }
    if (mode === 'open') {
      const existing = (await notebookDocs()).find(d => keyOf(d.path) === keyOf(root));
      if (existing) { await touchRecent(root, existing.file.title); return {doc: existing.doc, path: root, name: existing.file.title, alreadyOpen: true, warnings: []}; }
      const {content, warnings} = await loadNotebook(fs, root);
      content.notebook.path = root;
      const file = model.createFile('slate', content.notebook.name, {schema: 2});
      file.content = content;
      const saved = await store.save(model.validateFile(file));
      await touchRecent(root, saved.title);
      return {doc: saved.id, path: root, name: saved.title, alreadyOpen: false, warnings: warnings ?? []};
    }
    const title = path.basename(root);
    const file = model.createFile('slate', title, {schema: 2});
    file.content.notebook.path = root;
    await writeNotebook(fs, root, file.content);
    const saved = await store.save(model.validateFile(file));
    await touchRecent(root, title);
    return {doc: saved.id, path: root, name: title, alreadyOpen: false, warnings: []};
  }

  return {pick, create, recent, fs, grant, rootFor};
}

module.exports = {createNotebookFolders};
