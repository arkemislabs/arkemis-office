// Fails when a bridge E2E file uses pointer, keyboard or OS input (docs/architecture.md section 17.5).
// Flows drive the app only through the automation layer (tests/e2e/rpc-client.mjs: ui.activate, ui.dialog.*, ui.key,
// engine.execute) and take evidence with ui.capture.
//
//   node scripts/lint-e2e.mjs [directory]      (default tests/e2e)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RULES = [
  {re: /\.(click|dblclick|fill|press|pressSequentially|type|tap|hover|dragTo|dragAndDrop|selectText|setChecked|check|uncheck|selectOption|focus)\s*\(/, why: 'Playwright/DOM input action'},
  // The device objects themselves: `page.mouse.move(`, `keyboard.press(`, `const {mouse} = page`, `touchscreen.tap(`. A control id or a label
  // that merely contains the word ('qat.touch-mouse-mode', "Mouse Mode") is not a device.
  {re: /\b(keyboard|mouse|touchscreen)\s*\.\s*[A-Za-z_$]+\s*\(|\{[^}]*\b(keyboard|mouse|touchscreen)\b[^}]*\}\s*=|=\s*[\w$.]*\.(keyboard|mouse|touchscreen)\s*[;,)\n]/, why: 'keyboard, mouse or touch device API'},
  {re: /\.screenshot\s*\(/, why: 'page.screenshot (use the ui.capture bridge method)'},
  {re: /\bsendInputEvent\b/, why: 'synthetic Electron input event'},
  {re: /\b(dispatchEvent|KeyboardEvent|MouseEvent|PointerEvent|InputEvent|TouchEvent)\b/, why: 'synthetic DOM event'},
  {re: /['"](@playwright\/test|playwright|playwright-core)['"]/, why: 'Playwright import (drive the app through the test transport)'},
  {re: /['"](robotjs|@nut-tree\/nut-js|nut-js|node-key-sender|ks|iohook|uiohook-napi)['"]/, why: 'OS input library'},
  {re: /\b(SendKeys|SendInput|SetCursorPos|mouse_event|keybd_event|xdotool|cliclick|osascript|wscript\.shell)\b/i, why: 'OS input'},
];

/** Remove comments, keeping line numbers (strings are kept: a forbidden call in a string is still suspicious). */
export function stripComments(source) {
  let out = '';
  let i = 0, quote = null;
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(mjs|cjs|js|ts|mts|cts|tsx)$/.test(e.name)) yield full;
  }
}

/** Every violation under `dir`: {file, line, text, why}. */
export function lintE2e(dir = path.join(root, 'tests', 'e2e')) {
  const problems = [];
  for (const file of walk(dir)) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        const m = rule.re.exec(line);
        if (m) problems.push({file: path.relative(root, file), line: i + 1, text: m[0], why: rule.why});
      }
    });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'tests', 'e2e');
  const problems = lintE2e(dir);
  if (problems.length) {
    for (const p of problems) console.error(`${p.file}:${p.line}: ${p.text} - ${p.why}`);
    console.error(`\n${problems.length} forbidden input API use(s): bridge E2E flows drive the app through the test transport only.`);
    process.exit(1);
  }
  console.log(`lint-e2e: ${path.relative(root, dir) || '.'} uses no pointer, keyboard or OS input.`);
}
