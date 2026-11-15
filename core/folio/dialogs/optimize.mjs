// PDF Optimizer (submit: optimize.advanced): the structural settings of printcraft's optimizer.
// Translated from printcraft crates/optimize/src/lib.rs `Settings` and crates/ui-egui/src/workflows/optimize_ui.rs at 8f16855; the picture settings are
// not translated. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {DEFAULTS} from '../lib/optimize.mjs';

export default defineDialog({
  id: 'dialog.optimize',
  title: 'PDF Optimizer',
  command: 'optimize.advanced',
  init: () => ({...DEFAULTS}),
  validate: () => [],
  toCommand: v => ({command: 'optimize.advanced', params: Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, v[k] === true]))}),
});
