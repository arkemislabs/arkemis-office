// Export to Image (submit: export.image): Resolution, Format (PNG, JPEG with its Quality, TIFF) and Pages All / Current page / Range.
// Translated from printcraft crates/ui-egui/src/workflows/export_ui.rs:46 at 8f16855. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {pagesOf, rangeErrors, pageInit} from './export-all-images.mjs';

export default defineDialog({
  id: 'dialog.export-image',
  title: 'Export to Image',
  command: 'export.image',
  init: ctx => ({resolution: 150, format: 'PNG', quality: 85, ...pageInit(ctx)}),
  validate(v) {
    const q = Number(v.quality);
    if (v.format === 'JPEG' && !(Number.isInteger(q) && q >= 10 && q <= 100)) return [{field: 'quality', message: 'Type a quality from 10 to 100'}];
    return rangeErrors(v);
  },
  toCommand(v) {
    const pages = pagesOf(v);
    const format = String(v.format).toLowerCase();
    return {command: 'export.image', params: {dpi: Number(v.resolution), format, ...(format === 'jpeg' ? {quality: Number(v.quality)} : {}), ...(pages ? {pages} : {})}};
  },
});
