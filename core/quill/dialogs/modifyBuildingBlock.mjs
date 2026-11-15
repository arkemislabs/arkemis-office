// Insert › Text › Quick Parts › Building Blocks Organizer… › Edit Properties…: Word's Modify Building Block box, the fields of
// Create New Building Block (name, gallery, category, description, where it is kept) filled in from the block the Organizer opens
// it on (`_name`, `_from` and `_gallery` say which block). OK runs insert.buildingBlockProperties. See newBuildingBlock.mjs.

import {defineDialog} from '../../kernel/dialog.mjs';
import {blankBlock, blockProblems, LOCATIONS} from './newBuildingBlock.mjs';

export default defineDialog({
  id: 'dialog.modifyBuildingBlock',
  title: 'Modify Building Block',
  command: 'insert.buildingBlockProperties',
  init: () => ({...blankBlock(), _name: '', _from: 'settings', _gallery: 'Quick Parts'}),
  validate: blockProblems,
  toCommand(v) {
    const to = {name: String(v.name).trim(), gallery: v.gallery === 'AutoText' ? 'AutoText' : 'Quick Parts', category: String(v.category ?? '').trim() || 'General',
      description: String(v.description ?? '').trim(), in: v.location === LOCATIONS[1] ? 'document' : 'settings'};
    return {command: 'insert.buildingBlockProperties', params: {name: String(v._name), from: v._from === 'document' ? 'document' : 'settings', gallery: v._gallery === 'AutoText' ? 'AutoText' : 'Quick Parts', to}};
  },
});
