// Registry generation (docs/architecture.md section 6.1 steps 2-5): discover command, dialog and
// format modules and app foundations, validate them, and write the generated indexes.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {APPS, walk, rel, exists, writeIfChanged, GENERATED_HEADER, lit} from './util.mjs';
import {validateFamily, parseShortcut, formatShortcut} from '../../core/kernel/command.mjs';
import {findDuplicates} from '../../core/kernel/registry.mjs';
import {loadDialogModules, dialogsIndex} from './dialogs.mjs';

const FOUNDATION = ['schema', 'address', 'context', 'migrate', 'fixtures', 'hooks'];
export const isModuleFile = n => n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.startsWith('_');

export async function importModule(file, report, root) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    report.error(rel(root, file), `cannot be imported: ${e?.message ?? e}`);
    return null;
  }
}

/** Command modules under a commands/ folder: [{file, rel, family, module}] sorted by path. */
async function loadCommandModules(root, dir, expectedApp, report) {
  const out = [];
  for (const file of walk(dir, isModuleFile)) {
    const r = rel(root, file);
    if (rel(dir, file).split('/').some(seg => seg.startsWith('_'))) continue;
    const ns = await importModule(file, report, root);
    if (!ns) continue;
    const m = ns.default;
    const family = rel(dir, file).replace(/\.mjs$/, '');
    const errors = validateFamily(m, {where: r, allowView: false});
    for (const e of errors) report.error(r, e.slice(r.length + 2));
    if (!m || errors.length) continue;
    if (m.family !== family) report.error(r, `family is "${m.family}" but the file says "${family}" (family = path under commands/)`);
    const apps = Array.isArray(m.app) ? m.app : [m.app];
    if (expectedApp === '*') { if (m.app !== '*') report.error(r, "core/common command families declare app: '*'"); }
    else if (!apps.includes(expectedApp)) report.error(r, `app is ${JSON.stringify(m.app)} but the file lives in core/${expectedApp}`);
    else if (apps.includes('*')) report.error(r, "app '*' is only for core/common");
    out.push({file, rel: r, family, module: m});
  }
  return out;
}

/** Everything under core/ the generator indexes. */
export async function discoverCore(root, report) {
  const common = {
    commands: await loadCommandModules(root, path.join(root, 'core/common/commands'), '*', report),
    dialogs: await loadDialogModules(root, path.join(root, 'core/common/dialogs'), report),
  };
  const apps = {};
  for (const app of APPS) {
    const base = path.join(root, 'core', app);
    const formats = {};
    for (const file of walk(path.join(base, 'formats'), isModuleFile)) {
      const m = /^(.+)-(read|write)\.mjs$/.exec(path.basename(file));
      if (!m || path.dirname(file) !== path.join(base, 'formats')) { report.error(rel(root, file), 'format modules are named <ext>-read.mjs or <ext>-write.mjs'); continue; }
      (formats[m[1]] ||= {})[m[2]] = rel(root, file);
    }
    const foundation = {};
    for (const k of FOUNDATION) if (exists(path.join(base, `${k}.mjs`))) foundation[k] = `core/${app}/${k}.mjs`;
    if (exists(path.join(base, 'model', 'index.mjs'))) foundation.model = `core/${app}/model/index.mjs`;
    else if (exists(path.join(base, 'model.mjs'))) foundation.model = `core/${app}/model.mjs`;
    let contextFlags = null;
    if (foundation.context) {
      const ns = await importModule(path.join(root, foundation.context), report, root);
      if (ns && Array.isArray(ns.flags)) contextFlags = ns.flags.filter(x => typeof x === 'string');
      else if (ns) report.warn(foundation.context, 'exports no `flags` array (contextual tabs cannot be checked)');
    }
    apps[app] = {
      commands: await loadCommandModules(root, path.join(base, 'commands'), app, report),
      dialogs: await loadDialogModules(root, path.join(base, 'dialogs'), report),
      formats,
      foundation,
      contextFlags,
    };
  }
  return {common, apps};
}

/** Per-app checks across common + app modules: duplicate ids, shortcut conflicts, duplicate dialogs. */
export function checkApp(app, core, report) {
  const mods = [...core.common.commands, ...core.apps[app].commands];
  for (const d of findDuplicates(mods.map(m => m.module), mods.map(m => m.rel))) {
    report.error(`core/${app}`, `command id "${d.id}" is defined in ${d.files.join(' and ')}`);
  }
  const chords = new Map();
  for (const m of mods) for (const c of m.module.commands) {
    if (c.shortcut === undefined || c.shortcut === null) continue;
    const scope = c.shortcutContext ?? 'app';
    for (const entry of parseShortcut(c.shortcut)) {
      if (!entry.steps) continue;
      for (const platform of ['win', 'mac']) {
        const text = formatShortcut(entry, platform);
        const key = `${scope} ${text}`;
        const prev = chords.get(key);
        if (prev && prev.id !== c.id) { report.error(`core/${app}`, `shortcut ${text} (${platform}, ${scope}) is bound to ${prev.id} (${prev.rel}) and ${c.id} (${m.rel})`); break; }
        chords.set(key, {id: c.id, rel: m.rel});
      }
    }
  }
  const dialogs = new Map();
  for (const d of [...core.common.dialogs, ...core.apps[app].dialogs]) {
    if (dialogs.has(d.id)) report.error(`core/${app}`, `dialog "${d.id}" has two models: ${dialogs.get(d.id).rel} and ${d.rel}`);
    else dialogs.set(d.id, d);
  }
  return {modules: mods, dialogs};
}

export const relImport = (fromDir, root, target) => {
  let r = path.relative(path.join(root, fromDir), path.join(root, target)).split(path.sep).join('/');
  if (!r.startsWith('.')) r = './' + r;
  return r;
};

export function commandsIndex(root, mods) {
  const lines = [GENERATED_HEADER];
  mods.forEach((m, i) => lines.push(`import m${i} from ${lit(relImport('core/generated', root, m.rel))};`));
  lines.push(`export const modules = [${mods.map((_, i) => `m${i}`).join(', ')}];`);
  lines.push(`export const sources = ${JSON.stringify(mods.map(m => m.rel))};`, '');
  return lines.join('\n');
}

export function formatsIndex(root, formats) {
  const lines = [GENERATED_HEADER];
  const entries = [];
  let i = 0;
  for (const ext of Object.keys(formats).sort()) {
    const parts = [];
    for (const kind of ['read', 'write']) {
      if (!formats[ext][kind]) continue;
      lines.push(`import * as f${i} from ${lit(relImport('core/generated', root, formats[ext][kind]))};`);
      parts.push(`${kind}: f${i++}`);
    }
    entries.push(`  ${lit(ext)}: {${parts.join(', ')}},`);
  }
  lines.push('export const formats = {', ...entries, '};', '');
  return lines.join('\n');
}

/**
 * core/generated/apps.mjs: each app's foundation modules, its spec summary and `ready` (the app's
 * src/apps/<app>/manifest.ts says `ready: true`: the new host replaces the legacy editor, so the
 * main process makes and keeps schema-2 documents for it).
 */
export function appsIndex(root, core, infos, ready = {}) {
  const lines = [GENERATED_HEADER];
  const body = [];
  for (const app of APPS) {
    const f = core.apps[app].foundation;
    const parts = [];
    for (const k of [...FOUNDATION, 'model']) {
      if (!f[k]) continue;
      const name = `${app}_${k}`;
      lines.push(`import * as ${name} from ${lit(relImport('core/generated', root, f[k]))};`);
      parts.push(`${k}: ${name}`);
    }
    parts.push(`ready: ${ready[app] === true}`);
    parts.push(`spec: ${JSON.stringify(infos[app] ?? null)}`);
    body.push(`  ${app}: {${parts.join(', ')}},`);
  }
  lines.push(`export const appIds = ${JSON.stringify(APPS)};`);
  lines.push('export const apps = {', ...body, '};', '');
  return lines.join('\n');
}

/** Renderer-side discovery for src/generated/<app>.ui.ts. */
export function discoverUi(root, app) {
  const base = path.join(root, 'src/apps', app);
  const list = (sub, ext) => walk(path.join(base, sub), n => n.endsWith(ext) && !n.startsWith('_'))
    .filter(f => path.dirname(f) === path.join(base, sub)).map(f => ({stem: path.basename(f, ext), rel: rel(root, f).replace(/\.(tsx|ts)$/, '')}));
  return {
    manifest: exists(path.join(base, 'manifest.ts')) ? `src/apps/${app}/manifest` : null,
    uiCommands: list('ui-commands', '.ts'),
    dialogs: list('dialogs', '.tsx'),
    panes: list('panes', '.tsx'),
    backstage: list('backstage', '.tsx'),
    extensions: list('extensions', '.tsx'),
  };
}

export function uiIndex(root, app, ui) {
  const imp = r => lit(relImport('src/generated', root, r));
  const lines = ['// GENERATED by scripts/generate.mjs. Do not edit.', "import type {UiManifest, LazyModule} from './spec-types';",
    "import type {CommandFamily} from '../../core/kernel/command.mjs';"];
  ui.uiCommands.forEach((u, i) => lines.push(`import u${i} from ${imp(u.rel)};`));
  if (ui.manifest) lines.push(`export {default as manifest} from ${imp(ui.manifest)};`);
  else lines.push(`export const manifest: UiManifest = {ready: false, surface: null, contextProvider: null};`);
  lines.push(`export const app = ${lit(app)};`);
  lines.push(`export const uiCommands: CommandFamily[] = [${ui.uiCommands.map((_, i) => `u${i}`).join(', ')}];`);
  for (const key of ['dialogs', 'panes', 'backstage', 'extensions']) {
    lines.push(`export const ${key}: Record<string, LazyModule> = {`);
    for (const x of ui[key]) lines.push(`  ${lit(x.stem)}: () => import(${imp(x.rel)}),`);
    lines.push('};');
  }
  lines.push('');
  return lines.join('\n');
}

export function appsUiIndex(apps) {
  const lines = ['// GENERATED by scripts/generate.mjs. Do not edit.', "import type {SpecModel} from './spec-types';",
    `export const appIds = ${JSON.stringify(APPS)} as const;`,
    'export type AppId = typeof appIds[number];',
    '/** Lazy loaders: one chunk per app for the UI index and one for the normalized spec. */',
    'export const appUi = {'];
  for (const app of APPS) lines.push(`  ${app}: () => import('./${app}.ui'),`);
  lines.push('};', 'export const appSpec: Record<AppId, () => Promise<SpecModel | null>> = {');
  for (const app of APPS) lines.push(`  ${app}: () => import('./${app}.spec').then(m => m.default),`);
  lines.push('};', `export const specAvailable: Record<AppId, boolean> = ${JSON.stringify(Object.fromEntries(APPS.map(a => [a, !!apps[a]])))};`, '');
  return lines.join('\n');
}

export function writeCoreIndexes(root, app, checked, core) {
  writeIfChanged(path.join(root, 'core/generated', `${app}.commands.mjs`), commandsIndex(root, checked.modules));
  writeIfChanged(path.join(root, 'core/generated', `${app}.dialogs.mjs`), dialogsIndex(root, checked.dialogs));
  writeIfChanged(path.join(root, 'core/generated', `${app}.formats.mjs`), formatsIndex(root, core.apps[app].formats));
}
