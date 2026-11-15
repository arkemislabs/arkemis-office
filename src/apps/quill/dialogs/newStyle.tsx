// Create New Style from Formatting view (Home › Styles › Create a Style): Word's Properties (Name,
// Style type, Style based on, Style for following paragraph) and Formatting (font, size, B/I/U,
// colour, alignment, line spacing, spacing) sections, the preview and Add to the Styles gallery,
// over core/quill/dialogs/newStyle.mjs. Layout from wordcraft dispatch.rs `new_style_dialog` and
// Word at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, usePreview, useStyleOptions, TextPreview, type BodyProps} from './font';
import type {DialogState} from '../../../shell/dialogs/dialogState';

/** The Properties and Formatting sections both style dialogs share. */
export function StyleForm({d, set}: {d: DialogState; set: BodyProps['setValue']}) {
  const p = usePreview(d);
  const kind = String(d.values.styleType ?? 'paragraph');
  const based = useStyleOptions(kind === 'character' ? ['character'] : ['paragraph'], '(no style)');
  const next = useStyleOptions(['paragraph']);
  const desc = p && typeof p.description === 'string' ? p.description : null;
  return <div className="gd-fields">
    <Group title="Properties">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="name" set={set}/>
        <Field d={d} id="styleType" set={set}/>
        <Field d={d} id="basedOn" set={set} options={based}/>
        <Field d={d} id="next" set={set} options={next}/>
      </div>
    </Group>
    <Group title="Formatting">
      <div style={grid('minmax(0, 2fr) minmax(0, .8fr) minmax(0, 1.2fr)')}>
        <Field d={d} id="font" set={set} override="combo"/>
        <Field d={d} id="size" set={set}/>
        <Field d={d} id="color" set={set}/>
      </div>
      <div style={grid('repeat(3, max-content)', {gap: '6px 18px', marginTop: 10})}>
        <Field d={d} id="bold" set={set}/><Field d={d} id="italic" set={set}/><Field d={d} id="underline" set={set}/>
      </div>
      <div style={{marginTop: 10}}><Field d={d} id="alignment" set={set}/></div>
      <div style={grid('minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 10})}>
        <Field d={d} id="lineRule" set={set}/><Field d={d} id="before" set={set}/><Field d={d} id="after" set={set}/>
      </div>
    </Group>
    <TextPreview p={p}/>
    {desc ? <p className="sf-note" style={{whiteSpace: 'pre-wrap', margin: '8px 0 0', color: '#b9bac1', fontSize: 11.5}} data-field-id="description">{desc}</p> : null}
    <div style={{marginTop: 10}}><Field d={d} id="addToGallery" set={set}/></div>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  return <StyleForm d={d} set={set}/>;
}

export default {Body};
