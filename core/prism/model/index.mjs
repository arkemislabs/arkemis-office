// Prism foundation model API (ctx.model for command families): the translated deckcraft model,
// colour and geometry crates, plus the schema-2 helpers commands use to read and write a
// presentation through the kernel's change API.
// Upstream: deckcraft crates/model, crates/color, crates/geom at f893f6af7d36a5409fd804e81a34fd895cfefedf.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

export * as color from './color.mjs';
export * as geom from './geom/index.mjs';
export * as style from './style.mjs';
export * as text from './text.mjs';
export * as theme from './theme.mjs';
export * as defaults from './defaults.mjs';
export * as resolve from './resolve.mjs';
export * as edit from './edit.mjs';
export * as words from './words.mjs';
export * as bidi from './bidi.mjs';
export * as table from './table.mjs';
export * as pres from './presentation.mjs';
export * from './doc.mjs';
