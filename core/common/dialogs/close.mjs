// Prism's close prompt (dialog.close). Upstream: deckcraft crates/ui-egui/src/dialogs/body.rs
// (close: "Do you want to save the changes you made to …? Your changes will be lost if you don't
// save them."). The flow behind the buttons is core/common/commands/file.mjs.
import {defineDialog} from '../../kernel/dialog.mjs';
import {saveChangesModel} from '../commands/file.mjs';

export default defineDialog(saveChangesModel('dialog.close', 'Save Changes?'));
