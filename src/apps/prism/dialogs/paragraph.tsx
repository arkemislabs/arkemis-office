// Paragraph: the line spacing "At" box carries its unit: "pt" for Exactly (a point size, above 9.99 as the model's
// derive() reads it) and "lines" for Single / 1.5 / Double / Multiple (a multiple of the line).

import {NumberField, type FieldProps} from '../../../shell/fields';

function LineAt(props: FieldProps) {
  const exact = typeof props.value === 'number' && props.value > 9.99;
  const field = {...props.field, unit: exact ? 'pt' : 'lines', step: exact ? 1 : 0.1} as FieldProps['field'];
  return <NumberField {...props} field={field}/>;
}

export default {fields: {lineValue: LineAt}};
