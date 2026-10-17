const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function ({ evaluate, request, ext, reloadSettings, root }) {
  await evaluate("selectTab('rules');populate(BossCore.config({}));true");
  assert.deepEqual(await evaluate('({browse:readConfig().browseIntervalSeconds,greeting:readConfig().intervalSeconds})'), { browse: 0.5, greeting: 2 });
  await evaluate("populate(BossCore.config({intervalSeconds:8}));true");
  assert.deepEqual(await evaluate('({browse:readConfig().browseIntervalSeconds,greeting:readConfig().intervalSeconds})'), { browse: 0.5, greeting: 8 });
  await evaluate(`(()=>{
    for(const [id,value]of [['browseIntervalSeconds',1],['intervalSeconds',9]]){
      const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    return true;
  })()`);
  assert.equal(await evaluate('dirty'), true);
  async function save() {
    await evaluate('document.getElementById("save-config").click();true');
    for (let i = 0; i < 100; i++) { if (await evaluate('!document.getElementById("save-config").disabled')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(await evaluate('dirty'), false);
  }
  await save(); await reloadSettings();
  assert.deepEqual(await evaluate('({browse:readConfig().browseIntervalSeconds,greeting:readConfig().intervalSeconds})'), { browse: 1, greeting: 9 });
  assert.equal(await evaluate('(()=>{const b=document.getElementById("browseIntervalSeconds"),g=document.getElementById("intervalSeconds");b.value=0.1;g.value=0;const invalid=!b.checkValidity()&&!g.checkValidity();b.value=1;g.value=9;return invalid})()'), true);
  await evaluate('document.getElementById("reset-speed").click();true');
  assert.equal(await evaluate('dirty'), true);
  assert.deepEqual(await evaluate('({browse:readConfig().browseIntervalSeconds,greeting:readConfig().intervalSeconds})'), { browse: 0.5, greeting: 2 });
  await save(); await reloadSettings();
  assert.deepEqual(await evaluate('({browse:readConfig().browseIntervalSeconds,greeting:readConfig().intervalSeconds})'), { browse: 0.5, greeting: 2 });
  for (const width of [900, 360]) {
    await request('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false }, ext);
    await evaluate('document.getElementById("speed-settings").scrollIntoView({block:"center"});true');
    assert.equal(await evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth && ["browseIntervalSeconds","intervalSeconds"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})'), true);
    const screenshot = await request('Page.captureScreenshot', { format: 'png' }, ext);
    fs.writeFileSync(path.join(root, 'artifacts', 'speed-settings-' + width + '.png'), Buffer.from(screenshot.data, 'base64'));
  }
  console.log('PASS Edge speed settings: defaults 0.5/2, old greeting preserved, independent input, validation, save/reload, reset, desktop and mobile layout');
};
