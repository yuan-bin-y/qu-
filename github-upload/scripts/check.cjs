const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw Error('Manifest V3 is required');
const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap(s => s.js), ...Object.values(manifest.icons || {})];
for (const f of files) if (!existsSync(resolve(root, f))) throw Error('Missing manifest file: ' + f);
for (const f of ['core.js', 'cities.js', 'city-codes.js', 'source-plans.js', 'native-sources.js', 'source-options.js', 'salary.js', 'greeting-editor.js', 'chat-navigation.js', 'schedules.js', 'schedule-options.js', 'background.js', 'content.js', 'options.js', 'popup.js']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, f)], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr);
}
for (const f of ['options.html', 'popup.html']) {
  const html = readFileSync(resolve(root, f), 'utf8');
  if (/<script[^>]*>\s*[^<\s]/.test(html) || /\son\w+\s*=/.test(html)) throw Error('Inline scripts violate CSP: ' + f);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (!/^(https?:|mailto:)/.test(match[1]) && !existsSync(resolve(root, match[1]))) throw Error('Missing asset: ' + match[1]);
  }
}
console.log('Manifest references, syntax, local assets and extension CSP checks passed.');
