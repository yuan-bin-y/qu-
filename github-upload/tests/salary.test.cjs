const { test } = require('node:test');
const assert = require('node:assert/strict');
const Salary = require('../salary.js');
const C = require('../core.js');

test('salary decoding uses the supplied font mapping, including zero, without guessing unknown glyphs', () => {
  const raw = '\uE510\uE511\uE511–\uE510\uE512\uE511元/天';
  assert.equal(Salary.decode(raw, { '\uE510': '2', '\uE511': '0', '\uE512': '5' }), '200–250元/天');
  assert.equal(Salary.decode(raw, { '\uE510': '7', '\uE511': '3', '\uE512': '1' }), '733–713元/天');
  assert.equal(Salary.decode(raw, {}), raw);
  assert.equal(C.monthlySalary(Salary.decode(raw, { '\uE510': '2', '\uE511': '0', '\uE512': '5' }), 30).max, 7500);
});

test('glyph matching accepts a unique near-identical digit and rejects ambiguous or missing font shapes', () => {
  const shape = { aspect: 0.5, pixels: [1, 1, 0, 1] };
  assert.equal(Salary.bestMatch(shape, [{ digit: '2', ...shape }, { digit: '3', aspect: 0.5, pixels: [1, 0, 1, 0] }]), '2');
  assert.equal(Salary.bestMatch(shape, [{ digit: '2', ...shape }, { digit: '3', ...shape }]), null);
  assert.equal(Salary.bestMatch(null, []), null);
});

test('encoded or partially decoded salaries cannot turn bonuses or surviving digits into salary bounds', () => {
  for (const value of ['\uE513-\uE515K·14薪', '2\uE5110-250元/天', '�00-250元/天']) {
    assert.equal(C.monthlySalary(value), null);
    assert.match(C.filters({ title: 'Java', salary: value }, { salaryMin: 5000, blockedWords: '' }).reasons.join(' '), /字体编码未解析/);
  }
});
