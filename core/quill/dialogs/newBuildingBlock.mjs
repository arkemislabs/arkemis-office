// Insert › Text › Quick Parts › Save Selection to Quick Part Gallery… (and AutoText › Save Selection to AutoText Gallery…): Word's
// Create New Building Block box: the Name, the Gallery (Quick Parts or AutoText), the Category, a Description and where it is kept
// (the person's settings, or this document). OK runs insert.quickParts / insert.autoText with `save`.
// The Building Blocks Organizer's Edit Properties… opens the same fields as Modify Building Block (modifyBuildingBlock.mjs).
//
// Word's box (upstream saves by name only: tools/actions.rs quick_parts); MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export const GALLERIES = Object.freeze([['Quick Parts', 'insert.quickParts'], ['AutoText', 'insert.autoText']]);
export const LOCATIONS = Object.freeze(['Settings (all documents)', 'This document']);

/** The fields both boxes open with. */
export const blankBlock = () => ({name: '', gallery: 'Quick Parts', category: 'General', description: '', location: LOCATIONS[0]});
export const blockProblems = v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Type a name for the building block.'}]);

export default defineDialog({
  id: 'dialog.newBuildingBlock',
  title: 'Create New Building Block',
  command: 'insert.quickParts',
  init: blankBlock,
  validate: blockProblems,
  toCommand(v) {
    const command = GALLERIES.find(([g]) => g === v.gallery)?.[1] ?? 'insert.quickParts';
    const category = String(v.category ?? '').trim();
    const description = String(v.description ?? '').trim();
    return {command, params: {save: String(v.name).trim(), ...(category && category !== 'General' ? {category} : {}), ...(description ? {description} : {}), ...(v.location === LOCATIONS[1] ? {in: 'document'} : {})}};
  },
});
