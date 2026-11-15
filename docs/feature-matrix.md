# Feature and compatibility status

The target is full-feature applications. This matrix describes the current implementation, not a reduced definition of that target. Unimplemented items remain work; none are represented by fake ribbon commands.

| Application | Implemented | Major remaining requirements |
|---|---|---|
| Quill | Rich text, headings, installed Windows font catalog, lists, alignment, configurable tables with row/column/merge/split tools, images, hyperlinks, undo/redo, literal find/replace across marks, statistics, heading outline, zoom, A4/Letter/orientation/margins carried into print and DOCX, structured DOCX import | True paginated editing, sections, headers/footers/page numbers, footnotes, equations, comments, tracked changes, citations, mail merge, document comparison, complete field and layout fidelity |
| Grid | Sparse workbooks, sheet tabs/duplication/deletion, rectangular clipboard, formulas/references/ranges, formatting, two-dimensional virtualization, undo/redo, find, non-formula sorting, guarded AutoSum, row/column insertion/deletion updating local references, relative/absolute formula fill down/right, text filter view, formula/gridline display, configurable refreshable pivot summaries (row/column fields; SUM/COUNT/AVG/MIN/MAX), XLSX/CSV import/export | Full Excel function coverage, cross-sheet formulas, charts, native Excel pivot-cache interoperability, advanced filters, named ranges, data validation, conditional formatting, merged cells, formula-aware sorting, drag fill handles, workbook printing, VBA compatibility |
| Prism | Text/rectangle/image objects, group move/nudge, aspect-preserving image resize, multi-selection, alignment/distribution/layers, duplicate/delete, undo/redo, themes/backgrounds/apply-all, slide order/duplication, speaker notes, presentation starting positions, installed Windows font selection preserved in PPTX, PPTX export, structured slide import | Persistent groups, masters/layout inheritance, advanced shapes, charts/tables, animations/transitions, video/audio, presenter view, per-run text styling, full PowerPoint fidelity |
| Slate | Rich-text notes with Quill editing tools, search, tags, notebook and section assignment/library filters, local autosave, shared-cell links, document exports | Standalone notebook/section entities and bulk operations, handwriting, OCR, audio recording, attachment indexing, offline multi-device synchronization, OneNote format compatibility |

| PDF | Standalone PDF editor, native import/export, page navigation/rotation/reorder/duplicate/delete, text/highlight/rectangle overlays, undo/redo, text search, structured run/word/estimated-character inspection, source and geometry validation | OCR engine, generative AI integration, original-content text editing, real redaction, advanced forms/signatures, merge/split workflows, full Acrobat feature parity |

## File behavior

`.ark` is the native editable format. Office imports create a new native copy; original files are never overwritten. Unsupported Office features may be omitted or simplified, so keep originals.

DOCX import preserves supported paragraph content, headings, direct inline styling, alignment, simple lists/tables and embedded PNG/JPEG images. It does not reconstruct complete Word pagination, style inheritance or review markup.

XLSX import preserves cell values, formulas and selected formatting. Text cells retain their text type on export; leading-zero and long-number identifiers are not silently coerced. Unsupported formulas are not guaranteed to calculate correctly in Grid. Supported functions currently include SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, ROUND, ABS, SUMIF/SUMIFS, COUNTIF/COUNTIFS, AVERAGEIF/AVERAGEIFS, AND/OR/NOT, LEN/LOWER/UPPER/TRIM/LEFT/RIGHT/MID, CONCAT/CONCATENATE/SUBSTITUTE, INT/MOD/SQRT/POWER/ROUNDUP/ROUNDDOWN and text concatenation. Grid pivots export as ordinary result cells, not native Excel pivot definitions. Excel recalculates exported formulas when opening the workbook.

PPTX import follows presentation ordering and preserves supported positioned text, rectangle shapes, images, backgrounds and speaker notes. Groups, masters, theme inheritance, complex shapes, per-run styles, animations and media are incomplete. Mixed text styling is simplified.

## Release status

Development builds only. Five separate applications do not by themselves satisfy full Office feature parity. Code signing, clean-machine installation tests, accessibility audits, large-file stress tests and a broader Office corpus remain release gates.
