// Add Background: the marks preview (marks_ui.rs `preview` for Background) from header-footer.tsx.
// Translated from printcraft crates/ui-egui/src/dialogs/marks_ui.rs at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT).

import {MarksPreview} from './header-footer';

function Preview({values, preview}: {values: Record<string, unknown>; preview: unknown}) {
  return <MarksPreview preview={preview} values={values}/>;
}

export default {Preview};
