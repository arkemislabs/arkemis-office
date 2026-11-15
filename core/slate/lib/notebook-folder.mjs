// A notebook as a folder on disk, the OneNote way (F:slate foundation).
//
// Slate has no ArtCraft upstream. OneNote keeps a notebook as a folder the person chose: the
// folder holds the table of contents (section order and colours), one file per section, and a
// subfolder per section group. Slate keeps the same shape with standard JSON files, one per page
// so that autosave rewrites only what changed:
//
//   <Notebook>/notebook.json              table of contents: id, name, colour, items in order
//   <Notebook>/<Section>/section.json     section: id, name, colour, page order and levels
//   <Notebook>/<Section>/<pageId>.json    one page (title, dates, styles, note containers, ink)
//   <Notebook>/<Group>/group.json         section group: id, name, items in order
//   <Notebook>/<Group>/<Section>/...      sections inside the group
//
// Folder names follow the section and group names (renaming a section renames its folder, as
// OneNote renames the .one file); ids inside the JSON keep identity. `planSave` compares two
// immutable notebook versions by record identity, so saving after one keystroke writes one page
// file, and after a rename moves one folder.
//
// The file system is passed in (`FolderFs`), so this module stays free of Node built-ins and runs
// in the main process (node:fs), in tests and behind an IPC adapter:
//
//   interface FolderFs {
//     readText(path): Promise<string>;               // throws {code:'ENOENT'} when missing
//     writeText(path, text): Promise<void>;          // atomic (temp file + rename)
//     list(path): Promise<{name: string, dir: boolean}[]>;
//     mkdir(path): Promise<void>;                    // recursive
//     rename(from, to): Promise<void>;
//     remove(path): Promise<void>;                   // file or folder (recursive)
//   }
//
// Paths are joined with '/'; the adapter accepts them on every platform.

import {CONTENT_VERSION, NOTEBOOK_FORMAT, newPageRecord, validateContent} from '../schema.mjs';

export const FOLDER_FORMAT = 'arkemis.slate-notebook-folder';
export const NOTEBOOK_FILE = 'notebook.json';
export const SECTION_FILE = 'section.json';
export const GROUP_FILE = 'group.json';
export const STAGING = '.slate-moving';
export const pageFile = id => `${id}.json`;
/** A page's saved versions (History › Page Versions) sit beside it: <pageId>.versions.json. */
export const versionsFile = id => `${id}.versions.json`;
const isVersionsFile = name => /\.versions\.json$/.test(name);
const versionsText = list => JSON.stringify(list);

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A folder name for a section or group name (Windows, macOS and Linux safe). */
export function safeName(name) {
  let s = String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!s || s === '.' || s === '..') s = 'Untitled';
  if (RESERVED.test(s)) s += '_';
  if (s.startsWith('.')) s = '_' + s.slice(1);
  return s.slice(0, 100);
}

const join = (...parts) => parts.filter(p => p !== '' && p !== null && p !== undefined).join('/');

/**
 * Where every section and group lives: Map itemId -> {dir, kind, parent}. Folder names are unique
 * per parent (case-insensitive): a second "Notes" becomes "Notes (2)".
 */
export function folderLayout(content) {
  const dirs = new Map();
  const place = (items, parentDir, parent) => {
    const used = new Set();
    for (const id of items) {
      const record = content.sections[id] ?? content.groups[id];
      const kind = content.sections[id] ? 'section' : 'group';
      const base = safeName(record.name);
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()) || name.toLowerCase() === STAGING; n++) name = `${base} (${n})`;
      used.add(name.toLowerCase());
      const dir = join(parentDir, name);
      dirs.set(id, {dir, kind, parent, name});
      if (kind === 'group') place(content.groups[id].items, dir, id);
    }
  };
  place(content.tree, '', null);
  return dirs;
}

const itemsJSON = (content, items, dirs) => items.map(id => ({id, kind: dirs.get(id).kind, folder: dirs.get(id).name}));

/** notebook.json text. */
export function notebookFileText(content, dirs = folderLayout(content)) {
  const {path, ...nb} = content.notebook;
  return JSON.stringify({format: FOLDER_FORMAT, version: CONTENT_VERSION, ...nb, items: itemsJSON(content, content.tree, dirs)}, null, 1);
}
export function groupFileText(content, gid, dirs = folderLayout(content)) {
  const {items, ...g} = content.groups[gid];
  return JSON.stringify({...g, items: itemsJSON(content, items, dirs)}, null, 1);
}
export const sectionFileText = section => JSON.stringify(section, null, 1);
export const pageFileText = page => JSON.stringify(page);

/** Every file of the notebook: Map relativePath -> text. */
export function serialize(content) {
  const dirs = folderLayout(content);
  const files = new Map([[NOTEBOOK_FILE, notebookFileText(content, dirs)]]);
  for (const [id, d] of dirs) {
    if (d.kind === 'group') { files.set(join(d.dir, GROUP_FILE), groupFileText(content, id, dirs)); continue; }
    const s = content.sections[id];
    files.set(join(d.dir, SECTION_FILE), sectionFileText(s));
    for (const e of s.pages) {
      files.set(join(d.dir, pageFile(e.id)), pageFileText(content.pages[e.id]));
      const v = content.versions?.[e.id];
      if (v?.length) files.set(join(d.dir, versionsFile(e.id)), versionsText(v));
    }
  }
  return files;
}

const depthOf = dir => dir.split('/').length;

/**
 * What saving `next` over a folder that holds `prev` takes:
 * {moves: [{id, from, to}] (two-phase through STAGING), removeDirs, mkdirs, writes: [{path, text}], removes}.
 * Moves and removals are given in the order to run them.
 */
export function planSave(prev, next) {
  const pd = folderLayout(prev), nd = folderLayout(next);
  const plan = {moves: [], removeDirs: [], mkdirs: [], writes: [], removes: []};
  // Folders: an item moves when its own name or its parent changed; unchanged children ride along.
  const changedItems = [];
  for (const [id, n] of nd) {
    const p = pd.get(id);
    if (p && p.kind === n.kind && (p.name !== n.name || p.parent !== n.parent)) changedItems.push({id, from: p.dir, to: n.dir});
  }
  plan.moves = changedItems;
  for (const [id, p] of pd) if (!nd.has(id) || nd.get(id).kind !== p.kind) plan.removeDirs.push({id, dir: p.dir});
  for (const [id, n] of nd) if (!pd.has(id) || pd.get(id).kind !== n.kind) plan.mkdirs.push(n.dir);
  plan.mkdirs.sort((a, b) => depthOf(a) - depthOf(b));
  // Table of contents and group files: rewrite when their text changes.
  const nbText = notebookFileText(next, nd);
  if (nbText !== notebookFileText(prev, pd)) plan.writes.push({path: NOTEBOOK_FILE, text: nbText});
  for (const [id, n] of nd) {
    if (n.kind !== 'group') continue;
    const text = groupFileText(next, id, nd);
    if (!pd.has(id) || prev.groups[id] !== next.groups[id] || text !== groupFileText(prev, id, pd)) plan.writes.push({path: join(n.dir, GROUP_FILE), text});
  }
  // Sections and pages: by record identity.
  const prevHome = new Map();
  for (const s of Object.values(prev.sections)) for (const e of s.pages) prevHome.set(e.id, s.id);
  for (const [id, n] of nd) {
    if (n.kind !== 'section') continue;
    const s = next.sections[id];
    if (prev.sections[id] !== s) plan.writes.push({path: join(n.dir, SECTION_FILE), text: sectionFileText(s)});
    for (const e of s.pages) {
      const moved = prevHome.get(e.id) !== id;
      if (moved || prev.pages[e.id] !== next.pages[e.id]) plan.writes.push({path: join(n.dir, pageFile(e.id)), text: pageFileText(next.pages[e.id])});
      const pv = prev.versions?.[e.id], nv = next.versions?.[e.id];
      if (nv?.length && (moved || pv !== nv)) plan.writes.push({path: join(n.dir, versionsFile(e.id)), text: versionsText(nv)});
      else if (!nv?.length && pv?.length && !moved) plan.removes.push(join(n.dir, versionsFile(e.id)));
    }
  }
  // Page files that left a surviving section (deleted or moved elsewhere): removed at their new place.
  const nextHome = new Map();
  for (const s of Object.values(next.sections)) for (const e of s.pages) nextHome.set(e.id, s.id);
  for (const [pid, sid] of prevHome) {
    if (nextHome.get(pid) === sid || !nd.has(sid) || nd.get(sid).kind !== 'section') continue;
    plan.removes.push(join(nd.get(sid).dir, pageFile(pid)));
    if (prev.versions?.[pid]?.length) plan.removes.push(join(nd.get(sid).dir, versionsFile(pid)));
  }
  return plan;
}

/** Run a plan against a folder. Returns counts. */
export async function runPlan(fs, root, plan) {
  // Track where each old folder is while folders move, so later steps find them.
  const moved = [];
  const where = dir => {
    let d = dir;
    for (const m of moved) {
      if (d === m.from) d = m.to;
      else if (d.startsWith(m.from + '/')) d = m.to + d.slice(m.from.length);
    }
    return d;
  };
  const abs = rel => join(root, rel);
  if (plan.moves.length) {
    await fs.mkdir(abs(STAGING));
    // Phase 1, children first: every moving folder goes to the staging area by id.
    for (const m of [...plan.moves].sort((a, b) => depthOf(b.from) - depthOf(a.from))) {
      const at = where(m.from);
      const staged = join(STAGING, m.id);
      await fs.rename(abs(at), abs(staged));
      moved.push({from: at, to: staged});
    }
  }
  for (const r of [...plan.removeDirs].sort((a, b) => depthOf(b.dir) - depthOf(a.dir))) await fs.remove(abs(where(r.dir)));
  if (plan.moves.length) {
    // Phase 2, parents first: staged folders go to their new places.
    for (const m of [...plan.moves].sort((a, b) => depthOf(a.to) - depthOf(b.to))) {
      await fs.rename(abs(join(STAGING, m.id)), abs(m.to));
    }
    await fs.remove(abs(STAGING));
  }
  for (const dir of plan.mkdirs) await fs.mkdir(abs(dir));
  for (const path of plan.removes) await fs.remove(abs(path));
  for (const w of plan.writes) await fs.writeText(abs(w.path), w.text);
  return {moved: plan.moves.length, removedFolders: plan.removeDirs.length, created: plan.mkdirs.length, written: plan.writes.length, removed: plan.removes.length};
}

/** Save `next` over the folder that holds `prev` (null: write everything, e.g. a new notebook). */
export async function saveNotebook(fs, root, prev, next) {
  if (!prev) return writeNotebook(fs, root, next);
  return runPlan(fs, root, planSave(prev, next));
}

/** Write a whole notebook into a folder (New Notebook, or Save a Copy). */
export async function writeNotebook(fs, root, content) {
  await fs.mkdir(root);
  const dirs = folderLayout(content);
  for (const d of [...dirs.values()].sort((a, b) => depthOf(a.dir) - depthOf(b.dir))) await fs.mkdir(join(root, d.dir));
  let written = 0;
  for (const [rel, text] of serialize(content)) { await fs.writeText(join(root, rel), text); written++; }
  return {moved: 0, removedFolders: 0, created: dirs.size, written, removed: 0};
}

const readJSON = async (fs, path) => JSON.parse(await fs.readText(path));

/**
 * Read a notebook folder into content (Open Notebook). Pages listed in section.json whose file is
 * missing are dropped; page files a section does not list are added at its end (a page file
 * copied in from elsewhere), as OneNote shows every page its section file holds.
 * Returns {content, warnings}.
 */
export async function loadNotebook(fs, root) {
  const warnings = [];
  let toc;
  try { toc = await readJSON(fs, join(root, NOTEBOOK_FILE)); } catch (e) {
    throw new Error(e?.code === 'ENOENT' ? 'This folder is not a Slate notebook (it has no notebook.json).' : `The notebook's table of contents cannot be read: ${e?.message ?? e}`);
  }
  if (toc?.format !== FOLDER_FORMAT) throw new Error('This folder is not a Slate notebook.');
  const content = {format: NOTEBOOK_FORMAT, version: CONTENT_VERSION,
    notebook: {id: toc.id, name: toc.name, color: toc.color ?? null, created: toc.created, path: root,
      // What the notebook record carries besides its identity: the Recycle Bin, whether history is off.
      ...(Array.isArray(toc.recycleBin) ? {recycleBin: toc.recycleBin} : {}), ...(toc.historyDisabled === true ? {historyDisabled: true} : {})},
    tree: [], groups: {}, sections: {}, pages: {}};
  const readItems = async (items, dir, out, depth) => {
    for (const item of Array.isArray(items) ? items : []) {
      const folder = join(dir, item.folder);
      if (item.kind === 'group' && depth < 8) {
        let g;
        try { g = await readJSON(fs, join(root, folder, GROUP_FILE)); } catch { warnings.push(`Section group ${item.folder} is missing.`); continue; }
        if (content.groups[g.id] || content.sections[g.id]) { warnings.push(`Section group ${item.folder} repeats an id.`); continue; }
        const record = {...g, items: []};
        content.groups[g.id] = record;
        out.push(g.id);
        await readItems(g.items, folder, record.items, depth + 1);
        continue;
      }
      if (item.kind !== 'section') continue;
      let s;
      try { s = await readJSON(fs, join(root, folder, SECTION_FILE)); } catch { warnings.push(`Section ${item.folder} is missing.`); continue; }
      if (content.sections[s.id] || content.groups[s.id]) { warnings.push(`Section ${item.folder} repeats an id.`); continue; }
      const entries = [];
      const files = new Set();
      try { for (const f of await fs.list(join(root, folder))) if (!f.dir && /\.json$/.test(f.name) && f.name !== SECTION_FILE && !isVersionsFile(f.name)) files.add(f.name); } catch { /* listed below */ }
      for (const e of Array.isArray(s.pages) ? s.pages : []) {
        const name = pageFile(e.id);
        if (content.pages[e.id]) { warnings.push(`Page ${e.id} appears twice; the second copy was skipped.`); continue; }
        let page;
        try { page = await readJSON(fs, join(root, folder, name)); } catch { warnings.push(`A page of ${s.name} is missing (${name}).`); continue; }
        files.delete(name);
        content.pages[e.id] = {...page, id: e.id};
        try {
          const list = await readJSON(fs, join(root, folder, versionsFile(e.id)));
          const ok = Array.isArray(list) ? list.filter(v => v && typeof v.id === 'string' && v.body && typeof v.body === 'object' && Array.isArray(v.ink)) : [];
          if (ok.length) (content.versions ??= {})[e.id] = ok.slice(-20);
        } catch { /* a page with no saved versions */ }
        entries.push({id: e.id, level: Math.min(2, Math.max(0, Number(e.level) || 0))});
      }
      for (const name of [...files].sort()) {
        try {
          const page = await readJSON(fs, join(root, folder, name));
          if (typeof page?.id !== 'string' || content.pages[page.id]) continue;
          content.pages[page.id] = {...newPageRecord({id: page.id, created: page.created ?? new Date().toISOString()}), ...page};
          entries.push({id: page.id, level: 0});
        } catch { warnings.push(`${name} in ${s.name} is not a page.`); }
      }
      content.sections[s.id] = {...s, pages: entries};
      out.push(s.id);
    }
  };
  await readItems(toc.items, '', content.tree, 0);
  validateContent(content);
  return {content, warnings};
}
