// References › Captions › Insert Table of Figures (submit: references.tableOfFigures).
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/toc.rs (`FiguresForm` read/params,
// `figures_ui`) at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import * as T from '../lib/table-session.mjs';
import {labelsFor} from './caption.mjs';

export default defineDialog({
  id: 'dialog.tableOfFigures',
  title: 'Table of Figures',
  command: 'references.tableOfFigures',
  init: ctx => ({label: 'Figure', labels: labelsFor(ctx.prefs, T.open(ctx).d), includeLabel: true, pageNumbers: true, rightAlign: true, tabLeader: 'dot'}),
  validate: () => [],
  toCommand: v => ({command: 'references.tableOfFigures', params: {label: v.label, includeLabel: !!v.includeLabel, pageNumbers: !!v.pageNumbers,
    rightAlign: !!v.rightAlign, tabLeader: v.tabLeader ?? 'dot'}}),
});
