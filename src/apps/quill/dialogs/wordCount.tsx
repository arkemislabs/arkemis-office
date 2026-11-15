// Word Count view (Review › Proofing › Word Count, the status bar's word count): Word's Statistics
// table — each count's name on the left and its number on the right — and the Include textboxes,
// footnotes and endnotes check box, over core/quill/dialogs/wordCount.mjs. Layout from wordcraft
// crates/ui-egui/src/dialogs/dispatch.rs:760 (`word_count` grid) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, type BodyProps} from './font';

const ROWS: [string, string][] = [['pages', 'Pages'], ['words', 'Words'], ['characters', 'Characters (no spaces)'],
  ['charactersWithSpaces', 'Characters (with spaces)'], ['paragraphs', 'Paragraphs'], ['lines', 'Lines']];

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as Record<string, unknown>;
  return <div className="gd-fields" data-dialog-page="Statistics">
    <Group title="Statistics:">
      <table role="table" aria-label="Statistics" style={{width: '100%', borderCollapse: 'collapse', fontSize: 13}}>
        <tbody>
          {ROWS.map(([id, label]) => <tr key={id} data-field-id={id}>
            <td style={{padding: '4px 0'}}>{label}</td>
            <td style={{padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums'}}>{String(v[id] ?? '')}</td>
          </tr>)}
        </tbody>
      </table>
    </Group>
    <Field d={d} id="includeTextBoxes" set={set}/>
  </div>;
}

export default {Body};
