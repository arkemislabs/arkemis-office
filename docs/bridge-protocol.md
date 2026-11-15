# Automation protocol: main process and renderer

The contract between the main-process side of the automation layer (`electron/rpc-router.cjs`,
`electron/headless-host.mjs`, `electron/preload.cjs`, the test transport
`electron/test-rpc-server.cjs`) and the renderer side (`src/shell/bridge/RendererBridge.ts`).
Implements docs/architecture.md section 15.

The automation layer drives documents and the editors' interface the way their own controls do.
It is used by the end-to-end test harness (`tests/e2e/harness.mjs`) and the contract tests in
`tests/bridge/`. It is only routed in test mode: a development checkout started with
`ARKEMIS_STUDIO_TEST=1`. A normal run of the app opens no port and accepts no outside requests.

---

## 1. Who answers what

A request on `/v2/rpc` is answered by
exactly one of three places:

| Answered by | Methods |
|---|---|
| **main** (`rpc-router.cjs`) | `app.describe`, `documents.list`, `documents.create`, `documents.open`, `documents.delete`, `ui.capture` |
| **the window that has `doc` live** (renderer, over IPC) | `engine.commands {doc}`, `engine.execute`, `engine.batch`, `document.*`, `selection.*`, `documents.close`, `ui.*` (except `ui.capture`) |
| **headless host** (main-process `Session`, `headless-host.mjs`) | the same document methods when no window has `doc` live; `ui.*` and `document.render` there return `unavailable` with `data.hint: 'documents.open'` |

A window "has a document live" when its latest `documents` notification (section 3.3) lists it.
One writer per document: when a window claims a document the headless host was holding, the
headless host drops it first (its edits are already saved; its undo history is not carried over).

`ui.*` requests without `doc` go to the window whose last `documents` notification said it is
active (`active` set), else the first window that sent `hello`. If no window speaks the protocol
they return `unavailable`.

---

## 2. IPC channels

| Channel | Direction | API | Payload |
|---|---|---|---|
| `studio:rpc` | main → renderer | `webContents.send` | `RpcRequest` |
| `studio:rpc-reply` | renderer → main | `ipcRenderer.send` | `RpcReply` |
| `studio:rpc-notify` | renderer → main | `ipcRenderer.send` | `RpcNotify` |

The preload owns the plumbing; the renderer never touches `ipcRenderer` directly.

```ts
// Main → renderer
interface RpcRequest {
  id: string | null;            // correlation id ("r17"); null = notification, never replied to
  method: string;               // e.g. 'engine.execute', 'ui.dialog.set', 'ui.toast'
  params: Record<string, unknown>;
  origin: 'bridge';             // run every command with ExecOpts.origin = 'bridge'
}

// Renderer → main (sent by the preload when the handler resolves or throws)
type RpcReply =
  | {id: string; ok: true; result: unknown}
  | {id: string; ok: false; error: {code: string; message: string; data?: unknown}};

// Renderer → main, any time
type RpcNotify =
  | {type: 'hello'; protocol: 2; methods: string[]}        // RendererBridge mounted
  | {type: 'documents'; docs: LiveDoc[]; active: string | null}
  | {type: 'event'; event: BridgeEvent}
  | {type: 'bye'};                                        // RendererBridge unmounted

interface LiveDoc { doc: string; kind: 'quill'|'grid'|'prism'|'folio'|'slate'; title: string;
                    version: number; dirty: boolean; storeRevision: number }
```

Rules:

* `error.code` is one of the kernel codes (`core/kernel/errors.mjs`): `invalid_params`,
  `invalid_address`, `not_found`, `conflict`, `disabled`, `unavailable`, `approval_required`,
  `approval_invalid`, `failed`, `too_large`, `timeout`. A thrown value without a known code is
  sent as `failed`. `data` must be JSON (the preload round-trips it through `JSON`).
* Main verifies every reply and notification: the sender must be the main frame of one of the
  app's windows, loaded from `studio://app/`, and a reply's `id` must be pending **for that same
  window**. Anything else is dropped. A request with no reply in 30 s fails with `timeout`.
* Replies larger than 16 MB fail with `too_large` on the HTTP side.

### 2.1 Preload API (`window.studio`)

```ts
interface StudioAPI {
  // ...existing members...
  /** Register the RPC handler (the last registration wins). The preload replies for you:
   *  a resolved value becomes {ok:true,result}, a throw becomes {ok:false,error}.
   *  Notifications (id === null) are passed to the handler but never replied to.
   *  Returns an unsubscribe function. */
  onRpc(handler: (request: RpcRequest) => unknown | Promise<unknown>): () => void;
  /** Tell main which documents are live, forward session events, say hello/bye. */
  rpcNotify(message: RpcNotify): void;
  // removed: bridge()  (the token never reaches the renderer)
}
```

`src/types.ts` should add `onRpc` and `rpcNotify` and drop `bridge` (owned by the shell pass).

---

## 3. What RendererBridge does

### 3.1 Mount

1. `const off = studio.onRpc(handle)`; then `studio.rpcNotify({type:'hello', protocol: 2, methods})`.
2. Send `{type:'documents', docs, active}` immediately and again whenever the set of open
   documents, the active document, or a document's `dirty` flag changes (version changes do not
   need a notification; main reads versions from events).
3. Subscribe to the live `Session` and forward these event types as
   `{type:'event', event}`: `doc.changed`, `doc.saved`, `selection.changed`,
   `document.opened`, `document.closed`, plus `dialog.opened` / `dialog.closed` from the dialog
   host (`{type, doc, version, dialog: id}`). Other event types are ignored by main.
4. On unmount: `studio.rpcNotify({type:'bye'})` and `off()`.

### 3.2 Handling requests

Use the shared implementation for everything that only needs the `Session`:

```ts
import {createRpcMethods} from '../../../core/kernel/rpc-methods.mjs';
const methods = createRpcMethods(session, {manifest});   // manifest: core/generated/manifest.json (optional)
// methods.has(method) / await methods.call(method, params)
```

`createRpcMethods` implements `engine.commands`, `engine.execute`, `engine.batch`,
`document.inspect`, `document.read`, `document.find`, `document.anchor`, `selection.get`,
`selection.set`, and validates their params. It always runs commands with `origin:'bridge'`,
so the kernel's approval gate and the "Automation: <label>" undo labels apply. The headless host
uses the very same module, so both paths answer identically.

RendererBridge adds the methods that need the live UI:

| Method | Params | Result |
|---|---|---|
| `documents.close` | `doc, save?` | run `file.close` through the session (`{save:true}` or, for `save:false`, `{force:true}`) so the kernel gate asks for approval when unsaved changes would be lost; then close the tab. `{closed:true}` |
| `document.render` | `doc, target, scale?` | `{png: base64, width, height}` of a page/slide/range |
| `ui.inspect` | `doc?` | `{doc, tab, contextualTabs, controls:[{id, command, enabled, checked, value}], dialog:{id, values}|null, panes, zoom, view}` |
| `ui.tab` | `id` | `{tab}` |
| `ui.activate` | `control` | the control's handler result (it runs the command with origin `bridge`) |
| `ui.menu` | `control, open?` | `{menu}`: opens (or with `open: false` closes) the drop-down of a menu, split or gallery control, as its arrow does |
| `ui.dialog.open` / `.get` / `.set` / `.submit` / `.cancel` | `id`, `field`, `value`, `button`, `approval?` | `{id, values}`; `.submit` returns the `ExecResult` |
| `ui.pane` | `id, open, width?` | `{id, open}` (without `open` it toggles); `width` resizes the pane as its grip does (clamped to 200 to 640 px) |
| `ui.key` | `keys` | `{handled, command, scope, by}`: KeyRouter and the surface in the order a keystroke takes (3.2.1); never synthetic DOM input |
| `ui.keys` | `key, modifiers?` | one key straight to the surface (3.2.1); what the surface answers, e.g. `{handled, editing}` |
| `ui.pointer` | `action` or `events`, plus the surface's own params (3.2.1) | what the surface answers, e.g. `{sel}`, `{selection}`, `{container}` |
| `ui.type` | `text` (at most 1,000,000 characters) | what the surface answers, e.g. `{typed: n}` |
| `ui.toast` (notification, `id:null`) | `text, risk` | show the small "Automation: <summary>" toast; no reply |

`engine.execute` on a `needs:'view'` command runs it in the window (the window has a view).
Unknown methods: throw `{code:'not_found'}`.

#### 3.2.1 Surface input: `ui.pointer`, `ui.type`, `ui.keys` and the `ui.key` fallback

The editing surface registers a `SurfaceHandle` (src/shell/engine/ShellController.ts) with
optional input members. RendererBridge forwards the request to them; the surface performs the
gesture through the same code its own pointer and keyboard handlers run (selection, hit testing,
drag, typing, caret keys). No DOM or OS event is made, so a test never moves the person's mouse
or types on their keyboard, and a window that is not focused still takes the input.

| Handle member | Bridge method | Params the surface receives |
|---|---|---|
| `pointer(params)` | `ui.pointer` | the request params without `doc` and `approval`. Each app documents its own shape: Quill `{action: click/doubleClick/tripleClick/drag, page (0-based), x, y (points), to?, modifiers?}` and the shared ink action `{action: 'stroke', path, page? (0-based, default the first)}` (below); Grid `{action: click/doubleClick/drag, x?, y?, cell?: 'D4', to?, target?: 'fillHandle', modifiers?}`; Prism `{events: [{kind, x, y, pressure?}], mods?, tol?}` (deckcraft `control.rs`); PDF `{page, action: click/double/triple/drag/move, x, y, to?, path?, alt?, shift?, ctrl?}`; Slate `{action: click/drag/stroke, x, y, to?, path?: [[x, y], ...], target?: 'bar:<id>'/'width:<id>'/'ink'/'space'/'selection'}` (`path` is the pointer's samples and stands in for x, y and `to`: with the active Draw tool, target `ink` draws a pen, pencil or highlighter stroke along it, outlines a shape from its first to last point, erases along it or lassos the loop it makes; target `selection` moves the selected ink by `to` minus the start; a click with the Lasso selects the stroke under the point) |
| `type(text)` | `ui.type` | the text, typed at the surface's caret one character at a time as the keyboard types it (`\n` a new paragraph or Enter, `\t` Tab, `\b` Backspace where the surface supports them) |
| `keys(key, modifiers)` | `ui.keys`, `ui.key` | `key` is the DOM key name (`ArrowLeft`, `Enter`, `F2`, `a`), `modifiers` lower-case (`shift`, `ctrl`, `alt`, `meta`) |
| `key(key, mods)` | `ui.keys`, `ui.key` | deckcraft's `Session::key` shape, used when `keys` is absent: `{shift, ctrl, alt, meta, cmd}` |

**The ink action.** Quill and Slate (OneNote) take the same `ui.pointer {action: 'stroke', path, ...}`: `path` is the pointer's samples, `[[x, y], ...]` or `[{x, y, ...}, ...]` (Quill takes both forms), and what the stroke does is the Draw tool picked: a pen, pencil or highlighter draws ink along it, a shape is outlined from its first to last point (Ink to Shape), the eraser erases along it, the lasso selects the loop it makes or moves the selection it started in. Quill adds `page` (0-based, default the first; `path` is in page points) and, with no Draw tool picked, takes the stroke as a drag from its first point to its last; Slate adds `target`. Quill's earlier `{action: 'draw', page, points}` still works as a deprecated alias.

A surface that has no such member answers `unavailable` ("The <app> surface does not take
pointer gestures over the bridge"); so does a window whose File tab covers the document (close it
with `ui.key Escape` first). A missing `action`/`events` or `text` is `invalid_params`.

`ui.key {keys}` runs each chord of the sequence in the order a keystroke takes in the window
(`ShellController.keyWithSurface`):

1. Keys a focused editing field owns (printable characters, caret and selection keys,
   Backspace/Delete, Ctrl+Z/Y/A/C/X/V) go to the surface first, and reach the shortcut table only
   when the surface answers `{handled: false}`.
2. Every other chord goes to KeyRouter first; when nothing is bound to it there (Escape, F2, Enter
   in a grid, Shift+Arrow in a document), the surface gets it.
3. A surface that registers only deckcraft's `key` is asked first for every chord (deckcraft:
   engine keys, then the registry's shortcuts).
4. The surface is skipped while a modal dialog, the File tab, a menu or keytips have the keyboard.

The answer names who took each chord: `by: 'surface'` or `'shortcut'` (or `null` when neither did).

#### 3.2.2 Status values and zoom a surface reports

`SurfaceHandle.status?()` returns values for status-bar items that have no command (Quill
`{'status.page': {page, pages}, 'status.words': {words, selected}}`); StatusBar re-reads them on
every session or shell tick. `SurfaceHandle.zoom?()` returns the percent the person sees when the
view is in a fit mode (`view.fit` set: PowerPoint's Fit, PDF's Fit Page), which StatusBar shows
instead of `view.zoom`.

### 3.3 Approvals

The renderer never shows its own modal for bridge requests. The kernel gate throws
`approval_required` with `data: {nonce, summary, reason, risk, command, expires}`; the preload
returns it as an error reply; the client (in tests, the scripted approval) answers and resends the same request with
`approval: {nonce}`, which the router forwards to the same window. After an approved
destructive or irreversible request succeeds, main sends a `ui.toast` notification
(`{text: 'Automation: ' + summary, risk}`) to the window that ran it.

Error transport: Electron's context bridge copies a thrown `Error` with its message only, so the
handler RendererBridge gives `studio.onRpc` throws `toCommandError(e).toJSON()`, a plain
`{code, message, data}` object the bridge copies whole; the preload's `errorJson` reads the three
fields. That is what lets `approval_required` (with its nonce), `invalid_params` paths and
`conflict` versions reach a client for a document that is open in a window.

---

## 4. HTTP surface (test transport)

All routes need `Authorization: Bearer <token>` from `<test data folder>/test-rpc.json`, `Host:
127.0.0.1:<port>` and no `Origin` header (section 15.1).

### 4.1 `POST /v2/rpc`

Body: `{"id":1,"method":"engine.execute","params":{...}}` or an array of up to 100 of them.
Reply: `{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":{"code","message","data"}}`.
A single failed request answers with the code's HTTP status (409 conflict, 428
approval_required, 413 too_large, ...); a batch always answers 200 with one reply per request.
Body cap 16 MB.

### 4.2 `GET /v2/events`

Server-Sent Events. Query: `doc=<id>` (only that document), `types=doc.changed,doc.saved`.
Each event: `id: <seq>`, `event: <type>`, `data: {type, doc, version, changed?, origin?, owner,
...}` where `owner` is `window` or `headless`. A `: ping` comment every 15 s keeps the stream
open. At most 32 subscribers.

---

## 5. Windows, background start and test mode (main)

* `--background` (test mode only): start without showing a window. `documents.open {doc}` shows a window;
  `documents.open {doc, show:false}` opens the document in a hidden window
  (`--studio-document=<id>` like a normal launch), so view commands and `ui.*` work without taking
  the screen. `documents.open` waits up to 15 s for the window to claim the document and returns
  `{doc, kind, title, window, shown, live, version?}`; `live:false` means the window does not run
  RendererBridge yet (no `hello` within 5 s: a legacy editor) and document methods keep going to
  the headless host. Hidden documents share one hidden window.
* A normal launch quits when the person closes its last visible window (hidden bridge windows
  close with it). A `--background` launch keeps running headless and exits after 30 minutes
  without bridge requests and with no visible window.
* `ARKEMIS_STUDIO_TEST=1`: every window is shown with `showInactive()` and is
  `setFocusable(false)`, so tests never take focus and can run in parallel. Every document opened
  with `documents.open` gets its own window and each goes live (tests/e2e/bridge/second-window.e2e.mjs).
  A renderer's load failures, crashes and console errors are written to main's stdout, which the
  E2E harness keeps as the app log (`ARKEMIS_E2E_READABLE=1` builds the dev renderer unminified so
  those lines name readable source).
* `ui.capture {doc? | window?}`: a PNG of the window that holds `doc`, of window `window` (an id
  from `documents.open` or `app.describe`, live or not), or of the active window.

---

## 6. Format modules (format worker)

`electron/format-worker.cjs` routes through `electron/formats-v2.cjs`: schema-2 documents go to
the app's format modules (indexed in `core/generated/<app>.formats.mjs`); a PDF whose content is
the folio model (`content.folio === 2`) is written by `core/folio/formats/pdf-write.mjs` when it
exists, else by `core/folio/model/pdf-write.mjs writeFolioPdf` (comments written as real
annotations); a schema-2 document whose writer has not been translated yet fails with a message
naming the format; schema-1 files keep `electron/formats.cjs`. On import, an app without a
schema-2 reader for the extension falls back to the schema-1 converter and its `migrate.mjs`
converts the result at once:

* `core/<app>/formats/<ext>-write.mjs` exports `write(file, {resolvedLinks}) -> Uint8Array | Buffer | string`.
* `core/<app>/formats/<ext>-read.mjs` exports `read(bytes: Uint8Array, {title, kind}) -> content`
  (schema-2 content; the worker wraps it in a file and validates it). Imports use schema 2 only
  for apps whose foundation is ready (`apps.mjs` entry with `ready: true` and
  `schema.createContent`).
* `file.save {path}` from the headless host exports through the same worker.

Opening an older document: both hosts (the renderer's EngineProvider and the headless host) run
`core/kernel/open-migrate.mjs migrateOnOpen` with the app's `core/<app>/migrate.mjs` when they
open a schema-1 file of an app whose foundation exports `migrateFile` (PDF: content upgraded in
place while `content.folio !== 2`). Every change then persists with its `schema`, so the stored
file becomes schema 2. `documents.create` makes schema-2 files for every app whose foundation
can create content (`schema.createContent`) once the new host edits that app.
