// scripts/lint-e2e.mjs: the E2E tree stays free of pointer, keyboard and OS input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {lintE2e, stripComments} from '../../scripts/lint-e2e.mjs';
import {tempDir} from './helpers.mjs';

test('tests/e2e uses no input devices', () => {
  assert.deepEqual(lintE2e(), []);
});

test('device objects are caught however they are reached; a control id or label that names one is not', async () => {
  const dir = await tempDir('arkemis-lint-');
  try {
    await fs.writeFile(path.join(dir, 'devices.e2e.mjs'), [
      'await page.mouse.move(1, 2);',
      'const {mouse} = page;',
      'const m = page.mouse;',
      'await touchscreen.tap(1, 2);',
      "await app.rpc('ui.activate', {doc, control: 'qat.touch-mouse-mode.mouse'});",
      "const label = 'Touch/Mouse Mode';",
    ].join('\n'));
    assert.deepEqual([...new Set(lintE2e(dir).map(p => p.line))], [1, 2, 3, 4]);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the lint catches Playwright actions, devices, screenshots and OS input, but not comments or ui.key', async () => {
  const dir = await tempDir('arkemis-lint-');
  try {
    await fs.writeFile(path.join(dir, 'bad.e2e.mjs'), [
      "import {_electron} from '@playwright/test';",
      "await page.getByRole('button').click();",
      "await page.keyboard.press('Enter');",
      "await page.screenshot({path: 'x.png'});",
      "win.webContents.sendInputEvent({type: 'mouseDown'});",
      "// await page.click() in a comment is fine",
      "await app.rpc('ui.key', {keys: 'Mod+B'});",
    ].join('\n'));
    const problems = lintE2e(dir);
    assert.deepEqual([...new Set(problems.map(p => p.line))], [1, 2, 3, 4, 5]);
    assert.equal(stripComments('a // b\nc /* d\ne */ f'), 'a \nc \n f');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
