// Grid in the new shell (docs/architecture.md sections 2, 16.2; F:grid).
// Ready (2026-10-30): Grid's gate passed (section 17.5): tests/e2e/grid/*.e2e.mjs (typing, fill,
// clipboard, Paste Special, formats, formulas, sheets, surface), tests/e2e/grid/gate (Save As .xlsx
// and CSV and reopen, Print, every address read back), tests/e2e/common/file-grid and the dialog
// sweep. Production opens Excel workbooks here.

import type {UiManifest} from '../../generated/spec-types';
import GridSurface from './surface/GridSurface';
import {evaluate} from '../../../core/grid/context.mjs';

const manifest: UiManifest = {
  ready: true,
  surface: GridSurface,
  contextProvider: evaluate,
};

export default manifest;
