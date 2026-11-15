'use strict';
// Files written into a folder the person chose in the system folder dialog (a set of exported images, separate PDFs).
// The renderer never gives a path: it names a folder returned by studio:folder-pick and a plain file name. Main writes only
// inside a folder picked this session, only under a plain name (no separator, no "..", not absolute, no reserved characters), never
// replaces an existing file (a taken name gets " (2)", " (3)"...), and checks the final path is directly inside the folder.
const fs = require('node:fs/promises');
const path = require('node:path');

const plainFileName = n => typeof n === 'string' && n.length > 0 && n.length <= 200 && n === path.basename(n) && !path.isAbsolute(n)
  && n !== '.' && n !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/.test(n) && !/[. ]$/.test(n)
  // Windows device names (CON, NUL, COM1, LPT1...) name a device, not a file, with or without an extension.
  && !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(n);

const fail = (message, code) => Object.assign(new Error(message), {code});

/** @param {Set<string>} chosenFolders folders picked in the folder dialog this session (absolute, resolved) */
function createFolderWriter(chosenFolders) {
  return {
    /** The folders picked this session (for reading the PDFs in one). */
    chosen: chosenFolders,
    /** Remember a folder the dialog returned. */
    allow(folder) { const resolved = path.resolve(String(folder)); chosenFolders.add(resolved); return resolved; },
    async write(folder, name, bytes) {
      const dir = path.resolve(String(folder ?? ''));
      if (!chosenFolders.has(dir)) throw fail('Only a folder chosen in the folder dialog can be written to', 'forbidden');
      if (!plainFileName(name)) throw fail('The file name must be a plain name: no folders, no "..", not a full path', 'invalid_params');
      if (!Buffer.isBuffer(bytes)) throw fail('The data must be bytes', 'invalid_params');
      if (bytes.length > 100_000_000) throw fail('The data is too large', 'too_large');
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      for (let n = 1; n < 10000; n++) {
        const final = n === 1 ? name : `${base} (${n})${ext}`;
        const target = path.join(dir, final);
        if (path.dirname(target) !== dir) throw fail('The file name leaves the folder', 'invalid_params');
        try { await fs.writeFile(target, bytes, {flag: 'wx'}); return {name: final, path: target}; } catch (e) { if (e?.code !== 'EEXIST') throw e; }
      }
      throw fail('No unused file name', 'failed');
    },
  };
}

// The PDFs in a folder chosen this session (Combine files > Add folder), and with `recursive` the folders inside it (not following links, not hidden ones, at most
// MAX_DEPTH deep): their names relative to the folder in natural order, with size and modification time, at most MAX_FILES, no file over MAX_FILE bytes, and no more
// than MAX_TOTAL bytes together. `more` says some were left out. Only a folder the folder dialog returned can be read.
const MAX_FILES = 1000, MAX_DEPTH = 16, MAX_FILE = 30_000_000, MAX_TOTAL = 400_000_000;
const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

async function listPdfs(chosenFolders, folder, recursive) {
  const dir = path.resolve(String(folder ?? ''));
  if (!chosenFolders.has(dir)) throw fail('Only a folder chosen in the folder dialog can be read', 'forbidden');
  const found = [];
  let more = false, total = 0;
  const walk = [[dir, 0, '']];
  walkLoop: while (walk.length) {
    const [folderPath, depth, prefix] = walk.pop();
    let entries;
    try { entries = await fs.readdir(folderPath, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (recursive && !entry.name.startsWith('.') && depth < MAX_DEPTH) walk.push([path.join(folderPath, entry.name), depth + 1, rel]); continue; }
      if (!entry.isFile() || !/\.pdf$/i.test(entry.name)) continue;
      let st;
      try { st = await fs.stat(path.join(folderPath, entry.name)); } catch { continue; }
      if (st.size > MAX_FILE) { more = true; continue; }
      if (found.length >= MAX_FILES || total + st.size > MAX_TOTAL) { more = true; break walkLoop; }
      total += st.size;
      found.push({rel, abs: path.join(folderPath, entry.name), size: st.size, modified: st.mtimeMs});
    }
  }
  found.sort((a, b) => collator.compare(a.rel, b.rel));
  const files = [];
  for (const f of found) {
    try { files.push({name: f.rel, size: f.size, modified: f.modified, base64: (await fs.readFile(f.abs)).toString('base64')}); } catch { more = true; }
  }
  return {name: path.basename(dir), files, more};
}

module.exports = {plainFileName, createFolderWriter, listPdfs};
