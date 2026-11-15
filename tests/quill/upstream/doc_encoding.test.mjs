// Ported from wordcraft crates/doc/src/encoding.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../core/quill/model/encoding.mjs';

const win = (cp, bytes) => bytes.map(b => E.windowsByte(cp, b)).join('');
const doc = (cp, bytes) => bytes.map(b => E.codePageByte(cp, b)).join('');
const oem = (cp, bytes) => bytes.map(b => E.oemByte(cp, b)).join('');

test('single_byte_code_pages', () => {
  assert.equal(win(1251, [0xd1, 0xf7, 0xe5, 0xf2, 0x20, 0xb9]), 'Счет №');
  assert.equal(win(1251, [0xa8, 0xb8]), 'Ёё');
  assert.equal(win(1250, [0xa3, 0xf3, 0x9f]), 'Łóź');
  assert.equal(win(1253, [0xc1, 0xe2]), 'Αβ');
  assert.equal(win(1252, [0x80, 0xe9]), '€é');
  assert.equal(win(9999, [0xe9]), 'é');
  assert.equal(win(10000, [0x80, 0x8e, 0xdb, 0xf1, 0xf2, 0xf3, 0xd2, 0xd3, 0x41]), 'Äé€ÒÚÛ“”A');
  assert.equal(E.charsetCodePage(77), 10000);
  assert.equal(E.charsetCodePage(254), 437);
  assert.equal(E.charsetCodePage(255), 437);
  assert.equal(E.charsetCodePage(204), 1251);
  assert.equal(E.charsetCodePage(0), null);
  for (const cp of E.SINGLE_BYTE_CODE_PAGES) for (let b = 0; b < 256; b++) assert.equal(typeof E.windowsByte(cp, b), 'string');
});

test('windows_1255_holam_haser_for_vav', () => {
  assert.equal(E.windowsByte(1255, 0xca), 'ֺ');
});

test('document_text_in_windows_dos_and_mac_code_pages', () => {
  assert.equal(doc(437, [0x82, 0xa0, 0x41, 0x01]), 'éáA\u0001', 'DOS text; ASCII stays ASCII');
  assert.equal(doc(850, [0x9d, 0xe9]), 'ØÚ');
  assert.equal(doc(10000, [0x8e]), 'é');
  assert.equal(doc(1251, [0xc4]), 'Д');
  for (const cp of [437, 850, 866, 1250, 1252, 10000]) assert.ok(E.isByteCodePage(cp), String(cp));
  assert.ok(!E.isByteCodePage(932) && !E.isByteCodePage(0) && !E.SINGLE_BYTE_CODE_PAGES.includes(10000));
});

test('east_asian_code_pages_are_multibyte', () => {
  assert.equal(E.charsetCodePage(128), 932);
  assert.equal(E.charsetCodePage(129), 949);
  assert.equal(E.charsetCodePage(134), 936);
  assert.equal(E.charsetCodePage(136), 950);
  assert.equal(E.charsetCodePage(255), 437);
  assert.deepEqual([...E.MULTIBYTE_CODE_PAGES], [932, 936, 949, 950]);
  for (const cp of E.MULTIBYTE_CODE_PAGES) {
    assert.ok(E.isMultibyteCodePage(cp) && E.isTextCodePage(cp));
    assert.ok(!E.isByteCodePage(cp) && !E.SINGLE_BYTE_CODE_PAGES.includes(cp));
    assert.ok(E.multibyteEncodingName(cp));
    assert.doesNotThrow(() => new TextDecoder(E.multibyteEncodingName(cp)), 'the platform decodes it');
  }
  assert.ok(E.isTextCodePage(1251) && E.isTextCodePage(437) && E.isTextCodePage(10000));
  assert.ok(!E.isTextCodePage(0) && !E.isTextCodePage(9999));
});

test('oem_code_pages', () => {
  assert.equal(oem(437, [0x82, 0xe9, 0x01, 0x7f]), 'éΘ☺⌂');
  assert.equal(oem(850, [0x9b, 0xe9]), 'øÚ');
  assert.equal(oem(852, [0xa5, 0x88, 0xbe, 0xa9]), 'ąłżę');
  assert.equal(oem(866, [0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0xf0, 0xfc]), 'ПриветЁ№');
  assert.equal(oem(737, [0x80, 0x99, 0xe0]), 'Αβω');
  assert.equal(oem(857, [0x8d, 0x98, 0xa6, 0x9f]), 'ıİĞş');
  assert.equal(E.oemByte(857, 0xd5), '�', 'unassigned in 857');
  assert.equal(oem(9999, [0xe9]), 'Θ', 'unknown pages read as 437');
});

// --- cfb_guard.rs ---
import {cfbCheck, repeatingDifatSample} from '../../../core/quill/model/cfb-guard.mjs';

function headerDifat(sectors, fat) {
  const f = new Uint8Array(512 * (sectors + 1));
  const dv = new DataView(f.buffer);
  f.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(0x1a, 3, true);
  dv.setUint32(0x2c, fat.length, true);
  dv.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, fat[i] ?? 0xffffffff, true);
  return f;
}

test('cfb_guard: a_repeating_difat_is_refused_and_a_small_file_passes', () => {
  assert.ok(cfbCheck(repeatingDifatSample())?.includes('FAT sectors in a file of'));
  assert.equal(cfbCheck(new TextEncoder().encode('not a compound file')), null);
});

test('cfb_guard: a_fat_sector_listed_twice_or_more_than_the_file_needs_is_refused', () => {
  assert.ok(cfbCheck(headerDifat(10, [0, 0]))?.includes('FAT sector 0 twice'));
  assert.ok(cfbCheck(headerDifat(10, [0, 1, 2]))?.includes('3 FAT sectors'));
  assert.equal(cfbCheck(headerDifat(10, [0])), null);
  assert.equal(cfbCheck(headerDifat(200, [0, 1])), null);
});
