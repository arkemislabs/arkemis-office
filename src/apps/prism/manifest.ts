// Prism in the new shell (docs/architecture.md sections 2, 16.3; F:prism).
// Ready (2026-10-30): Prism's gate passed (section 17.5): tests/e2e/prism/*.e2e.mjs (slides, text,
// shapes, formatting, Find, Selection Pane, Normal view, .pptx), tests/e2e/prism/gate (type, Save As
// .pptx and reopen, Print, every address read back), tests/e2e/common/file-prism and the dialog
// sweep. Production opens PowerPoint presentations here.

import type {UiManifest} from '../../generated/spec-types';
import PrismSurface from './surface/PrismSurface';
import {evaluate} from '../../../core/prism/context.mjs';

const manifest: UiManifest = {
  ready: true,
  surface: PrismSurface,
  contextProvider: evaluate,
};

export default manifest;
