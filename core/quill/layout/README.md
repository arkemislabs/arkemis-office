# Quill layout

`core/quill/layout/` is the JavaScript translation of wordcraft `crates/layout` (ArtCraft, commit
`aadb077e072b7de05f724e359d8db82e151f125c`): it turns committed Quill content (schema 2, see
`../model/README.md`) into pages of placed items, a display list per page, and hit testing. No DOM
and no Node built-ins anywhere except `shaper-canvas.mjs` (renderer only). Every file names the
upstream file it translates in its header.

## Use

```js
import {layout, LayoutCache, pageDisplay, setDefaultShaper} from '../../core/quill/layout/index.mjs';
import {createCanvasShaper} from '../../core/quill/layout/shaper-canvas.mjs';

setDefaultShaper(createCanvasShaper());          // once, in the renderer (tests use the metrics stub)
const cache = new LayoutCache();                 // one per open document; keep it across edits
let lay = layout(ctx.doc, {cache, view: 'print'}); // content (or a model Document)
// after every commit: layout(newContent, {cache}) — only edited paragraphs are laid out again
```

Options: `view` (`'print'` | `'web'` | `'draft'` | `'read'`), `webWidth` (points, web/draft),
`readHeight`, `readLineSpacing`, `showHidden`, `fieldCodes` (Alt+F9), `hideDeleted` (No Markup),
`hideMarked: {plain, movedFrom}`, `deletionsInBalloons`, `numeral` (`'arabic'|'hindi'|'context'|
'system'` + `locale`), `filename`, `filepath`, `shaper`, `cache`.

### Result: `DocLayout`

`lay.pages[i]`:

| field | |
|---|---|
| `w`, `h` | page size, points (web view: `h` is the text height) |
| `number` | page number as shown (section restarts applied) |
| `section` | index into the document's sections |
| `body` | `{x, y, w, h}` the text area |
| `items` | body items (below), in drawing order: items behind the text first |
| `header`, `footer` | the header/footer items; `headerStory`, `footerStory` their part ids |
| `hfSlot` | `'default' \| 'first' \| 'even'`: which header/footer the page shows (even if the section has none: double-click creates it) |
| `firstBlock` | top-level body block index at the page start |

Items (`placed.mjs`), page coordinates (points, y down):

- `lines {story, path, para, l0, l1, x, y}`: lines `l0..l1` of a laid-out paragraph (`para`, a
  `ParaLayout`); `y` is the top of line `l0`, `x` the column's left edge. `story` is `'body'` or a
  part id (`DECOR_STORY` for line numbers).
- `fill {rect, color}`, `rule {x0, y0, x1, y1, border}`
- `image {rect, media, crop, rot, story, path, off}`, `shape {rect, shape, fill, stroke, strokeWidth, rot}`
- `cell {rect, covered, table, row, cell, story, clip}`: table cell areas (hit testing, cell selection)
- `object {rect, rot, story, path, off, textBox, wrap, origin}`: a drawing's frame (selection
  handles, dragging; `textBox` is the part id of a text box's story)

`ParaLayout`: `lines[]` (`top`, `height`, `baseline`, `start`/`stop` text offsets, `xs`, `left`/
`right`, `end`), `clusters[]`, `label`, `rp` (resolved paragraph formatting), and the caret helpers
`xOf(li, off)`, `offAtX(li, x)`, `lineOf(off)`, `lineOffsets(li)`, `xSpans(li, a, b)`.

### Painting: `pageDisplay(page, {marks, hfAlpha, bodyAlpha})`

Returns draw items (`display.mjs` header lists them): `fill`, `line` (`stroke` solid/dash/dot/double/
wave), `text` (`x`, baseline `y`, `text`, `font` {family, size, bold, italic}, `color` [r,g,b],
`xScale`, optional `spacing` = advance per character for tab leaders), `image` (`media` key into
`content.media`), `shape`, `mark` (formatting marks ¶ · → ↵, screen only, with `marks: true`).
Draw text with the same shaper font: `ctx.font = cssFont(font)` from `shaper-canvas.mjs`. Dim the
header/footer with `hfAlpha: 0.5` while editing the body (Word), or the body while editing them.

### Hit testing and caret (`hit.mjs`)

Positions are the model's `{story, path, off}` (UTF-16 offsets).

- `lay.hitTest(page, x, y, story = 'body')` → position nearest the point (`hit`)
- `lay.storyAt(page, x, y)` → `'body'` or a text box part id under the point
- `lay.headerFooterAt(page, y)` → `[partId, isFooter]` in the header/footer zone
- `lay.objectAt(page, x, y, edge)` → the `object` item under the point; `lay.cellAt(page, x, y)` → `[story, tablePath, row, cell]`
- `lay.caret(pos, pageHint)` → `{page, x, top, height, width}`
- `lay.vertical(pos, goalX, dir, pageHint)` → `[pos, goalX]` for Up (`dir < 0`) / Down
- `lay.lineBounds(pos)` → `[start, end]` positions for Home/End
- `lay.rectsForRange(a, b)` (`selectionRects`) → `[[page, {x, y, w, h}]]`, paragraph marks included
- `lay.selectionBarAt(page, x, y)` → the line start beside a click in the left margin
- `lay.pieces(story, path)` → where a paragraph's lines were placed; `lay.pageOf(pos)`

### Page addresses

`installPageResolver(setPageResolver, content => layoutOf(content))` (from `../address.mjs`) makes
`/page:<n>` resolve to `{kind: 'page', node: {index, number, section}, path, from, to, end}`.
`pageRange(lay, n)` gives the same range directly.

### Incremental layout

`LayoutCache` keeps each paragraph's layouts in a `WeakMap` keyed by the paragraph object (the
model shares unchanged blocks between versions), under a key of width, list label, page context
(only for paragraphs with page fields), table formatting, wrap areas and grid. A pass after an
edit lays out only the edited paragraphs and repaginates from cached layouts. Benchmark
(`tests/quill/layout.test.mjs`, metrics shaper): a 300-page document, cold ~550 ms, after a
one-character edit ~25 ms. Anything that changes styles, numbering or the options clears it.

### Shaper

`shaper.mjs` defines the interface: `metrics(font) -> {ascent, descent}` and
`advance(text, font) -> width` (points, one grapheme cluster at a time; Word measures without
kerning unless Kerning for fonts applies). `createMetricsShaper()` is deterministic (tests);
`createCanvasShaper()` (renderer) measures with Canvas2D `measureText` and caches.

## What is translated

`para/*` (shaping through the shaper, UAX #14 breaks with Word's slash/hyphen rules, kinsoku,
UAX #9 bidi levels and line reordering, first-fit lines, tabs incl. right/centre/decimal/bar and
positional tabs, leaders, alignment, justification with Word 2013 space shrinking, line spacing
rules, document grid, drop caps, list labels, soft hyphens, hidden text and tracked deletions left
out), `flow.rs`, `page.rs`, `pass.rs` (sections, next/odd/even page starts with blank pages,
continuous sections, columns with separators and balancing, page and column breaks, keep with
next, keep lines together, widow/orphan control, contextual and automatic spacing, page vertical
alignment, mirror indents and margins, line numbers, web/draft/read views), `floats.rs` (float
positions for every anchor, square/top-and-bottom/behind/in-front wrap, wrap sides and distances,
rotated bounds), `table.rs`/`table_flow.rs` (grid, cell margins, style regions, borders, vertical
merges, valign, exact/at-least rows, row splitting, repeated header rows, cant-split and kept rows,
footnotes in rows), `notes.rs` (numbering per section/page/continuous, footnotes on the referencing
page, notes split across pages with the continuation separator, endnotes at section or document
end), `headers.rs` (first/even/default, linked to previous, PAGEREF bookmarks), `fields.rs`
(PAGE, NUMPAGES, SECTIONPAGES, SECTION, PAGEREF, TITLE, AUTHOR, FILENAME, ASK/SET, format and case
switches), `hit.rs`, `display/*`, `cache.rs`.

## Not translated yet (hidden or shown plainly until they land)

Equations (`math/*`, shown as linear text), automatic hyphenation (`wordcraft_proof` patterns;
soft hyphens work), proofing squiggles (`proof.rs`), Tight/Through contours (`contour.rs`, wrap
the frame), floats above their anchors (`EarlyFloats` re-wrap), the rest of a paragraph re-wrapped
for the next column's floats (`relay_wrap`), floating tables (`w:tblpPr`, laid out in the flow),
text frames (`w:framePr`), linked text box chains and auto-fit boxes (`textbox.rs`), AutoFit table
columns to contents (the file's grid is used), turned cell text and vertical sections
(`vertical.rs`), WordArt (`wordart.rs`), STYLEREF (`styleref.rs`), Outline view (`outline.rs`),
comment balloons for Print Markup (`balloons.rs`), legacy check boxes (show their result), group
members and chart/SmartArt contents (drawn as their frame).
