// Compress a PDF > Audit space usage: how the file's bytes are spent now, by kind of content (Description, Bytes, Percentage, Total).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/ui-egui/src/workflows/optimize_ui.rs `audit_body`
// and `audit_table` (the explanation, the table of the kinds that use bytes, "Patterns (graphics objects)", the Total row) and crates/optimize/src/audit.rs (lib/space-audit.mjs).
// The file measured is the document as Save would write it now.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/space-audit.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {documentOpen} from '../lib/edit-needs.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {auditSpace} from '../lib/space-audit.mjs';
import {PDFDocument} from 'pdf-lib';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/workflows/optimize_ui.rs', 'crates/optimize/src/audit.rs']};

export default defineCommands({
  family: 'optimize_audit',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'optimize.audit', label: 'Audit space usage…', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Audit Space Usage: how the document\'s bytes are spent now, by kind of content (images, content streams, fonts, forms, structure, bookmarks, thumbnails, comments, form fields, named destinations, colour spaces, shadings, patterns, graphics states, embedded files, document overhead): `rows` with the bytes and share of each, `total` and the file\'s size. Each object counts once, for the first kind that reaches it. Sizes are close to, not byte for byte, upstream\'s.',
      params: s.object({}),
      state: documentOpen,
      async run(ctx) {
        const bytes = await writeFolioPdf(ctx.doc);
        const doc = await PDFDocument.load(bytes, {updateMetadata: false, ignoreEncryption: true});
        const rows = auditSpace(doc, bytes.length);
        const used = rows.filter(r => r.bytes > 0);
        return {rows: used.map(r => ({category: r.category === 'Patterns' ? 'Patterns (graphics objects)' : r.category, bytes: r.bytes, percent: Math.round(r.percent * 100) / 100})),
          total: rows.reduce((a, r) => a + r.bytes, 0), fileSize: bytes.length};
      },
    },
  ],
});
