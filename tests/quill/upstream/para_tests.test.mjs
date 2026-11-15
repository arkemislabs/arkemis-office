// Ports of the upstream Rust tests for paragraph formatting, lists and styles (Home › Paragraph,
// Home › Styles, Multilevel List): wordcraft crates/engine/src/tests.rs and
// crates/engine/src/cmd/lists.rs `mod tests` at aadb077e072b7de05f724e359d8db82e151f125c.
// Each test names the Rust test it ports.
//
// Behaviour fidelity: (1) upstream's own assertions; (2) setup that upstream types is built
// directly (paragraph per line), selections are UTF-16 offsets; list labels are read from the
// translated layout (core/quill/layout) as upstream reads `Placed::Lines` labels; DOCX round trips
// are the docx unit's; (3) parity evidence for core/quill/commands/{para,para/styles,lists}.mjs.
// Known divergence: upstream ignores a junk `beforeAuto: "yes"` (p::bool → None); the kernel
// validates params before a command runs, so ours is a params error that changes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {quill} from '../format-fixture.mjs';
import {getStyle, resolvePara, resolveChar} from '../../../core/quill/model/styles.mjs';
import * as P from '../../../core/quill/model/para.mjs';
import {listButtons} from '../../../core/quill/lib/para-lists.mjs';

const rp = (q, n) => resolvePara(q.t.content.styles, q.props(n));

test('tests.rs applying_a_heading_clears_list_numbering', async () => {
  for (const cmd of ['para.heading1', 'para.heading2', 'para.normal']) {
    const q = await quill('item');
    q.sel(0, 4);
    await q.exec('para.bullets');
    assert.ok(q.props(0).numbering?.num, `${cmd}: list numbering before the style`);
    await q.exec(cmd);
    assert.ok(!q.props(0).numbering || q.props(0).numbering.num === 0, `${cmd}: clears direct list numbering`);
  }
});

test('tests.rs line_and_page_break_toggles_take_an_explicit_value (#967, without Enter)', async () => {
  for (const [id, k] of [['para.keepNext', 'keepNext'], ['para.keepLines', 'keepLines'], ['para.pageBreakBefore', 'pageBreakBefore'], ['para.widowControl', 'widowControl']]) {
    const q = await quill('Heading\nnext');
    q.sel(0, 0);
    for (const value of [true, true, false, false, true]) {
      await q.exec(id, {value});
      assert.equal(q.props(0)[k], value, `${id} value ${value} sets, never toggles`);
    }
    q.sel(1, 0);
    await q.exec(id, {value: true});
    await q.exec(id, {value: false});
    assert.deepEqual([q.props(0)[k], q.props(1)[k]], [true, false], `${id} clears only the next paragraph`);
    await q.exec(id);
    assert.equal(q.props(1)[k], true, `${id} without value toggles`);
  }
});

test('tests.rs center_after_select_paragraph_leaves_the_next_paragraph_alone (#418)', async () => {
  const align = (q, i) => q.props(i).align;
  let q = await quill('Alpha\nBeta');
  q.sel([0, 0], [1, 0]);
  await q.exec('para.alignCenter');
  assert.deepEqual([align(q, 0), align(q, 1)], ['center', undefined]);
  for (const [a, b, want] of [[[1, 0], [0, 0], ['center', undefined]], [[0, 0], [1, 1], ['center', 'center']]]) {
    q = await quill('Alpha\nBeta');
    q.sel(a, b);
    await q.exec('para.align', {value: 'center'});
    assert.deepEqual([align(q, 0), align(q, 1)], want, `${a}..${b}`);
  }
  q = await quill('Alpha\nBeta');
  q.sel(1, 0);
  await q.exec('para.alignCenter');
  assert.deepEqual([align(q, 0), align(q, 1)], [undefined, 'center']);
});

test('tests.rs para_tabs_set_clear_and_undo', async () => {
  const q = await quill('Name\tPrice');
  q.sel(0, 0);
  await q.exec('para.style', {style: 'Header'});
  const stops = () => rp(q, 0).tabs.map(t => [t.pos, t.align, t.leader]);
  assert.equal(stops().length, 2, 'Header\'s own stops');
  await q.exec('para.tabs', {set: [{pos: 100, align: 'decimal', leader: 'dot'}, {pos: 300}], clear: [234], default: 18});
  assert.deepEqual(stops(), [[100, 'decimal', 'dot'], [300, 'left', 'none'], [468, 'right', 'none']]);
  assert.equal(q.t.content.settings.defaultTab, 18);
  // Setting a stop at an existing position replaces it.
  await q.exec('para.tabs', {set: [{pos: 300, align: 'bar'}]});
  assert.ok(stops().some(s => s[0] === 300 && s[1] === 'bar'));
  await q.exec('para.tabs', {clearAll: true});
  assert.deepEqual(stops(), [], 'Clear All removes inherited stops too');
  await q.t.undo();
  assert.equal(stops().length, 3);
  await q.t.undo();
  await q.t.undo();
  assert.equal(stops().length, 2);
  assert.equal(q.t.content.settings.defaultTab, 36, 'one undo step restores stops and default together');
  await assert.rejects(q.t.bridge('para.tabs', {set: [{pos: Number.MAX_VALUE}]}));
  await assert.rejects(q.t.bridge('para.tabs', {clear: 'x'}));
});

test('tests.rs para_tabs_default_only_undoes (#320)', async () => {
  const q = await quill('a\tb');
  q.sel(0, 0);
  await q.exec('para.tabs', {default: 72});
  assert.equal(q.t.content.settings.defaultTab, 72);
  await q.t.undo();
  assert.equal(q.t.content.settings.defaultTab, 36, 'undo restores the default interval');
  assert.equal(q.texts()[0], 'a\tb', 'only the setting was undone');
  await q.t.redo();
  assert.equal(q.t.content.settings.defaultTab, 72, 'redo sets it again');
});

test('tests.rs border_sides_apply_exactly (#320, the paragraph part)', async () => {
  const q = await quill('Boxed');
  q.sel(0, 0);
  const side = {style: 'double', width: 1.5, color: 'C00000'};
  await q.exec('para.borders', {sides: {top: side, bottom: side, left: side, right: side}});
  const b = q.props(0).borders;
  for (const x of [b.top, b.bottom, b.left, b.right]) assert.deepEqual([x.style, x.width, x.color], ['double', 1.5, [0xc0, 0, 0]]);
  assert.equal(b.between, undefined);
  await q.exec('para.borders', {sides: {}});
  assert.deepEqual(q.props(0).borders, {});
});

test('tests.rs asian_typography_sets_flags_on_selected_paragraphs_and_undoes', async () => {
  const q = await quill('一\n二\n三');
  q.sel([0, 0], [2, 1]);
  const r = await q.exec('para.asianTypography', {kinsoku: false, wordWrap: false, topLinePunct: true});
  assert.equal(r.result.asianTypography.kinsoku, false);
  assert.equal(r.result.asianTypography.autoSpaceDE, true, 'a flag left out keeps its default');
  for (let i = 0; i < 3; i++) {
    const p = q.props(i);
    assert.deepEqual([p.kinsoku, p.wordWrap, p.topLinePunct, p.overflowPunct], [false, false, true, undefined]);
  }
  await q.t.undo();
  for (let i = 0; i < 3; i++) assert.ok(q.props(i).kinsoku === undefined && q.props(i).wordWrap === undefined);
  assert.equal((await q.exec('para.asianTypography', {})).result.asianTypography.kinsoku, true);
});

test('tests.rs spacing_commands_handle_automatic_spacing', async () => {
  const q = await quill('Pasted from the web');
  q.sel(0, 0);
  await q.exec('para.spacing', {beforeAuto: true, afterAuto: true});
  assert.deepEqual([rp(q, 0).spaceBefore, rp(q, 0).spaceAfter, rp(q, 0).beforeAuto], [14, 14, true]);
  await q.exec('para.spacing', {before: 6});
  assert.deepEqual([rp(q, 0).spaceBefore, rp(q, 0).beforeAuto, rp(q, 0).afterAuto], [6, false, true], 'a number replaces Auto');
  await q.exec('para.removeSpaceAfter');
  assert.deepEqual([rp(q, 0).spaceAfter, rp(q, 0).afterAuto], [0, false]);
  await q.exec('para.spacing', {beforeAuto: true});
  await q.exec('para.addSpaceBefore');
  assert.deepEqual([rp(q, 0).spaceBefore, rp(q, 0).beforeAuto], [0, false], 'Ctrl+0 removes the automatic space');
  const doc = structuredClone(q.t.content);
  await assert.rejects(q.t.bridge('para.spacing', {beforeAuto: 'yes'}), /boolean|invalid|true or false/i);
  assert.deepEqual(q.t.content, doc, 'junk changes nothing');
});

test('tests.rs list_buttons_follow_the_paragraphs_own_level', async () => {
  const q = await quill('item');
  q.sel(0, 0);
  const state = () => listButtons(q.t.content.numbering, rp(q, 0).numbering);
  assert.deepEqual(state(), {bullets: false, numbering: false, multilevel: false}, 'plain text: no list button on');
  await q.exec('para.bullets');
  assert.deepEqual(state(), {bullets: true, numbering: false, multilevel: false});
  // A bulleted list whose second level is numbered: at level 2 the paragraph is numbered.
  const num = q.props(0).numbering.num;
  const numbering = q.t.content.numbering;
  const numbered = {start: 1, format: 'decimal', text: '%2.', align: 'left', indent: 36, hanging: 18, suffix: 'tab', chr: {}, restart: true, legal: false, style: null};
  await q.t.session.execute(q.t.docId, 'list.define', {levels: [], num, apply: false}, {origin: 'test'}).catch(() => {});
  const nums = numbering.nums.map(n => (n.id === num ? {...n, levelOverrides: [...(n.levelOverrides ?? []), [1, numbered]]} : n));
  // Set the override directly (upstream mutates the numbering in the test too).
  const content = {...q.t.content, numbering: {...q.t.content.numbering, nums}};
  // A store reload replaces a clean document's content; mark it clean first (test only).
  const doc = q.t.session.get(q.t.docId);
  doc.dirty = false;
  q.t.session.reload(q.t.docId, {...doc.file, content});
  q.sel(0, 0);
  await q.exec('para.listLevel', {level: 1});
  assert.deepEqual(state(), {bullets: false, numbering: true, multilevel: false});
  await q.exec('para.numbering');
  assert.deepEqual(state(), {bullets: false, numbering: false, multilevel: false}, 'Numbering toggles off the paragraph\'s effective numbered level');
  await q.exec('para.numbering');
  await q.exec('para.listLevel', {level: 1});
  assert.deepEqual(state(), {bullets: false, numbering: true, multilevel: false}, '1. a. i. is not multilevel');
  await q.exec('para.numbering', {off: true});
  await q.exec('para.multilevel', {kind: 'legal'});
  await q.exec('para.listLevel', {level: 0});
  assert.deepEqual(state(), {bullets: false, numbering: true, multilevel: true});
  await q.exec('para.listLevel', {level: 2});
  assert.ok(state().multilevel);
  await q.exec('para.numbering', {off: true});
  assert.deepEqual(state(), {bullets: false, numbering: false, multilevel: false});
});

test('tests.rs table_and_paragraph_sort_use_polish_alphabet (the paragraph part)', async () => {
  const q = await quill('źdźbło\nzebra\nżaba\nłąka\nlas', c => {
    const b = c.body.chunks[0].map(p => ({...p, runs: [{len: p.text.length, props: {lang: 'pl-PL'}}]}));
    return {...c, body: {...c.body, chunks: [b]}};
  });
  q.sel([0, 0], [4, 3]);
  await q.exec('para.sort');
  assert.deepEqual(q.texts(), ['las', 'łąka', 'zebra', 'źdźbło', 'żaba']);
});

// --- styles ------------------------------------------------------------------------------------

test('tests.rs styles_apply_by_name / styles_apply_undo_redo', async () => {
  const q = await quill('Title text');
  q.sel(0, 0);
  await q.exec('styles.apply', {style: 'Heading 1'});
  assert.equal(q.props(0).style, 'Heading1');
  await q.exec('styles.apply', {style: 'Heading 2'});
  await q.t.undo();
  assert.equal(q.props(0).style, 'Heading1');
  await q.t.redo();
  assert.equal(q.props(0).style, 'Heading2');
});

test('tests.rs styles_apply_pane_is_not_an_edit', async () => {
  const q = await quill('Hello');
  q.sel(0, 0);
  const v = q.t.version;
  assert.deepEqual((await q.exec('styles.apply', {})).result, {pane: true});
  assert.equal(q.t.doc.view.stylesPane, true);
  await q.exec('styles.apply', {});
  assert.equal(q.t.doc.view.stylesPane, true, 'shows, never toggles');
  assert.equal(q.t.version, v);
});

test('tests.rs styles_apply_rejects_bad_style_params / styles_apply_unknown_style_changes_nothing', async () => {
  const q = await quill('Hello');
  q.sel(0, 0);
  const doc = structuredClone(q.t.content);
  for (const bad of [5, null, [], {}, '', '   ', true, 'No Such Style']) await assert.rejects(q.t.bridge('styles.apply', {style: bad}), undefined, JSON.stringify(bad));
  assert.deepEqual(q.t.content, doc);
  assert.equal(q.props(0).style, undefined);
});

test('tests.rs styles_apply_character_style', async () => {
  const q = await quill('make this strong');
  q.sel(0, 5, 9);
  await q.exec('styles.apply', {style: 'Strong'});
  assert.equal(P.propsOfChar(q.para(0), 6).style, 'Strong');
  assert.equal(P.propsOfChar(q.para(0), 0).style, undefined);
  assert.equal(q.props(0).style, undefined, 'a character style leaves the paragraph style alone');
});

test('tests.rs styles_apply_multi_paragraph_selection', async () => {
  const q = await quill('One\nTwo\nThree');
  q.sel([0, 0], [2, 5]);
  await q.exec('styles.apply', {style: 'Quote'});
  for (let i = 0; i < 3; i++) assert.equal(q.props(i).style, 'Quote');
  await q.t.undo();
  for (let i = 0; i < 3; i++) assert.equal(q.props(i).style, undefined, 'one undo step for the whole selection');
});

test('tests.rs modify_style_takes_hex_colours_like_format_color (#865)', async () => {
  const q = await quill('a');
  const color = () => getStyle(q.t.content.styles, 'Heading1').chr.color;
  const modify = c => q.t.bridge('styles.modify', {style: 'Heading1', chr: {color: c}});
  await modify('1B1611');
  assert.deepEqual(color(), {Rgb: [0x1b, 0x16, 0x11]});
  await modify('auto');
  assert.equal(color(), 'Auto');
  await modify('#1B1611');
  assert.deepEqual(color(), {Rgb: [0x1b, 0x16, 0x11]});
  await modify('Auto');
  assert.equal(color(), 'Auto');
  await modify({Rgb: [192, 0, 0]});
  assert.deepEqual(color(), {Rgb: [192, 0, 0]});
  assert.deepEqual(resolveChar(q.t.content.styles, 'Heading1', {}).color, {Rgb: [192, 0, 0]});
  for (const bad of ['1B16', 'not a colour', {Rgb: '1B16'}, 7]) {
    await assert.rejects(modify(bad), /color/, JSON.stringify(bad));
    assert.deepEqual(color(), {Rgb: [192, 0, 0]}, `${JSON.stringify(bad)} leaves the style alone`);
  }
  await modify({Rgb: '1B1611'});
  assert.deepEqual(color(), {Rgb: [0x1b, 0x16, 0x11]}, 'the hex string also reads inside {"Rgb": …}');
});

test('tests.rs props_colours_take_hex_strings (#865)', async () => {
  const ink = [0x1b, 0x16, 0x11];
  const q = await quill('Hello');
  q.sel(0, 0);
  await q.exec('styles.modify', {style: 'Heading1', chr: {underlineColor: '1B1611', shading: '#1b1611', border: {style: 'single', width: 1, color: '1B1611'}},
    para: {shading: '1B1611', borders: {bottom: {style: 'single', width: 1, color: '#1B1611'}}}});
  const st = getStyle(q.t.content.styles, 'Heading1');
  assert.deepEqual([st.chr.underlineColor, st.chr.shading, st.chr.border.color], [ink, ink, ink]);
  assert.deepEqual([st.para.shading, st.para.borders.bottom.color], [ink, ink]);
  await q.exec('para.set', {props: {shading: 'C00000'}});
  assert.deepEqual(q.props(0).shading, [0xc0, 0, 0]);
  await q.exec('para.set', {props: {shading: [1, 2, 3]}});
  assert.deepEqual(q.props(0).shading, [1, 2, 3], '[r, g, b] still reads');
  for (const bad of ['C0000', 'auto', [1, 2], [1, 2, 300], 7]) {
    await assert.rejects(q.t.bridge('para.set', {props: {shading: bad}}), /shading/, JSON.stringify(bad));
    assert.deepEqual(q.props(0).shading, [1, 2, 3], `${JSON.stringify(bad)} changes nothing`);
  }
});

test('tests.rs update_heading_to_match_selection_takes_the_selections_formatting (#555)', async () => {
  const q = await quill('Heading text\nBody text');
  q.sel(0, 0);
  await q.exec('styles.apply', {style: 'Heading 2'});
  q.sel(1, 0);
  await q.exec('styles.apply', {style: 'Normal'});
  q.sel(1, 0, 9);
  await q.exec('format.size', {size: 20});
  await q.exec('format.italic');
  await q.exec('format.color', {color: 'C00000'});
  await q.exec('para.alignCenter');
  const sheet = () => q.t.content.styles;
  const normal = resolveChar(sheet(), 'Normal', {});
  const before = q.t.doc.undo.size;
  await q.exec('styles.updateToMatch', {style: 'Heading2'});
  const c = resolveChar(sheet(), 'Heading2', {});
  assert.equal(c.size, 20);
  assert.equal(c.italic, true);
  assert.deepEqual(c.color, {Rgb: [0xc0, 0, 0]});
  assert.equal(c.font, normal.font, 'the heading font gives way to the selection\'s');
  const p = resolvePara(sheet(), {style: 'Heading2'});
  assert.equal(p.align, 'center');
  assert.equal(p.outlineLevel, 1, 'Heading 2 stays a level-2 heading');
  assert.equal(q.props(1).style, 'Heading2');
  const run = P.propsOfChar(q.para(1), 0);
  assert.deepEqual(Object.keys(run).filter(k => !['link', 'ins', 'del', 'fmtChange'].includes(k)), [], JSON.stringify(run));
  assert.equal(q.props(1).align, undefined);
  assert.equal(q.t.doc.undo.size, before + 1, 'one undo step');
  await q.t.undo();
  assert.equal(resolveChar(sheet(), 'Heading2', {}).size, 16);
  assert.equal(q.props(1).style, 'Normal');
});

test('tests.rs manage_styles_lists_paragraph_character_linked_and_table_styles', async () => {
  const q = await quill('a');
  const list = (await q.exec('styles.manage', {sort: 'alphabetical'})).result;
  const find = name => list.find(x => x.name === name);
  assert.deepEqual([find('Normal').type, find('Normal').builtIn, find('Normal').inGallery], ['paragraph', true, true]);
  assert.equal(find('Heading 1').type, 'linked');
  assert.equal(find('Heading 1').basedOn, 'Normal');
  assert.equal(typeof find('Heading 1').format.size, 'number', 'description formatting');
  assert.equal(find('Table Grid').type, 'table');
  assert.ok(list.some(x => x.type === 'character'));
  assert.ok(!list.some(x => x.id === 'Heading1Char'));
  const names = list.map(x => x.name.toLowerCase());
  for (let i = 1; i < names.length; i++) assert.ok(names[i - 1] <= names[i], 'alphabetical');
  assert.equal((await q.exec('styles.manage', {})).result[0].name, 'Normal');
  await assert.rejects(q.t.bridge('styles.manage', {sort: 'sideways'}));
});

test('tests.rs deleting_a_style_falls_back_to_its_base_and_undoes', async () => {
  const q = await quill('Styled');
  q.sel(0, 0);
  await q.exec('styles.create', {name: 'Mine', basedOn: 'Heading 1'});
  await q.exec('styles.create', {name: 'Child', basedOn: 'Mine', fromSelection: false});
  await q.exec('styles.apply', {style: 'Mine'});
  assert.equal(q.props(0).style, 'Mine');
  const r = (await q.exec('styles.delete', {style: 'Mine'})).result;
  assert.equal(r.restyled, 1);
  assert.equal(getStyle(q.t.content.styles, 'Mine'), null);
  assert.equal(q.props(0).style, 'Heading1', 'falls back to its base');
  assert.equal(getStyle(q.t.content.styles, 'Child').basedOn, 'Heading1', 'rebased');
  await q.t.undo();
  assert.ok(getStyle(q.t.content.styles, 'Mine'));
  assert.equal(q.props(0).style, 'Mine');
  await assert.rejects(q.t.bridge('styles.delete', {style: 'Heading 1'}));
  await assert.rejects(q.t.bridge('styles.delete', {style: 'No Such Style'}));
});

// --- lists.rs mod tests -----------------------------------------------------------------------

const headings = async (paras, from, to) => {
  const q = await quill(paras.map(p => p[0]).join('\n'));
  for (let i = 0; i < paras.length; i++) { q.sel(i, 0); await q.exec('para.style', {style: paras[i][1]}); }
  q.sel([from, 0], [to, paras[to][0].length]);
  return q;
};
const numbered = q => q.labels().map((l, i) => [l, q.props(i).style ?? 'Normal']);

test('lists.rs a_heading_preset_numbers_headings_and_keeps_their_styles (#1793, without DOCX)', async () => {
  const q = await headings([['One', 'Heading1'], ['Two', 'Heading2'], ['Three', 'Heading1']], 0, 0);
  q.sel(0, 0);
  await q.exec('list.multilevelPreset', {preset: 'headings'});
  assert.deepEqual(numbered(q), [['1', 'Heading1'], ['1.1', 'Heading2'], ['2', 'Heading1']]);
  assert.equal(getStyle(q.t.content.styles, 'Heading2').para.numbering.level, 1);
});

test('lists.rs every_heading_preset_numbers_three_heading_levels (#1793)', async () => {
  for (const [preset, want] of [['headings', ['1', '1.1', '1.1.1']], ['article', ['Article I.', 'Section 1.01', '(a)']],
    ['outlineHeadings', ['I.', 'A.', '1.']], ['chapter', ['Chapter 1', null, null]]]) {
    const q = await headings([['One', 'Heading1'], ['Two', 'Heading2'], ['Three', 'Heading3']], 0, 0);
    q.sel(0, 0);
    await q.exec('list.multilevelPreset', {preset});
    assert.deepEqual(q.labels(), want, preset);
  }
  const q = await headings([['One', 'Heading1']], 0, 0);
  await assert.rejects(q.t.bridge('list.multilevelPreset', {preset: 'nope'}));
  await assert.rejects(q.t.bridge('list.multilevelPreset', {}));
});

test('lists.rs a_heading_preset_keeps_headings_and_makes_other_paragraphs_heading_1 (#1793)', async () => {
  const [h1, h2, h3] = ['Heading1', 'Heading2', 'Heading3'];
  const cases = [
    [[['One', h1], ['Two', h2], ['Three', h3]], 0, 2, [['1', h1], ['1.1', h2], ['1.1.1', h3]]],
    [[['Two', h2], ['Three', h3]], 0, 1, [['1.1', h2], ['1.1.1', h3]]],
    [[['Body', 'Normal'], ['Three', h3]], 0, 1, [['1', h1], ['1.1.1', h3]]],
    [[['One', h1], ['Body', 'Normal'], ['Two', h2]], 0, 2, [['1', h1], ['2', h1], ['2.1', h2]]],
    [[['One', h1], ['Two', h2], ['Body', 'Normal']], 0, 2, [['1', h1], ['1.1', h2], ['2', h1]]],
    [[['One', h1], ['Two', h2], ['Three', h3]], 1, 1, [['1', h1], ['1.1', h2], ['1.1.1', h3]]],
    [[['Quote', 'Quote'], ['Two', h2]], 0, 1, [['1', h1], ['1.1', h2]]],
    [[['Title', 'Title']], 0, 0, [['1', h1]]],
    [[['One', h1], ['After', 'Normal']], 0, 0, [['1', h1], [null, 'Normal']]],
  ];
  for (const [paras, from, to, want] of cases) {
    const q = await headings(paras, from, to);
    await q.exec('list.multilevelPreset', {preset: 'headings'});
    assert.deepEqual(numbered(q), want, `${JSON.stringify(paras)} ${from}..=${to}`);
  }
});

test('lists.rs a_heading_preset_on_a_lone_normal_paragraph_makes_it_heading_1 (#1793)', async () => {
  const q = await headings([['Body', 'Normal']], 0, 0);
  q.sel(0, 2);
  await q.exec('list.multilevelPreset', {preset: 'headings'});
  assert.deepEqual(numbered(q), [['1', 'Heading1']]);
});

test('lists.rs undo_takes_a_heading_preset_back_in_one_step (#1793)', async () => {
  const q = await headings([['Body', 'Normal'], ['Two', 'Heading2']], 0, 1);
  const before = numbered(q);
  await q.exec('list.multilevelPreset', {preset: 'headings'});
  assert.notDeepEqual(numbered(q), before);
  await q.t.undo();
  assert.deepEqual(numbered(q), before);
  for (let n = 1; n <= 9; n++) assert.equal(getStyle(q.t.content.styles, `Heading${n}`)?.para?.numbering, undefined, `Heading${n}`);
});
