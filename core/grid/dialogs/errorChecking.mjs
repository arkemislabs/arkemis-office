// Error Checking (Formulas › Error Checking): steps through the cells that show an error ("Error
// in cell", the formula, what the error means) with Previous / Next, Show Calculation Steps…
// (Evaluate Formula on that cell) and Edit in Formula Bar.
// The list is gridcraft's `formulas.errorChecking` (crates/engine/src/cmd/formulas.rs:772, shown
// as JSON by crates/ui-egui/src/dialogs.rs:964) at 146161b4b450a56e5e59a083ba0478582d1e602b; the
// stepping and the explanations are Excel's. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {errorCells} from '../commands/formulas.mjs';

/** Excel's title and explanation of an error value. */
export const ERROR_HELP = Object.freeze({
  '#DIV/0!': ['Divide by Zero Error', 'The formula or function used is dividing by zero or empty cells.'],
  '#NAME?': ['Invalid Name Error', 'The formula contains unrecognized text.'],
  '#N/A': ['Value Not Available Error', 'A value is not available to the formula or function.'],
  '#NULL!': ['Null Error', 'The ranges in the formula do not intersect.'],
  '#NUM!': ['Invalid Number Error', 'A number in the formula or function is not valid.'],
  '#REF!': ['Invalid Cell Reference Error', 'The formula or function refers to cells that are not valid.'],
  '#VALUE!': ['Error in Value', 'A value used in the formula is of the wrong data type.'],
  '#SPILL!': ['Spill Error', 'The results cannot spill because the spill range is not blank.'],
  '#CALC!': ['Calculation Error', 'The formula gives an empty array or another result that cannot be calculated.'],
  '#GETTING_DATA': ['Getting Data', 'The value is still being calculated.'],
  '#CIRC!': ['Circular Reference', 'The formula refers to its own cell, directly or through other cells.'],
});

/** What Help on this Error says to try, by error value (Excel opens its online help; this is the short version, offline). */
export const ERROR_FIX = Object.freeze({
  '#DIV/0!': 'Change the divisor to a number other than zero, or make the cell it refers to hold a value. IF(divisor=0, "", dividend/divisor) shows nothing instead of the error.',
  '#NAME?': 'Check the spelling of the function or name, define the name if it is missing (Formulas > Name Manager), and put text in quotation marks.',
  '#N/A': 'The lookup found nothing: check that the value is in the list, or wrap the formula in IFNA to show something else.',
  '#NULL!': 'Use a colon between the two ends of a range and a comma between separate references; a space asks for the cells both ranges share.',
  '#NUM!': 'Check the arguments are numbers in the range the function accepts, or give an iterative function a closer starting guess.',
  '#REF!': 'A cell the formula used was deleted or pasted over. Undo, or edit the formula to point at the cells you mean.',
  '#VALUE!': 'Check that every argument is the kind of value the formula expects: numbers where it adds, no text that cannot be read as a number.',
  '#SPILL!': 'Clear the cells in the way of the result, or make the formula return a single value.',
  '#CALC!': 'The formula produced an empty array: check its filter or lookup conditions.',
  '#CIRC!': 'Edit one of the formulas in the loop so that it no longer depends on its own result (Formulas > Error Checking > Circular References).',
});

export default defineDialog({
  id: 'dialog.errorChecking',
  title: 'Error Checking',
  command: 'formulas.errorChecking',
  init: ctx => ({result: errorCells(ctx.doc), index: 0}),
  validate: () => [],
  toCommand: () => null,
});
