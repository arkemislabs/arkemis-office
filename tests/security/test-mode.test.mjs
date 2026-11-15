// Security audit L1: the test-mode switches are ignored by a packaged build. Electron cannot be started packaged from a unit
// test, so this evaluates main's own decision expression with app.isPackaged both ways, and checks the preload no longer reads
// the environment (it takes testMode from the argument main passes only when main decided it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');

test('main decides testMode as not packaged and the environment switch', () => {
  const line = main.split('\n').find(l => l.startsWith('const testMode='));
  assert.ok(line, 'const testMode= line');
  const decide = (isPackaged, env) => new Function('app', 'process', `${line}; return testMode;`)({isPackaged}, {env});
  assert.equal(decide(false, {ARKEMIS_STUDIO_TEST: '1'}), true);
  assert.equal(decide(true, {ARKEMIS_STUDIO_TEST: '1'}), false);
  assert.equal(decide(false, {}), false);
});

test('the preload takes testMode from main, never from the environment', () => {
  assert.ok(!preload.includes('ARKEMIS_STUDIO_TEST'));
  assert.match(preload, /testMode:process\.argv\.includes\('--studio-test=1'\)/);
  // Both window kinds pass the argument only when main's testMode is true.
  const passes = main.match(/\.\.\.\(testMode\?\['--studio-test=1'\]:\[\]\)/g) ?? [];
  assert.equal(passes.length, 2);
  assert.ok(!/additionalArguments:\[[^\]]*'--studio-test=1'(?!\]:)/.test(main.replace(/\.\.\.\(testMode\?\['--studio-test=1'\]:\[\]\)/g, '')));
});

test('ARKEMIS_STUDIO_DIST is only honoured through testMode', () => {
  assert.match(main, /const root=testMode&&process\.env\.ARKEMIS_STUDIO_DIST/);
});
