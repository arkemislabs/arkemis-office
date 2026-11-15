# Behaviour fidelity: every feature works the way it does in the real app

An early build of the suite looked right but behaved wrong: features were "assumed and refined"
into simpler versions that look similar and behave differently. That is the failure this rule
exists to stop.

**The rule.** A command or control behaves exactly as it does in ArtCraft (the upstream Rust we
translate) and in the Office/Acrobat app it stands for. Not a lookalike, not a simplified version,
not a "good enough" stand-in. If the upstream does something in five steps with options, ours does
the same five steps with the same options. If we can't do it fully yet, the control is not shown
(architecture.md 8.7); it is never shown doing something else.

Before marking any command done, its author answers, in the unit's test file header:
1. What does ArtCraft do (file:line), and what does Office/Acrobat do?
2. Does ours do the same thing, end to end, including where data goes and what the person sees?
3. Which test proves it (unit test on the engine and a bridge E2E for the flow)?

## Known failures to fix (examples, not the whole list)

| Area | What the old build did | What it must do |
|---|---|---|
| File > Save | Saved silently "god knows where" (an app-private store) | First save of a new document opens the **system Save dialog** (Electron `dialog.showSaveDialog`) with the right file types; later saves write to that same file on disk; the title bar shows the file name; unsaved changes mark the title and prompt on close. |
| File > Save As / Save a Copy | Same silent store | System Save dialog every time, format chooser (docx/xlsx/pptx/pdf/odt/csv/... as the app supports), overwrite confirmation from the OS dialog. |
| File > Open / Open recent | App-private list | System Open dialog; recent files are real paths on disk; dropping a file on the window opens it. |
| Export / Print | Approximations | Export to PDF etc. through the system Save dialog; Print through the system print dialog (`webContents.print`) with preview. |
| PDF Highlight | A rectangle drawn over the page | **Text highlight**: select text and highlight follows the text lines (quad points per line, PDF Highlight annotation, editable color/opacity, shows in comments). **Highlighter pen** (Draw/Comment tools): freehand ink stroke with highlighter blending, pressure-insensitive width, saved as Ink annotation. Same for Underline, Strikethrough, Squiggly. |
| PDF text boxes, notes, comments | Could not be moved | Every annotation can be selected, moved, resized, edited, deleted, replied to, with the comments pane listing them. |
| PDF signatures | Missing e-sign and digital signature verification | Fill & Sign (type/draw/image signature, initials, date), certificate-based digital signing, and signature validation panel (valid/invalid/unknown signer, modified-after-signing), as Acrobat. |
| Ribbons | Card-like popups, an "Export" button instead of File/Edit/View structure | Office ribbon structure per the spec; File backstage; dialogs are full glass dialogs. |
| Layout | Controls placed by guess | ArtCraft's tab order, groups and control placement from `crates/ui-egui` (the spec), restyled only. |

## How to check behaviour (not just that it runs)

- Unit tests on the engine port upstream Rust tests where they exist (`tests/<app>/upstream/`).
- Bridge E2E runs the real flow: e.g. save → the main process asked for a path (the harness
  answers the system dialog by stubbing `dialog.showSaveDialog` in the test only) → the file exists
  on disk at that path with the right content → reopen gives the same document.
- Visual checks capture the window (`capturePage`) and someone looks at the image.
- Never claim parity for a feature whose behaviour wasn't compared with the upstream and the
  Office app.
