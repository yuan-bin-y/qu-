const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const content = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const source = content.slice(content.indexOf("  let highlightJobId = ''"), content.indexOf('  async function markJob('));
function card(id) {
  const attributes = {};
  return { id, attributes, getAttribute: key => attributes[key], setAttribute(key, value) { attributes[key] = value; }, removeAttribute(key) { delete attributes[key]; } };
}
test('a re-rendered card regains its highlight by identity without clicking or scrolling', () => {
  let list = [card('a'), card('b')];
  const context = vm.createContext({ cards: () => list, cardInfo: card => ({ id: card.id }), document: { querySelectorAll: () => list.filter(card => card.attributes['data-zhixiang-current']) } });
  vm.runInContext(source + '\nhighlightJobId = "b"; syncHighlight();', context);
  assert.equal(list[1].attributes['data-zhixiang-current'], 'b');
  list = [card('b'), card('a')]; vm.runInContext('syncHighlight()', context);
  assert.equal(list[0].attributes['data-zhixiang-current'], 'b'); assert.equal(list[1].attributes['data-zhixiang-current'], undefined);
  list = [card('other')]; vm.runInContext('syncHighlight()', context);
  assert.equal(list[0].attributes['data-zhixiang-current'], undefined, 'An unloaded job must never highlight another card');
});
