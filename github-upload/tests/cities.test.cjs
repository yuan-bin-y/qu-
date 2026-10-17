const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const scope = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../cities.js'), 'utf8'), scope);
const cities = scope.BossCities;

test('city picker includes the complete 2025 first, new-first, second and third tiers', () => {
  assert.equal(cities.year, 2025);
  assert.equal(cities.tiers.firstTier.length, 4);
  assert.equal(cities.tiers.newFirstTier.length, 15);
  assert.equal(cities.tiers.secondTier.length, 30);
  assert.equal(cities.tiers.thirdTier.length, 70);
  assert.equal(cities.cities.length, 119);
  assert.equal(new Set(cities.cities).size, 119);
  for (const city of ['乌鲁木齐', '兰州', '中山', '海口', '唐山', '阜阳', '茂名', '衢州']) assert.ok(cities.tiers.thirdTier.includes(city), city);
  assert.ok(cities.tiers.secondTier.includes('台州'));
  assert.ok(cities.tiers.thirdTier.includes('泰州'));
  assert.equal(cities.groups, undefined);
});

test('every available city has searchable pinyin and hot cities remain available', () => {
  for (const city of cities.cities) assert.match(cities.pinyin[city], /^[a-z]+$/, city);
  assert.equal(cities.pinyin['乌鲁木齐'], 'wulumuqi');
  assert.equal(cities.pinyin['兰州'], 'lanzhou');
  assert.equal(cities.pinyin['济宁'], 'jining');
  assert.equal(cities.pinyin['亳州'], 'bozhou');
  for (const city of cities.hot) assert.ok(cities.cities.includes(city));
});

test('BOSS-style letter groups cover every retained city exactly once', () => {
  assert.deepEqual(Array.from(cities.letterGroups), ['ABCDE', 'FGHJ', 'KLMN', 'PQRST', 'WXYZ']);
  const classified = cities.letterGroups.flatMap(letters => cities.cities.filter(city => letters.includes(cities.pinyin[city][0].toUpperCase())));
  assert.equal(classified.length, 119); assert.equal(new Set(classified).size, 119);
  assert.equal(cities.hot.length, 14);
  assert.deepEqual(Array.from(cities.hot).slice(0, 5), ['北京', '上海', '广州', '深圳', '杭州']);
});
