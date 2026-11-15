# What was removed for the open-source release

Arkemis Office 0.1.5 was copied from the private development tree and every AI feature, and every
tie to the separate Arkemis assistant app and its services, was taken out. This note lists what
went and where it was. Nothing here is needed to build or contribute.

## AI features (user interface)

| Feature | Where it was |
|---|---|
| **Arkemis pane** (Home › Arkemis, `Alt+I`): the assistant pane, chat history, attachments, citation style, insert/copy answer | `src/shell/ai/AiPane.tsx`, `aiStore.ts`, `Markdown.tsx`, `insert.ts`, `ai.css`; per app `src/apps/<app>/panes/arkemis.tsx` |
| **Research pane** (Home › Research): the Arkemis app's browser docked beside a document | `src/shell/ai/ResearchPane.tsx`; per app `src/apps/<app>/panes/arkemis-research.tsx` |
| `ui.arkemis` and `ui.research` commands (ribbon toggles in Quill, Grid and Prism Home; Slate's Copilot slot; PDF's AI Assistant mode-bar button and Research button; PDF All Tools › AI assistant: Summarize, Ask about this document, Translate) | `src/shell/ai/commands.ts`, `src/apps/<app>/ui-commands/arkemis.ts`, `src/shell/engine/ShellController.ts`, `docs/spec/patches/<app>/ai.json` |
| The AI controls in the ribbon specs and layouts (`home.arkemis.*`, `home.copilot.*`, `chrome.mode.ai`, `chrome.mode.research`, `alltools.ai.*`, the `copilot.*` commands and the Copilot pane) | `docs/spec/pdf.json`, `docs/spec/slate.json`, `docs/spec/layout/{quill,grid,prism,slate}/home.json`, `docs/spec/layout/folio/{all-tools,title-bar}.json`, `src/apps/folio/chrome/AllToolsPage.tsx` |
| The `ui.ai` automation method (drove the Arkemis pane in tests) | `src/shell/bridge/RendererBridge.ts`, `electron/rpc-router.cjs` |
| Ribbon icons only those controls used | `assets/icons/ribbon/arkemis.svg`, `arkemis.32.svg`, `assistant-spark.svg` |

Controls for Office's own online AI features that were never implemented (Grid's Analyze Data,
Word's Researcher, Translate, Smart Lookup, Dictate) stay in the specs as Office catalogue entries:
they have no registered command, so a production build does not show them.

## Ties to the Arkemis assistant app

| What | Where it was |
|---|---|
| AI host: found the Arkemis app's discovery file, called its host API (`/suite/v1/status`, `/run`, `/approve`, `/cancel`, `/browser`) with its bearer token, launched the Arkemis app | `electron/arkemis-host.cjs`; the `studio:ai-*` IPC handlers in `electron/main.cjs`; `window.studio.ai` in `electron/preload.cjs` and `src/types.ts` |
| Research dock: placed the Arkemis browser window over the Research pane | `electron/research-dock.cjs`; the `studio:research-*` handlers; `window.studio.research` |
| The agent bridge: an always-on loopback HTTP server with a v1 REST API (`/v1/capabilities`, `/v1/documents`, `/v1/commands`, structure/forms/signatures/text-objects) and v2 routes including an MCP endpoint (`/v2/mcp`) for the Arkemis agent | `electron/bridge.cjs`, `electron/bridge-v2.cjs`, `integration/mcp-tools.cjs` |
| The agent's client SDK (`SuiteClient`: discovery, auto-launch, tools in Anthropic `input_schema` shape, approval hook) | `integration/suite-client.cjs` |
| Connection and installation records the Arkemis app read to find and auto-start Office (`connections/<product>.json`, `installations/<product>.json`) | `core/bridge-discovery.cjs`, `electron/installations.cjs`; `publishConnection`/`writeInstallation` in `electron/main.cjs` |
| `--background` start for the Arkemis app (now test mode only) | `electron/main.cjs` |
| The native "An app asks to change something … connected to Arkemis Office" approval dialog | `electron/main.cjs` (`confirmApproval`) |
| "Arkemis: <label>" undo labels for agent edits (now "Automation: <label>") | `core/kernel/undo.mjs`, `electron/rpc-router.cjs` |
| Installer note about "Arkemis Setup" passing app choices | `scripts/installer/office-uninstall.nsh` (comment only) |
| Obsolete per-app packager that shipped `bridge.cjs` | `scripts/package-apps.mjs` |

What stays: the in-process automation layer (`electron/rpc-router.cjs`, `electron/headless-host.mjs`,
`core/kernel/rpc-methods.mjs`, `src/shell/bridge/RendererBridge.ts`). It is how the end-to-end tests
drive the editors. It now runs only in test mode (a development checkout started with
`ARKEMIS_STUDIO_TEST=1`), over a new test-only loopback transport, `electron/test-rpc-server.cjs`
(`/v2/rpc` and `/v2/events`, no MCP, no v1 API), whose port and token are written to the test's own
data folder (`test-rpc.json`). A normal run of the app opens no port. The e2e harness uses
`tests/e2e/rpc-client.mjs` instead of `SuiteClient`.

## Assets that could not be published

| What | Why | Where it was |
|---|---|---|
| OpenAI Sans font files (UI typeface) | OpenAI's proprietary typeface, not licensed for redistribution; the UI now uses the system font stack (Segoe UI on Windows, the system UI font elsewhere) | `assets/fonts/OpenAISans-*.woff2`, `src/arkemis-theme.css` |
| AI-generated "glass" logo masters and their image-generation prompts (never shipped in builds) | AI artefacts | `assets/brand/products/glass/` |

## Tests removed or changed

Removed (they tested removed code): `tests/arkemis-host.test.mjs`, `tests/research-dock.test.mjs`,
`tests/suite-client.test.mjs`, `tests/suite-client-pdf.test.mjs`, `tests/bridge-discovery.test.mjs`,
`tests/bridge-discovery-lock.test.mjs`, the v1 REST tests `tests/bridge-{bookmarks,pdf-design,pdf-text,replace-content,signatures,structure,unicode}.test.mjs`,
`tests/bridge/suite-client.test.mjs`, the MCP test in `tests/bridge/events-mcp.test.mjs` (the rest is
now `tests/bridge/events.test.mjs`), the v1 test in `tests/store.test.mjs` and in
`tests/bridge/rpc.test.mjs`, `tests/e2e/shell/{ai-pane,research-pane,research-pane-apps}.e2e.mjs`,
`tests/e2e/shell/research-host.mjs`, and `tests/office-launcher.e2e.mjs` (it found the launched app
through the removed connection records).

Changed: `tests/bridge/helpers.mjs` and `tests/bridge/file-lifecycle.test.mjs` use the test transport;
`tests/e2e/harness.mjs` reads `test-rpc.json`; `tests/e2e/bridge/smoke.e2e.mjs` lost its MCP checks; the
legacy Playwright suites (`electron`, `desktop-shell`, `grid-dynamic-arrays`, `pdf`, `pdf-bookmarks`,
`pdf-workflows`, `production-hardening`) lost their v1-bridge and discovery steps; the font checks in
`products`, `package-smoke` and `packages-all` expect the system font.

## Internal notes not published

Agent hand-off notes (`docs/requests/`), research dumps and Office binary inspection reports
(`docs/research/`), translation-coverage and inventory JSON (`docs/*-translation-coverage.json`,
`docs/source-translation-*.json`, `docs/release-readiness.json`), the Arkemis integration note
(`docs/arkemis-integration.md`), early planning notes (`docs/design.md`, `docs/implementation-plan.md`,
`docs/pdf-layout-alignment.md`) and the scripts that built the research inventory
(`scripts/catalog-office-resources.mjs`, `scripts/index-translation-source.mjs`, `scripts/zz-audit.mjs`).
Code comments that cited a hand-off note keep only its name. The upstream MIT notices that were in
`docs/research/artcraft/` moved to `LICENSES/upstream/`.
