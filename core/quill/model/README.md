# Quill model (schema 2)

`core/quill/model/` is the JavaScript translation of wordcraft `crates/doc` (ArtCraft, commit
`aadb077e072b7de05f724e359d8db82e151f125c`). Layout (`core/quill/layout/`), commands
(`core/quill/commands/*`), formats and the page view build on it. Every file names the upstream
file it translates in its header. No DOM, no Node built-ins anywhere in this folder.

Two Arkemis additions on top of upstream's data model:

1. **Stable ids.** Every paragraph, table, row, cell, inline object (`oid`) and section has an
   8-character base36 `id` (`ids.mjs`). A split keeps the id on the first half, a join keeps the
   first paragraph's id. Addresses (`/body/b:<id>/t:4-9`) and sticky anchors are built on them.
2. **A chunked body.** `content.body = {chunks: Block[][]}` (`body.mjs`): the chunks concatenated
   are upstream's `body`. An edit copies one chunk (at most 1024 block pointers), so a 100k
   paragraph document commits an edit in about 5 ms (see the benchmark in
   `tests/quill/model.test.mjs`).

Offsets are **UTF-16 code units** (upstream: UTF-8 bytes). An offset that splits a surrogate pair is
refused, as upstream refuses one inside a character.

## Files

| File | Upstream | What |
|---|---|---|
| `index.mjs` | — | the `ctx.model` API commands use (`open`, `edit`, `commit`, `selection`, ...) and every module below as a namespace |
| `content.mjs` | `lib.rs`, `document.rs` (`new`, `from_text`), `parts.rs`, `block.rs`, `settings.rs`, `review.rs` | top-level shape, defaults, parts, settings, comments, revisions, building blocks |
| `document.mjs` | `document.rs`, `position.rs`, `text_walk.rs`, `block.rs`, `error.rs` | `Document`: stories, positions, sections, parts, words, text boxes, media, bookmarks, permissions; copy-on-write and `takeOp()` |
| `edit.mjs` | `edit.rs` | insert/split/delete/format ranges, copy/paste fragments (text boxes get stories of their own), restyle, convert notes |
| `ranges.mjs` | `fields.rs`, `control.rs` | range fields (FieldStart…FieldEnd), content controls, balancing, where typing goes |
| `para.mjs` | `para.rs`, `para/run.rs`, `para/inline_object.rs`, `para/inline_kinds.rs`, `para/float.rs` | paragraphs, runs, inline objects, floating-object anchors |
| `props.mjs` | `props.rs`, `props/*.rs` | CharProps, ParaProps, table/row/cell props, colours, borders, shading |
| `styles.mjs` | `styles.rs`, `resolve.rs` | style sheet, based-on chains, built-in styles, latent styles (kept verbatim), table style parts, resolution to concrete formatting |
| `numbering.mjs`, `numfmt.mjs` | `numbering.rs`, `section.rs` (`NumFormat`), `cjk_numbers.rs` | lists, levels, counters, every ST_NumberFormat |
| `section.mjs` | `section.rs` | page size, margins, orientation, columns, header/footer slots (default/first/even), page numbering, notes, line numbers, doc grid |
| `table.mjs` | `table.rs` | grid, rows, cells, horizontal spans and vertical merges, insert/delete/merge/split |
| `text.mjs` | `cluster.rs`, `bidi.rs`, `text_walk.rs` (`count_words`) | grapheme/syllable clusters, RTL and complex-script classes, word counting |
| `ops.mjs` | — | the Quill app op the kernel stores (forward + inverse, position steps) |
| `effects.mjs`, `wordart.mjs`, `fill.mjs`, `line-dash.mjs`, `connector.mjs`, `wrap.mjs`, `freeform.mjs` | the same-named `.rs` files (+ `graphic.rs`) | shape effects, WordArt text effects and warps, fills, dashes, connectors and glue, wrap outlines, freeform/ink and chart/diagram item kinds |
| `link.mjs`, `collate.mjs`, `locale-number.mjs`, `symbol-fonts.mjs` | the same-named `.rs` files | safe hyperlink targets, language-aware sorting, locale numbers, Symbol/Wingdings mapping |
| `chart.mjs`, `smart-art.mjs` | `chart.rs`, `smart_art.rs` | the editable chart and SmartArt models (sample data, sanitizing, outline parents) |
| `eq.mjs`, `legacy-form.mjs` | `eq.rs`, `legacy_form.rs` | EQ `\o` overstrike / Enclose Characters; legacy form fields read from `w:ffData` |
| `ime-text.mjs` | `ime_text.rs` | the visible text an IME sees (tracked deletions hidden, objects as text), bounded windows and delete-surrounding in UTF-16 units |
| `encoding.mjs`, `cfb-guard.mjs` | `encoding.rs`, `cfb_guard.rs` | single-byte Windows/DOS/Mac code pages, multibyte code page names; the compound-file DIFAT guard |
| `../lib/geom.mjs` | `crates/geom/src/lib.rs` | units (pt, twips, EMU), measurement parsing, rects, `Spin`, paper sizes |
| `../address.mjs` | — | the address grammar (architecture 14.2), resolver contract (14.7), anchor mapping |
| `../schema.mjs` | — | `validateContent`, `createContent`, the kernel `apply` hook |
| `../migrate.mjs` | — | schema 1 (ProseMirror JSON) → schema 2 |

## Types (serialized JSON, as upstream's serde writes them, camelCase, absent = inherit/None)

```ts
type Content = {
  body: {chunks: Block[][]};          // the main story, chunked
  lastSection: Section;               // OOXML body-level sectPr
  parts: {[partId: number]: Part};    // headers, footers, footnotes, endnotes, comments, text boxes
  styles: StyleSheet; numbering: Numbering;
  comments: {[commentId: number]: Comment}; revisions: Revision[];
  settings: Settings; core: CoreProps; sources: Source[]; customProps: CustomProp[];
  footnoteSeparators: NoteSeparators; endnoteSeparators: NoteSeparators;
  media: {[key: string]: base64}; passthrough: {[partName: string]: base64}; glossary: BuildingBlock[];
};
type Block = Paragraph | Table;
type Paragraph = {kind: 'para'; id; text: string; runs: {len: number; props?: CharProps}[];
                  props?: ParaProps; mark?: CharProps /* paragraph-mark formatting */;
                  objects?: InlineObject[] /* the k-th U+FFFC in text is objects[k] */;
                  section?: Section /* a section break after this paragraph */};
type Table = {kind: 'table'; id; props: TableProps; grid: number[] /* column widths, pt */; rows: Row[]; controls?};
type Row   = {id; props: RowProps; cells: Cell[]; controls?};
type Cell  = {id; props: CellProps /* span, vmerge: 'restart'|'continue', width, shading, borders, ... */; blocks: Block[]; controls?};
type Part  = {kind: 'header'|'footer'|'footnote'|'endnote'|'comment'|'textBox'; blocks: Block[]; body?: TextBody};
```

Special characters in `text`: `\t` tab, `\n` manual line break, U+000C page break, U+000E column
break, U+00AD optional hyphen, U+2011 non-breaking hyphen, U+00A0 non-breaking space, U+FFFC an
inline object.

`InlineObject.type` is one of `image`, `graphic` (chart/SmartArt/ink), `shape` (incl. text box:
`story` is its part id), `group` (incl. drawing canvas), `field` (simple field with `instr`,
`result`), `fieldStart`/`fieldEnd` (range fields), `controlStart`/`controlEnd` (content controls),
`noteRef` (`kind`, `id` = part id), `bookmarkStart`/`bookmarkEnd`, `commentStart`/`commentEnd`,
`permStart`/`permEnd`, `equation`, `ruby`, `positionalTab`, `opaque` (kept for round trip).
Drawings (`image`, `graphic`, `shape`, `group`) have `w`, `h` and `float` (`wrap`: `inline` or a
floating wrap, `hRel`/`vRel` anchors, `x`/`y` or `hAlign`/`vAlign`, distances, `effect` extents,
`rot`, `flipH`, `flipV`, `wrapPolygon`, `alt`, `z`). `para.mjs` has the predicates
(`isDrawing`, `isFloating`, `isMarker`, `objectFrame`, `textBoxesOf`, `groupRects`).

CharProps keys: `props.CHAR_KEYS`; ParaProps keys: `props.PARA_KEYS`; section fields:
`section.defaultSection()`; settings: `content.defaultSettings()`. Tracked changes live on runs
(`ins`/`del` = revision index, `fmtChange`), on paragraphs (`mark.ins/del`, `props.numChange`,
`props.fmtChange`) and on sections (`fmtChange`); `content.revisions[i]` holds author/date/kind.
Hyperlinks are the run property `link` (URL or `#bookmark`), plus the `Hyperlink` character style.

## Reading

```js
import {Document, BODY} from './document.mjs';
const d = new Document(content);                 // cheap: wraps, never copies
d.story(BODY).len(); d.story(BODY).get(i);       // top-level blocks (global index across chunks)
for (const [i, block] of d.story(BODY).entries()) { ... }
d.story(partId)                                  // a part's blocks (same list API)
d.paraPaths(story)                               // every paragraph path in document order (tables descended)
d.para(story, path) / d.block(story, path) / d.table(story, path)
d.sections()                                     // [[index of the body block ending it, Section]]
d.sectionOfBlock(i), d.noteOptions(section, endnote)
d.shownStories(), d.countedStories(), d.textBoxChains(), d.objectsInReadingOrder(f)
d.fieldRanges(story), d.controlRanges(story), d.bookmarks(), d.permRanges()
```

A **path** indexes blocks: `[block]` at the top of a story, `[table, row, cell, block]` inside a
cell, three more numbers per nesting level. A **position** is `{story: 'body' | partId, path, off}`.
`cmpPath`/`cmpPos` give document order.

Runs: `para.runRanges(p)` gives `[start, end, props]`; `para.objectsWithOffsets(p)` gives
`[offset, object]`. Formatting for layout: `styles.resolvePara(content.styles, p.props, tableStylePara)`
and `styles.resolveChar(content.styles, p.props?.style, runProps, tableStyleChar)` apply defaults,
the based-on chain, the table style part and direct formatting, as upstream `resolve.rs`.

Objects returned by reads are live until the next write through the same `Document`; layout should
read from committed content (a fresh `new Document(content)` per content version) and may cache
per block object, since an unchanged block keeps its identity across versions (structural sharing).

## Writing (commands)

Commands never mutate content. They open a `Document` over `ctx.doc`, edit it with the translated
upstream methods, and commit one app op:

```js
run(ctx, p) {
  const [from, to] = ctx.model.selectionRange(ctx);          // positions from the selection
  let end;
  ctx.model.edit(ctx, d => { end = d.insertText(d.deleteRange(from, to), p.text); });
  ctx.model.setSelection(ctx, [{anchor: end, focus: end}]);   // after the edit: names committed ids
}
```

`edit` calls `d.takeOp()` and `ctx.change.apply(op)`. The op (`ops.mjs`) is
`{type: 'quill', set: {field: newValue}, parts: {id: Part|null}, steps, changed}`: the top-level
fields, parts and (for `body`) the chunk array it replaced. `schema.apply` returns the inverse
(the old values, pointer-equal), so undo restores exactly the previous objects. `steps` say how
positions moved (`text`, `split`, `join`, `remove`); `address.mapThrough` uses them to move sticky
anchors and the selection. `changed` lists touched blocks/parts/fields for `doc.changed` events.
A command that throws commits nothing.

Lower-level writes: `d.paraMut(story, path)` (a paragraph owned by this round, change it with the
`para.mjs` functions), `d.updateTable(story, path, t => newTable)`, `d.updateField(key, f)`,
`d.setField(key, v)`, `d.updateSection(blockIndex, f)`, `d.addPart(kind, blocks)`,
`d.insertBlock(story, path, block)` (ids adopted or made fresh), `d.removeBlock(story, path)`.
New ids come from `d.newId()` (never repeats an id in the document).

## Addresses

`../address.mjs` implements architecture 14.2: `/body`, `/hdr:<sectionId>.default|first|even`,
`/ftr:...`, `/fn:<id>`, `/en:<id>`, `/cmt:<commentId>`, `/tbx:<shapeOid>`, `/part:<id>`,
`/body/b:<id>`, `/body/b:<table>/r:<row>/c:<cell>/b:<block>` (nests), `.../t:<from>-<to>`,
`.../o:<oid>`, `/sec:<id>`, `/style:<id>`, `/list:<numId>`, `/bm:<name>`, `/rev:<index>`,
`/page:<n>` (the layout registers `setPageResolver`). Inputs may use upstream index paths
(`/body/b:2.1.1.0`) or friendly forms (`paragraph 3`, `table 1`, `section 2`, `style Heading 1`);
`canonical` turns them into ids. `rangeOf`/`positionOf`/`addressOf` convert between addresses and
positions. Schema-1 content (not yet migrated) resolves the interim `/body/b:<i.j>/t:` grammar the
schema-1 format commands use.

## Not translated yet

`math.rs`, `math_edit.rs`, `math_latex.rs`, `math_linear.rs` and `math_symbols.rs` (the equation
model and its tree editor; about 4,800 lines upstream) are not translated: an equation object is its
`linear` text (UnicodeMath), parsed and typeset by Slate's equation code (core/slate/lib/equation*.mjs,
laid out for the page by core/quill/lib/math-layout.mjs, read and written as OMML by
core/quill/lib/omml.mjs) and edited as text; `display`, `math.jc`, `format` (`linear`), `normalText`
and `omml` (what a .docx held, written back until the equation changes) are Quill's. A chart is a
`graphic` object with `graphic.chart` (chart.mjs), drawn by Grid's chart renderer and written as a
chart part with an embedded workbook (core/quill/lib/chart-part.mjs); `graphic.raw` keeps the markup
of a chart read from a file until a command edits it. `byte_store.rs` needs no translation (media and
passthrough parts are already base64 strings in JSON) and `compare.rs` is `props.same` plus the
pointer checks structural sharing gives for free.
