// Developer › Controls › Properties: Word's Content Control Properties dialog for the control at the selection.
// General: Title, Tag, Show as (Bounding Box, Start/End Tag, None), Color, Use a style to format text typed into the empty
// control (Style, New Style…), Remove content control when contents are edited; Locking: Content control cannot be deleted,
// Contents cannot be edited; and by type: Drop-Down List / Combo Box Properties (a list with Display Name and Value
// columns, Add…, Modify…, Remove, Move Up, Move Down; Add and Modify open Add Choice / Modify Choice), Date Picker Properties
// (the display format, Locale, Calendar type, Store XML contents as), Check Box Properties (the Checked and Unchecked symbols,
// each with Change…), Plain Text Properties (Allow carriage returns). OK runs developer.properties.
//
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_controls.rs (`control_properties`: Title, Tag, Placeholder text,
// the locks, Remove the control once edited, the entries, the date format, the symbols, Allow line breaks) at
// aadb077e072b7de05f724e359d8db82e151f125c, checked against wordcraft 0.13.1 (f2dfa0d); laid out as Word's dialog is, with
// Word's own Show as, Color, Use a style, Locale, Calendar type and Store XML contents as (not in upstream; the control keeps them as
// w15:appearance, w15:color, the run style of w:sdtPr, w:lid, w:calendar and w:storeMappedDataAs). Drawn by
// src/apps/quill/dialogs/controlProperties.tsx. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {Document} from '../model/document.mjs';
import {isQuill2} from '../model/content.mjs';
import {MAX_LIST_ITEMS, MAX_CONTROL_TEXT} from '../model/ranges.mjs';
import {info} from '../commands/developer.mjs';

/** Show as: the words the box shows and what the control keeps. */
export const APPEARANCES = Object.freeze([['Bounding Box', 'boundingBox'], ['Start/End Tag', 'tags'], ['None', 'hidden']]);
export const appearanceLabel = v => APPEARANCES.find(([, k]) => k === v)?.[0] ?? 'Bounding Box';
export const appearanceOf = label => APPEARANCES.find(([l]) => l === label)?.[1] ?? 'boundingBox';
/** Calendar types (w:calendar) and Store XML contents as (w:storeMappedDataAs). */
export const CALENDARS = Object.freeze([['Gregorian', 'gregorian'], ['Gregorian (Arabic)', 'gregorianArabic'], ['Gregorian (Middle East French)', 'gregorianMeFrench'], ['Hijri', 'hijri'],
  ['Hebrew', 'hebrew'], ['Japanese Emperor Era', 'japan'], ['Taiwan Calendar', 'taiwan'], ['Thai Buddhist', 'thai'], ['Korean Tangun Era', 'korea'], ['Saka Era', 'saka']]);
export const STORE_AS = Object.freeze([['Date and Time', 'dateTime'], ['Date', 'date'], ['Text', 'text']]);
export const LOCALES = Object.freeze([['English (United States)', 'en-US'], ['English (United Kingdom)', 'en-GB'], ['English (Australia)', 'en-AU'], ['English (Canada)', 'en-CA'],
  ['German (Germany)', 'de-DE'], ['French (France)', 'fr-FR'], ['Spanish (Spain)', 'es-ES'], ['Italian (Italy)', 'it-IT'], ['Portuguese (Brazil)', 'pt-BR'], ['Dutch (Netherlands)', 'nl-NL'],
  ['Swedish (Sweden)', 'sv-SE'], ['Norwegian Bokmål (Norway)', 'nb-NO'], ['Danish (Denmark)', 'da-DK'], ['Finnish (Finland)', 'fi-FI'], ['Polish (Poland)', 'pl-PL'], ['Russian (Russia)', 'ru-RU'],
  ['Japanese (Japan)', 'ja-JP'], ['Korean (Korea)', 'ko-KR'], ['Chinese (Simplified, China)', 'zh-CN'], ['Chinese (Traditional, Taiwan)', 'zh-TW'], ['Arabic (Saudi Arabia)', 'ar-SA'], ['Hebrew (Israel)', 'he-IL']]);
const labelOf = (list, v, fallback) => list.find(([, k]) => k === v)?.[0] ?? fallback;
const valueOf = (list, label, fallback) => list.find(([l]) => l === label)?.[1] ?? fallback;

/** The characters the symbol boxes show as one code point. */
const cp = ch => (ch ? ch.codePointAt(0) : 0);

// Opened with no control under the caret the boxes still show Word's defaults, never an empty Show as.
const NO_CONTROL = {kind: 'richText', title: '', tag: '', appearance: appearanceLabel('boundingBox'), color: 'auto', useStyle: false, style: ''};

export default defineDialog({
  id: 'dialog.controlProperties',
  title: 'Content Control Properties',
  command: 'developer.properties',
  init(ctx) {
    if (!isQuill2(ctx?.doc)) return {...NO_CONTROL};
    const d = new Document(ctx.doc);
    const all = ctx.model.selection(ctx);
    const r = d.controlAt(d.clamp((all[ctx.selection?.primary ?? 0] ?? all[0]).focus));
    const c = info({d}, r);
    if (!c) return {...NO_CONTROL};
    const entries = (c.items ?? []).map(i => ({display: i.display, value: i.value}));
    return {
      kind: c.type, title: c.title, tag: c.tag, appearance: appearanceLabel(c.appearance), color: c.color || 'auto', useStyle: !!c.style, style: c.style || '',
      temporary: c.temporary, lockDelete: c.lockDelete, lockEdit: c.lockEdit,
      multiLine: !!c.multiLine, dateFormat: c.format ?? '', locale: labelOf(LOCALES, c.locale, c.locale || 'English (United States)'), calendar: labelOf(CALENDARS, c.calendar, 'Gregorian'),
      storeAs: labelOf(STORE_AS, c.storeAs, 'Date and Time'),
      checkedSymbol: c.checkedSymbol ?? '', checkedFont: c.checkedFont ?? '', uncheckedSymbol: c.uncheckedSymbol ?? '', uncheckedFont: c.uncheckedFont ?? '',
      entries, entry: entries.length ? 0 : -1,
      // `at`: a position inside the control, so OK acts on the control the dialog opened on.
      _at: {...c.start, off: c.start.off + 1}, _locks: [c.lockDelete, c.lockEdit], _styled: c.style || '',
    };
  },
  validate(v) {
    const errors = [];
    if (String(v.title ?? '').length > 255) errors.push({field: 'title', message: 'The title is too long.'});
    if (String(v.tag ?? '').length > 255) errors.push({field: 'tag', message: 'The tag is too long.'});
    if (v.useStyle && !String(v.style ?? '')) errors.push({field: 'style', message: 'Choose a style.'});
    if (v.kind === 'checkBox') {
      for (const f of ['checkedSymbol', 'uncheckedSymbol']) if ([...String(v[f] ?? '')].length !== 1) errors.push({field: f, message: 'Choose a symbol.'});
    }
    if (v.kind === 'comboBox' || v.kind === 'dropDown') {
      const items = v.entries ?? [];
      if (items.length > MAX_LIST_ITEMS) errors.push({field: 'entries', message: `A list keeps at most ${MAX_LIST_ITEMS} entries.`});
      if (items.some(i => String(i.display).length > MAX_CONTROL_TEXT || String(i.value).length > MAX_CONTROL_TEXT)) errors.push({field: 'entries', message: 'An entry is too long.'});
    }
    return errors;
  },
  toCommand(v) {
    const params = {at: v._at, title: String(v.title ?? ''), tag: String(v.tag ?? ''), temporary: !!v.temporary, appearance: appearanceOf(v.appearance),
      color: v.color && v.color !== 'auto' ? String(v.color) : '', style: v.useStyle ? String(v.style ?? '') : ''};
    // The locks go only when the person changed them (a protected document refuses changing them).
    if (!v._locks || !!v.lockDelete !== v._locks[0] || !!v.lockEdit !== v._locks[1]) Object.assign(params, {lockDelete: !!v.lockDelete, lockEdit: !!v.lockEdit});
    if (v.kind === 'plainText') params.multiLine = !!v.multiLine;
    if (v.kind === 'date') Object.assign(params, {format: String(v.dateFormat ?? ''), locale: valueOf(LOCALES, v.locale, String(v.locale ?? '')), calendar: valueOf(CALENDARS, v.calendar, 'gregorian'),
      storeAs: valueOf(STORE_AS, v.storeAs, 'dateTime')});
    if (v.kind === 'checkBox') Object.assign(params, {checkedSymbol: String(v.checkedSymbol), uncheckedSymbol: String(v.uncheckedSymbol), checkedFont: String(v.checkedFont ?? ''), uncheckedFont: String(v.uncheckedFont ?? '')});
    if (v.kind === 'comboBox' || v.kind === 'dropDown') params.items = (v.entries ?? []).map(i => ({display: String(i.display), value: String(i.value)}));
    return {command: 'developer.properties', params};
  },
});

export {cp};
