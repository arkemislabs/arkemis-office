// Save Changes? (Quill and Grid name it dialog.saveChanges): "Do you want to save changes to …?"
// with Save / Don't Save / Cancel. Upstream: wordcraft crates/ui-egui/src/dialogs/dispatch.rs
// (saveChanges) and gridcraft crates/ui-egui/src/dialogs/show.rs (saveChanges); the flow behind
// the buttons is core/common/commands/file.mjs (file.close {save} / {force}).
import {defineDialog} from '../../kernel/dialog.mjs';
import {saveChangesModel} from '../commands/file.mjs';

export default defineDialog(saveChangesModel('dialog.saveChanges', 'Save Changes?'));
