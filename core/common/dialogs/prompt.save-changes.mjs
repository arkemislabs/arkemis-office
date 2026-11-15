// PDF's close prompt (prompt.save-changes, opened by file.close). Upstream: printcraft
// crates/ui-egui/src/dialogs/prompts.rs (save-changes); Acrobat asks "Do you want to save changes
// to … before closing?" with Yes / No / Cancel. The flow is core/common/commands/file.mjs.
import {defineDialog} from '../../kernel/dialog.mjs';
import {saveChangesModel} from '../commands/file.mjs';

export default defineDialog(saveChangesModel('prompt.save-changes', 'Save changes before closing?'));
