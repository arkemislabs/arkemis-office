// Quill schema-2 content → plain text (.txt): what Save As > Plain Text writes.
//
// Translated from wordcraft crates/formats/src/txt.rs `export` and crates/formats/src/comments.rs
// (`text`, Print Markup) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c: UTF-8 with CRLF
// line ends; list paragraphs get their label and a tab; table cells are separated by tabs; text in
// a symbol font is written as its Unicode equivalents. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {fromContent, ListCounter, shownText, commentNotes} from './_flow.mjs';

export const UPSTREAM = Object.freeze({repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c', files: ['crates/formats/src/txt.rs', 'crates/formats/src/comments.rs']});

function blocksText(blocks, out, lists, depth) {
  for (const b of blocks) {
    if (b.t === 'para') {
      let line = '';
      if (b.list) line += '\t'.repeat(b.list.level) + lists.label(b.list) + '\t';
      else lists.reset();
      line += shownText(b).replace(/\n/g, '\r\n').replace(/[\u000C\u000E]/g, '');
      out.push(line);
    } else {
      lists.reset();
      for (const row of b.rows) {
        out.push(row.map(c => {
          if (depth > 8) return '';
          const v = [];
          blocksText(c.blocks, v, new ListCounter(), depth + 1);
          return v.join(' ');
        }).join('\t'));
      }
    }
  }
}

/** The document as plain text (txt.rs `export`). */
export function exportText(content) {
  const lines = [];
  blocksText(fromContent(content).blocks, lines, new ListCounter(), 0);
  return lines.join('\r\n');
}

/** comments.rs `text`: the comments at the end of a plain-text copy (Print Markup). */
export function commentsText(notes) {
  let s = '\r\n\r\nComments\r\n';
  notes.forEach((n, i) => {
    s += `\r\n[${i + 1}] ${n.author}`;
    if (n.quote) s += ` on “${n.quote}”`;
    s += `: ${n.text}\r\n`;
    for (const [a, t] of n.replies) s += `    ${a}: ${t}\r\n`;
  });
  return s;
}

/** formats-v2 contract: the .txt bytes of `file` (opts.comments: Print Markup). */
export function write(file, opts = {}) {
  const content = file.content ?? file;
  let s = exportText(content);
  if (opts.comments) { const notes = commentNotes(content); if (notes.length) s += commentsText(notes); }
  return new TextEncoder().encode(s);
}
