// Ported from wordcraft crates/doc/src/{cluster,bidi,cjk_numbers,collate,locale_number,symbol_fonts}.rs
// and crates/geom/src/lib.rs (mod tests) at aadb077e072b7de05f724e359d8db82e151f125c. Each test
// names the Rust test. Upstream cluster offsets are UTF-8 bytes (3 per Myanmar letter); here they
// are UTF-16 units (1 per letter), and "inside a character" cases use a surrogate pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../../core/quill/model/text.mjs';
import {formatNumber as fmt} from '../../../core/quill/model/numfmt.mjs';
import {collate, headingLetter, sortKey} from '../../../core/quill/model/collate.mjs';
import {parseNumber, formatNumber, decimalSeparator} from '../../../core/quill/model/locale-number.mjs';
import {isSymbolFont, symbolChar, mapText} from '../../../core/quill/model/symbol-fonts.mjs';
import * as G from '../../../core/quill/lib/geom.mjs';

const MYANMAR = 'မြန်မာစာ';
const split = (s, at) => at.map((a, n) => s.slice(a, at[n + 1] ?? s.length));
const cp = s => s.codePointAt(0);

// --- cluster.rs ---
test('cluster: myanmar_vowel_signs_stay_in_their_syllable', () => {
  assert.deepEqual(split(MYANMAR, T.clusterStarts(MYANMAR)), ['မြ', 'န်', 'မာ', 'စာ']);
  assert.deepEqual(split('ကြေး', T.clusterStarts('ကြေး')), ['ကြေး']);
  assert.deepEqual(T.clusterStarts('မ္ဘာ'), [0]);
  const kinzi = 'အင်္ဂလိပ်';
  assert.deepEqual(split(kinzi, T.clusterStarts(kinzi)), ['အ', 'င်္ဂ', 'လိ', 'ပ်']);
});

test('cluster: ascii_cluster_starts_match_the_graphemes', () => {
  const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  const graphemes = t => [...seg.segment(t)].map(x => x.index);
  let all = '';
  for (let i = 0; i < 128; i++) all += String.fromCharCode(i);
  for (const t of ['', 'a', 'Hello, world.', '\r\n', 'a\r\nb\n\rc\r\r\n\n', '\t \u007fx\u0000', all]) assert.deepEqual(T.clusterStarts(t), graphemes(t), JSON.stringify(t));
  for (let a = 0; a < 128; a++) for (let b = 0; b < 128; b++) {
    const t = String.fromCharCode(a) + String.fromCharCode(b);
    assert.deepEqual(T.clusterStarts(t), graphemes(t), JSON.stringify(t));
  }
});

test('cluster: khmer_subscripts_and_indic_conjuncts_are_one_cluster', () => {
  assert.deepEqual(split('ខ្មែរ', T.clusterStarts('ខ្មែរ')), ['ខ្មែ', 'រ']);
  assert.deepEqual(split('क्षि हि', T.clusterStarts('क्षि हि')), ['क्षि', ' ', 'हि']);
  assert.deepEqual(split('éa', T.clusterStarts('éa')), ['é', 'a']);
});

test('cluster: caret_steps_skip_over_whole_clusters', () => {
  const s = MYANMAR;
  assert.equal(T.nextCluster(s, 0), 2);
  assert.equal(T.nextCluster(s, 4), 6, 'past the aa sign, not before it');
  assert.equal(T.prevCluster(s, 6), 4);
  assert.equal(T.prevCluster(s, 0), 0);
  assert.equal(T.nextCluster(s, s.length), s.length);
  assert.ok(!T.isClusterBoundary(s, 5) && T.isClusterBoundary(s, 4));
  assert.equal(T.nextCluster(s, 1000), s.length);
  // Inside a character: a surrogate pair stands in for upstream's inside-a-UTF-8-sequence.
  assert.ok(!T.isClusterBoundary('a\u{1F600}b', 2));
  assert.equal(T.prevCluster('', 5), 0);
  assert.equal(T.nextCluster('', 0), 0);
});

test('cluster: myanmar_wraps_between_syllables', () => {
  assert.deepEqual(T.myanmarBreaks(MYANMAR), [4, 6]);
  assert.deepEqual(T.myanmarBreaks('မ္ဘာ'), []);
  assert.deepEqual(T.myanmarBreaks('ကျွန်'), []);
  assert.deepEqual(T.myanmarBreaks('abcက'), []);
  assert.deepEqual(T.myanmarBreaks(''), []);
});

test('cluster: backspace_by_character_in_brahmic_scripts_only', () => {
  assert.ok(T.backspacesByChar(cp('ေ')) && T.backspacesByChar(cp('ि')) && T.backspacesByChar(cp('្')));
  assert.ok(!T.backspacesByChar(0x301) && !T.backspacesByChar(cp('a')) && !T.backspacesByChar(cp('語')));
});

// --- bidi.rs ---
test('bidi: classifies_persian_and_latin', () => {
  const all = (s, f) => [...s].every(c => f(cp(c)));
  assert.ok(all('سلام', T.isRtlScript));
  assert.ok(all('پچژگکی', T.isRtlScript));
  assert.ok(all('۰۱۲۳۴۵۶۷۸۹', T.isRtlScript));
  assert.ok(T.isRtlScript(0x064e));
  assert.ok(all('שלום', T.isRtlScript));
  assert.ok(![...'Hello 123'].some(c => T.isRtlScript(cp(c))));
  assert.ok(!T.isRtlScript(0x200c));
  assert.ok(T.isComplexScript(cp('क')) && !T.isRtlScript(cp('क')));
  assert.ok(T.hasRtl('Word ورد 2024') && !T.hasRtl('Word 2024'));
  assert.ok(all('می‌خواهم', T.isWordChar));
  assert.ok(all('کِتاب', T.isWordChar));
  assert.ok(!T.isWordChar(cp(' ')) && !T.isWordChar(cp('،')));
  assert.ok(T.firstStrongIsRtl('سلام'));
  assert.ok(T.firstStrongIsRtl('من ناوم هێڤاره'));
  assert.ok(T.firstStrongIsRtl('  123. سلام'));
  assert.ok(!T.firstStrongIsRtl('Hello سلام'));
  assert.ok(!T.firstStrongIsRtl('123 Hello'));
  assert.ok(!T.firstStrongIsRtl(''));
});

// --- cjk_numbers.rs ---
const each = (f, ns) => ns.map(n => fmt(f, n));
test('cjk_numbers: chinese_no_zero_after_group_trailing_zeros', () => {
  assert.equal(fmt('chineseCountingThousand', 201_000), '二十万一千');
  assert.equal(fmt('chineseCountingThousand', 120_000), '十二万');
  assert.equal(fmt('chineseCountingThousand', 100_100), '十万零一百');
  assert.equal(fmt('taiwaneseCountingThousand', 201_000), '二十萬一千');
  assert.equal(fmt('chineseCountingThousand', 100_000_001), '一亿零一');
  assert.equal(fmt('chineseCountingThousand', 100_010_000), '一亿零一万');
  assert.equal(fmt('chineseCountingThousand', 120_000_001), '一亿二千万零一');
});
test('cjk_numbers: chinese_counting_systems', () => {
  assert.deepEqual(each('chineseCounting', [1, 2, 3, 10, 11, 20, 21, 99]), ['一', '二', '三', '十', '十一', '二十', '二十一', '九十九']);
  assert.deepEqual(each('chineseCounting', [100, 101, 1000]), ['一〇〇', '一〇一', '一〇〇〇']);
  assert.deepEqual(each('chineseCountingThousand', [10, 11, 20, 101, 110, 111, 1000, 1010]), ['十', '十一', '二十', '一百零一', '一百一十', '一百一十一', '一千', '一千零一十']);
  assert.deepEqual(each('chineseCountingThousand', [10_000, 10_001, 100_100, 1_000_000, 100_000_001]), ['一万', '一万零一', '十万零一百', '一百万', '一亿零一']);
  assert.equal(fmt('chineseCountingThousand', 4294967295), '四十二亿九千四百九十六万七千二百九十五');
  assert.deepEqual(each('chineseLegalSimplified', [1, 3, 10, 11, 101, 1000]), ['壹', '叁', '壹拾', '壹拾壹', '壹佰零壹', '壹仟']);
  assert.deepEqual([fmt('taiwaneseCountingThousand', 10_001), fmt('ideographLegalTraditional', 20)], ['一萬零一', '貳拾']);
  assert.deepEqual(each('ideographDigital', [10, 101]), ['一〇', '一〇一']);
});
test('cjk_numbers: japanese_and_korean', () => {
  assert.deepEqual(each('japaneseCounting', [10, 11, 20, 101, 1000, 10_000, 10_001]), ['十', '十一', '二十', '百一', '千', '一万', '一万一']);
  assert.deepEqual(each('japaneseLegal', [10, 1000]), ['壱拾', '壱阡']);
  assert.deepEqual(each('japaneseDigitalTenThousand', [12, 10_000, 12_345, 100_000_000]), ['一二', '一万〇〇〇〇', '一万二三四五', '一億〇〇〇〇万〇〇〇〇']);
  assert.deepEqual(each('koreanCounting', [11, 20, 101]), ['십일', '이십', '백일']);
  assert.deepEqual([fmt('koreanDigital', 10), ...each('koreanLegal', [1, 11, 20, 100])], ['일영', '하나', '열하나', '스물', '100']);
});
test('cjk_numbers: sequences_and_enclosed_numbers', () => {
  assert.deepEqual(each('ideographTraditional', [1, 10, 11]), ['甲', '癸', '11']);
  assert.deepEqual(each('ideographZodiac', [1, 12, 13]), ['子', '亥', '13']);
  assert.deepEqual(each('ideographZodiacTraditional', [1, 11, 60]), ['甲子', '甲戌', '癸亥']);
  assert.deepEqual(each('decimalEnclosedCircle', [1, 20, 21]), ['①', '⑳', '21']);
  assert.deepEqual(each('decimalEnclosedCircleChinese', [10, 11]), ['⑩', '11']);
  assert.deepEqual([fmt('decimalEnclosedFullstop', 1), fmt('decimalEnclosedParen', 20), fmt('ideographEnclosedCircle', 1)], ['⒈', '⒇', '㊀']);
  assert.equal(fmt('decimalFullWidth', 10), '１０');
  assert.deepEqual([...each('aiueoFullWidth', [1, 46, 47]), fmt('aiueo', 2)], ['ア', 'ン', '47', 'ｲ']);
  assert.deepEqual([...each('irohaFullWidth', [1, 47]), fmt('iroha', 3)], ['イ', 'ス', 'ﾊ']);
  assert.deepEqual([fmt('ganada', 1), fmt('chosung', 14), fmt('ganada', 0)], ['가', 'ㅎ', '0']);
});

// --- collate.rs ---
const sorted = (words, lang) => words.slice().sort((a, b) => collate(a, b, lang));
test('collate: polish_letters_follow_their_base_letter', () => {
  assert.deepEqual(sorted(['Zakopane', 'Łódź', 'Kraków'], 'pl-PL'), ['Kraków', 'Łódź', 'Zakopane']);
  assert.deepEqual(sorted(['zebra', 'ćma', 'dom'], 'pl-PL'), ['ćma', 'dom', 'zebra']);
  assert.deepEqual(sorted(['żaba', 'źle', 'zebra', 'ząb', 'lato', 'łapa', 'mama'], 'pl'), ['lato', 'łapa', 'mama', 'ząb', 'zebra', 'źle', 'żaba']);
  assert.deepEqual(sorted(['b', 'ą', 'a'], 'pl'), ['a', 'ą', 'b']);
  assert.deepEqual(sorted(['Malbork', 'Łódź', 'Lublin'], 'pl'), ['Lublin', 'Łódź', 'Malbork']);
  assert.deepEqual(sorted(['ósmy', 'owca', 'pies'], 'pl'), ['owca', 'ósmy', 'pies']);
  assert.deepEqual(sorted(['ściana', 'sum', 'tak'], 'pl'), ['sum', 'ściana', 'tak']);
  assert.deepEqual(sorted(['ęsi', 'ezop', 'fala'], 'pl'), ['ezop', 'ęsi', 'fala']);
  assert.deepEqual(sorted(['ńa', 'nz', 'oko'], 'pl'), ['nz', 'ńa', 'oko']);
  assert.equal(headingLetter('ósmy', 'pl'), 'Ó');
  assert.equal(headingLetter('ńa', 'pl'), 'Ń');
  assert.equal(collate('żaba', 'żaba', 'pl-PL'), 0);
  assert.equal(collate('żaba', 'zebra', 'pl-PL'), 1);
  assert.equal(headingLetter('Żaba', 'pl'), 'Ż');
  assert.equal(collate('ą', 'ą', 'pl'), 0);
});
test('collate: swedish_puts_a_ring_and_umlauts_after_z', () => {
  assert.deepEqual(sorted(['ödla', 'zebra', 'äpple', 'åka', 'apa'], 'sv-SE'), ['apa', 'zebra', 'åka', 'äpple', 'ödla']);
});
test('collate: german_sorts_umlauts_with_their_base_letter', () => {
  assert.deepEqual(sorted(['Zug', 'Äpfel', 'Apfel', 'Bach'], 'de-DE'), ['Apfel', 'Äpfel', 'Bach', 'Zug']);
  assert.deepEqual(sorted(['Straße', 'Strasse', 'Strand'], 'de'), ['Strand', 'Strasse', 'Straße']);
});
test('collate: russian_yo_sorts_with_e_instead_of_after_ya', () => {
  for (const lang of ['ru', 'ru-RU', 'RU_ru']) {
    assert.deepEqual(sorted(['яблоко', 'ёлка', 'жук', 'ель', 'ёж', 'еж'], lang), ['еж', 'ёж', 'ёлка', 'ель', 'жук', 'яблоко']);
    assert.equal(collate('ЁЛКА', 'ёлка', lang), 0);
    assert.equal(headingLetter('Ёлка', lang), 'Ё');
  }
});
test('collate: russian_decomposed_letters_match_their_composed_forms', () => {
  for (const [c, d] of [['ёлка', 'ёлка'], ['Ёлка', 'Ёлка'], ['йод', 'йод'], ['Йод', 'Йод']]) {
    assert.equal(collate(c, d, 'ru-RU'), 0);
    assert.equal(headingLetter(c, 'ru'), headingLetter(d, 'ru'));
  }
  assert.deepEqual(sorted(['к', 'й', 'и'], 'ru'), ['и', 'й', 'к']);
});
test('collate: spanish_n_tilde_after_n', () => {
  assert.deepEqual(sorted(['oso', 'ñu', 'nube'], 'es-ES'), ['nube', 'ñu', 'oso']);
});
test('collate: czech_slovak_hungarian_alphabets', () => {
  assert.deepEqual(sorted(['chata', 'hrad', 'ihla', 'cesta', 'čaj', 'dům'], 'cs-CZ'), ['cesta', 'čaj', 'dům', 'hrad', 'chata', 'ihla']);
  assert.deepEqual(sorted(['ôsmy', 'oko', 'pes', 'ä', 'b'], 'sk'), ['ä', 'b', 'oko', 'ôsmy', 'pes']);
  assert.deepEqual(sorted(['csak', 'cukor', 'dob', 'szó', 'sűrű', 'tál'], 'hu-HU'), ['cukor', 'csak', 'dob', 'sűrű', 'szó', 'tál']);
  assert.deepEqual(sorted(['ötös', 'őr', 'pálya', 'olló', 'ör'], 'hu'), ['olló', 'ör', 'őr', 'ötös', 'pálya']);
});
test('collate: english_keeps_case_insensitive_order_and_folds_accents', () => {
  assert.deepEqual(sorted(['rex', 'résumé', 'resume', 'Apple', 'banana'], 'en-US'), ['Apple', 'banana', 'resume', 'résumé', 'rex']);
  assert.equal(collate('Łódź', 'Lodz'), 1);
  assert.equal(collate('Łódź', 'Lodzia'), -1);
  assert.equal(collate('ABC', 'abc'), 0);
});
test('collate: heading_letters', () => {
  assert.equal(headingLetter('Łódź', 'pl-PL'), 'Ł');
  assert.equal(headingLetter('Łódź', 'en-US'), 'L');
  assert.equal(headingLetter('chata', 'cs'), 'Ch');
  assert.equal(headingLetter('Äpfel', 'de'), 'A');
  assert.equal(headingLetter('Äpple', 'sv'), 'Ä');
  assert.equal(headingLetter('', 'sv'), null);
});
test('collate: hostile_input_never_panics', () => {
  for (const s of ['', '́', 'á́́', 'dzs', '\u{10FFFF}', 'ẞ', 'İstanbul']) for (const l of [null, 'hu', '', '-', 'tr-TR']) { sortKey(s, l); headingLetter(s, l); }
});

// --- locale_number.rs ---
test('locale_number: polish_numbers', () => {
  const pl = 'pl-PL';
  for (const [s, v] of [['1,5', 1.5], ['3,50', 3.5], ['1 250,00', 1250], ['1 250,00 zł', 1250], ['1.250,00', 1250], ['1.5', 1.5], ['-2,25', -2.25], ['PLN 12', 12],
    ['abc', null], ['1,2,3', null], ['1.', 1], ['10.', 10], ['0.125', 0.125], ['0,125', 0.125], ['12 %', 12], ['12%', 12], ['–2,5', -2.5], ['%', null], ['.', null]]) {
    assert.equal(parseNumber(s, pl), v, s);
  }
  assert.equal(formatNumber(5.75, pl), '5,75');
  assert.equal(formatNumber(1350, pl), '1350');
  assert.equal(formatNumber(-0.001, pl), '0,00');
});
test('locale_number: overflowing_digit_strings_are_not_numbers', () => {
  assert.equal(parseNumber('1'.repeat(350)), null);
  assert.equal(parseNumber('9'.repeat(400), 'pl-PL'), null);
  assert.equal(parseNumber('-' + '1'.repeat(350)), null);
  assert.ok(Number.isFinite(parseNumber('1'.repeat(300))));
});
test('locale_number: cuban_and_peruvian_numbers_use_decimal_points', () => {
  for (const lang of ['es-CU', 'es-PE']) {
    assert.equal(parseNumber('1.234', lang), 1.234);
    assert.equal(parseNumber('1,234.50', lang), 1234.5);
    assert.equal(formatNumber(5.75, lang), '5.75');
  }
  assert.equal(parseNumber('1.234,50', 'es-ES'), 1234.5);
  assert.equal(formatNumber(5.75, 'es-ES'), '5,75');
});
test('locale_number: english_numbers', () => {
  const en = 'en-US';
  for (const [s, l, v] of [['1,250.50', en, 1250.5], ['$1,250', en, 1250], ['1.5', en, 1.5], ['12', null, 12], ['.5', null, 0.5], ['1,5', en, null], ['1.', en, 1], ['0,125', en, null]]) {
    assert.equal(parseNumber(s, l), v, s);
  }
  assert.equal(formatNumber(5.75, en), '5.75');
  assert.equal(formatNumber(-0.001, en), '0.00');
  assert.equal(formatNumber(-0, null), '0');
  assert.equal(decimalSeparator('de-CH'), '.');
  assert.equal(decimalSeparator('de-DE'), ',');
});
test('locale_number: hostile_numbers_never_panic', () => {
  for (const s of ['', '-', '+', ',', '.', '1e400', 'inf', 'NaN', '--1', '₽', '1 ,', ' zł', '−', '9'.repeat(500)]) for (const l of [null, 'pl', 'en', '']) parseNumber(s, l);
  assert.equal(formatNumber(NaN), '0');
});
test('locale_number: large_whole_numbers_have_no_decimals', () => {
  assert.equal(formatNumber(1e15), '1000000000000000');
  assert.equal(formatNumber(2.5e15), '2500000000000000');
  assert.equal(formatNumber(-1e15), '-1000000000000000');
  assert.equal(formatNumber(9.0e18), '9000000000000000000');
  assert.equal(formatNumber(1e15 + 0.5), '1000000000000000.50');
});

// --- symbol_fonts.rs ---
test('symbol_fonts: both_storage_forms_map_alike', () => {
  for (const f of ['Symbol', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings']) {
    assert.ok(isSymbolFont(f));
    for (let code = 0x20; code <= 0xff; code++) {
      if (code === 0xad) { assert.equal(symbolChar(f, code), null); continue; }
      assert.equal(symbolChar(f, 0xf000 + code), symbolChar(f, code), `${f} ${code.toString(16)}`);
    }
  }
});
test('symbol_fonts: pcl6_symbol_encoding', () => {
  for (const family of ['Symbol (PCL6)', ' symbol (pcl6) ']) {
    assert.ok(isSymbolFont(family));
    for (let code = 0x20; code <= 0xff; code++) {
      assert.equal(symbolChar(family, code), symbolChar('Symbol', code));
      assert.equal(symbolChar(family, 0xf000 + code), symbolChar('Symbol', 0xf000 + code));
    }
    assert.equal(symbolChar(family, ''), '≥');
  }
  assert.ok(!isSymbolFont('Symbol (unknown)'));
});
test('symbol_fonts: symbol_uses_the_adobe_symbol_encoding', () => {
  for (const [c, want] of [['', 'α'], ['m', 'μ'], ['W', 'Ω'], ['', '•'], ['', '∞'], ['', '√'], ['', null]]) assert.equal(symbolChar('Symbol', c), want, c);
  assert.equal(symbolChar('symbol', 'a'), 'α');
});
test('symbol_fonts: wingdings_codes', () => {
  for (const [c, want] of [['', '☺'], ['J', '☺'], ['L', '☹'], ['', '✓'], ['', '\u{1F5F9}'], ['', '◼'], ['', '▪'], ['', '❖'],
    ['', '\u{1F57F}'], ['', null]]) assert.equal(symbolChar('Wingdings', c), want, c);
});
test('symbol_fonts: wingdings_2_3_and_webdings_codes', () => {
  assert.equal(symbolChar('Wingdings 2', ''), '\u{1F5F8}');
  assert.equal(symbolChar('Wingdings 2', 'O'), '\u{1F5F4}');
  assert.equal(symbolChar('Wingdings 2', ''), null);
  assert.equal(symbolChar('Wingdings 3', ''), '⭠');
  assert.equal(symbolChar('Wingdings 3', ''), null);
  assert.equal(symbolChar('Webdings', ''), '\u{1F394}');
  assert.equal(symbolChar('Webdings', 'a'), '✔');
  assert.equal(symbolChar('Webdings', ''), '\u{1F54A}');
});
test('symbol_fonts: other_fonts_and_characters_are_left_alone', () => {
  assert.ok(!isSymbolFont('Arial'));
  assert.equal(symbolChar('Arial', ''), null);
  assert.equal(symbolChar('Wingdings', '\u{1F600}'), null);
  assert.equal(symbolChar('Wingdings', '\u{10FFFF}'), null);
  assert.equal(symbolChar('Wingdings', '\u001F'), null);
  assert.equal(mapText('Wingdings', 'Jé'), '☺☹\u{1F879}');
  assert.equal(mapText('Arial', 'J'), 'J');
});

// --- geom lib.rs ---
test('geom: unit_round_trips', () => {
  assert.equal(G.twips(1440), 72);
  assert.equal(G.toTwips(72), 1440);
  assert.equal(G.emu(914_400), 72);
  assert.equal(G.toEmu(72), 914_400);
  assert.equal(G.halfPoints(24), 12);
  assert.equal(G.toHalfPoints(10.5), 21);
  assert.equal(G.toTwips(NaN), 0);
});
test('geom: parses_measurements', () => {
  assert.equal(G.parseMeasure('1"', 'points'), 72);
  assert.equal(G.parseMeasure('1 in', 'points'), 72);
  assert.equal(G.parseMeasure('12pt', 'inches'), 12);
  assert.equal(G.parseMeasure('2', 'inches'), 144);
  assert.equal(G.parseMeasure('1,5 li', 'inches'), 18);
  assert.ok(Math.abs(G.parseMeasure('2.54 cm', 'inches') - 72) < 0.01);
  for (const s of ['abc', '', '1 furlong', '1,2,3', '3.4e38 in', '-3.4e38 in', '3.4e38 cm', '3.4e38 mm', '3.4e38 pi', '3.4e38 li', '1e39 pt', 'inf', 'nan']) assert.equal(G.parseMeasure(s, 'points'), null, s);
  assert.equal(G.parseMeasure('3.4e38', 'inches'), null);
  assert.ok(Math.abs(G.parseMeasure('2,54 cm', 'inches') - 72) < 0.01);
  assert.equal(G.parseMeasure('1,5', 'inches'), 108);
  assert.equal(G.parseMeasure('1.5"', 'centimeters'), 108);
  assert.equal(G.parseMeasure('−1 in', 'points'), -72);
});
test('geom: parse_measure_rejects_overflow_to_infinity', () => {
  const e38 = '1' + '0'.repeat(38);
  for (const s of [`${e38}"`, `${e38} in`, `${e38} cm`, `${e38} pi`, `${e38} li`, `-${e38} in`, e38]) assert.equal(G.parseMeasure(s, 'inches'), null, s);
  assert.equal(G.parseMeasure(`2${'0'.repeat(38)} mm`, 'inches'), null);
  const big = G.parseMeasure('1' + '0'.repeat(30) + ' in', 'points');
  assert.ok(Number.isFinite(big) && big > 0);
  assert.ok(Number.isFinite(G.parseMeasure(`${e38} pt`, 'inches')));
});
test('geom: formats_measurements', () => {
  assert.equal(G.formatUnit('inches', 72), '1"');
  assert.equal(G.formatUnit('inches', 90), '1.25"');
  assert.equal(G.formatUnit('points', 12), '12 pt');
  assert.equal(G.formatUnit('centimeters', 72), '2.54 cm');
  assert.equal(G.formatUnit('centimeters', 72, ','), '2,54 cm');
  assert.equal(G.formatUnit('inches', 108, ','), '1,5"');
  assert.equal(G.formatUnit('points', 720, ','), '720 pt');
  assert.equal(G.formatUnit('inches', NaN, ','), '0"');
});
test('geom: rect_ops', () => {
  const a = G.rect(0, 0, 10, 10), b = G.rect(5, 5, 10, 10);
  assert.ok(G.rectIntersects(a, b));
  assert.deepEqual(G.rectUnion(a, b), G.rect(0, 0, 15, 15));
  assert.ok(G.rectContains(a, {x: 5, y: 5}));
  assert.equal(G.rect(0, 0, -5, NaN).w, 0);
  assert.deepEqual(G.rectInset(a, 1, 2, 3, 4), G.rect(1, 2, 6, 4));
});
test('geom: paper_names', () => {
  assert.equal(G.paperName(612, 792), 'Letter');
  assert.equal(G.paperName(792, 612), 'Letter');
  assert.equal(G.paperName(100, 100), null);
  assert.equal(G.paperByName(' a4 ')[0], 'A4');
  assert.deepEqual(G.paperByName('Legal').slice(1), [612, 1008]);
  assert.equal(G.paperByName('Quarto'), null);
});
test('geom: pages_fit_other_paper', () => {
  const close = (a, b) => Math.abs(a - b) < 0.01;
  const f = G.fitToPaper(612, 792, 595.28, 841.89);
  assert.ok(close(f.paperW, 595.28) && close(f.paperH, 841.89));
  assert.ok(close(f.k, 595.28 / 612) && close(f.dx, 0));
  assert.ok(close(f.dy, (841.89 - 792 * f.k) / 2) && f.dy > 0);
  assert.ok(close(G.fitToPaper(595.28, 841.89, 612, 1008).k, 612 / 595.28));
  assert.ok(close(G.fitToPaper(419.53, 595.28, 595.28, 841.89).k, 595.28 / 419.53));
  const l = G.fitToPaper(792, 612, 595.28, 841.89);
  assert.ok(close(l.paperW, 841.89) && close(l.paperH, 595.28));
  assert.ok(close(l.k, 595.28 / 612) && l.dx > 0 && close(l.dy, 0));
  const same = G.fitToPaper(612, 792, 612, 792);
  assert.ok(close(same.k, 1) && close(same.dx, 0) && close(same.dy, 0));
  for (const [a, b, c, d] of [[NaN, 792, 595, 842], [612, 0, 595, 842], [612, 792, Infinity, 842], [612, 792, -5, 842]]) {
    const r = G.fitToPaper(a, b, c, d);
    assert.deepEqual([r.k, r.dx, r.dy], [1, 0, 0]);
  }
  assert.ok(Number.isFinite(G.fitToPaper(1, 1, 3.4028234663852886e38, 3.4028234663852886e38).k));
});
