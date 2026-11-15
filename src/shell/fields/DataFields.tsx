// Fields that draw records a model keeps beside the fields (the dialog's values, named by the field's
// `itemsFrom`): TreeField (notebook > group > section), SwatchField (a drawn palette), and the read-only
// kinds (`path`, `value`, `meter`, `thumbnails`) a spec gives a preview that is really a field.

import {FieldShell, fieldLabel, fieldData, type FieldProps} from './common';
import {TreeBox, SwatchPalette, StrengthMeter, ThumbStrip, ValueBox, toTree} from './controls';

/** The tree's records, narrowed by the text of the field named in `filterBy` (matches keep their parents). */
export function filterTreeItems<T extends {label: string; depth: number}>(items: T[], search: unknown): T[] {
  const q = String(search ?? '').trim().toLowerCase();
  if (!q) return items;
  const keep = new Set<number>();
  items.forEach((item, i) => {
    if (!item.label.toLowerCase().includes(q)) return;
    keep.add(i);
    for (let j = i - 1, d = item.depth; j >= 0 && d > 0; j--) if (items[j].depth < d) { keep.add(j); d = items[j].depth; }
  });
  return items.filter((_, i) => keep.has(i));
}

export function TreeField({field, value, onChange, error, disabled, values}: FieldProps) {
  const all = toTree(fieldData(field, values));
  const filter = typeof field.filterBy === 'string' && values ? values[field.filterBy] : null;
  const items = filterTreeItems(all, filter);
  return <FieldShell field={field} error={error}>{() => <TreeBox items={items} selected={typeof value === 'string' ? value : null} onSelect={onChange} disabled={disabled}
    label={fieldLabel(field)} empty={all.length ? 'Nothing matches' : undefined} height={typeof field.height === 'number' ? field.height : undefined}/>}</FieldShell>;
}

export function SwatchField({field, value, onChange, error, disabled, values}: FieldProps) {
  const data = fieldData(field, values) as {rows?: string[][]; greys?: string[]} | null;
  return <FieldShell field={field} error={error}>{() => <SwatchPalette rows={data?.rows ?? []} greys={data?.greys} selected={typeof value === 'string' ? value : null}
    onSelect={onChange} disabled={disabled} label={fieldLabel(field)}/>}</FieldShell>;
}

/** A read-only value: the field's own value (a notebook's path, its default format). */
export function ValueField({field, value, error, values}: FieldProps) {
  const own = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const v = own || (typeof field.itemsFrom === 'string' && values ? String(values[field.itemsFrom] ?? '') : '');
  return <FieldShell field={field} error={error}>{() => <ValueBox value={v} label={fieldLabel(field)} empty={typeof field.empty === 'string' ? field.empty : undefined}/>}</FieldShell>;
}

export function MeterField({field, value, values}: FieldProps) {
  const data = (fieldData(field, values) ?? value) as {score?: number; label?: string} | number | null;
  const score = typeof data === 'number' ? data : typeof data?.score === 'number' ? data.score : 0;
  const label = typeof data === 'object' && data && typeof data.label === 'string' ? data.label : '';
  return <FieldShell field={field}>{() => <StrengthMeter score={score} label={label}/>}</FieldShell>;
}

export function ThumbnailsField({field, values}: FieldProps) {
  const raw = fieldData(field, values);
  const pages = (Array.isArray(raw) ? raw : []).map(p => (p && typeof p === 'object' ? p as {label: string; selected?: boolean} : {label: String(p)}));
  return <FieldShell field={field}>{() => <ThumbStrip pages={pages}/>}</FieldShell>;
}
