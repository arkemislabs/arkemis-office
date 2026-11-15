# Arkemis Office

A free, local-first desktop office suite built on Electron. Five apps share one engine and one
installer:

| App | For | Opens and saves |
|---|---|---|
| **Quill** | documents (like Word) | `.docx`, `.txt`, `.md`, `.html`; PDF export |
| **Grid** | spreadsheets (like Excel) | `.xlsx`, `.csv`, `.tsv`; HTML and PDF export |
| **Prism** | presentations (like PowerPoint) | `.pptx`; PDF export |
| **Slate** | notebooks (like OneNote) | notebooks as folders on disk |
| **PDF** (`folio`) | PDF viewing and editing (like Acrobat) | `.pdf` |

Everything runs on your computer. There is no account, no sign-in, no telemetry and no online
service: documents are ordinary files, spell checking and OCR run locally, and nothing is sent
anywhere.

Quill, Grid, Prism and PDF are translations into JavaScript of storytold's ArtCraft apps
(wordcraft, gridcraft, deckcraft, printcraft), with an Office-style ribbon. Slate follows OneNote.
See [THIRD_PARTY.md](THIRD_PARTY.md) for the upstream projects and their licences.

This is an active project, not a finished Microsoft Office replacement: keep your original files
when you rely on features the suite does not cover yet.

## Screenshots

_Screenshots of each app go here._

## Requirements

- Node.js 24 or later and npm
- Windows 10/11 or macOS (Linux builds are untested)

## Build and run

```sh
npm install
npm start            # builds, then opens the launcher for all five apps
npm run start:quill  # or start:grid, start:prism, start:slate, start:folio
```

`npm run build` regenerates the command registry (see below), bundles the renderer with esbuild
into `dist/`, and builds the file-format and OCR workers into `runtime/`.

## Test

```sh
npm run typecheck    # tsc --noEmit (runs the generator first)
npm test             # node --test "tests/**/*.test.mjs" (runs the generator first)
```

`npm test` covers the engine, every app's commands (including ported upstream Rust tests), the
file formats, the generator and the automation-layer contracts. It needs no Electron window.
One test needs the format worker, so run `npm run build` once before the first `npm test`.

End-to-end suites start the real app (they need `npm run build` first):

```sh
npm run test:e2e:bridge   # tests/e2e/**: drives the app through its test-only automation layer
npm run test:e2e          # scripts/verify-desktop.mjs: legacy Playwright regression checks
```

The `tests/e2e` flows never move the mouse, type on the keyboard or touch the system clipboard:
the app runs in test mode (`ARKEMIS_STUDIO_TEST=1`, development checkouts only), its windows are
shown inactive and are not focusable, and the flows drive the editors through the same commands
the ribbon runs (`electron/test-rpc-server.cjs`, `tests/e2e/harness.mjs`). `scripts/lint-e2e.mjs`
rejects pointer, keyboard and OS input in those files. Evidence (window captures) goes to
`artifacts/e2e/`.

## Package

```sh
npm run package:office   # one installer for all five apps (NSIS on Windows, .app/.dmg on macOS)
```

The output goes to `release/office/`. Builds are unsigned; signing is up to whoever publishes a
release. The installed app starts each product with `--product=<quill|grid|prism|slate|folio>`.

## Project layout

```
core/               the engine: isomorphic ESM, no DOM
  kernel/           sessions, changes and undo, commands, schemas, addresses, risk and approvals
  common/           commands and dialogs shared by every app (file, edit, view, clipboard)
  quill/ grid/ prism/ folio/ slate/
    model/ lib/     each app's document model and helpers
    commands/       one file per command family (translated from the upstream cmd/*.rs)
    dialogs/        dialog models
    formats/        import and export (docx, xlsx, pptx, pdf, ...)
  generated/        written by the generator, never edited (gitignored)
src/                the renderer (React + TypeScript)
  shell/            app-independent UI: ribbon, backstage, dialogs, panes, keys, status bar
  apps/<app>/       each app's editing surface, panes, dialogs and view-only commands
  generated/        written by the generator (gitignored)
electron/           main process: windows, the file service and store, IPC, workers
docs/
  architecture.md   how the pieces fit together (start here)
  behaviour-fidelity.md  the rule every command follows
  bridge-protocol.md     the automation layer the tests use
  spec/             ribbon, command and dialog specs per app, layout overlays and patches
assets/             icons, product logos, hyphenation patterns, the OCR model
scripts/            build, generator, packaging and test runners
tests/              unit, conformance, contract and end-to-end tests
LICENSES/upstream/  the ArtCraft licence notices
```

## How commands and ribbons are generated

Nothing in the UI changes a document except by running a command by id, and the ribbon, the
keyboard and the automation layer all run the same commands.

- A **command family** is a file in `core/<app>/commands/` that calls `defineCommands()` with ids,
  labels, parameter schemas, a risk level and a `run` function. Edits are recorded as changes with
  inverses, so undo and redo work for every command.
- The **spec** (`docs/spec/<app>.json`) lists every tab, group, control, dialog and pane of the
  app's ribbon. **Layout overlays** (`docs/spec/layout/<app>/<tab>.json`) give the ribbon geometry,
  and **patches** (`docs/spec/patches/<app>/*.json`) correct or extend the spec by id. Edit
  patches and overlays, not the spec itself.
- `scripts/generate.mjs` scans those folders and writes `core/generated/*` (the command registry,
  dialogs, formats and `manifest.json`) and `src/generated/*` (the specs as TypeScript and the
  icon index from `assets/icons/ribbon/*.svg`). It runs before `build`, `test` and `typecheck`;
  run it alone with `npm run generate`.
- A control whose command is not implemented is not shown in a production build, so there are
  no dead buttons.

[docs/architecture.md](docs/architecture.md) has the details (sections 4 to 9).

## Data

Each document is a real file. The app also keeps working copies for crash recovery
(AutoRecover) in `%APPDATA%/Arkemis Studio/` on Windows (the app-data folder on macOS);
`ARKEMIS_STUDIO_DATA` points a run at a different folder, which tests use.

## Contributing

- Open an issue before a large change, and keep pull requests focused.
- Follow [docs/behaviour-fidelity.md](docs/behaviour-fidelity.md): a control behaves exactly as it
  does upstream and in the Office or Acrobat app it stands for, or it is not shown.
- Translated code names its upstream file and commit in its header; keep that when you change it.
- Add or update tests with every change, and make sure `npm run typecheck` and `npm test` pass.
- Never commit generated files (`core/generated/`, `src/generated/`), build output or test artifacts.

## Licence

MIT, see [LICENSE](LICENSE). Third-party and upstream notices are in
[THIRD_PARTY.md](THIRD_PARTY.md) and `LICENSES/`. The Arkemis name and the product logos in
`assets/brand/` belong to their owner.
