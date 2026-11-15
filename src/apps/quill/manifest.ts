// Quill in the new shell (docs/architecture.md sections 2, 16.1; F:quill).
// Ready (2026-10-30): Quill's gate passed (section 17.5): tests/e2e/quill/*.e2e.mjs (typing,
// AutoCorrect, selection, undo, formatting, tables, Insert, page view, .docx), tests/e2e/quill/gate
// (Save As every format and reopen, Export to PDF, Print, every address read back),
// tests/e2e/common/file-quill and the dialog sweep. Production opens Word documents here.

import type {UiManifest} from '../../generated/spec-types';
import QuillSurface from './surface/QuillSurface';
import {evaluate} from '../../../core/quill/context.mjs';

const manifest: UiManifest = {
  ready: true,
  surface: QuillSurface,
  contextProvider: evaluate,
};

export default manifest;
