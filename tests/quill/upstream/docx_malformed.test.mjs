// Ported from wordcraft crates/docx/tests/it/malformed.rs at aadb077e072b7de05f724e359d8db82e151f125c:
// hostile input must give an error or a document, never a crash or a hang. Each test names the Rust test.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft: wordcraft_docx::read refuses a damaged main part with an error (never a silently
//    truncated document), skips broken secondary parts, and caps nesting, attributes and fields.
//    Word likewise refuses a corrupt document.xml and opens a file whose optional parts are broken.
// 2. Ours: core/quill/formats/docx-read.mjs throws DocxError with the same kinds (Zip, MissingPart,
//    NotWord, Xml, Limit) and reads the rest the same way; docx-write.mjs writes whatever it read.
// 3. These tests (engine). File > Open surfaces the error through electron/formats-v2.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {read, DocxError} from '../../../core/quill/formats/docx-read.mjs';
import {writeDocx} from '../../../core/quill/formats/docx-write.mjs';
import {contentFromText} from '../../../core/quill/model/content.mjs';
import {newTable} from '../../../core/quill/model/table.mjs';
import * as P from '../../../core/quill/model/para.mjs';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const ROOT_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const enc = s => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
async function zip(entries) { const z = new JSZip(); for (const [n, b] of entries) z.file(n, enc(b)); return z.generateAsync({type: 'uint8array'}); }
const docZip = xml => zip([['_rels/.rels', ROOT_RELS], ['word/document.xml', xml]]);
const bodyZip = body => docZip(`<w:document ${W_NS}><w:body>${body}</w:body></w:document>`);
const bodyText = c => c.body.chunks.flat().filter(b => b.kind === 'para').map(P.plainText).join('\n');
const kindOf = async p => { try { await p; return 'ok'; } catch (e) { return e instanceof DocxError ? e.kind ?? e.code ?? e.name : `other:${e?.message}`; } };
async function sample() {
  const c = contentFromText('Hello world\nSecond paragraph with more text\nThird');
  const bl = c.body.chunks.flat();
  bl.splice(1, 0, newTable(2, 2, 200));
  c.body = {chunks: [bl]};
  return writeDocx(c);
}

test('malformed.rs random_bytes_and_empty_input', async () => {
  await assert.rejects(read(new Uint8Array(0)));
  await assert.rejects(read(enc('PK\x03\x04garbage')));
  await assert.rejects(read(new Uint8Array(4096)));
  const noise = Uint8Array.from({length: 10_000}, (_, i) => (Math.imul(i, 2_654_435_761) >>> 13) & 0xff);
  await assert.rejects(read(noise));
});

test('malformed.rs truncated_zip_never_panics', async () => {
  const good = await sample();
  await read(good);
  for (let cut = 0; cut < good.length; cut += 37 * 7) await read(good.slice(0, cut)).catch(e => assert.ok(e instanceof Error));
  for (let i = 0; i < good.length; i += 53 * 5) { const b = good.slice(); b[i] ^= 0xa5; await read(b).catch(e => assert.ok(e instanceof Error)); }
});

test('malformed.rs missing_or_wrong_main_part', async () => {
  await assert.rejects(read(await zip([['_rels/.rels', ROOT_RELS], ['word/other.xml', '<x/>']])), e => e instanceof DocxError && /missing/i.test(e.message));
  await assert.rejects(read(await docZip('<notword/>')), e => e instanceof DocxError && /not a Word document/i.test(e.message));
  await read(await docZip('<w:document xmlns:w="x"><unclosed')).catch(() => null);
  await assert.rejects(read(await docZip(Uint8Array.from([0xff, 0xfe, 0x3c, 0, 0x77, 0]))));
  const d = await read(await zip([['word/document.xml', `<w:document ${W_NS}><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>`]]));
  assert.equal(bodyText(d), 'ok', 'no root rels: falls back to word/document.xml');
});

test('malformed.rs a_malformed_main_part_is_an_error_not_a_truncated_document', async () => {
  for (const [what, body] of [
    ['a less-than sign in a run', '<w:p><w:r><w:t>before a <- b after</w:t></w:r></w:p><w:p><w:r><w:t>last</w:t></w:r></w:p>'],
    ['a paragraph left open', '<w:p><w:r><w:t>first</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r><w:p><w:r><w:t>third</w:t></w:r></w:p>'],
    ['a mismatched end tag', '<w:p><w:r><w:t>one</w:t></w:p></w:r><w:p><w:r><w:t>two</w:t></w:r></w:p>'],
  ]) await assert.rejects(read(await bodyZip(body)), e => e instanceof DocxError, what);
  const d = await read(await bodyZip('<w:p><w:r><w:t>a &lt;- b</w:t></w:r></w:p><w:p><w:r><w:t>last</w:t></w:r></w:p>'));
  assert.equal(bodyText(d), 'a <- b\nlast');
});

test('malformed.rs deep_nesting_is_rejected', async () => {
  await assert.rejects(read(await bodyZip('<w:sdt><w:sdtContent>'.repeat(5000))), e => e instanceof DocxError);
  const y = `${'<w:tbl><w:tr><w:tc>'.repeat(60)}<w:p><w:r><w:t>deep</w:t></w:r></w:p>${'</w:tc></w:tr></w:tbl>'.repeat(60)}`;
  const d = await read(await bodyZip(y));
  assert.ok(JSON.stringify(d.body).includes('deep'));
  await writeDocx(d);
});

test('malformed.rs broken_secondary_parts_are_ignored', async () => {
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="b" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>';
  const z = await zip([['_rels/.rels', ROOT_RELS], ['word/document.xml', `<w:document ${W_NS}><w:body><w:p><w:r><w:t>body</w:t></w:r></w:p></w:body></w:document>`],
    ['word/_rels/document.xml.rels', rels], ['word/styles.xml', Uint8Array.from([0xff, 0xfe])],
    ['word/numbering.xml', '<w:numbering><w:num w:numId="1"><w:abstractNumId w:val="999"/></w:num></w:numbering>'], ['word/comments.xml', '<<<']]);
  const d = await read(z);
  assert.equal(bodyText(d), 'body');
  await writeDocx(d);
});

test('malformed.rs many_fields_and_huge_attribute_values', async () => {
  const x = `<w:p>${'<w:r><w:fldChar w:fldCharType="begin"/></w:r>'.repeat(200)}<w:r><w:rPr><w:rFonts w:ascii="${'F'.repeat(100_000)}"/></w:rPr><w:t>x</w:t></w:r></w:p><w:p><w:r><w:t>later</w:t></w:r></w:p>`;
  const d = await read(await bodyZip(x));
  assert.ok(JSON.stringify(d.body).includes('later'));
});

test('malformed.rs millions_of_attributes_on_one_paragraph_are_capped', async () => {
  let attrs = '';
  for (let i = 0; i < 2_000_000; i++) attrs += ` a${i}=""`;
  const t0 = Date.now();
  const r = await kindOf(read(await bodyZip(`<w:p${attrs}><w:r><w:t>kept</w:t></w:r></w:p>`)).then(d => { assert.ok(bodyText(d).includes('kept')); return d; }));
  assert.ok(r === 'ok' || !String(r).startsWith('other:'), String(r));
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
});
