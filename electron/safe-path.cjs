'use strict';
// Paths the file service will touch (security audit M2). A path is data from a window or the bridge, so before it reaches fs it
// must be a plain local file path: no UNC share (opening one makes Windows send the person's credentials to that host), no
// device path (\\.\ and \\?\), no NTFS alternate data stream, no reserved device name (CON, NUL, COM1...), no control characters.

const path = require('node:path');

const fail = (message, data) => Object.assign(new Error(message), {code: 'invalid_params', ...(data !== undefined ? {data} : {})});
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/** The reason `p` is not a plain local path, or null when it is. */
function whyUnsafe(p) {
  if (typeof p !== 'string' || !p) return 'a path is required';
  if (p.length > 4096) return 'the path is too long';
  if (/[\u0000-\u001f]/.test(p)) return 'the path has control characters';
  // Two leading separators of either kind: a UNC share, or a \\?\ / \\.\ device path.
  if (/^[\\/]{2}/.test(p)) return 'network and device paths cannot be used';
  if (process.platform === 'win32') {
    const rest = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
    if (rest.includes(':')) return 'the path has a stream name or a stray colon';
    for (const part of p.split(/[\\/]+/)) {
      if (RESERVED.test(part.replace(/^[A-Za-z]:/, ''))) return `${part} is a device name`;
    }
  }
  return null;
}

/** Throws invalid_params unless `p` is a plain, absolute, local file path. */
function assertLocalFilePath(p) {
  const why = whyUnsafe(p);
  if (why) throw fail(`That path cannot be used: ${why}`, {path: '/path'});
  if (!path.isAbsolute(p)) throw fail('path must be an absolute file path', {path: '/path'});
  return p;
}

module.exports = {assertLocalFilePath, whyUnsafe};
