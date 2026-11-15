// The field library (docs/architecture.md section 9.3) and the dispatcher that picks a component for
// a spec field kind. Dialog overrides may replace any field through their `fields` map.

import type {ComponentType} from 'react';
import type {SpecField} from '../../generated/spec-types';
import type {FieldProps} from './common';
import {NumberField, SliderField} from './NumberField';
import {SelectField, ComboField, FontField} from './SelectField';
import {Checkbox, RadioGroup, ListField} from './ChoiceFields';
import {TextField, FileField} from './TextField';
import {ColorField, ColorPickerField} from './ColorField';
import {ButtonField} from './ButtonField';
import {TabStopsField, BorderField, ShortcutField, GridField} from './special';
import {TreeField, SwatchField, ValueField, MeterField, ThumbnailsField} from './DataFields';

export {NumberField, SliderField, SelectField, ComboField, FontField, Checkbox, RadioGroup, ListField, TextField, FileField, ColorField, ColorPickerField,
  ButtonField, TabStopsField, BorderField, ShortcutField, GridField, TreeField, SwatchField, ValueField, MeterField, ThumbnailsField};
export {PreviewField} from './PreviewField';
export {LabelField, MessageField} from './ButtonField';
export type {FieldProps} from './common';

const isFontField = (f: SpecField) => /(^|[^a-z])font(name|face|family)?$/i.test(f.id) || /^(latin|asian|complex|east asian)?\s*(text )?font:?$/i.test(f.label.split('/')[0].trim());

/** The component for a field, or null for kinds the dialog body draws itself (preview, label, message). */
export function fieldComponent(f: SpecField, overrides?: Record<string, ComponentType<FieldProps>>): ComponentType<FieldProps> | null {
  const o = overrides?.[f.id] ?? overrides?.[f.kind];
  if (o) return o;
  switch (f.kind) {
    case 'number': return NumberField;
    case 'slider': return SliderField;
    case 'select': return isFontField(f) ? FontField : SelectField;
    case 'combo': return isFontField(f) ? FontField : ComboField;
    case 'checkbox': return Checkbox;
    case 'radio': return RadioGroup;
    case 'list': return ListField;
    case 'color': return ColorField;
    case 'colorPicker': return ColorPickerField;
    case 'button': return ButtonField;
    case 'grid': return GridField;
    case 'tabStops': return TabStopsField;
    case 'border': return BorderField;
    case 'shortcut': return ShortcutField;
    case 'tree': return TreeField;
    case 'swatches': return SwatchField;
    case 'path': case 'value': return ValueField;
    case 'meter': return MeterField;
    case 'thumbnails': return ThumbnailsField;
    case 'text': return f.input === 'file-picker' || f.input === 'folder-picker' || f.input === 'save-picker' ? FileField : TextField;
    case 'preview': case 'label': case 'message': return null;
    default: return TextField;
  }
}
