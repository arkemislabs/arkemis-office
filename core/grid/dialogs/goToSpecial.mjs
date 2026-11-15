// Go To Special dialog model (submit: edit.goToSpecial).
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (Go To Special, `kind`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's Numbers / Text / Logicals / Errors under
// Constants and Formulas, Direct only / All levels, and Data validation All / Same.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {SPECIAL_KINDS} from '../commands/edit/go_to.mjs';

const TYPES = [['typeNumbers', 'numbers'], ['typeText', 'text'], ['typeLogicals', 'logicals'], ['typeErrors', 'errors']];

export default defineDialog({
  id: 'dialog.goToSpecial',
  title: 'Go To Special',
  command: 'edit.goToSpecial',
  init: () => ({kind: 'blanks', typeNumbers: true, typeText: true, typeLogicals: true, typeErrors: true, levels: 'direct', dvScope: 'all'}),
  validate(v) {
    const out = [];
    if (!SPECIAL_KINDS.includes(v.kind)) out.push({field: 'kind', message: 'Choose what to select'});
    if ((v.kind === 'constants' || v.kind === 'formulas') && TYPES.every(([k]) => v[k] === false)) out.push({field: 'typeNumbers', message: 'Choose at least one type'});
    return out;
  },
  toCommand(v) {
    const params = {kind: v.kind};
    if (v.kind === 'constants' || v.kind === 'formulas') {
      const types = TYPES.filter(([k]) => v[k] !== false).map(([, t]) => t);
      if (types.length < 4) params.types = types;
    }
    if (v.kind === 'precedents' || v.kind === 'dependents') params.levels = v.levels === 'all' ? 'all' : 'direct';
    if (v.kind === 'dataValidation') params.dvScope = v.dvScope === 'same' ? 'same' : 'all';
    return {command: 'edit.goToSpecial', params};
  },
});
