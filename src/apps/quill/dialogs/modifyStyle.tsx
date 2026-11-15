// Modify Style view (Styles gallery › right-click › Modify…, Manage Styles › Modify…): the same
// Properties and Formatting sections as Create New Style, with the style's description under the
// preview, over core/quill/dialogs/modifyStyle.mjs. Layout from wordcraft dispatch.rs
// `modify_style_dialog` and Word at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {StyleForm} from './newStyle';
import type {BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  return <StyleForm d={d} set={set}/>;
}

export default {Body};
