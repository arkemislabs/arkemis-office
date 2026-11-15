// Ported from wordcraft crates/doc/src/chart.rs and crates/doc/src/smart_art.rs (mod tests) at
// aadb077e072b7de05f724e359d8db82e151f125c. Each test names the Rust test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Ch from '../../../core/quill/model/chart.mjs';
import * as SA from '../../../core/quill/model/smart-art.mjs';

test('chart: sanitize_caps_sizes_and_drop_non_finite_values', () => {
  const c = Ch.sanitizedChart({
    type: 'column',
    categories: Array.from({length: Ch.MAX_POINTS + 10}, () => 'a'),
    series: Array.from({length: Ch.MAX_SERIES + 5}, (_, i) => ({name: `${'x'.repeat(400)}\n${i}`, values: [NaN, Infinity, 1]})),
    title: '  ', legend: null, dataLabels: false,
  });
  assert.equal(Ch.chartPoints(c), Ch.MAX_POINTS);
  assert.ok(c.series.length * Ch.chartPoints(c) <= Ch.MAX_CELLS);
  assert.ok(c.series.length > 0);
  const s = c.series[0];
  assert.equal(s.values.length, Ch.MAX_POINTS);
  assert.deepEqual(s.values.slice(0, 3), [null, null, 1]);
  assert.equal([...s.name].length, Ch.MAX_TEXT);
  assert.ok(!s.name.includes('\n'));
  assert.equal(c.title, null);
});

test('chart: short_categories_are_padded_to_the_longest_series', () => {
  const c = Ch.sanitizedChart({type: 'column', categories: ['a'], series: [{name: 's', values: [1, 2]}], title: null, legend: null, dataLabels: false});
  assert.deepEqual(c.categories, ['a', '']);
  assert.equal(Ch.chartTypeFromId('BARSTACKED'), 'barStacked');
  assert.equal(Ch.legendPosFromId('top'), 'top');
  assert.equal(Ch.sampleChart('pie').series.length, 1);
});

test('smart_art: sanitize_caps_items_text_and_levels', () => {
  const s = SA.sanitizedSmartArt({layout: 'basicList', colors: 'accent1',
    items: Array.from({length: SA.MAX_ITEMS + 20}, (_, i) => ({text: `${'x'.repeat(400)}\n${i}`, level: i === 0 ? 5 : 200}))});
  assert.equal(s.items.length, SA.MAX_ITEMS);
  assert.equal(s.items[0].level, 0, 'the first item is at the top');
  assert.equal(s.items[1].level, 1, 'one level below the item before');
  assert.ok(s.items.every(it => it.level <= SA.MAX_LEVEL));
  assert.equal([...s.items[0].text].length, SA.MAX_TEXT);
  assert.ok(!s.items[0].text.includes('\n'));
});

test('smart_art: parents_and_descendants_follow_levels', () => {
  const s = SA.sanitizedSmartArt(SA.sampleSmartArt('hierarchy'));
  assert.deepEqual(SA.smartArtParents(s), [null, 0, 1, 0, 3, 3]);
  assert.deepEqual(SA.smartArtDescendants(s, 0), [1, 6]);
  assert.deepEqual(SA.smartArtDescendants(s, 1), [2, 3]);
  assert.deepEqual(SA.smartArtDescendants(s, 5), [6, 6]);
  assert.deepEqual(SA.smartArtDescendants(s, 99), [0, 0]);
  assert.equal(SA.smartArtLayoutFromId('VENN'), 'venn');
  assert.equal(SA.smartArtLayoutFromId('basic-list'), 'basicList');
  assert.equal(SA.smartArtLayoutFromId('Basic Process'), 'process');
  assert.equal(SA.smartArtLayoutFromId('basic_cycle'), 'cycle');
  assert.equal(SA.smartArtLayoutFromId('list'), 'basicList');
  assert.equal(SA.smartArtColorsFromId('colorful'), 'colorful');
  assert.equal(SA.smartArtColorsFromId('Accent 2'), 'accent2');
  assert.equal(SA.smartArtColorsFromId('accent-4'), 'accent4');
  assert.equal(SA.cleanSmartArtText(`${' '.repeat(1500)}Valid Text`), 'Valid Text');
});
