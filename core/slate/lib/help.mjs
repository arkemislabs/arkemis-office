// Help, Show Training and What's New (Help tab; U:slate/rest).
//
// OneNote's Help button opens Microsoft's online help and Show Training its video courses; neither
// can be offered offline and the app makes no web requests of its own. These are the same three
// places written for this app and kept in it: topics about what the app does (searchable), short
// lessons for the first hour, and what the latest version added. Contact Support and Feedback go to
// a Microsoft service and are not offered. Not checked against upstream (there is none).
// No DOM, no Node built-ins.

export const HELP_TOPICS = Object.freeze([
  {id: 'notes', title: 'Take notes', body: [
    'Click anywhere on a page and type: the text goes in a note container you can drag by its top bar and widen from its edge.',
    'Home has the font, size, bold, italic, lists, alignment, styles and tags. Page templates and rule lines are on Insert and View.',
    'Ctrl+Z undoes the last change, one step at a time.']},
  {id: 'organise', title: 'Notebooks, sections and pages', body: [
    'A notebook is a folder of sections; a section holds pages. Right-click a tab to rename, colour, move, merge or delete it.',
    'Drag a page tab to move it, and indent it to make a subpage. Deleted pages stay in the Notebook Recycle Bin for 60 days (History).',
    'Sections can be locked with a password (Review > Password).']},
  {id: 'tables', title: 'Tables and spreadsheets', body: [
    'Insert > Table makes a table; the Table Layout tab adds and removes rows and columns, shades cells, sorts and turns on a header row.',
    'Insert > Spreadsheet puts a worksheet on the page. Type a number, some text or a formula that starts with =, such as =SUM(A1:A4), and press Enter; the same functions as the Grid app are available. Add rows and columns with the plus buttons on the worksheet.',
    'Table Layout > Convert to Spreadsheet turns the table into a worksheet, keeping each cell\'s text.']},
  {id: 'diagrams', title: 'Diagrams', body: [
    'Insert > Diagram draws a diagram from an outline: type one line for each box. Choose Flowchart, Hierarchy, Process or Cycle.',
    'In a Flowchart, (Start) makes a rounded box and <Is it done?> a diamond. In a Hierarchy, indent a line to hang it under the one above.',
    'Double-click a diagram to change its outline or its kind.']},
  {id: 'pictures', title: 'Pictures, scanned images and files', body: [
    'Insert > Pictures puts a picture at the caret. Screen Clipping adds a clip of the window.',
    'Insert > Scanned Image takes a picture from a file (a scan or a photo) and, if you ask, reads the text in it offline. The text is saved with the picture, so Search finds it.',
    'File Attachment puts a file on the page as an icon; File Printout also shows a picture of each page of a PDF.']},
  {id: 'ink', title: 'Draw and ink', body: [
    'The Draw tab has pens, a pencil, highlighters, the eraser, the ruler and shapes. Ink to Shape turns a rough shape you draw into a clean one.',
    'Handwriting is stored as ink. It is not turned into text: a screen reader cannot read it, so add typed text where it matters.']},
  {id: 'audio', title: 'Record audio and video', body: [
    'Insert > Record Audio or Record Video starts a recording at the caret; Stop ends it. Notes you type while recording are tied to that moment, so you can play from them.',
    'Audio & Video Settings picks the microphone and camera, and the audio and video quality.']},
  {id: 'review', title: 'Check your notes', body: [
    'Review > Spelling checks the page; Thesaurus looks up a word. Set Proofing Language marks text in another language.',
    'Check Accessibility lists pictures without alternative text, a missing page title, tables without a header row, low contrast and more, and goes to each one.',
    'Search looks for the selected words (or any words you type) on pages, titles, picture text and file names in the section, group or notebook.']},
  {id: 'link', title: 'Links and linked notes', body: [
    'Ctrl+K makes a link to a web address, a page or a section. Linked Notes starts a page of notes about a file on your computer, with a link to the file at the top.']},
  {id: 'shortcuts', title: 'Keyboard shortcuts', body: [
    'Ctrl+K link, Ctrl+B bold, Ctrl+I italic, Ctrl+U underline, Ctrl+Z undo, Ctrl+Y redo, F7 spelling, Shift+F7 thesaurus, Alt+= equation, F1 this help.',
    'Alt+Q goes to the command search. Press Alt to show the key tips for the ribbon.']},
]);

export const TRAINING = Object.freeze([
  {id: 'first-note', title: 'Your first note', minutes: 2, steps: ['Click on the page and type a few words.', 'Select them and use Bold on Home.', 'Press Ctrl+Z to undo it, then Ctrl+Y to bring it back.']},
  {id: 'first-notebook', title: 'Set up a notebook', minutes: 3, steps: ['Click the + at the end of the section tabs to add a section.', 'Right-click the tab and choose a colour.', 'Click Add Page at the right and give the page a title.']},
  {id: 'first-table', title: 'A table that adds up', minutes: 3, steps: ['Choose Insert > Spreadsheet > New Spreadsheet.', 'Type 4, 8 and 15 in A1, A2 and A3.', 'Type =SUM(A1:A3) in A4 and press Enter: it shows 27.']},
  {id: 'first-diagram', title: 'Draw a diagram from an outline', minutes: 2, steps: ['Choose Insert > Diagram > New Diagram.', 'Double-click it and choose Hierarchy.', 'Type your boxes one to a line, indenting the ones that belong under another.']},
  {id: 'first-check', title: 'Check a page before you share it', minutes: 2, steps: ['Choose Review > Check Accessibility.', 'Click an item to go to it and fix it.', 'Run the check again until the pane says nothing is left.']},
]);

/** What the latest version added, newest first. */
export const WHATS_NEW = Object.freeze([
  {title: 'Spreadsheets on a page', body: 'Insert > Spreadsheet puts a worksheet with formulas on the page. Existing Spreadsheet reads a workbook or CSV file; Convert to Spreadsheet turns a table into one.'},
  {title: 'Diagrams', body: 'Insert > Diagram draws a flowchart, hierarchy, process or cycle from an outline you type.'},
  {title: 'Scanned Image', body: 'Insert a picture from a file and read the text in it offline, so Search finds it.'},
  {title: 'Check Accessibility', body: 'Lists what makes the page hard to read with a screen reader, and goes to each item.'},
  {title: 'Search', body: 'Search the notebook for the words you select, with results you can open.'},
  {title: 'Linked Notes', body: 'Start a page of notes linked to a file on your computer.'},
  {title: 'Audio & Video Settings', body: 'Choose the microphone, camera and recording quality.'},
  {title: 'Touch mode', body: 'Larger controls for the page tabs, page list and the page itself.'},
  {title: 'Help and training', body: 'Press F1 for help written for this app, offline.'},
]);

/** The topics whose title or text holds every word of the query (all topics for an empty query). */
export function searchHelp(query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return HELP_TOPICS.slice();
  return HELP_TOPICS.filter(t => { const hay = `${t.title} ${t.body.join(' ')}`.toLowerCase(); return words.every(w => hay.includes(w)); });
}
