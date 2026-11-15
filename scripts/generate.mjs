// The generator (docs/architecture.md section 6): scans core/ and src/apps/, normalizes the specs,
// and writes core/generated/* and src/generated/* (gitignored), plus artifacts/coverage/*.
//
//   node scripts/generate.mjs                       generate (non-zero exit on errors)
//   node scripts/generate.mjs --check               validate only, write nothing
//   node scripts/generate.mjs --strict              pending controls and missing icons are errors
//   node scripts/generate.mjs --app grid            report (and apply --strict) for one app only
//   node scripts/generate.mjs --verbose             also print notes
//   node scripts/generate.mjs --check-ownership U:grid/data --files core/grid/commands/data.mjs ...
//
// Pure Node, deterministic, no network. Called from scripts/build.mjs and the pretest/pretypecheck hooks.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APPS, SPEC_STEM, Report, writeIfChanged, stableStringify} from './gen/util.mjs';
import {discoverCore, checkApp, writeCoreIndexes, appsIndex, discoverUi, uiIndex, appsUiIndex} from './gen/registry.mjs';
import {buildSpecModel, validateSpecModel, shippedModel, appInfo} from './gen/spec.mjs';
import {loadIcons, iconsModule, assignIconOwners} from './gen/icons.mjs';
import {checkControlArgs, appCoverage, manifestEntries, controlStatus, uiCommandIds} from './gen/coverage.mjs';
import {createOwnership, checkOwnership} from './gen/ownership.mjs';
import {SPEC_TYPES, specModule} from './gen/types.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Does src/apps/<app>/manifest.ts declare ready: true? (strict release gate) */
function manifestReady(root, app) {
  try { return /\bready\s*:\s*true\b/.test(fs.readFileSync(path.join(root, 'src/apps', app, 'manifest.ts'), 'utf8')); } catch { return false; }
}

/** Messages about another app than `only` are dropped when --app is given. */
function scopeFilter(only) {
  if (!only) return () => true;
  const others = APPS.filter(a => a !== only);
  const marks = others.flatMap(a => [`core/${a}`, `src/apps/${a}/`, `docs/spec/${SPEC_STEM[a]}.json`, `docs/spec/layout/${a}/`,
    `docs/spec/patches/${a}/`, `docs/spec/layout/${SPEC_STEM[a]}/`, `docs/spec/patches/${SPEC_STEM[a]}/`]);
  return msg => !marks.some(m => msg.startsWith(m));
}

/**
 * Run the generator.
 * @param {{root?: string, strict?: boolean, check?: boolean, app?: string|null, log?: {log: Function, error: Function}|null}} [opts]
 */
export async function generate({root = defaultRoot, strict = false, check = false, app: only = null, log = null} = {}) {
  if (only && !APPS.includes(only)) throw new Error(`--app must be one of ${APPS.join(', ')}`);
  const started = Date.now();
  const report = new Report();
  const core = await discoverCore(root, report);
  const commonIds = new Set(core.common.commands.flatMap(m => m.module.commands.map(c => c.id)));

  // Specs
  const models = new Map();
  for (const app of APPS) models.set(app, buildSpecModel(root, app, report));
  const dialogCommands = new Map(APPS.map(app => [app, new Map([...core.common.dialogs, ...core.apps[app].dialogs]
    .filter(d => d.command).map(d => [d.id, d.command]))]));
  let ownership = createOwnership({models, commonIds, dialogCommands, root});
  const iconOwners = assignIconOwners(models, (app, c) => ownership.iconOwner(app, c));
  ownership = createOwnership({models, commonIds, dialogCommands, root, iconOwners});
  const icons = loadIcons(root, report);

  // Per app
  const coverage = {};
  const manifest = [];
  const infos = {};
  const checkedByApp = {};
  for (const app of APPS) {
    const model = models.get(app);
    const checked = checkApp(app, core, report);
    checkedByApp[app] = checked;
    infos[app] = appInfo(model);
    const commandsById = new Map(checked.modules.flatMap(m => m.module.commands.map(c => [c.id, c])));
    const uiIds = uiCommandIds(root, app);
    const withUi = new Map(commandsById);
    for (const id of uiIds) if (!withUi.has(id)) withUi.set(id, {id, ui: true});
    let argProblems = [];
    if (model) {
      validateSpecModel(model, report, {contextFlags: core.apps[app].contextFlags});
      argProblems = checkControlArgs(app, model, commandsById, report);
      model.pendingControls = controlStatus(model, withUi, new Set(checked.dialogs.keys())).pending.map(p => p.id);
    }
    const warnings = report.warnings.filter(w => model && w.startsWith(model.specFile));
    coverage[app] = appCoverage(app, {model, modules: checked.modules, dialogs: checked.dialogs, icons, iconOwners, ownership, warnings, argProblems, uiIds});
    manifest.push(...manifestEntries(app, checked.modules, model));
    const isStrict = strict && (only === app || (!only && manifestReady(root, app)));
    if (isStrict && model) {
      for (const p of coverage[app].controls.pending) report.error(`${model.specFile}#${p.id}`, `pending: ${p.command ?? p.dialog ?? 'no command'} is not implemented (--strict)`);
      for (const m of coverage[app].iconsMissing) report.error(`assets/icons/ribbon/${m.icon}.svg`, `missing (owner ${m.owner}) (--strict)`);
    }
  }

  // Write
  if (!check) {
    for (const app of APPS) writeCoreIndexes(root, app, checkedByApp[app], core);
    writeIfChanged(path.join(root, 'core/generated/apps.mjs'), appsIndex(root, core, infos, Object.fromEntries(APPS.map(a => [a, manifestReady(root, a)]))));
    writeIfChanged(path.join(root, 'core/generated/manifest.json'), stableStringify({version: 1, apps: APPS, commands: manifest}) + '\n');
    writeIfChanged(path.join(root, 'src/generated/spec-types.ts'), SPEC_TYPES);
    writeIfChanged(path.join(root, 'src/generated/icons.ts'), iconsModule(icons));
    writeIfChanged(path.join(root, 'src/generated/apps.ts'), appsUiIndex(Object.fromEntries(APPS.map(a => [a, models.get(a)]))));
    for (const app of APPS) {
      const model = models.get(app);
      writeIfChanged(path.join(root, 'src/generated', `${app}.spec.ts`), specModule(app, model ? shippedModel(model) : null));
      writeIfChanged(path.join(root, 'src/generated', `${app}.ui.ts`), uiIndex(root, app, discoverUi(root, app)));
      writeIfChanged(path.join(root, 'artifacts/coverage', `${app}.json`), stableStringify(coverage[app]) + '\n');
    }
    const iconTable = Object.fromEntries(Object.entries(iconOwners).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, o]) => [id, {...o, present: !!icons[id]}]));
    writeIfChanged(path.join(root, 'artifacts/coverage/icons.json'), stableStringify(iconTable) + '\n');
  }

  const keep = scopeFilter(only);
  const result = {
    errors: report.errors.filter(keep),
    warnings: report.warnings.filter(keep),
    info: report.info.filter(keep),
    coverage, models, ownership, icons, iconOwners, core,
    ms: Date.now() - started,
  };
  if (log) printSummary(result, log, {check});
  return result;
}

function printSummary(r, log, {check, verbose = false} = {}) {
  for (const e of r.errors) log.error(`error  ${e}`);
  for (const w of r.warnings) log.log(`warn   ${w}`);
  if (verbose) for (const i of r.info) log.log(`note   ${i}`);
  const parts = APPS.map(app => {
    const c = r.coverage[app];
    if (!c || c.legacy) return `${app}: legacy`;
    return `${app}: ${c.registered} cmds, ${c.counts.implemented}/${c.counts.controls} controls`;
  });
  log.log(`generate${check ? ' --check' : ''}: ${r.errors.length} errors, ${r.warnings.length} warnings (${r.ms} ms) — ${parts.join('; ')}`);
}

/** CLI */
async function main(argv) {
  const args = argv.slice(2);
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const verbose = flag('--verbose');
  if (flag('--check-ownership')) {
    const unit = value('--check-ownership');
    const i = args.indexOf('--files');
    const files = i >= 0 ? args.slice(i + 1).flatMap(x => x.split(',')).map(x => x.trim()).filter(Boolean) : [];
    if (!unit || !files.length) {
      console.error('usage: node scripts/generate.mjs --check-ownership <unit> --files <file> [<file> ...]');
      return 2;
    }
    const r = await generate({check: true});
    const res = checkOwnership(r.ownership, unit, files);
    for (const v of res.violations) console.error(`not yours: ${v.file} (owner ${v.owner})`);
    console.log(res.ok ? `ownership ok: ${files.length} files belong to ${res.unit}` : `ownership: ${res.violations.length} of ${files.length} files are not ${res.unit}'s`);
    return res.ok ? 0 : 1;
  }
  const r = await generate({check: flag('--check'), strict: flag('--strict'), app: value('--app')});
  printSummary(r, console, {check: flag('--check'), verbose});
  return r.errors.length ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv).then(code => { process.exitCode = code; }, e => { console.error(e?.stack ?? e); process.exitCode = 1; });
}

