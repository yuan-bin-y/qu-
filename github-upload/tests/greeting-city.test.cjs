const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../cities.js');
const C = require('../core.js');
const { read } = require('../greeting-editor.js');

test('job city comes from the location hierarchy and supports prefixes and full addresses', () => {
  for (const [location, city] of [
    ['杭州·余杭区·仓前', '杭州'], ['苏州·工业园区', '苏州'], ['杭州市余杭区爱力中心A座13层', '杭州'],
    ['深圳南山区', '深圳'], ['浙江省杭州市余杭区', '杭州'], ['广东省·深圳市·南山区', '深圳'],
    ['内蒙古自治区呼和浩特市赛罕区', '呼和浩特'], ['景德镇市珠山区', '景德镇'], ['上海·浦东新区·张江', '上海']
  ]) assert.equal(C.jobCity(location), city, location);
});

test('missing, province-only, multiple-city and remote locations are not guessed', () => {
  for (const location of ['', '浙江省', '全国', '远程', '杭州/苏州', '杭州·苏州', '杭州、上海', '多城市', '海外', '余杭区']) assert.equal(C.jobCity(location), '', location);
});

test('only bound placeholders change and the rest of a personal greeting remains literal', () => {
  const text = '您好，看了贵公司的开发实习岗位，很感兴趣。有一年开发经验，熟悉Spring Boot、MySQL、Redis、RabbitMQ、Spring Cloud等相关技术，可实习六个月以上，{city}有常住地，能随时到岗稳定实习。杭州是原先居住城市。';
  assert.equal(C.template({ location: '苏州·工业园区' }, { greetingTemplate: text }), text.replace('{city}', '苏州'));
  assert.equal(C.template({ location: '杭州·余杭区·仓前' }, { greetingTemplate: text }), text.replace('{city}', '杭州'));
});

test('city-bound greeting requires a readable detail city and agreement with the source card', () => {
  const config = { greetingTemplate: '{city}有常住地。' };
  assert.equal(C.template({ cardLocation: '杭州·余杭区', detailLocation: '杭州市余杭区爱力中心', location: '错误的搜索城市' }, config), '杭州有常住地。');
  for (const job of [
    { location: '杭州', detailLocation: '', cardLocation: '杭州' },
    { detailLocation: '苏州', cardLocation: '杭州' },
    { detailLocation: '苏州', cardLocation: '苏州/上海' },
    { location: '全国' }
  ]) assert.throws(() => C.template(job, config), /城市/);
  assert.equal(C.template({ location: '全国' }, { greetingTemplate: '固定招呼，杭州有常住地。' }), '固定招呼，杭州有常住地。');
});

test('expansion cannot silently cut a greeting and binding originals survive normalization without deduplication', () => {
  assert.throws(() => C.template({ title: '很长的岗位名称'.repeat(30) }, { greetingTemplate: '{title}'.repeat(10) }), /300/);
  const config = C.config({ greetingCityOriginals: ['杭州', '杭州', '<script>', 42] });
  assert.deepEqual(config.greetingCityOriginals, ['杭州', '杭州', '<script>', '']);
});

test('rich greeting serialization preserves line breaks and atomic city tokens instead of button labels', () => {
  const text = nodeValue => ({ nodeType: 3, nodeValue });
  const node = (nodeName, ...childNodes) => ({ nodeType: 1, nodeName, childNodes });
  const token = { ...node('SPAN', text('岗位城市'), node('BUTTON', text('×'))), dataset: { greetingToken: 'city' } };
  const editor = node('DIV', text('您好，'), token, node('DIV', text('有常住地。')), node('DIV', text('可以实习六个月。')));
  assert.equal(read(editor), '您好，{city}\n有常住地。\n可以实习六个月。');
});
