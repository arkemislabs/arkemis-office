# Arkemis Office architecture

This document describes how the suite is put together: the engine kernel, the generated command
registry, the spec-driven ribbon, dialogs, addressing, the automation layer used by the tests, and
the test strategy. It was first written as the plan for translating storytold's ArtCraft apps
(wordcraft, gridcraft, deckcraft, printcraft) into Quill, Grid, Prism, PDF (`folio`) and Slate by
many contributors working in parallel **without two of them ever editing the same file**; the
ownership notes (integrator, foundation, unit) come from that plan and still explain why indexes
are generated instead of hand-edited.

Ground rules that every part of this design serves:

1. **Translation, never compilation.** The upstream Rust (the ArtCraft repositories at pinned commits)
   is read and rewritten as JS/TS. No wasm builds of upstream crates, no FFI, no copied binaries.
   Every translated module names its upstream source file and the pinned commit in its header
   (MIT notice kept in `assets/third-party-licenses/`).
2. **ArtCraft layout and flow, Arkemis skin.** Tab order, groups, control placement, dialogs,
   panes, shortcuts and keytips come from upstream `crates/ui-egui` (Office conventions for
   Slate, which has no upstream); colors, type, glass and icons are Arkemis's.
3. **One command id, three callers.** The ribbon, the keyboard and the automation layer all run the same
   command by id through the same registry. Nothing in the UI mutates a document except by
   running a command.
4. **Additive files only during fan-out.** Shared files change once, by the integrator, before
   fan-out (section 18). After that, agents only create files inside the folders they own;
   indexes are generated at build time.
5. **Every exposed control works.** A control whose command is not implemented is not rendered
   in a production build (section 8.7). There are no decorative buttons.

---

## 1. Decisions at a glance

| Topic | Decision |
|---|---|
| Engine location | Isomorphic ESM in `core/` (no DOM), runs in the renderer (live editing) and in the main process (headless bridge edits on documents no window has open). |
| Command unit | One file per command family: `core/<app>/commands/<family>.mjs`; family = upstream `cmd/<module>.rs` stem (Slate: the module the spec's `commands[].sourceRef` names). |
| Registry | Generated, never hand-edited: `scripts/generate.mjs` scans folders and writes `core/generated/*` and `src/generated/*` (gitignored). Hooked into build, test and typecheck. |
| Ribbon | One renderer (`src/shell/ribbon/`) driven by `docs/spec/<app>.json`, plus per-tab layout overlays and per-unit patch files (never edits to the spec itself). |
| Dialogs | Spec-declared fields + engine dialog model (`core/<app>/dialogs/<id>.mjs`) + optional layout overlay and React override (`src/apps/<app>/dialogs/<id>.tsx`). One glass chrome. Bridge-drivable. |
| Icons | One SVG per icon id in `assets/icons/ribbon/<id>.svg` (ids already chosen by the spec), sanitized and inlined by the generator. |
| Undo | Kernel-owned per document; every edit command is undoable through recorded inverse changes; automation edits land on the same stack ("Automation: Bold"). |
| Addressing | Doc-relative path strings with stable ids (`/body/b:7hq2c0xa/t:4-9`, `/sh:k3f/B7`, `/sl:s1/sp:e9/t:0-5`, `/pg:p3/annot:a7`), plus sticky anchors that survive edits. |
| Automation | An in-process rpc router (`electron/rpc-router.cjs`) and headless host drive documents and the UI through the same commands. Only the E2E harness uses it, in test mode, over a loopback transport (`/v2/rpc`, `/v2/events`, `electron/test-rpc-server.cjs`); a normal run opens no port. |
| Approval | Each command declares `risk`. `destructive` and `irreversible` commands run through the automation layer return `approval_required` with an app-written summary and a one-time nonce; the caller resends with the nonce once approved. |
| Quill surface | Translate wordcraft `doc` + `layout` into a paginated engine with its own page view (Canvas2D + EditContext). TipTap stays only until the page view passes its gate. **Recommended.** |
| Slate surface | Keep TipTap/ProseMirror (no upstream app; continuous notes). Commands are ProseMirror steps run headless with the same schema. |
| Grid surface | Canvas-rendered virtual grid translated from gridcraft `ui-egui/src/grid*`, DOM overlays for the in-cell editor and formula bar. |
| Prism surface | DOM/SVG slide canvas; geometry presets and text fit translated from deckcraft `geom`/`text`. |
| PDF surface | Keep pdf.js page rendering + PDFium/pdf-lib worker for writes; DOM overlays for annotations, fields and text edit; engine translated from printcraft. |
| Tests | Unit tests per family (ported upstream Rust tests first), generated conformance tests over the whole registry, bridge-driven Electron E2E that never uses OS or synthetic pointer/keyboard input. |

---

## 2. Directory layout

Owners: **I** = integrator (once, before fan-out), **F:<app>** = that app's foundation agent,
**U:<app>/<unit>** = a fan-out unit agent, **G** = generated (never edited, gitignored).

```
studio/
  core/
    kernel/                         I  shared engine kernel (no app knowledge)
      command.mjs + command.d.mts   I  defineCommands(), contract types
      dialog.mjs  + dialog.d.mts    I  defineDialog()
      schema.mjs  + schema.d.mts    I  tiny param validator `s` that also emits JSON Schema
      registry.mjs                  I  buildRegistry(modules) -> lookup/list/state
      session.mjs                   I  Session, DocState, transactions, versions
      change.mjs                    I  JSON patch ops with inverses + structural sharing
      undo.mjs                      I  undo/redo stacks, groups, labels, origin tags
      anchors.mjs                   I  sticky anchors mapped through changes
      address.mjs                   I  address string parse/format dispatch to app resolvers
      risk.mjs                      I  risk levels, approval nonces, summaries
      errors.mjs                    I  CommandError codes (section 15.6)
      host.mjs                      I  Host interface: services available per environment
      testing.mjs                   I  createTestSession(), expectUndoRoundTrip(), fixtures
    common/
      commands/*.mjs                I  file.*, edit.undo/redo/repeat, view.zoom*, clipboard core,
                                       ribbon customization, shared by all apps
      dialogs/*.mjs                 I  options, zoom, customize ribbon, ...
    quill/                          F:quill owns model/, layout/, address.mjs, schema.mjs,
      model/                                 context.mjs, migrate.mjs, lib/
      layout/                       F:quill (translated wordcraft crates/layout)
      address.mjs                   F:quill address resolver + change mapping
      schema.mjs                    F:quill content validator (schema 2) + app ops
      context.mjs                   F:quill contextual flags (table, picture, equation, ...)
      migrate.mjs                   F:quill schema 1 (ProseMirror JSON) -> schema 2
      lib/                          F:quill shared helpers; units add lib/<family>-*.mjs only
      commands/<family>.mjs         U:quill/<family>
      commands/<family>/<sub>.mjs   U:quill/<family>   (large families may split)
      dialogs/<dialogId>.mjs        U:quill/<owning family>
      formats/<ext>-read.mjs        U:quill/formats-<ext>
      formats/<ext>-write.mjs       U:quill/formats-<ext>
    grid/  prism/  folio/  slate/   same shape as quill/ (folio/model wraps the PDF worker)
    generated/                      G  <app>.commands.mjs, <app>.dialogs.mjs, <app>.formats.mjs,
                                       apps.mjs, manifest.json
    *.mjs (existing flat modules)      untouched; new code may import them; retired per app later
  src/
    shell/                          I  everything app-independent in the UI
      AppHost.tsx                   I  mounts frame + ribbon + surface + panes + dialogs for a kind
      engine/EngineProvider.tsx     I  renderer Host, session <-> useWorkspace persistence
      engine/useCommand.ts          I  useCommandState(id,args), runCommand(id,args,origin)
      ribbon/*.tsx, ribbon/fit.ts   I  spec ribbon renderer (section 8)
      backstage/*.tsx               I  File backstage frame + common pages
      dialogs/*.tsx, fields/*.tsx   I  GlassDialog, DialogHost, field library (section 9)
      panes/PaneHost.tsx            I  task pane docking (left/right/float)
      keys/KeyRouter.ts, KeyTips.tsx I shortcuts + Alt keytips (section 11)
      icons/Icon.tsx                I  renders generated icons
      chrome/TitleBar.tsx           I  traffic lights + QAT + title + search
      statusbar/StatusBar.tsx       I  spec-driven status bar
      bridge/RendererBridge.ts      I  answers rpc requests routed from main (section 15.4)
      diagnostics/                  I  dev-only; compiled out of production (section 13)
      *.css                         I  shell styles (glass tokens reuse glass-dialogs.css)
    apps/<app>/
      manifest.ts                   F:<app>  {ready:boolean, surface, contextProvider}
      surface/*                     F:<app>  editing surface (section 16)
      ui-commands/<family>.ts       U:<app>/<family>  view-only commands (needs:'view')
      dialogs/<dialogId>.tsx        U:<app>/<owning family>  optional dialog override/preview
      panes/<paneId>.tsx            U:<app>/pane-<paneId>
      backstage/<pageId>.tsx        U:<app>/backstage-<pageId>  optional page override
      extensions/<id>.tsx           U:<app>/<owning family>  spec `arkemisExtensions` controls
      *.css                         owner of the adjacent .tsx
    generated/                      G  icons.ts, <app>.ui.ts, <app>.spec.ts
    editors/*, App.tsx, ...            existing; legacy editors stay until manifest.ready flips
  assets/icons/ribbon/<iconId>.svg  owner per section 12.4
  docs/
    architecture.md                 this file
    spec/<app>.json                 read-only input during fan-out (written by the spec pass)
    spec/layout/<app>/<tabId>.json  U:<app>/layout-<tabId>  ribbon geometry overlay (7.3)
    spec/layout/<app>/dialogs/<dialogId>.json  owner of that dialog  dialog geometry overlay (7.3)
    spec/patches/<app>/<unit>.json  U:<app>/<unit>  corrections as merge patches by id (7.4)
  electron/
    test-rpc-server.cjs             I  test-only loopback transport: /v2/rpc and /v2/events (section 15.1)
    rpc-router.cjs                  I  routes a method to a window's renderer or the headless host
    headless-host.mjs               I  main-process Session over the store
  scripts/
    generate.mjs                    I  the generator (section 6)
    gen/*.mjs                       I  registry, spec normalizer, icons, dialogs, coverage sub-steps
    lint-e2e.mjs                    I  forbids pointer/keyboard APIs in tests/e2e
    verify-bridge-e2e.mjs           I  parallel E2E runner over tests/e2e/**
  tests/
    kernel/*.test.mjs               I
    bridge/*.test.mjs               I  in-process bridge contract tests
    conformance/*.test.mjs          I  generated-registry checks (section 17.3)
    <app>/<family>.test.mjs         U:<app>/<family>
    <app>/upstream/<module>_<test>.test.mjs  U:<app>/<family>  ported upstream Rust tests
    e2e/harness.mjs                 I
    e2e/<app>/<flow>.e2e.mjs        U:<app>/<family> or U:<app>/e2e-<flow>
    *.test.mjs, *.e2e.mjs (existing) untouched
```

---

## 3. Ownership rules for parallel work

1. **A unit owns a path set, not a topic.** `U:grid/data` owns `core/grid/commands/data.mjs`,
   `core/grid/commands/data/**`, `core/grid/lib/data-*.mjs`, `core/grid/dialogs/<dialogs whose
   submit command is in this family>.mjs`, the matching `src/apps/grid/dialogs/*.tsx` and
   `docs/spec/layout/grid/dialogs/*.json`, `src/apps/grid/ui-commands/data.ts`,
   `tests/grid/data*.test.mjs`, `tests/grid/upstream/data_*.test.mjs`,
   `tests/e2e/grid/data-*.e2e.mjs`, and the icons assigned to it (12.4). It never edits anything else.
2. **Never edit generated files** (`core/generated/**`, `src/generated/**`). Run `npm run generate`.
3. **Never edit `docs/spec/<app>.json` during fan-out.** If the spec is wrong, add
   `docs/spec/patches/<app>/<unit>.json` (7.4). The generator applies patches in sorted filename
   order and fails if two patches touch the same key, naming both files.
4. **Foundation helpers** (`core/<app>/lib/*.mjs` without a family prefix) belong to the
   foundation agent. A unit that needs a new shared helper writes `core/<app>/lib/<family>-<name>.mjs`;
   other units may import it but not edit it. If it must change for another unit, file a request.
5. **Command ids are globally unique per app.** Ids follow the spec's `commands[].id`, which
   follow upstream verbatim (`format.bold` in wordcraft, `home.bold` in gridcraft, `shape.insert`
   in deckcraft, printcraft catalog ids). The generator fails on duplicates and names both files.
6. **Cross-unit needs** go into a new file `design note <from>--<to>--<slug>` (what, why,
   proposed signature). The owner implements it; the requester never edits the owner's file.
7. **Kernel or shell gaps** discovered after fan-out are integrator requests
   (`design note <unit>--integrator--<slug>`). The integrator batches them; units keep
   working with a local workaround inside their own files.
8. **Commit hygiene:** one unit, one commit series touching only its paths.
   `node scripts/generate.mjs --check-ownership <unit> --files <changed files>` fails if a change
   touches another owner's path. The ownership map is computed from the rules above plus the
   family a dialog's submit command belongs to.

---

## 4. Kernel

### 4.1 Session and documents

```ts
// core/kernel/session.mjs (types in session.d.mts)
interface Session {
  app: AppId;                                // 'quill'|'grid'|'prism'|'folio'|'slate'
  registry: Registry;                        // built from generated modules for this app
  host: Host;                                // environment services (4.4)
  docs: Map<DocId, DocState>;
  activeDocId: DocId | null;
  clipboard: ClipboardState | null;          // app-internal rich clipboard
  prefs: Prefs;                              // Options dialog values
  execute(docId: DocId|null, id: CommandId, params: object, opts: ExecOpts): Promise<ExecResult>;
  batch(docId: DocId, steps: {command:CommandId; params:object}[], opts: ExecOpts & {label:string}): Promise<ExecResult>;
  state(docId: DocId|null, id: CommandId, params?: object): ControlState;   // enabled/checked/value
  subscribe(listener: (e: SessionEvent) => void): () => void;
}
interface DocState {
  file: StudioFile;          // metadata + content (content is the app model, immutable)
  version: number;           // session version: +1 per committed transaction, never reused
  storeRevision: number;     // last revision written to / read from electron/store.cjs
  undo: UndoStack; redo: UndoStack;
  selection: Selection;      // { ranges: {anchor: Address, focus: Address}[], primary: number }
  anchors: AnchorTable;      // sticky anchors (4.3)
  dirty: boolean;
}
interface ExecOpts { origin: 'ui'|'shortcut'|'bridge'|'test'|'dialog'; baseVersion?: number;
                     approval?: {nonce: string}; signal?: AbortSignal; dryRun?: boolean }
interface ExecResult { result: unknown; version: number; changed: Address[];
                       undoLabel?: string; selection?: Selection }
```

Execution algorithm (identical in renderer and headless):

1. Look up the command; unknown id → `not_found`.
2. Validate `params` against the command's schema → `invalid_params` with the JSON-Schema path.
3. `baseVersion` given and `!== doc.version` → `conflict` (HTTP 409 on the bridge).
4. Risk gate (15.7): `destructive`/`irreversible` with `origin:'bridge'` and no valid nonce →
   `approval_required`.
5. `state()` says disabled → `disabled` with the reason (upstream `enabled` functions return the
   strings; translate them verbatim).
6. Run inside a transaction: the command reads `ctx.doc` and writes only through `ctx.change`.
   Throwing rolls everything back; nothing partial is ever committed (upstream: "A failed command
   leaves the document unchanged").
7. Commit: new immutable content, `version+1`, push undo entry `{label, origin, forward, inverse,
   selectionBefore, selectionAfter}`, map anchors, emit `doc.changed` with changed addresses.
8. `dryRun` performs 1–6, returns the would-be `changed` and result, and discards (used for
   gallery live preview and by the bridge).

### 4.2 Changes and undo

`core/kernel/change.mjs` provides path-based operations over plain JSON with structural sharing:

```ts
interface ChangeApi {
  set(path: Path, value: unknown): void;          // records {op:'set', path, value, old}
  delete(path: Path): void;
  splice(path: Path, index: number, remove: number, ...items: unknown[]): void;
  apply(op: AppOp): void;                         // app-specific op through app.model.apply
}
```

* The kernel copies only the objects along each written path, so content must be shaped so paths
  are short and leaf objects small. Foundations must chunk large collections: Grid cells in
  256-row blocks (`sheets[i].blocks[rowBlock][a1]`), Quill body blocks in an array of block
  records (pointer copies of a 100k-element array are acceptable), PDF overlays per page.
* Undo stores the recorded inverse ops; redo replays forward ops. Groups (`batch`, dialogs that
  run several commands, upstream "undo groups") collapse into one entry.
* App-specific ops: an app may register `apply(content, op) -> {content, inverse}` in its
  `schema.mjs`. Slate uses this for ProseMirror steps (16.5); Folio uses it for worker-produced
  source replacements (`{op:'pdfSource', before: hash, after: blobRef}`) so undo restores the
  exact previous bytes from a bounded blob cache.
* Commands declare `undo: 'auto' | 'none'`. `none` is only for queries, view state and
  persistence actions (zoom, scroll, save). There is no custom undo: if a command can't express
  its effect as recorded changes it is not finished.

### 4.3 Versions, revisions and anchors

* `version` (session) is what clients use for optimistic concurrency on open documents.
  `storeRevision` is the persisted revision used by `electron/store.cjs`. Autosave (the existing
  650 ms debounce in `useWorkspace`) writes the session content with the store's revision check.
  A store write from another process while the document is clean reloads it and bumps `version`;
  while dirty it raises the existing conflict banner.
* Anchors: `document.anchor {address}` returns `@a<n>`; every commit maps all anchors through the
  forward ops with the app's `address.mapThrough(op, address)`. A deleted target maps to
  `{deleted:true, nearest}`. Anchors are session-only, capped at 10k per document, and let an
  agent read once, edit many places, and keep its references valid.

### 4.4 Hosts

`Host` is the environment the kernel runs in. Commands only reach the outside through it:

```ts
interface Host {
  kind: 'renderer'|'headless'|'test';
  fonts(): Promise<FontInfo[]>;
  measureText?(font: FontSpec, text: string): TextMetrics;     // renderer only (Canvas2D)
  worker(op: WorkerOp): Promise<unknown>;                       // PDF, format, OCR worker
  pickFile?(opts): Promise<string|null>;                        // renderer only (main dialog)
  pickImage?(): Promise<string|null>;
  clipboardRead(): Promise<{text:string;html:string}>; clipboardWrite(data): Promise<void>;
  openDialog?(id: DialogId, init: object): Promise<object|null>; // renderer only
  view?: AppView;                                              // renderer only: surface handle
  now(): number; uid(): string;
}
```

Rule: a command whose params can be supplied programmatically must not require `pickFile`,
`openDialog` or `view`. The UI path opens the dialog or file picker, then calls the command with
full params (gridcraft rule: "Programmatic calls never open dialogs: missing required params give
an error"). Commands that inherently need the live view (caret movement, scrolling, zoom-to-fit,
format painter pick-up) declare `needs:'view'` and live in `src/apps/<app>/ui-commands/`.

---

## 5. Command module contract

### 5.1 Types

```ts
// core/kernel/command.d.mts
export type Risk = 'read' | 'edit' | 'destructive' | 'irreversible';
//  read         : no change (queries, inspection)                         -> never asks
//  edit         : undoable change to the open document                     -> never asks
//  destructive  : loses data outside the undo stack but recoverable        -> asks (Autopilot may skip)
//                 (delete a document to trash, close without saving, discard recovery copies,
//                  replace a vault file, empty a section's recycle bin into trash)
//  irreversible : permanent, or leaves the machine / others see it        -> always asks
//                 (apply redactions, sign, flatten, remove protection, permanent delete,
//                  overwrite an external file, print, send mail merge, share)

export interface CommandSpec<P = any, R = any> {
  id: string;                         // spec commands[].id = upstream id verbatim, e.g. 'format.bold'
  label: string;                      // upstream label, e.g. 'Bold'
  description?: string;               // one sentence (spec commands[].summary); used by engine.commands
  shortcut?: string | string[];       // 'Ctrl+B'; 'Mod' = Ctrl on Windows, Cmd on macOS
  risk: Risk;
  needs?: 'model' | 'view' | 'worker'; // default 'model'; 'view' only in src/apps/*/ui-commands
  params: Schema<P>;                  // from core/kernel/schema.mjs `s`; doubles as JSON Schema
  result?: Schema<R>;
  dialog?: string;                    // dialog id opened when the UI invokes it without required params
  undo?: 'auto' | 'none';             // default 'auto' for risk 'edit', 'none' for 'read'
  journal?: boolean;                  // default true; secret params (password, *Password) never journaled
  summary?(ctx: Ctx, p: P): string;   // approval text for destructive/irreversible ("Delete 3 pages: 4–6")
  state?(ctx: Ctx, p: Partial<P>): ControlState;   // enabled/checked/value for ribbon binding
  run(ctx: Ctx, p: P): R | Promise<R>;
}
export interface ControlState { enabled: boolean; reason?: string; checked?: boolean | 'mixed';
                                value?: unknown /* font name, size, current color, gallery index */ }
export interface Ctx {
  app: AppId; doc: Readonly<Content>; file: Readonly<StudioFileMeta>; docId: string; version: number;
  selection: Selection; prefs: Readonly<Prefs>; origin: ExecOpts['origin'];
  change: ChangeApi;                          // the only way to write
  resolve(address: Address): Resolved;        // app resolver; throws not_found
  setSelection(sel: Selection): void;
  run(id: string, params: object): unknown;   // compose other commands inside this transaction
  host: Host; signal: AbortSignal;
  model: AppModel;                            // the app's foundation API (core/<app>/model)
}
export interface CommandFamily {
  family: string;                             // path relative to commands/, e.g. 'format' or 'format/borders'
  app: AppId | AppId[] | '*';                 // '*' only in core/common
  upstream: { repo: 'wordcraft'|'gridcraft'|'deckcraft'|'printcraft'|'office'; commit?: string; files: string[] };
  commands: CommandSpec[];
}
export function defineCommands(f: CommandFamily): CommandFamily;
```

### 5.2 Example

```js
// core/grid/commands/format/font.mjs
// Translated from gridcraft crates/engine/src/cmd/format.rs (home.bold, home.italic, home.fontName)
// at <pinned commit>. MIT, see assets/third-party-licenses/artcraft-reference.txt.
import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {targetRanges, everyCell} from '../../lib/ranges.mjs';      // foundation helper

const toggle = (id, label, prop, shortcut) => ({
  id, label, shortcut, risk: 'edit',
  description: `${label} on/off for a range (default: the selection).`,
  params: s.object({range: s.optional(s.address('range')), value: s.optional(s.boolean())}),
  state(ctx) {
    const cell = ctx.model.activeCell(ctx);
    return {enabled: ctx.model.canFormat(ctx), checked: !!cell?.style?.[prop]};
  },
  run(ctx, p) {
    const ranges = targetRanges(ctx, p.range);
    const on = p.value ?? !ctx.model.allCells(ctx, ranges, c => c.style?.[prop]);
    let n = 0;
    for (const at of everyCell(ctx, ranges)) { ctx.model.setStyle(ctx, at, {[prop]: on}); n++; }
    return {changed: n, value: on};
  },
});

export default defineCommands({
  family: 'format/font', app: 'grid',
  upstream: {repo: 'gridcraft', commit: '<pinned>', files: ['crates/engine/src/cmd/format.rs']},
  commands: [
    toggle('home.bold', 'Bold', 'bold', 'Mod+B'),
    toggle('home.italic', 'Italic', 'italic', 'Mod+I'),
    { id: 'home.fontName', label: 'Font', risk: 'edit', dialog: 'formatCells',
      params: s.object({range: s.optional(s.address('range')), name: s.string({min:1, max:200})}),
      state: ctx => ({enabled: ctx.model.canFormat(ctx),
                      value: ctx.model.activeCell(ctx)?.style?.fontName ?? ctx.model.defaultFont(ctx)}),
      run(ctx, p) { /* set fontName on every target cell through ctx.model.setStyle */ } },
  ],
});
```

### 5.3 Rules

* **Ids, labels, disabled reasons and params text come from upstream** (through the spec), so the
  automation layer's `engine.commands` lists them the same way.
* **One id, several controls:** spec controls pass fixed `args` (Slate's Paste split runs
  `clipboard.paste` with `{mode:'keep-source'}` etc.). The params schema must accept every `args`
  object the spec uses; the generator checks this.
* **Offsets:** wordcraft positions are UTF-8 byte offsets (`"off": byteOffset`); every translated
  API converts to UTF-16 code-unit offsets and refuses offsets that split a surrogate pair (the
  existing `core/automation.mjs` rule).
* **No DOM, no Node built-ins** in `core/` (except `core/*/formats/*`, which may use `jszip`,
  `fast-xml-parser`, `pdf-lib`, already dependencies). Every command then runs in both hosts and
  in `node --test`.
* **Async only when needed** (`needs:'worker'`, fonts). The renderer shows a busy state for
  commands that take over 150 ms.
* **Composite commands** call `ctx.run()` so the whole thing is one undo entry.
* **Queries are commands too** (`risk:'read'`, `undo:'none'`), e.g. `cell.get`,
  `formulas.evaluate`, `styles.list` (galleries and dynamic menus read their items through them).
* **Every command has tests** (section 17); the conformance suite fails a command id that no test
  file mentions.

---

## 6. Registry generation (no shared index file)

### 6.1 `scripts/generate.mjs`

Pure Node, deterministic, fast (under a second for thousands of commands). Steps:

1. **Discover apps:** `['quill','grid','prism','folio','slate']` (the product list in
   `electron/main.cjs` minus `studio`).
2. **Commands:** glob `core/common/commands/**/*.mjs` and `core/<app>/commands/**/*.mjs`, excluding
   `*.test.mjs` and files whose basename starts with `_`. Sort paths. Import each (pure ESM) and
   read the default export.
   * Validate: `family` equals the path relative to `commands/` without extension; `app` matches
     the folder; every command has `id`, `label`, `risk`, `params`, `run`; ids are unique across
     common + app (error names both files); `needs:'view'` is rejected in `core/`; `shortcut`
     strings parse; destructive/irreversible commands define `summary`.
   * Write `core/generated/<app>.commands.mjs`:
     ```js
     // GENERATED by scripts/generate.mjs. Do not edit.
     import m0 from '../common/commands/edit.mjs';
     import m1 from '../grid/commands/data.mjs';
     import m2 from '../grid/commands/format/font.mjs';
     export const modules = [m0, m1, m2];
     ```
3. **Dialogs, formats:** same pattern for `core/<app>/dialogs/*.mjs` →
   `core/generated/<app>.dialogs.mjs`, and `core/<app>/formats/*.mjs` →
   `core/generated/<app>.formats.mjs`.
4. **App foundations:** `core/generated/apps.mjs` exports, per app that has them,
   `{schema, address, context, migrate}` imported from `core/<app>/*.mjs`. Missing foundation
   files are skipped (the app keeps schema-1 behaviour).
5. **Renderer side:** glob `src/apps/<app>/ui-commands/*.ts`, `dialogs/*.tsx`, `panes/*.tsx`,
   `backstage/*.tsx`, `extensions/*.tsx`, and `manifest.ts`, and write `src/generated/<app>.ui.ts`:
   ```ts
   // GENERATED
   import manifest from '../apps/grid/manifest';
   import u0 from '../apps/grid/ui-commands/view';
   export {manifest};
   export const uiCommands = [u0];
   export const dialogs = {formatCells: () => import('../apps/grid/dialogs/formatCells')};
   export const panes = {selection: () => import('../apps/grid/panes/selection')};
   export const backstage = {};
   export const extensions = {};
   ```
   Dialog, pane, backstage and extension modules are lazy chunks (esbuild `splitting:true` is on).
6. **Spec:** load `docs/spec/<app>.json`, normalize it (7.2), merge layout overlays (7.3) and
   patches (7.4), validate (7.5), and write `src/generated/<app>.spec.ts`
   (`export default {...} as const`).
7. **Icons:** sanitize `assets/icons/ribbon/*.svg` → `src/generated/icons.ts` (section 12).
8. **Coverage and manifest:** write `core/generated/manifest.json` (every command: id, app, family,
   label, description, risk, needs, params JSON Schema, ribbon paths from the spec, shortcut,
   upstream file) and `artifacts/coverage/<app>.json` (spec controls implemented/pending, spec
   `commands` not yet registered, registered commands not in the spec, dialogs without a model,
   icons missing with their owners). The automation layer serves `manifest.json` for `engine.commands`.

Flags: `--check` (validate only, non-zero on any error; agents run it before committing),
`--app <id>`, `--strict` (pending controls and missing icons are errors; used for releases of an
app whose manifest says `ready:true`), `--check-ownership <unit> --files <list>`.

### 6.2 Hooks

* `scripts/build.mjs`: right after `root` is computed,
  `await (await import('./generate.mjs')).generate({root, strict: process.env.ARKEMIS_STRICT==='1'});`
* `package.json`: `"generate": "node scripts/generate.mjs"`, `"pretest"` and `"pretypecheck"` run it,
  and the test glob is widened (section 18).
* `.gitignore`: `core/generated/`, `src/generated/`.
* Packaging already includes `core/**/*`, and the `package:*` scripts run `build` first, so the
  generated core indexes ship. `dist/` contains the bundled renderer side.

Because the indexes are rebuilt from folder contents, two agents adding two command files never
touch a common file, and merging their branches never conflicts.

---

## 7. Spec: input format, normalization, overlays, patches

### 7.1 What the spec pass produces

`docs/spec/<app>.json` (Slate's is the first to land; the other four follow the same top level).
Shape as written by the spec pass:

```ts
interface SpecFile {
  app: AppId; product: string;
  upstream: null | {repo: string; commit: string};   // null for Slate (Office-based)
  basis: string; conventions: object; dataModel: object;
  ribbon: { tab: string; contextual: boolean; contextFor?: string;        // 'table' | 'equation' | 'media' ...
            groups: { group: string; controls: SpecControl[] }[] }[];
  quickAccessToolbar: SpecControl[];
  backstage: { id: string; label: string; kind: 'page'|'action'; command?: string; dialog?: string;
               shortcut?: string; sourceRef: string; children?: {id; label; kind; command?; dialog?; items?: string[]}[] }[];
  dialogs: { id: string /* 'dialog.paragraph-spacing' */; title: string; command: string /* submit */;
             presentation?: 'modal'|'pane'|'backstage'|'inline-bar'|'full-window';
             tabs: { name: string; fields: SpecField[] }[];
             buttons: string[] /* 'OK', 'Cancel', 'Apply', ... */; relatedCommands?: string[]; sourceRef: string }[];
  commands: { id: string; args: string[] /* 'mode: default|keep-source|...' */; sourceRef: string; summary: string }[];
  contextMenus: { target: string; items: string[]; commands: string[] }[];
  panes: { id: string; label: string; sourceRef: string; contents?: string[]; commands?: string[]; dialog?: string }[];
  statusBar: string[];
  shortcuts: { keys: string; command: string; args?: object }[];
  arkemisExtensions: { id: string; label: string; kind: string; command: string; existing?: string; note?: string }[];
  alreadyImplementedInStudio: { id: string; status: 'done'|'partial'; where: string; note?: string }[];
  unusedCommands: string[];
}
interface SpecControl { id: string /* '<tab>.<group>.<control>[.<item>]' */; label: string;
  kind: 'button'|'toggle'|'split'|'dropdown'|'gallery'|'combo'|'color';
  command: string; args?: object; shortcut: string|null; dialog: string|null; icon: string;
  source: 'artcraft'|'office'; sourceRef: string; items?: SpecControl[]; note?: string }
interface SpecField { id: string; label: string;
  kind: 'number'|'select'|'checkbox'|'color'|'text'|'radio'|'list'|'preview'|'button';
  options: string[]; min?: number; max?: number; step?: number; unit?: string; default?: unknown;
  dialog?: string /* a button that opens a nested dialog */; input?: string; multiline?: boolean;
  accept?: string; masked?: boolean }
```

The spec is authoritative for **what** exists (tabs, groups, controls, commands, dialogs, fields,
icons, shortcuts) and is never edited during fan-out.

### 7.2 Normalization (`scripts/gen/spec.mjs`)

The generator converts the spec into the internal `RibbonModel` the renderer consumes:

* `ribbon[]` → tabs with ids `kebab(tab)`; `contextual:true` tabs become contextual tabs whose
  visibility flag is `contextFor` (the app's `context.mjs` must emit that flag).
* `kind` → renderer control type (`dropdown` → menu, `color` → color split, `gallery` → in-ribbon
  gallery when the overlay says `inline`, else a dropdown gallery).
* Dialog ids keep their `dialog.` prefix; `buttons` strings map to roles (`OK`→ok, `Cancel`→cancel,
  `Apply`→apply, `Close`→cancel, anything else→other with its own command from `relatedCommands`
  or the field list).
* `commands[]` is the command catalogue: the generator diffs it against the registry for
  coverage, and maps each `sourceRef` to the owning family file: `crates/engine/src/cmd/<m>.rs` →
  `core/<app>/commands/<m>.mjs`; Slate's planned flat paths `core/slate-<m>.mjs` →
  `core/slate/commands/<m>.mjs`. This is how units know which command ids they own.
* `contextMenus[]`, `panes[]`, `statusBar[]` are normalized into menu, pane and status models;
  string-only entries are matched to the listed `commands` by position.

### 7.3 Layout overlays (geometry the spec does not carry)

The spec lists controls per group in order but not their ArtCraft geometry. Geometry lives in
small overlay files, one per tab, owned by a layout unit that reads upstream
`crates/ui-egui/src/ribbon/<tab>.rs` (Office screenshots/docs for Slate):

```jsonc
// docs/spec/layout/quill/home.json
{ "tab": "home", "keytip": "H", "source": "wordcraft crates/ui-egui/src/ribbon/home.rs",
  "groups": {
    "clipboard": { "keytip": "FO", "launcher": {"pane": "clipboard"}, "collapseOrder": 7, "collapsedIcon": "paste",
                   "layout": [ {"large": "home.clipboard.paste"},
                               {"stack": ["home.clipboard.cut", "home.clipboard.copy", "home.clipboard.format-painter"]} ] },
    "font": { "launcher": {"dialog": "dialog.font"},
              "layout": [ {"rows": [ ["home.font.font", "home.font.size", "home.font.grow", "home.font.shrink", "home.font.case", "home.font.clear"],
                                     ["home.font.bold", "home.font.italic", "home.font.underline", "home.font.strike", "..."] ]} ],
              "widths": {"home.font.font": 150, "home.font.size": 52} } },
  "keytips": {"home.clipboard.paste": "V", "home.font.bold": "1"} }
```

Primitives: `large` (32 px icon, label below), `stack` (up to three medium/small controls
vertically), `rows` (two or three horizontal rows of small controls, Office Font/Paragraph
style), `gallery` (`{"gallery": id, "inline": true, "columns": n}`), `separator`. A control the
overlay does not place is appended as a small control at the end of its group, and coverage
flags it. Dialog geometry overlays (`docs/spec/layout/<app>/dialogs/<dialogId>.json`) set dialog
size, sections, column count and field order per tab; without one the generic two-column form
is used.

### 7.4 Patches

`docs/spec/patches/<app>/<unit>.json` corrects the spec without editing it:

```json
{ "controls": { "home.font.grow": {"icon": "font-grow"} },
  "dialogs":  { "dialog.font": {"tabs": [ "..." ]} },
  "commands": { "format.growFont": {"args": ["step?: number"]} },
  "insertAfter": { "home.font.clear": [ {"id": "home.font.phonetic", "label": "Phonetic Guide", "kind": "button", "...": "..."} ] } }
```

Merge-patch semantics (RFC 7396) per keyed entry; `insertAfter` adds controls found upstream
later. Two patches touching the same key fail the build, naming both files.

### 7.5 Validation (generator)

Every control's `command` exists in the spec's `commands` (and in the registry, or it is
reported pending); every `icon` exists (or is reported missing with its owner); every `dialog`
referenced is declared; control ids unique; keytips unique within a tab; shortcuts unique per
context scope; contextual flags appear in the app's `context.mjs` export `flags`; dialogs'
submit commands exist; every control's `args` validate against the command's params schema once
the command is registered.

---

## 8. Ribbon renderer

### 8.1 Components (`src/shell/ribbon/`)

* `SpecRibbon` — props `{model, session}`. Renders the tab strip (File first, then the normal
  tabs in spec order, then active contextual tabs under their accent color, as Office does), the
  active tab's groups, the ribbon display options (Always show / Show tabs only / Auto-hide), and
  the collapse chevron. Double-clicking a tab toggles Show tabs only.
* `RibbonGroup` — label at the bottom, optional launcher (the corner arrow) bound to
  `launcher.dialog|pane|command`.
* Layout primitives `Large`, `Stack`, `Rows`, `Gallery` reproduce egui's arrangement exactly as
  declared in the overlay; there is no automatic flow layout, so placement stays ArtCraft's.
* Controls: `RibbonButton` (large 32 px icon + label under; medium 16 px + label; small icon
  only), `RibbonToggle`, `RibbonSplit` (primary part runs `command` with `args`, arrow opens
  `items`), `RibbonMenu` (`dropdown`), `RibbonGallery` (inline row with scroll arrows and a More
  flyout; dynamic items from a read command; live preview on hover by running the command with
  `dryRun` and painting the result through the surface's `preview(changes)` hook),
  `RibbonCombo` (editable font/size combos), `RibbonColor` (split: last color + palette flyout
  with theme colors, standard colors, More Colors dialog).
* Every control renders `data-control-id`, `aria-label`, `aria-pressed`/`aria-expanded`, and a
  tooltip with label, shortcut and the command's description.

### 8.2 State binding

`useCommandState(command, args)` subscribes to the session's `tick` (one per commit or selection
change) and calls the command's `state()` only for controls on the visible tab, the QAT and open
menus. Results are memoized per tick, so a ribbon with 150 visible controls costs at most 150
`state()` calls per selection change. A control with no `state()` is enabled when a document is
open.

### 8.3 Activation

Clicking a control calls `runCommand(command, args, 'ui')`. If the control (or command) names a
`dialog` and the args lack required params, the shell opens that dialog instead; the dialog's OK
runs the command with full params (origin `'dialog'`). Focus returns to the surface after any
ribbon command (upstream behaviour), except for combos while typing.

### 8.4 Fit and collapse

`src/shell/ribbon/fit.ts` translates wordcraft `ui-egui/src/ribbon_fit.rs`: as width shrinks,
groups step down in `collapseOrder` (large → medium → small → whole group collapses into one
dropdown button showing `collapsedIcon`). Measurement uses one hidden layout pass with a
`ResizeObserver`, batched per animation frame.

### 8.5 File backstage

`File` opens `Backstage` over the window (not a ribbon panel): left rail of the spec's
`backstage` pages, page body from `src/shell/backstage/<pageId>.tsx` or the app override
`src/apps/<app>/backstage/<pageId>.tsx`; `action` children are buttons running their command or
dialog. Esc and the back arrow return to the previous tab (today's `Ribbon.tsx` behaviour is
kept). Save As, Export and Print are full pages with format lists and print preview, as
upstream; the current one-line `SaveAsDialog` is retired when an app flips.

### 8.6 QAT, keytips, contextual tabs, extensions

* The QAT lives in the title bar (`TitleBar.tsx`), from the spec's `quickAccessToolbar` plus the
  person's customization (`tools.customizeRibbon`, translated from wordcraft `engine/src/ribbon.rs`,
  saved in prefs; shared command in `core/common`).
* Alt shows keytips for tabs, then for the chosen tab's controls (`KeyTips.tsx`, translated from
  `ui-egui/src/keytips*`, letters from the overlays).
* Contextual tabs appear when their flag holds and take focus only when the selection *enters*
  that context (Office behaviour), never on every tick.
* `arkemisExtensions` (Arkemis-only controls such as Slate's notebook breadcrumb and linked
  values) render from `src/apps/<app>/extensions/<id>.tsx` in the slots the overlay assigns.

### 8.7 Pending controls

A control whose command is not in the registry is omitted in production and `--strict` builds.
With `ARKEMIS_SHOW_PENDING=1` (development) it renders hatched and disabled with the tooltip
"Not translated yet: <command id>", so layout can be reviewed against ArtCraft before every
command lands. Groups whose controls are all pending are omitted.

### 8.8 Inspectability

`ui.inspect` (15.3) returns the rendered ribbon: visible tab ids, contextual tabs, each visible
control's id, command, enabled, checked, value and collapsed state. E2E asserts against this, not
against DOM selectors.

---

## 9. Dialog framework

### 9.1 Four parts, one id

1. **Fields** in the spec (`dialogs[]`): tabs, every field, buttons, submit command, presentation.
2. **Geometry** (optional) in `docs/spec/layout/<app>/dialogs/<dialogId>.json`: size, sections,
   columns, field order, preview placement (translated from upstream `ui-egui/src/dialogs/*.rs`).
3. **Model** in `core/<app>/dialogs/<dialogId>.mjs` (pure, testable, runs headless):
   ```ts
   export default defineDialog({
     id: 'dialog.font',
     init(ctx): Values,                         // initial values from the selection (mixed -> null)
     derive?(values, changed: string[]): Partial<Values>,   // dependent fields
     validate(values): {field: string; message: string}[],
     preview?(ctx, values): PreviewModel,       // pure data the preview field draws
     buttons?: Record<string, (ctx, values) => {command: string; params: object}>, // in-dialog buttons
     toCommand(values): {command: string; params: object} | {batch: {command: string; params: object}[]},
   });
   ```
4. **View override** (optional) `src/apps/<app>/dialogs/<dialogId>.tsx` exporting
   `{Preview?, fields?: Record<string, FieldComponent>, Body?}` for custom previews (font sample,
   paragraph preview page, border box, page setup thumbnail, chart type gallery) and custom
   fields. Without an override, the generic renderer draws the whole dialog from parts 1–3.

### 9.2 Chrome and behaviour (`src/shell/dialogs/GlassDialog.tsx`)

* Liquid-glass panel (reusing `glass-dialogs.css` tokens: blurred translucent surface, 1 px inner
  highlight, soft shadow), title bar with title and close, draggable, sized from the overlay,
  never a one-line popup.
* Tabs across the top for multi-tab dialogs (Font: Font / Advanced; Paragraph: Indents and
  Spacing / Line and Page Breaks; Format Cells: Number / Alignment / Font / Border / Fill /
  Protection).
* Fields in labelled sections with one to three columns; units shown and parsed (`12 pt`,
  `2.54 cm`); spinners respond to arrow keys and the wheel.
* `preview` fields redraw on every value change (debounced 50 ms) from the model's `preview()`.
* Buttons as the spec lists them; Enter = OK, Esc = Cancel; `button` fields run their model
  handler; a field's `dialog` opens a nested dialog on the stack (More Colors from Font).
* `presentation` other than modal: `pane` renders the same dialog in `PaneHost`, `backstage` as a
  backstage page, `inline-bar` as a bar under the ribbon, `full-window` as a full window sheet.
* Modal with focus trap, focus restore, `aria-modal`, `aria-labelledby`.
* `DialogHost` holds the stack. `ui.dialog.*` bridge methods read and set the same values object
  the fields edit, so a dialog driven by the bridge and one driven by a person are identical.

### 9.3 Field library (`src/shell/fields/`)

`NumberField` (with units, min/max/step), `SelectField`, `ComboField`, `FontField` (virtualized,
each name in its own face), `Checkbox` (tri-state for mixed selections), `RadioGroup`,
`ColorField`, `TextField` (multiline, masked for passwords, never journaled), `ListField`
(single/multi-select listbox), `PreviewField` (hosts the model's preview), `ButtonField`,
`FileField` (main-process dialog, `accept`), plus `TabStopsField`, `BorderField`,
`ShortcutField` used by overrides.

### 9.4 Message boxes

Confirmations ("Do you want to save changes?") use `GlassDialog` with the message layout; they
are registered dialogs too, so the bridge can see and answer them.

---

## 10. Panes, context menus, mini toolbar, status bar

* **Panes** (`PaneHost`): Navigation, Styles, Clipboard, Format Shape/Picture, Selection,
  Comments, Thumbnails, Bookmarks, Slate's notebook list, section tabs and page list. Dock
  left/right/float, widths from upstream `panes.rs`; order and dock saved in prefs (wordcraft
  `ui.paneDock`). A pane is a lazy module `src/apps/<app>/panes/<paneId>.tsx`; it reads through
  queries and writes through commands only.
* **Context menus** from the normalized `contextMenus` by target (`text-selection`, `cell`,
  `shape`, `page`, `paragraph-handle`, ...), opened by the surface on right-click, Shift+F10 or
  the Menu key.
* **Mini toolbar** above a text selection (Quill, Prism, Slate) when the spec or overlay defines one.
* **Status bar** from the normalized `statusBar`: each item reads a query command and may run one
  (page x of y, words, language, track changes, view buttons, zoom slider).

---

## 11. Keyboard routing

* `KeyRouter` (one capture-phase `keydown` listener on the window) resolves, in order: open
  dialog scope → keytip mode → surface scope (contextual flags) → app scope. Bindings come from
  the spec's `shortcuts`, controls' `shortcut`, and commands' `shortcut`. `Mod` maps to Ctrl or
  Cmd by platform.
* The surface handles plain text input itself (EditContext or contenteditable); the router only
  claims chords and named keys that have a binding.
* Conflicts within a scope fail the generator. The existing per-editor `onKeyDownCapture`
  handlers go away when an app flips to the new host.
* `ui.key {keys:'Mod+B'}` on the bridge feeds the router directly (no OS or synthetic DOM input).

---

## 12. Icon pipeline

### 12.1 Source

`assets/icons/ribbon/<iconId>.svg`, one file per icon id. Ids come from the spec's `icon` fields
(kebab-case, e.g. `clipboard-paste`, `paste-keep-source`, `arrow-left-circle`, `window-dock`);
patches may rename. Optional large variant `<iconId>.32.svg` when the 32 px drawing needs more
detail than a scaled 24 px one.

### 12.2 Drawing rules (enforced by `scripts/gen/icons.mjs`)

* Root `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` (`0 0 32 32` for `.32`),
  no width/height.
* Elements limited to `g path circle ellipse rect line polyline polygon`; no `style`, `script`,
  `foreignObject`, `image`, `use`, external `href`, ids, or event attributes.
* Paint: `currentColor` for strokes/fills; `class="accent"` for the part that shows a live color
  (font color bar, highlight, fill swatch, border color), painted with `var(--icon-accent)`;
  `class="tone"` for the soft second tone (`var(--icon-tone)`, about 35% of currentColor) that
  gives the Office-like two-tone look within the monochrome Arkemis skin.
* Stroke width 1.5 at 24 px, round caps and joins, 2 px keyline grid, coordinates on the half-pixel.
* Original, hand-authored drawings. Upstream `ui-egui/src/icons.rs` may be read to learn which
  concept an icon depicts, not traced. lucide (today's `RibbonIcon.tsx`) is not used in the new ribbon.

### 12.3 Output

`src/generated/icons.ts` exports `icons: Record<string, {d24: string; d32?: string}>` (sanitized
inner markup). `src/shell/icons/Icon.tsx` renders `<svg viewBox aria-hidden>` with that markup and
sets `--icon-accent` from the control's `state().value` for color controls. Sizes: 16 px for
small/medium controls, 32 px for large. A missing icon is a build error under `--strict`;
otherwise the control shows its label only and coverage lists it.

### 12.4 Ownership

The spec reuses icon ids across controls (Slate: 487 controls, 381 distinct icons). The generator
assigns each icon id one owner: the first unit, in app order quill, grid, prism, folio, slate and
then spec order, whose controls reference it, and writes `artifacts/coverage/icons.json`. Only
the owner creates the file; others reuse it. Shared basics (`undo`, `redo`, `save`, `cut`,
`copy`, `clipboard-paste`, `bold`, `italic`, `underline`, alignments, bullets, numbering) are
drawn by the integrator in Phase 0 so no unit waits on them.

---

## 13. Window chrome, no diagnostics

* `TitleBar` keeps today's custom traffic lights (`WindowControls.tsx`: close/minimize/maximize
  circles with glyphs on hover, dimmed when unfocused, `-webkit-app-region: no-drag`), then the
  QAT, the centered document title (rename in place), and the Tell-me search box, which searches
  `engine.commands` labels and runs the chosen command.
* macOS keeps `setWindowButtonVisibility(false)` so only the Arkemis lights show.
* **No diagnostics UI in production:** `src/shell/diagnostics/` is imported only behind
  `if (process.env.ARKEMIS_DIAGNOSTICS === '1')`, which esbuild `define`s to `"0"` in production so
  the code is dropped. Production has no metrics panel, no warnings console, no bridge token
  display. `studio:metrics` answers only in test mode or with a development data folder.
* No renderer ever receives a token: the test transport's token lives only in the main process and the
  test data folder.

---

## 14. Document addressing

### 14.1 Grammar

Addresses are doc-relative strings; the document is named separately (`doc` param), as in
ArtCraft's control protocol.

```
address  := anchor | path
anchor   := "@a" digits                      ; sticky, session-scoped (4.3)
path     := ("/" segment)+
segment  := kind [":" key]
text     := "t:" from ["-" to]               ; UTF-16 code units, to exclusive; "t:5" is a caret
```

Every read result includes the canonical address of every node it returns, so clients never build
addresses by guesswork. Inputs also accept friendly forms (`Sheet1!B2:C9`, `slide 3`, `page 2`),
which the resolver canonicalizes and echoes back.

### 14.2 Quill

Stable ids are part of the schema-2 model: every block (paragraph, table, row, cell, content
control) has `id` (8 chars base36), created on insert/import and kept through edits (a split keeps
the id on the first half and gives the second a new id; a merge keeps the first). DOCX import and
export map paragraph ids to `w14:paraId`, so ids survive round trips through Word.

| Address | Meaning |
|---|---|
| `/body` | main story |
| `/hdr:<sectionId>.default`, `.first`, `.even`; `/ftr:...` | header/footer stories |
| `/fn:<noteId>` `/en:<noteId>` `/cmt:<commentId>` `/tbx:<shapeId>` | footnote, endnote, comment, text-box stories |
| `/body/b:<blockId>` | a paragraph or table |
| `/body/b:<tableId>/r:<rowId>/c:<cellId>/b:<blockId>` | block inside a table cell (nests) |
| `/body/b:<blockId>/t:4-9` | characters 4..9 of a paragraph's text |
| `/body/b:<blockId>/o:<objectId>` | inline object: picture, shape anchor, field, equation, content control |
| `/sec:<sectionId>` `/style:<styleId>` `/list:<numId>` `/bm:<name>` `/rev:<revisionId>` | non-flow objects |
| `/page:<n>` | layout-derived page (read-only, 1-based, changes with reflow) |

### 14.3 Grid

Cells use A1 because spreadsheet semantics define them: inserting a row moves `B7` to `B8`, and
anchors and defined names track it exactly as gridcraft adjusts references. Sheets use stable ids.

| Address | Meaning |
|---|---|
| `/sh:<sheetId>` | sheet |
| `/sh:<sheetId>/B7`, `/sh:<sheetId>/A1:C9`, `/sh:<sheetId>/A1:B2,D4` | cell, range, multi-area |
| `/sh:<sheetId>/row:5`, `/rows:5-9`, `/col:C`, `/cols:C-F` | whole rows/columns |
| `/sh:<sheetId>/B2/t:0-4` | a run inside a rich-text cell |
| `/tbl:<name>`, `/tbl:<name>/col:<columnName>` | table, table column |
| `/name:<definedName>` | defined name |
| `/sh:<id>/chart:<id>`, `/sh:<id>/shape:<id>`, `/sh:<id>/pic:<id>` | drawing objects |
| `/sh:<id>/note:B7`, `/sh:<id>/cf:<ruleId>`, `/sh:<id>/dv:<ruleId>` | note/comment, conditional format, validation |
| `/pivot:<id>`, `/slicer:<id>` | pivot table, slicer |

Results always return both forms: `{address:'/sh:k3f/A1:C9', a1:'Sheet1!A1:C9'}`.

### 14.4 Prism

Shape text is one UTF-16 string per text body with `\n` between paragraphs (the PowerPoint
TextRange model), so a run inside paragraph 3 is a plain offset range.

| Address | Meaning |
|---|---|
| `/sl:<slideId>` | slide |
| `/sl:<slideId>/sp:<shapeId>`, `/sl:<id>/sp:<groupId>/sp:<childId>` | shape, grouped shape |
| `/sl:<id>/sp:<shapeId>/t:3-8` | text in a shape |
| `/sl:<id>/sp:<tableId>/r:<i>/c:<j>/t:0-4` | table cell text |
| `/sl:<id>/notes/t:0-12` | speaker notes |
| `/layout:<id>`, `/master:<id>`, `/sec:<id>` | layouts, masters, sections |
| `/sl:<id>/anim:<effectId>`, `/sl:<id>/transition`, `/cmt:<id>` | animation effect, transition, comment |

### 14.5 PDF (`folio`)

Page ids already exist in `PdfContent`; annotation ids come from `/NM` or are assigned and
written back. Coordinates are points, crop-box relative, origin top-left (the current bridge
convention).

| Address | Meaning |
|---|---|
| `/pg:<pageId>` | page |
| `/pg:<pageId>/annot:<annotId>` | annotation (comment, highlight, ink, stamp, link, redaction mark) |
| `/pg:<pageId>/chars:<from>-<to>` | page text in reading order (UTF-16 over extracted text) |
| `/pg:<pageId>/word:<n>` | nth word with its quad |
| `/pg:<pageId>/text:<index>.<hash>` | an editable content-stream text object; the hash detects staleness |
| `/pg:<pageId>/rect:<x>,<y>,<w>,<h>` | a region (redact, crop, stamp, OCR) |
| `/field:<fullyQualifiedName>`, `/sig:<fieldName>` | form field, signature field |
| `/bm:<id>`, `/layer:<ocgId>`, `/att:<name>`, `/label:<startPage>` | bookmark, layer, attachment, page-label range |

### 14.6 Slate

The spec's data model is notebook → section groups → sections → pages. Vault documents stay one
file per page (today's model), with notebook/section ids in metadata; inside a page, Quill's body
grammar without stories, plus page-level containers: `/meta` (title, created, color, rule lines),
`/b:<blockId>`, `/b:<blockId>/t:0-5`, `/b:<tableId>/r:<i>/c:<j>/b:<blockId>`, `/ink:<strokeId>`,
`/tag:<blockId>.<tagId>` (paragraph tags), `/media:<id>`. Notebook-level addresses
(`/nb:<id>`, `/nb:<id>/sec:<id>`) are accepted by notebook commands with `doc:null`. Block ids are
ProseMirror node attrs added by the Slate schema.

### 14.7 Resolver contract (`core/<app>/address.mjs`, foundation-owned)

```ts
export function parse(s: string): AddressAst;            // throws invalid_address
export function format(ast: AddressAst): string;
export function resolve(content, ast): Resolved;          // {kind, node, parentPath, ...}; throws not_found
export function canonical(content, input: string): string;// friendly -> canonical
export function mapThrough(op: Op, ast: AddressAst): AddressAst | {deleted: true; nearest?: AddressAst};
export function enumerate(content, scope: AddressAst, opts: {depth: number; cursor?: string; limit: number}):
  {nodes: InspectNode[]; cursor?: string};
export function read(content, ast, as: 'text'|'runs'|'props'|'values'|'formulas'|'display'|'json'): unknown;
```

---

## 15. Automation layer

The automation layer lets a program drive documents and the editors' interface through the same
commands the ribbon and the keyboard run. The end-to-end tests are its only client: it is routed
only in test mode (a development checkout started with `ARKEMIS_STUDIO_TEST=1`, never a packaged
build). A normal run opens no port and accepts no outside requests.

### 15.1 Test transport

`electron/test-rpc-server.cjs`: a loopback HTTP server started by `main.cjs` in test mode only.
Random 256-bit token, bound to 127.0.0.1 on a random port, `Origin` header rejected, `Host`
checked, constant-time bearer check. Its port, token and pid are written to
`<test data folder>/test-rpc.json` (removed on exit), where `tests/e2e/harness.mjs` reads them.

| Route | Purpose |
|---|---|
| `POST /v2/rpc` | `{"id":1,"method":"...","params":{...}}` or an array (batch). Reply `{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":{"code","message","data"}}`. 16 MB body cap. |
| `GET /v2/events` | Server-Sent Events: `doc.changed`, `doc.saved`, `selection.changed`, `document.opened`, `document.closed`, `dialog.opened`, `dialog.closed`; each carries `doc`, `version` and changed addresses. |

### 15.2 Background start (test mode)

`--background` starts without showing a window; `documents.open` shows one, or with
`{show:false}` opens the document in a hidden window so view commands can run without taking
the screen.

### 15.3 Methods

| Method | Params | Result |
|---|---|---|
| `app.describe` | — | product, appVersion, protocol, address grammar version, limits, open documents |
| `documents.list` | `kind?` | vault documents: `id, kind, title, storeRevision, open, version?` |
| `documents.create` | `kind, title?` | `{doc}` |
| `documents.open` | `doc, show?` | opens in a window (`show:false` = hidden window) |
| `documents.close` | `doc, save?` | `destructive` when unsaved and `save:false` |
| `documents.delete` | `doc` | moves to the vault trash; `destructive` |
| `engine.commands` | `search?, family?, doc?` | id, label, ribbon paths, shortcut, description, params JSON Schema, risk, needs, enabled, disabledReason |
| `engine.execute` | `doc, command, params, baseVersion?, dryRun?, approval?` | `{result, version, changed, undoLabel}` |
| `engine.batch` | `doc, steps, label, baseVersion?, approval?` | one undo entry, all or nothing |
| `document.inspect` | `doc, address?, depth?, cursor?, limit?` | tree of nodes with canonical addresses, paged |
| `document.read` | `doc, address, as` | precise state: text, runs with props, cell value/formula/display/style, shape geometry, annotation dictionary |
| `document.find` | `doc, query, scope?, regex?, matchCase?, wholeWord?, limit?` | matching address ranges with context |
| `document.anchor` | `doc, address` | `{anchor:'@a12'}` |
| `document.render` | `doc, target, scale?` | PNG (base64) of a page, slide or range, to check the visual result |
| `selection.get` / `selection.set` | `doc, ranges?` | selection as addresses |
| `ui.inspect` | — | active document, tab, contextual tabs, ribbon control states, open dialog with values, panes, zoom, view |
| `ui.tab` | `id` | switch ribbon tab |
| `ui.activate` | `control` | press a ribbon/QAT/backstage control through its normal handler |
| `ui.dialog.open` / `.get` / `.set` / `.submit` / `.cancel` | `id, field, value, button` | drive a dialog's model |
| `ui.pane` | `id, open` | show/hide a task pane |
| `ui.key` | `keys` | route a chord through KeyRouter |
| `ui.capture` | `target?` | PNG of the window via `webContents.capturePage` |

`engine.execute` with a `needs:'view'` command, or any `ui.*` method, on a document with no open
window returns `unavailable` with `data.hint: 'documents.open'`.

### 15.4 Routing (`electron/rpc-router.cjs`)

* If a window in this process has `doc` open, the request goes to that window's renderer over a
  dedicated IPC pair (`studio:rpc` → `studio:rpc-reply`, correlation id, 30 s timeout, sender
  verified with the existing `verify`). `RendererBridge.ts` runs it on the live `Session`, so the
  person sees the change, it lands on the same undo stack, and autosave persists it.
* Otherwise `electron/headless-host.mjs` loads the file from the store, runs the same command on
  a main-process `Session` (`host.kind:'headless'`, worker available, no view), writes with the
  store's revision check, and broadcasts `studio:changed` as today.
* PDF worker operations from either host go through the existing `format-worker.cjs` thread.
* One writer per document: a document is either live in a window or edited headless, never both.

### 15.6 Errors

`invalid_params`, `invalid_address`, `not_found`, `conflict` (409), `disabled`, `unavailable`,
`approval_required` (428), `approval_invalid`, `failed`, `too_large` (413), `timeout`. `data`
carries specifics (JSON-Schema path, current version, disabled reason, approval request).

### 15.7 Approval model

* `read`, `edit`: run immediately. Edits are undoable and show in the app's Undo list as
  "Automation: <label>".
* `destructive`, `irreversible` from `origin:'bridge'` (the automation layer): the app computes
  `summary(ctx, params)` itself and replies `approval_required` with
  `data: {nonce, summary, reason, risk, command, expires}`. The nonce is bound to
  `sha256(doc, command, canonical params, version)`, single use, and expires in 5 minutes. The
  caller resends with `approval: {nonce}`; in tests the scripted approval answers
  (`test.dialogs` with `{type:'approval', allow}`).
* After an approved destructive action runs, the window shows a small toast "Automation: <summary>".

---

## 16. Editing surfaces per app

### 16.1 Quill — recommendation: translate wordcraft `doc` + `layout`, own page view

TipTap/ProseMirror is a continuous-flow editor. ArtCraft's Word flow depends on real pagination:
sections with their own page size, orientation and columns; headers and footers per section and
first/even page; footnotes placed on the page that references them; floating objects with text
wrap; line numbering; keep-with-next and widow control; page and column breaks; text boxes; Print
Layout, Read Mode, Web Layout, Outline and Draft views; page-accurate print and PDF export. None of
these can be done faithfully on top of ProseMirror's DOM, and approximations would break the 1:1
requirement and every page-dependent command (fields, TOC, cross-references, Go To page).

Design:

* `core/quill/model/` translates `wordcraft/crates/doc` (blocks, runs, `CharProps`, `ParaProps`,
  styles, numbering, sections, stories, revisions, comments, fields) with stable block ids.
* `core/quill/layout/` translates `wordcraft/crates/layout` (`para/*` line breaking, bidi,
  justify, tabs; `flow.rs`, `page.rs`, `floats.rs`, `table*.rs`, `notes.rs`, `headers.rs`,
  `fields.rs`, `hit.rs`, `display/*`, `cache.rs`). Its text-shaper interface is backed by
  `Canvas2D measureText` in the renderer (installed fonts are already enumerated by
  `core/installed-fonts.cjs`) instead of translating a Rust shaper; complex scripts use the
  browser's shaping through measured clusters. Layout is incremental per block with a cache.
* Headless page information (page numbers for the bridge) comes from a hidden layout window (the
  existing `pdf-automation.html` pattern) when no window has the document open.
* `src/apps/quill/surface/PageView.tsx`: virtualized pages, each a `<canvas>` painting the
  display list, plus DOM overlays for selection, caret, comment balloons and object handles.
  Text input through the **EditContext API** (available in Electron 44's Chromium) with IME
  composition; a hidden accessible mirror of the visible pages (translated from wordcraft
  `a11y.rs`) for screen readers; hit-testing from translated `hit.rs`.
* Migration: `core/quill/migrate.mjs` converts schema-1 ProseMirror JSON to the schema-2 model.
  The legacy `RichEditor` keeps serving Quill until `src/apps/quill/manifest.ts` sets
  `ready:true`, which requires the Quill gate (typing, IME, selection, undo, tables, page breaks,
  print, DOCX round trip) to pass. No adapter between TipTap and the new model is built.

Critical path: model → layout → page view. Command units start as soon as the model exists (they
are tested headless); UI wiring follows the page view.

### 16.2 Grid — canvas virtual grid

Translate `gridcraft/crates/{core,model,calc,formula,functions,numfmt,chart}` into `core/grid/*`
(the existing `core/formulas.mjs` and `core/gridcraft-*.mjs` translations are folded in by the
foundation, then retired). Limits follow gridcraft (1,048,576 × 16,384), cells chunked in 256-row
blocks. Surface `src/apps/grid/surface/GridCanvas.tsx` paints visible cells, headers, gridlines,
borders, conditional formats, sparklines and selection on canvas (translated from
`ui-egui/src/grid*`), with DOM overlays for the in-cell editor, formula bar, autocomplete, charts,
pictures, comments and filter dropdowns. Recalculation moves to a worker above a workbook-size
threshold so typing stays responsive.

### 16.3 Prism — DOM/SVG slide canvas

Translate `deckcraft/crates/{model,geom,text,color,anim}`. Shapes render as SVG paths from the
translated preset geometry; text bodies render as positioned HTML with autofit and line breaking
computed by the translated `text` crate on Canvas2D metrics, so they match export. The slide show
runs in a separate full-screen window driven by the same session (presenter view per deckcraft).
Media plays through `<video>`/`<audio>`; deckcraft's codec crates are not translated.

### 16.4 PDF (`folio`) — pdf.js render, PDFium/pdf-lib writes

Keep the current page rendering (pdf.js canvas) and the format worker (PDFium wasm, pdf-lib).
Translate `printcraft/crates/{engine,annot,forms,organize,edit,redact,sign,measure,content,...}`
logic into `core/folio/*`, with `needs:'worker'` for byte-level operations. Annotations, form
fields, text-edit boxes and measurement overlays are DOM layers over the page canvas.

### 16.5 Slate — keep TipTap/ProseMirror

Slate has no ArtCraft upstream; its spec models OneNote. `core/slate/schema.mjs` builds the
ProseMirror schema headlessly from `@tiptap/pm/model` (no DOM), and commands produce ProseMirror
steps (`@tiptap/pm/transform`) through the kernel's app-op hook, so the same command runs
headless and in the editor and the kernel's undo (TipTap history disabled) maps the caret
correctly. Notebooks, section groups, sections and pages from the spec's data model are vault
metadata managed by `notebook.*`/`section.*`/`page.*` commands; the page canvas is TipTap with
note containers, ink as an SVG overlay, and rule lines/backgrounds as page styles.

---

## 17. Test strategy

### 17.1 Unit (engine), `node --test`

* `tests/<app>/<family>.test.mjs` per family, using `core/kernel/testing.mjs`:
  ```js
  import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
  const s = await createTestSession('grid', {fixture: 'two-sheets'});
  await expectUndoRoundTrip(s, 'home.bold', {range: '/sh:s1/A1:B2'}, after => {
    assert.equal(after.read('/sh:s1/A1', 'props').bold, true);
  });
  ```
  `expectUndoRoundTrip` asserts: run changes the document; undo restores deep-equal content and
  selection; redo reproduces the run's content; `version` increments correctly.
* **Upstream ports first:** each family translates the upstream Rust tests for its module
  (`crates/engine/src/tests/*` and `#[test]` functions in the module) into
  `tests/<app>/upstream/<module>_<test>.test.mjs`, naming the Rust test in the test title. These
  are the parity evidence.
* Every command test also runs through `session.execute` with `origin:'bridge'` to prove params
  validation and the risk gate.
* Kernel tests (`tests/kernel/`): rollback on throw, structural sharing, anchors, approval nonces
  bound to params, version conflicts.

### 17.2 Dialog and spec tests

* Dialog models: `init` from fixtures, `validate` errors, `toCommand` output, `preview` data.
* `npm run generate -- --check` validates spec ↔ overlays ↔ patches ↔ registry ↔ icons.

### 17.3 Conformance (integrator-written, driven by generated data)

`tests/conformance/registry.test.mjs` iterates `core/generated/manifest.json`: every command has
label, risk and params; params compile to valid JSON Schema; `edit` commands have `undo:'auto'`;
destructive/irreversible commands implement `summary`; every command id appears in at least one
test file; every spec dialog with a registered submit command has a model; spec control `args`
validate. Spec commands not yet implemented are reported, not failed, until a `--strict` release.

### 17.4 Bridge contract tests (no Electron)

`tests/bridge/*.test.mjs` start the test transport (`electron/test-rpc-server.cjs`) against a temporary
store and the headless host in-process, covering auth, origin/host checks, every method's happy path, errors,
`approval_required` → resend with nonce, nonce replay rejected, conflicts, batch atomicity and SSE.

### 17.5 Bridge-driven E2E (Electron, no input devices)

* `tests/e2e/harness.mjs` spawns Electron (`electron . --product=<p>`) with
  `ARKEMIS_STUDIO_DATA=<temp vault>` and `ARKEMIS_STUDIO_TEST=1`. In test mode `main.cjs` shows
  windows with `showInactive()` and `setFocusable(false)`, so tests never take focus and can run
  in parallel.
* The harness reads `test-rpc.json` from the temp vault and drives everything through the test
  transport (`tests/e2e/rpc-client.mjs`): `documents.create/open`, `ui.tab`, `ui.activate` (press a ribbon control
  through its real handler), `ui.dialog.open/set/submit`, `ui.key` (KeyRouter), `engine.execute`,
  and asserts with `ui.inspect`, `document.read`, `selection.get`. Visual evidence comes from
  `ui.capture` (`webContents.capturePage`) saved to `artifacts/e2e/<app>/<flow>/`.
* **Forbidden** in `tests/e2e/**`: Playwright `click`, `fill`, `press`, `type`, `keyboard`,
  `mouse`, `page.screenshot`, and any OS input. `scripts/lint-e2e.mjs` fails on them and runs
  before the E2E suite.
* `scripts/verify-bridge-e2e.mjs` discovers `tests/e2e/**/*.e2e.mjs` and runs them with a
  concurrency limit (default 4), a 4-minute per-test timeout, and kills only its own process trees.
  The existing `scripts/verify-desktop.mjs` and its Playwright suites stay as legacy regression
  checks until each app flips.
* Per-app gate flows (must pass before `manifest.ready=true`): create; edit through ribbon and
  shortcuts; every dialog of the app opened and submitted once; contextual tabs appear and
  disappear; undo/redo of bridge and UI edits; save/reopen; import/export round trip per format;
  print to PDF; bridge read-back of every address kind.

---

## 18. Shared files

A few files are shared by every app: `package.json`, `.gitignore`, `scripts/build.mjs`,
`electron/main.cjs`, `electron/preload.cjs`, `electron/format-worker.cjs`, `core/model.mjs`,
`src/App.tsx` and `src/types.ts`. During the original build-out they were changed once, before the
per-app work started, and every other contribution only added files in the folders it owned
(section 3). Change them deliberately and review them together; everything else is found by the
generator from folder contents.

---

## 19. How the apps were built out

Phase 0 built the kernel, generator, shell, automation layer and test harness. Phase 1 built
one foundation per app (`core/<app>/{model,address,schema,context,migrate}.mjs`, `lib/`, the
editing surface and `manifest.ts`) and the ribbon layout overlays. Phase 2 translated one
command family per unit, each with its upstream tests ported, undo round trips, dialogs, icons
and E2E flows. Phase 3 flipped each app's `manifest.ready` once its E2E gate passed.

---

## 20. Risks and open points

* **Quill's page view is a large translation** (layout crate, EditContext input, accessibility
  mirror). Mitigation: commands proceed headless in parallel; the legacy TipTap editor ships until
  the gate passes; layout is translated together with its upstream tests (`layout/src/tests/*`).
* **Canvas text metrics vs the upstream shaper**: line breaks may differ from wordcraft in edge
  cases (ligatures, kerning, complex scripts). Port wordcraft's layout tests and accept a
  difference only where the browser shaper is more correct; record each in coverage.
* **Performance of immutable changes** on very large documents depends on foundations chunking
  their models (4.2); each foundation ships a benchmark before units start.
* **Spec gaps**: the spec carries no ribbon geometry (sizes, rows/stacks, launchers, keytips,
  collapse order); layout overlays (7.3) fill this and are a Phase 1 dependency for faithful
  placement. Only `slate.json` exists at the time of writing; the generator treats a missing spec
  as "legacy ribbon" for that app.
* **Ownership drift**: every unit runs `--check-ownership` before committing; commits that touch
  shared files after Phase 0 are rejected.
* **Upstream commit pins** for gridcraft, deckcraft and printcraft must be recorded in their specs
  (`upstream.commit`); wordcraft is pinned at `3de6ff95af86c19d67030cd96dba15cd6a45a25e`.
