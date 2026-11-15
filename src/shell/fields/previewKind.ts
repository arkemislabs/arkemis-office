// Which control a preview field is (PreviewField.tsx): the data's `type`, else its shape, else what the dialog's values describe.
// Pure: no DOM, no React.

import type {SpecField} from '../../generated/spec-types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (values: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (values[k] !== undefined && values[k] !== null && values[k] !== '') return values[k]; return null; };

export type PreviewKind = 'text' | 'meter' | 'list' | 'tree' | 'swatches' | 'colors' | 'path' | 'thumbs' | 'font' | 'page' | 'empty';

/** Which control a preview field is: the data's `type`, else its shape, else what the dialog's values describe. */
export function previewKind(field: SpecField, data: Record<string, unknown>, values: Record<string, unknown>): PreviewKind {
  const t = typeof data.type === 'string' ? data.type : null;
  if (t && ['text', 'meter', 'list', 'tree', 'swatches', 'colors', 'path', 'thumbs', 'font', 'page'].includes(t)) return t as PreviewKind;
  if (data.meter !== undefined || (num(data.score) !== null && typeof data.label === 'string')) return 'meter';
  if (Array.isArray(data.tree)) return 'tree';
  if (Array.isArray(data.items) || Array.isArray(data.lines)) return 'list';
  if (data.comb !== undefined || Array.isArray(data.swatches)) return 'swatches';
  if (typeof data.new === 'string' && typeof data.current === 'string') return 'colors';
  if (typeof data.path === 'string') return 'path';
  if (Array.isArray(data.pages) || Array.isArray(data.thumbs)) return 'thumbs';
  // Text the model wrote for this very field ({currentSection: '...'}) or a message ({message: '...'}) is a status line, whatever the label says.
  if (typeof data[field.id] === 'string' || typeof data.message === 'string') return 'text';
  const font = data.font !== undefined || pick(values, 'font', 'fontName', 'typeface', 'fontSize') !== null;
  const pageish = /page|paragraph|margin|layout|border|columns|setup|indent|spacing/i.test(`${field.id} ${field.label}`) && !font;
  if (pageish && typeof data.text !== 'string') return 'page';
  if (font && (typeof data.text === 'string' || data.font !== undefined || num(data.size) !== null || data.color !== undefined)) return 'font';
  if (typeof data.text === 'string') return 'text';
  if (typeof values[field.id] === 'string' || typeof values[field.id] === 'number') return 'path';
  if (pageish) return 'page';
  if (font) return 'font';
  return 'empty';
}
