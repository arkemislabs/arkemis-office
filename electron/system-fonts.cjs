'use strict';
// The operating system's font files for the window. A PDF written in the window (added text, comments, a redaction's overlay text) embeds a system font for the scripts the
// standard faces lack (core/common/lib/pdf-fonts.mjs), and the window has no file system of its own. The renderer names a path from the helper's list; main reads it only when
// it is a font file (.ttf, .ttc, .otf, .otc) directly or deeper inside one of the operating system's font folders, and never more than 60 MB. Anything else is refused.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 60 * 1024 * 1024;
const EXTENSIONS = new Set(['.ttf', '.ttc', '.otf', '.otc']);

/** The operating system's font folders, resolved and with a trailing separator. */
function fontFolders(platform = process.platform, env = process.env) {
  const dirs = platform === 'win32' ? [path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts'), 'C:\\Windows\\Fonts', 'C:\\WINNT\\Fonts']
    : platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts']
      : ['/usr/share/fonts', '/usr/local/share/fonts'];
  return dirs.map(d => path.resolve(d) + path.sep);
}

/** Whether `file` is a font file inside one of the folders. */
function isSystemFont(file, folders = fontFolders(), platform = process.platform) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.length > 500) return false;
  const resolved = path.resolve(file);
  if (!EXTENSIONS.has(path.extname(resolved).toLowerCase())) return false;
  const norm = platform === 'win32' ? resolved.toLowerCase() : resolved;
  return folders.some(f => norm.startsWith(platform === 'win32' ? f.toLowerCase() : f));
}

/** The bytes of a system font, or null when there is no such font file here. */
async function readSystemFont(file, folders = fontFolders()) {
  if (!isSystemFont(file, folders)) {
    const error = new Error('Only a font file in the operating system\'s font folder can be read here');
    error.code = 'forbidden';
    throw error;
  }
  try {
    // Where the path really leads: a link inside the font folder that points elsewhere is refused like a path outside it.
    const resolved = await fs.realpath(path.resolve(file));
    // The real file must sit in a font folder's real place (a folder reached through a link, such as macOS's
    // /var -> /private/var, is compared by where it really is).
    const realFolders = await Promise.all(folders.map(f => fs.realpath(f).then(r => r.endsWith(path.sep) ? r : r + path.sep).catch(() => f)));
    if (!isSystemFont(resolved, realFolders)) return null;
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return await fs.readFile(resolved);
  } catch { return null; }
}

module.exports = {fontFolders, isSystemFont, readSystemFont, MAX_BYTES};
