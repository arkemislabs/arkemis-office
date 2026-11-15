// Arkemis Office 0.1.2 on a Mac showed Electron's logo in Finder, the Dock and the disk image: the Mac build had no icon.
// The bundle now carries suite.icns and each app sets its own Dock icon (scripts/render-mac-icons.cjs renders both).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const products = path.join(root, 'assets/brand/products');

test('every app has a well-formed .icns with PNGs up to 1024 px, and a Dock PNG', () => {
  for (const name of ['suite', 'quill', 'grid', 'prism', 'slate', 'folio']) {
    const icns = fs.readFileSync(path.join(products, name + '.icns'));
    assert.equal(icns.toString('ascii', 0, 4), 'icns', name);
    assert.equal(icns.readUInt32BE(4), icns.length, name + ' length');
    const widths = [];
    for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
      assert.equal(icns.readUInt32BE(at + 8), 0x89504e47, name + ' slot is a PNG');
      widths.push(icns.readUInt32BE(at + 24));
    }
    for (const size of [16, 32, 128, 256, 512, 1024]) assert.ok(widths.includes(size), `${name} has ${size} px`);
    const dock = fs.readFileSync(path.join(products, name + '-dock.png'));
    assert.equal(dock.readUInt32BE(16), 512, name + ' Dock icon is 512 px');
  }
});

test('the Mac build uses the suite icon for the app and the disk image', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/package-suite.mjs'), 'utf8');
  const icon = "icon:path.join(root,'assets/brand/products/suite.icns')";
  assert.ok(script.includes('identity:null,' + icon), 'the app bundle');
  assert.ok(script.includes("dmg:{title:'Arkemis Office ${version}'," + icon), 'the disk image');
});

test('each app sets its own Dock icon on macOS', () => {
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  assert.ok(main.includes("app.dock.setIcon(path.join(__dirname,'../assets/brand/products/'+(product==='studio'?'suite':product)+'-dock.png'))"));
});
