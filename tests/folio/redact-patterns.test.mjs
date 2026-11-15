// core/folio/lib/redact-patterns.mjs: the Find text and redact patterns, word lists and redaction codes.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft crates/redact/src/patterns.rs tests, codes.rs): phone numbers (NANP, E.164,
//    national with a trunk 0, labelled, Italian slashed), emails (internationalised too), credit cards
//    (Luhn, with a trailing expiry or CVV), US SSNs, dates in English, Turkish, German, French and
//    Italian; a word list is trimmed, unique and bounded; a code overlay lists the picked codes in
//    the set's order. Acrobat's Search & Redact patterns match the same things.
// 2. Ours is the same code translated: these are the upstream tests, ported case by case.
import test from 'node:test';
import assert from 'node:assert/strict';
import {find, wordList, MAX_WORDS, MAX_WORD_CHARS, CODE_SETS, codesOverlay} from '../../core/folio/lib/redact-patterns.mjs';

const found = (id, s) => { const c = Array.from(s); return find(id, c).map(([a, b]) => c.slice(a, b).join('')); };

test('word lists are trimmed, unique and bounded', () => {
  assert.deepEqual(wordList('  John Smith \n\n\tACME\r\nJohn Smith\n  \nő ű'), ['John Smith', 'ACME', 'ő ű']);
  assert.equal(Array.from(wordList('é'.repeat(MAX_WORD_CHARS + 10))[0]).length, MAX_WORD_CHARS);
  const many = Array.from({length: MAX_WORDS + 50}, (_, i) => `w${i}\n`).join('');
  const list = wordList(many);
  assert.deepEqual([list.length, list.at(-1)], [MAX_WORDS, 'w999']);
  assert.deepEqual(wordList(''), []);
});

test('phone numbers', () => {
  assert.deepEqual(found('phone', 'Call (555) 123-4567 or 555.987.6543, +1 555 222 3333; not 12345 or 5551234567890'), ['(555) 123-4567', '555.987.6543', '+1 555 222 3333']);
  assert.deepEqual(found('phone', 'Tel. +49 2151 123456.'), ['+49 2151 123456']);
  assert.deepEqual(found('phone', '+44 20 7946 0018, +33 1 23 45 67 89, +49 (0) 2151 123456, (0211) 123456, 030 12345678, 01 23 45 67 89'),
    ['+44 20 7946 0018', '+33 1 23 45 67 89', '+49 (0) 2151 123456', '(0211) 123456', '030 12345678', '01 23 45 67 89']);
  assert.deepEqual(found('phone', 'on 01.10.2026 or 09-10-2026, ratio 0.1234567, id 0211123456, +4921511234567, +1 234 567, 0211 12, +49 1234 5678 9012 3456'), []);
});

test('slashed and labelled unseparated phone numbers', () => {
  const lines = ['A tel. 0426 123456', 'B tel. +39 0426 123456', 'C cell. 345 1234567', 'D cell. 3451234567', 'E tel. 0426/123456', 'F cell. 345.123.4567',
    'G tel. 0426.123456', 'H cell. +393451234567', 'Fax: 0211123456', 'Telefono 0426/123456'];
  assert.deepEqual(found('phone', lines.join('\n')), ['0426 123456', '+39 0426 123456', '345 1234567', '3451234567', '0426/123456', '345.123.4567', '0426.123456',
    '+393451234567', '0211123456', '0426/123456']);
  assert.deepEqual(found('phone', 'id 0211123456, +4921511234567, hotel 3451234567, prot. 2024/123456, on 01/10/2026, tel. 12345, tel 0426/ 123456, +39 0426/123456, tel 0426/12/3456, tel 0426 12/3456'), []);
});

test('labelled Italian international slash numbers match whole while dates and other digit runs stay unmarked', () => {
  for (const [text, number] of [['tel. +39 0426/123456', '+39 0426/123456'], ['Fax: +390426/123456', '+390426/123456'], ['Telefono +39 02/12345678', '+39 02/12345678'],
    ['tel. +39 02/1234', '+39 02/1234'], ['tel. +39 0426/1234567', '+39 0426/1234567']]) assert.deepEqual(found('phone', text), [number], text);
  for (const text of ['+39 0426/123456', 'tel. +39 2024/123456', 'tel. +39 0/123456789', 'tel. +39 0426/12/3456', 'tel. +39 0426 12/3456', 'tel. +39 0426/ 123456', 'tel. +39 02/123',
    'tel. +39 0426/12345678', 'tel. +39 0426/1234567890', 'tel. +39  0426/123456', 'tel. +39-0426/123456', 'tel. +39 -0426/123456', 'tel. +40 0426/123456', 'protocol 2024/123456',
    'on 01/10/2026']) assert.deepEqual(found('phone', text), [], text);
});

test('the tail of a longer number is not a phone number', () => {
  for (const s of ['NIR 1 85 05 78 006 084 36 end', 'IBAN FR76 3000 6000 0112 3456 7890 189', 'SIRET 123 456 782 00010']) assert.deepEqual(found('phone', s), [], s);
  assert.deepEqual(found('phone', 'tel 01 23 45 67 89 / +33 1 23 45 67 89'), ['01 23 45 67 89', '+33 1 23 45 67 89']);
  assert.deepEqual(found('phone', '01 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7'), []);
});

test('emails, with leading punctuation and internationalised', () => {
  assert.deepEqual(found('email', 'Write to ada.lovelace+pdf@example.co.uk, or bob@host (no TLD) or x@y.z.'), ['ada.lovelace+pdf@example.co.uk']);
  for (const lead of ['_', '-', '.', '%', '+']) { const a = `${lead}john@example.com`; assert.deepEqual(found('email', `Write to ${a} now`), [a], lead); }
  assert.deepEqual(found('email', 'a.b@x.com, foo_john@example.com'), ['a.b@x.com', 'foo_john@example.com']);
  assert.deepEqual(found('email', 'Write to ..@example.com or -@example.com'), []);
  assert.deepEqual(found('email', 'Yazın: ayşe.yılmaz@örnek.com.tr, ÇAĞLAR@ŞİRKET.COM.TR; müller@bücher.de, иван@пример.рф, josé@correo.es.'),
    ['ayşe.yılmaz@örnek.com.tr', 'ÇAĞLAR@ŞİRKET.COM.TR', 'müller@bücher.de', 'иван@пример.рф', 'josé@correo.es']);
  assert.deepEqual(found('email', 'メールはtaro@example.jpまで、联系support@example.cn谢谢'), ['taro@example.jp', 'support@example.cn']);
  assert.deepEqual(found('email', 'ayşe@örnek, ş@ğ.ü, kişi@alan.123, a@b.c'), []);
});

test('credit cards need a valid checksum and may be followed by another number', () => {
  assert.deepEqual(found('credit-card', 'Visa 4111 1111 1111 1111, bad 4111 1111 1111 1112, amex 3782-822463-10005'), ['4111 1111 1111 1111', '3782-822463-10005']);
  for (const tail of ['12/26', '2026', '123', '12 26']) assert.deepEqual(found('credit-card', `Card 4111 1111 1111 1111 ${tail}`), ['4111 1111 1111 1111'], tail);
  assert.deepEqual(found('credit-card', 'Card 3782-822463-10005 123'), ['3782-822463-10005']);
  assert.deepEqual(found('credit-card', 'Card 4111 1111 1111 1112 12/26'), []);
  assert.deepEqual(found('credit-card', 'IBAN 4111 1111 1111 1111 0000 0000'), []);
});

test('social security numbers', () => {
  assert.deepEqual(found('ssn', 'SSN 123-45-6789 and 123 45 6789; invalid 000-12-3456, 666-12-3456, 912-12-3456, 1234-56-7890'), ['123-45-6789', '123 45 6789']);
});

test('dates in English, Turkish, German, French and Italian', () => {
  assert.deepEqual(found('date', 'Due 10/01/2026, 2026-10-01, 1.10.26, March 5, 2024, Jan. 7 2025 and 5 June 2023; not 10/2026 or Mayday 12'),
    ['10/01/2026', '2026-10-01', '1.10.26', 'March 5, 2024', 'Jan. 7 2025', '5 June 2023']);
  assert.deepEqual(found('date', 'Tarih: 10 Ekim 2026, 3 Mayıs 2025, 5 Şubat 2024, 5 ŞUBAT 2024, 3 MAYIS 2025, 1 EKİM 2026 ve 9 kasım 2023.'),
    ['10 Ekim 2026', '3 Mayıs 2025', '5 Şubat 2024', '5 ŞUBAT 2024', '3 MAYIS 2025', '1 EKİM 2026', '9 kasım 2023']);
  assert.deepEqual(found('date', '12 Oca 2024, 7 Şub. 2025, 30 Ağu 2023, 1 ARA. 2022, 2 Haz 2021'), ['12 Oca 2024', '7 Şub. 2025', '30 Ağu 2023', '1 ARA. 2022', '2 Haz 2021']);
  assert.deepEqual(found('date', '5 Martı 2024, Ekimde 2026, 3 Mayısta 2025, ara 2024, Kasım ayında, 12 Aralık, Aralık 2024'), []);
  assert.deepEqual(found('date', 'am 10. Oktober 2026, 3 März 2025, le 14 juillet 2024, 1 août 2023, il 25 dicembre 2022'),
    ['10. Oktober 2026', '3 März 2025', '14 juillet 2024', '1 août 2023', '25 dicembre 2022']);
  assert.deepEqual(found('date', 'Mai 2024, Kapitel 5. Absatz 2024, 5 Oktoberfest 2024'), []);
});

test('redaction code sets give the overlay in the set order', () => {
  const foia = CODE_SETS.find(s => s.id === 'foia');
  assert.equal(codesOverlay(foia, ['(b)(6)', '(b)(1)(A)', '(b)(6)']), '(b)(1)(A), (b)(6)');
  assert.throws(() => codesOverlay(foia, ['(k)(1)']), /not a code/);
  assert.equal(CODE_SETS.length, 2);
});
