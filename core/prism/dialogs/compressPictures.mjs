// Compress Pictures dialog model (Picture Format › Adjust › Compress Pictures): Apply only to this
// picture, Delete cropped areas of pictures and the resolution (HD 330, Print 220, Web 150, E-mail 96 ppi).
// Compress runs picture.compress. Translated from deckcraft crates/ui-egui/src/ribbon/picture_format.rs
// (`compress_menu`) at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.compressPictures',
  title: 'Compress Pictures',
  command: 'picture.compress',
  init: () => ({onlySelected: true, deleteCropped: true, ppi: '220'}),
  validate: v => (['330', '220', '150', '96'].includes(String(v.ppi)) ? [] : [{field: 'ppi', message: 'Choose a resolution'}]),
  toCommand: v => ({command: 'picture.compress', params: {ppi: Number(v.ppi), deleteCropped: !!v.deleteCropped, all: !v.onlySelected}}),
});
