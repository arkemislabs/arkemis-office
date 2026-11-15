// Match Fields view (Mailings › Write & Insert Fields): the recipient-list field that fills each part of
// an address block and greeting line, or "(not matched)", over core/quill/dialogs/matchFields.mjs.
// Layout from wordcraft crates/ui-egui/src/dialogs/dispatch.rs (`match_fields_dialog`) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {ADDRESS_PARTS} from '../../../../core/quill/dialogs/matchFields.mjs';
import './recipientList.css';

function Body({dialog: d}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const fields = (d.values.fields as string[]) ?? [];
  const address = (d.values.address as Record<string, string | null>) ?? {};
  if (!fields.length) return <div className="gd-fields" data-dialog-page="Match Fields"><p className="sf sf-static rl-weak">Select recipients first to match their fields.</p></div>;
  return <div className="gd-fields" data-dialog-page="Match Fields">
    <p className="sf sf-static">The recipient-list field that fills each part of an address block and greeting line.</p>
    <div className="rl-map" data-field-id="mapping">
      {(ADDRESS_PARTS as unknown as readonly (readonly [string, string])[]).flatMap(([label, key]) => [
        <span key={`${key}-l`}>{label}</span>,
        address[key] ? <strong key={`${key}-v`} data-part={key}>{address[key]}</strong> : <span key={`${key}-v`} className="rl-weak" data-part={key}>(not matched)</span>,
      ])}
    </div>
  </div>;
}

export default {Body};
