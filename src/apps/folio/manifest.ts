// PDF (product id "folio") in the new shell (docs/architecture.md sections 2, 16.4; F:folio).
// Ready (2026-10-31): the folio gate passed (section 17.5) on the merged suite-build: tests/e2e/folio/gate.e2e.mjs,
// every folio flow and the dialog sweep. Production opens PDFs in the new host.
// `chrome` is Acrobat's layout (mode bar, tool panel, quick bar, right rail) in place of the ribbon;
// Acrobat has no status bar (the page box and zoom live at the foot of the rail).

import type {UiManifest} from '../../generated/spec-types';
import FolioSurface from './surface/FolioSurface';
import AcrobatChrome from './chrome/AcrobatChrome';
import {evaluate} from '../../../core/folio/context.mjs';

const manifest: UiManifest = {
  ready: true,
  surface: FolioSurface,
  chrome: AcrobatChrome,
  statusBar: false,
  contextProvider: evaluate,
};

export default manifest;
