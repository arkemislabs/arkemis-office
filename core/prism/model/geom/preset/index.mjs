// Preset shape geometry (deckcraft crates/geom/src/preset.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf). Each preset is identified by its Office Open XML name
// so files round-trip; every outline is deckcraft's own construction. Adjust values use the file
// convention: ratios in 1/100 000 of the shorter side (or of the width/height), angles in 1/60 000
// degree. MIT, see assets/third-party-licenses/artcraft-reference.txt.

export {build} from './build.mjs';
export {CATALOG, CATEGORIES, categoryLabel, info, isLineLike, mitredByDefault} from './catalog.mjs';
export {FillMode, handleValueAt, outline, isOpen} from './builder.mjs';
