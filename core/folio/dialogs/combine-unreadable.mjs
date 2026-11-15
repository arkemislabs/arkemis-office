// "Leave out files that can't be read?" (submit: combine.go with skipUnreadable): shown when Combine is
// pressed with files in the list that can't be combined; "Combine the rest" goes on without them.
// Translated from printcraft crates/ui-egui/src/workflows/combine_ui/view.rs (confirm_skip) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.combine-unreadable',
  title: "Leave out files that can't be read?",
  command: 'combine.go',
  init(ctx) {
    const tab = ctx.view?.combine ?? {files: []};
    const bad = (tab.files ?? []).filter(f => f.problem).map(f => `${f.name} ${f.message}`);
    return {message: bad.length ? `${bad.length === 1 ? 'This file' : `These ${bad.length} files`} can't be read and will be left out.` : "Files that can't be read will be left out.", detail: bad.join('; ')};
  },
  validate: () => [],
  toCommand: () => ({command: 'combine.go', params: {skipUnreadable: true}}),
});
