// Create Custom Stamp: the chosen picture, drawn at the size it will have in the palette. The file field holds the picked image as a data URL
// (the main process reads it); a typed path has nothing to draw until it is chosen with Browse.
// Layout from printcraft crates/ui-egui/src/tools/stamps_ui.rs (From <file>, Category, Name; no preview there): the preview is Acrobat's.

import type {DialogOverride} from '../../../shell/dialogs/DialogHost';
import './signature-pad.css';

function Preview({preview}: {values: Record<string, unknown>; preview: unknown}) {
  const src = (preview as {src?: string} | null)?.src;
  return <div className="fcs-preview" aria-label="Stamp preview">
    {src ? <img src={src} alt="The chosen stamp"/> : <span>Choose a picture to see the stamp.</span>}
  </div>;
}

const override: DialogOverride = {Preview};
export default override;
