// Create New Theme Fonts: the Heading and Body fields pick from the installed fonts, each name drawn
// in its own face (deckcraft crates/ui-egui/src/dialogs/theme_fonts.rs, a font list per face).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {FontField, type FieldProps} from '../../../shell/fields';

function Installed(props: FieldProps) {
  return <FontField {...props}/>;
}

export default {fields: {major: Installed, minor: Installed}};
