// Security audit H2: hand-rolled XML scanners treat an unterminated construct as malformed input
// (indexOf === -1) instead of looping forever from the start of the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXml, readXfdf} from '../../core/folio/lib/comment-pdf.mjs';
import {dataValues} from '../../core/folio/lib/form-data.mjs';

test('XFDF with an unterminated PI, comment, CDATA or declaration is rejected, not looped on', () => {
  for (const src of ['<xfdf>x<?', '<xfdf>xx<!--', '<xfdf>x<![CDATA[abc', '<xfdf>x<!DOCTYPE', '<?xml version="1.0"', '<xfdf><!-- never closed --']) {
    assert.throws(() => parseXml(src), e => e.code === 'invalid_params', src);
    assert.throws(() => readXfdf(src), e => e.code === 'invalid_params', src);
  }
});

test('XFDF with closed constructs still parses', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><xfdf><![CDATA[a<b]]><annots/></xfdf>');
  const x = root.children.find(c => c.name === 'xfdf');
  assert.equal(x.text, 'a<b');
  assert.ok(x.children.some(c => c.name === 'annots'));
});

test('FDF with an unterminated hex string is rejected', () => {
  const bytes = new TextEncoder().encode('%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T (a) /V <41');
  assert.throws(() => dataValues(bytes));
});

// Security audit M4: the Mailings recipients scanner is linear.
import {walk} from '../../core/quill/lib/mailings-sheet.mjs';

test('Mailings XML walk takes linear time on unterminated tags', () => {
  for (const src of ['<a '.repeat(400_000), '<a "'.repeat(300_000), '<!--'.repeat(300_000), '<'.repeat(600_000), '< '.repeat(300_000)]) {
    const t = Date.now();
    let events = 0;
    walk(src, () => { events += 1; });
    assert.ok(Date.now() - t < 1500, `${src.slice(0, 6)} took ${Date.now() - t} ms`);
  }
});

test('Mailings XML walk still reads tags, attributes, self-closing tags, CDATA and entities', () => {
  const seen = [];
  walk('<?xml version="1.0"?><!-- c --><r:row id="7" t=\'x\'><c a="1"/><![CDATA[a<b]]>x &amp; y</r:row>', e => seen.push(e.type === 'start' ? `start ${e.name} ${e.attr('id') ?? e.attr('a') ?? e.attr('t')}` : e.type === 'end' ? `end ${e.name}` : `text ${e.text}`));
  assert.deepEqual(seen, ['start row 7', 'start c 1', 'end c', 'text a<b', 'text x & y', 'end row']);
});
