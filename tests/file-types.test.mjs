// Arkemis Office opens its file types directly (Nov 10: a .xlsx on a PC without Excel gave "This file does not have an
// app associated with it"). Windows: the installer makes an app the default for a type no working program opens, and
// never takes a type the person or a working program has. macOS: the bundle declares the types, and a file opened from
// Finder (open-file) reaches its own app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const nsh = read('scripts/installer/office-uninstall.nsh');
const main = read('electron/main.cjs');
const suite = read('scripts/package-suite.mjs');

const TYPES = {
  quill: ['docx', 'dotx', 'doc', 'rtf', 'odt'],
  grid: ['xlsx', 'xlsm', 'xls', 'csv', 'ods'],
  prism: ['pptx', 'ppsx', 'ppt', 'odp'],
  slate: ['one'],
  folio: ['pdf'],
};

test('Windows: every type is registered to its app, and becomes its default only when nothing working opens it', () => {
  for (const [app, exts] of Object.entries(TYPES))
    for (const ext of exts) assert.match(nsh, new RegExp(`!insertmacro \\$\\{TYPES\\} ${app} "\\.${ext}"`), `${app} .${ext}`);
  const openWith = nsh.slice(nsh.indexOf('!macro OfficeOpenWith ID EXT'), nsh.indexOf('!macro OfficeAppRemove'));
  assert.match(openWith, /OpenWithProgids" "Arkemis\.\$\{ID\}"/, 'always offered under Open with');
  assert.match(openWith, /OfficeChoice "\$\{EXT\}" "UserChoice"/, "the person's choice is checked first");
  assert.match(openWith, /OfficeChoice "\$\{EXT\}" "UserChoiceLatest"/);
  assert.match(openWith, /ReadRegStr \$R5 HKCR "\$\{EXT\}" ""[\s\S]*OfficeHandlerWorks \$R5/, 'then the type\'s current program');
  assert.match(openWith, /\$\{If\} \$R6 == "1"\s+WriteRegStr HKLM "Software\\Classes\\\$\{EXT\}" "" "Arkemis\.\$\{ID\}"/, 'a machine-wide default, only when unhandled');
  assert.match(openWith, /WriteRegStr HKLM "Software\\Classes\\\$\{EXT\}\\OpenWithProgids"/, 'Open with, for everyone');
  assert.match(openWith, /ReadRegStr \$R5 HKCU "Software\\Classes\\\$\{EXT\}" ""[\s\S]*\$\{If\} \$R4 != "1"\s+DeleteRegValue HKCU "Software\\Classes\\\$\{EXT\}" ""/, 'a dead per-user default no longer hides it');
  const entry = nsh.slice(nsh.indexOf('!macro OfficeAppEntry'), nsh.indexOf('!macro OfficeHandlerWorks'));
  assert.match(entry, /WriteRegStr HKLM "Software\\Classes\\Arkemis\.\$\{ID\}\\shell\\open\\command" "" '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --product=\$\{ID\} "%1"'/);
  const choice = nsh.slice(nsh.indexOf('!macro OfficeChoice'), nsh.indexOf('!macro OfficeOpenWith'));
  assert.match(choice, /\$\{If\} \$R4 == "1"\s+StrCpy \$R6 "0"\s+\$\{Else\}\s+DeleteRegKey/, 'a working choice is kept; only a broken one goes');
  const works = nsh.slice(nsh.indexOf('!macro OfficeHandlerWorks'), nsh.indexOf('!macro OfficeChoice'));
  assert.match(works, /shell\\\$R3\\command" ""/);
  assert.match(works, /DelegateExecute/);
  assert.match(works, /\\Application" 0/, 'Store apps count as working');
});

test('Windows: uninstalling removes the default only where it is still Arkemis Office', () => {
  const remove = nsh.slice(nsh.indexOf('!macro OfficeOpenWithRemoveFrom'), nsh.indexOf('; Windows\' Default apps lists'));
  assert.match(remove, /ReadRegStr \$R5 \$\{ROOT\} "Software\\Classes\\\$\{EXT\}" ""\s+\$\{If\} \$R5 == "Arkemis\.\$\{ID\}"\s+DeleteRegValue \$\{ROOT\} "Software\\Classes\\\$\{EXT\}" ""/);
  assert.match(remove, /OfficeOpenWithRemoveFrom HKLM \$\{ID\} "\$\{EXT\}"\s+!insertmacro OfficeOpenWithRemoveFrom HKCU/, 'this install and the per-user ones before it');
  for (const reg of ['$R2', '$R3', '$R4', '$R5', '$R6']) assert.ok(nsh.includes('Push ' + reg) && nsh.includes('Pop ' + reg), reg + ' is saved');
});

test('Windows: Default apps lists Arkemis Office with every type, and uninstalling removes it', () => {
  assert.ok(nsh.includes('WriteRegStr HKLM "Software\\ArkemisOffice\\Capabilities\\FileAssociations" "${EXT}" "Arkemis.${ID}"'));
  assert.ok(nsh.includes('WriteRegStr HKLM "Software\\RegisteredApplications" "Arkemis Office" "Software\\ArkemisOffice\\Capabilities"'));
  assert.ok(nsh.includes('WriteRegStr HKLM "Software\\ArkemisOffice\\Capabilities" "ApplicationIcon"'));
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'));
  assert.match(install, /OfficeRegisteredRemove[\s\S]*OfficeApps OfficeAppEntry OfficeOpenWith\s+!insertmacro OfficeRegistered/);
  assert.match(nsh.slice(nsh.indexOf('!macro customUnInstall')), /OfficeRegisteredRemove/);
});

test('macOS: the bundle declares every type, at Default rank, with its app icon', () => {
  const declared = suite.match(/const MAC_DOCUMENT_TYPES=(\[.*?\])\.map/)?.[1];
  assert.ok(declared, 'MAC_DOCUMENT_TYPES');
  const list = JSON.parse(declared);
  assert.deepEqual(Object.fromEntries(list.map(([app, , ext]) => [app, ext])), TYPES);
  assert.match(suite, /role:'Editor',rank:'Default',icon:path\.join\(root,'assets\/brand\/products\/'\+app\+'\.icns'\)/);
  assert.ok(suite.includes('fileAssociations:MAC_DOCUMENT_TYPES'), 'on the mac target');
  for (const app of Object.keys(TYPES)) assert.ok(fs.existsSync(path.join(root, 'assets/brand/products', app + '.icns')), app + '.icns');
});

test('macOS: a file opened from Finder reaches its own app', () => {
  const map = main.match(/const KIND_OF_EXTENSION=(\{.*?\});/)?.[1];
  assert.ok(map, 'KIND_OF_EXTENSION');
  const kinds = Function('return ' + map)();
  for (const [app, exts] of Object.entries(TYPES)) for (const ext of exts) assert.equal(kinds[ext], app, ext);
  assert.match(main, /app\.on\('open-file',\(event,p\)=>\{event\.preventDefault\(\);/);
  assert.match(main, /if\(finderReady\)void openFromFinder\(p\);else finderFiles\.push\(p\);/, 'files opened before launch finishes wait');
  assert.match(main, /finderReady=true;for\(const p of finderFiles\.splice\(0\)\)await openFromFinder\(p\);/);
  assert.match(main, /'--product='\+kind,p\]/, 'another app\'s file starts that app with the file');
  assert.match(main, /if\(!kind\|\|kind===product\)return openPathInWindow\(p\)/, 'the launcher hands a known type to its app by path, as Windows does');
});

test('Windows: the suite installs for everyone, in Program Files', () => {
  assert.match(suite, /nsis:\{\.\.\.pkg\.build\.nsis,perMachine:true,/);
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'));
  assert.match(install, /OfficeOldUserShortcuts/, 'the per-user Start menu folder of earlier installs goes');
});

test('Windows: "Open with" references to programs that are gone are dropped, so Windows uses the default', () => {
  const dead = nsh.slice(nsh.indexOf('!macro OfficeDropDead'), nsh.indexOf('!macro OfficeOpenWith ID EXT'));
  assert.match(dead, /EnumRegValue \$R5 \$\{ROOT\} "\$\{KEY\}" \$R1/);
  assert.match(dead, /OfficeHandlerWorks \$R5\s+\$\{If\} \$R4 == "1"\s+IntOp \$R1 \$R1 \+ 1\s+\$\{Else\}\s+DeleteRegValue/, 'only dead ones go');
  const openWith = nsh.slice(nsh.indexOf('!macro OfficeOpenWith ID EXT'), nsh.indexOf('; Removes an app'));
  for (const key of ['HKLM "Software\\Classes\\${EXT}\\OpenWithProgids"', 'HKCU "Software\\Classes\\${EXT}\\OpenWithProgids"', 'HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${EXT}\\OpenWithProgids"'])
    assert.ok(openWith.includes('!insertmacro OfficeDropDead ' + key), key);
  assert.ok(nsh.includes('Push $R1') && nsh.includes('Pop $R1'));
});
