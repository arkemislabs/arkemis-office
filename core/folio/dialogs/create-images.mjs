// Create PDF from images (host.openDialog from create.images): the resolution the pages are made at.
// Translated from printcraft crates/ui-egui/src/workflows/create_ui.rs `image_import_body` (Use image resolution, Use 72 DPI, Use custom DPI)
// at 8f16855. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.create-images',
  title: 'Create PDF from images',
  command: 'create.images',
  init: () => ({count: '', mode: 'image', dpi: 300}),
  validate: v => (v.mode !== 'custom' || (Number(v.dpi) >= 1 && Number(v.dpi) <= 1200) ? [] : [{field: 'dpi', message: 'Type a resolution from 1 to 1200 dpi'}]),
  toCommand: v => ({command: 'create.images', params: {mode: v.mode, ...(v.mode === 'custom' ? {dpi: Number(v.dpi)} : {})}}),
});
