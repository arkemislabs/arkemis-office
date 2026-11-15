// Ported from wordcraft crates/engine/src/cmd/citations/tests.rs at aadb077e072b7de05f724e359d8db82e151f125c
// (MIT, see assets/third-party-licenses/artcraft-reference.txt): the citation styles' rendering.
//
// Every upstream test here drives a Session; these ports keep only what render.rs and styles.rs
// decide (cite text, entry text, style lookup), against core/quill/lib/references-cite.mjs. The
// expected strings are upstream's literals; where upstream checks the document's text for a run of
// citations or a block of entries, the port joins the same cite()/entry() results in the order the
// session puts them (numbered styles: the numbers the session gives). Each test names the Rust test
// and line it ports; the Session halves (ordering, fields, docx, errors) belong to the command layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {STYLES, ORDER, findStyle, style, numbered, authors, cite, entry} from '../../../core/quill/lib/references-cite.mjs';

/** The two sources of two_sources() (tests.rs:513). */
const twoSources = aTitle => [
  {tag: 'A', author: 'Rivera, Alex; Chen, Mei', title: aTitle, year: '2021', publisher: 'Harbor Books', city: 'Portland'},
  {tag: 'B', author: 'Okafor, Ngozi', title: 'Kilns and Clay', year: '2019', journal: 'Studio Quarterly', volume: '4', pages: '10-20'},
];

// tests.rs:5 citations_and_bibliography
test('citations_and_bibliography: cite and entry', () => {
  const src = {author: 'Rivera, Alex; Chen, Mei', title: 'Shared Spaces', year: '2021', publisher: 'Harbor Books', city: 'Portland'};
  assert.ok(cite(src, 'APA', 1, '').includes('(Rivera & Chen, 2021)'));
  assert.ok(entry(src, 'APA', 1).includes('Rivera, A., & Chen, M. (2021). Shared Spaces. Harbor Books.'));
  assert.ok(cite(src, 'MLA', 1, '').includes('(Rivera and Chen)'));
  assert.ok(cite(src, 'IEEE', 1, '').includes('[1]'));
});

// tests.rs:38 bibliography_round_trip_docx (the Harvard citation and entry after the round trip)
test('bibliography_round_trip_docx: cite and entry', () => {
  const src = {
    author: 'Rivera, Alex; Chen, Mei', title: 'Shared Spaces', year: '2021', publisher: 'Harbor Books', city: 'Portland',
    editor: 'Johnson, Robert', edition: '2nd', issue: '4', month: '10', day: '15', accessed: '2024-05-15', doi: '10.1000/182',
  };
  assert.ok(cite(src, 'Harvard (Anglia)', 1, '').includes('(Rivera and Chen, 2021)'));
  assert.ok(entry(src, 'Harvard (Anglia)', 1).includes('Rivera, A. and Chen, M., 2021. Shared Spaces. Portland: Harbor Books.'));
});

// tests.rs:522 author_date_styles_cite_and_list (A cited with pages 12, then B; the list by author)
test('author_date_styles_cite_and_list: cite and entry', () => {
  const [a, b] = twoSources('Shared Spaces');
  const cases = [
    [
      'Harvard (Anglia)',
      '(Rivera and Chen, 2021, p. 12)(Okafor, 2019)',
      'Okafor, N., 2019. Kilns and Clay. Studio Quarterly, 4, pp. 10-20.\nRivera, A. and Chen, M., 2021. Shared Spaces. Portland: Harbor Books.',
    ],
    [
      'ISO 690 - First Element and Date',
      '(Rivera and Chen 2021, p. 12)(Okafor 2019)',
      'OKAFOR, Ngozi, 2019. Kilns and Clay. Studio Quarterly, 4, 10-20.\nRIVERA, Alex and CHEN, Mei, 2021. Shared Spaces. Portland: Harbor Books.',
    ],
    [
      'turabian',
      '(Rivera and Chen 2021, 12)(Okafor 2019)',
      'Okafor, Ngozi. “Kilns and Clay.” Studio Quarterly 4 (2019): 10-20.\nRivera, Alex, and Mei Chen. Shared Spaces. Portland: Harbor Books, 2021.',
    ],
  ];
  for (const [st, cites, list] of cases) {
    assert.equal(style(st).order, ORDER.AUTHOR, st);
    assert.ok(!numbered(style(st)), st);
    const t = cite(a, st, 1, '12') + cite(b, st, 2, '');
    assert.ok(t.startsWith(cites), `${st}: ${t}`);
    const l = `${entry(b, st, 1)}\n${entry(a, st, 2)}`;
    assert.ok(l.includes(list), `${st}: ${l}`);
  }
  // tests.rs:551: "Vancouver" is no style (the command's error names the current one).
  assert.equal(findStyle('Vancouver'), null);
  assert.equal(style('turabian').name, 'Turabian');
});

// tests.rs:638 numbered_styles_count_in_order_of_first_citation (B cited first is 1, A is 2)
test('numbered_styles_count_in_order_of_first_citation: cite and entry', () => {
  const [a, b] = twoSources('Shared Spaces');
  // tests.rs:644: A alone, the only citation, is number 1.
  assert.equal(cite(a, 'ISO 690 (numerical)', 1, '12'), '(1, p. 12)');
  const cases = [
    [
      'ISO 690 (numerical)',
      '(1)Later (2, p. 12)',
      '1. OKAFOR, Ngozi. Kilns and Clay. Studio Quarterly. 2019, 4, 10-20.\n2. RIVERA, Alex and CHEN, Mei. Shared Spaces. Portland: Harbor Books, 2021.',
    ],
    [
      'GB/T 7714',
      '[1]Later [2, 12]',
      '[1] OKAFOR N. Kilns and Clay[J]. Studio Quarterly, 2019, 4: 10-20.\n[2] RIVERA A, CHEN M. Shared Spaces[M]. Portland: Harbor Books, 2021.',
    ],
    [
      'SIST02',
      '(1)Later (2, p. 12)',
      '1) Okafor, Ngozi. Kilns and Clay. Studio Quarterly. 2019, vol. 4, p. 10-20.\n2) Rivera, Alex; Chen, Mei. Shared Spaces. Portland, Harbor Books, 2021.',
    ],
    [
      'IEEE',
      '[1]Later [2]',
      '[1] N. Okafor, “Kilns and Clay,” Studio Quarterly, 4, 10-20, 2019.\n[2] A. Rivera, M. Chen, “Shared Spaces,” Portland: Harbor Books, 2021.',
    ],
  ];
  for (const [st, cites, list] of cases) {
    assert.equal(style(st).name, st);
    assert.equal(style(st).order, ORDER.CITED, st);
    assert.ok(numbered(style(st)), st);
    const t = `${cite(b, st, 1, '')}Later ${cite(a, st, 2, '12')}`;
    assert.ok(t.startsWith(cites), `${st}: ${t}`);
    const l = `${entry(b, st, 1)}\n${entry(a, st, 2)}`;
    assert.ok(l.includes(list), `${st}: ${l}`);
  }
});

// tests.rs:681 gost_numbers_follow_its_name_or_title_sort (A cited, then B with pages 15)
test('gost_numbers_follow_its_name_or_title_sort', () => {
  const [a, b] = twoSources('Atlas of Studios');
  const okafor = 'Okafor N. Kilns and Clay // Studio Quarterly. – 2019. – Vol. 4. – P. 10-20.';
  const rivera = 'Rivera A., Chen M. Atlas of Studios. – Portland : Harbor Books, 2021.';
  // Word's style and style-sheet names pick the same styles.
  const byName = style('\\GostName.XSL');
  assert.equal(byName.name, 'GOST (name sort)');
  assert.equal(byName.order, ORDER.AUTHOR);
  // By name: Okafor 1, Rivera 2.
  let t = cite(a, byName.name, 2, '') + cite(b, byName.name, 1, '15');
  let l = `${entry(b, byName.name, 1)}\n${entry(a, byName.name, 2)}`;
  assert.ok(t.startsWith('[2][1, p. 15]') && l.includes(`1. ${okafor}\n2. ${rivera}`), `${t}\n${l}`);
  const byTitle = style('GOST - Title Sort');
  assert.equal(byTitle.name, 'GOST (title sort)');
  assert.equal(byTitle.order, ORDER.TITLE);
  // By title: "Atlas of Studios" 1, "Kilns and Clay" 2.
  t = cite(a, byTitle.name, 1, '') + cite(b, byTitle.name, 2, '15');
  l = `${entry(a, byTitle.name, 1)}\n${entry(b, byTitle.name, 2)}`;
  assert.ok(t.startsWith('[1][2, p. 15]') && l.includes(`1. ${rivera}\n2. ${okafor}`), `${t}\n${l}`);
  // tests.rs:698
  assert.equal(findStyle('ISO 690 - Numerical Reference')?.name, 'ISO 690 (numerical)');
  assert.equal(findStyle('Harvard - Anglia 2008')?.name, 'Harvard (Anglia)');
  assert.ok(findStyle('') === null && findStyle('Vancouver') === null);
});

// Not upstream: the record shape the command layer relies on.
test('styles are in picker order and authors split as upstream', () => {
  assert.equal(STYLES.length, 12);
  assert.equal(STYLES[0].name, 'APA');
  assert.equal(style('nonsense').name, 'APA');
  assert.equal(style('MLA').bibTitle, 'Works Cited');
  assert.deepEqual(authors(' Rivera, Alex ; Mei Chen;; Plato '), [['Rivera', 'Alex'], ['Chen', 'Mei'], ['Plato', '']]);
});
