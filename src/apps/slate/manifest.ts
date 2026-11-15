// Slate in the new shell (docs/architecture.md section 2, 16.5; F:slate).
// Ready (2026-10-31): Slate's gate passed (section 17.5): tests/e2e/slate/*.e2e.mjs (typing, insert, tables,
// draw, history, review with password-protected sections, equation, Home, View), tests/e2e/slate/gate (a notebook
// folder written and read back, close and reopen, Print, every address read back) and the dialog sweep.
// Production opens OneNote notebooks here.

import type {UiManifest} from '../../generated/spec-types';
import SlateSurface from './surface/SlateSurface';
import {evaluate} from '../../../core/slate/context.mjs';

const manifest: UiManifest = {
  ready: true,
  surface: SlateSurface,
  contextProvider: evaluate,
};

export default manifest;
