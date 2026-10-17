const fs = require('node:fs');
const path = require('node:path');
const { zipSync } = require('fflate');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version_name;
const runtimeFiles = ['manifest.json', 'core.js', 'cities.js', 'city-codes.js', 'source-plans.js', 'native-sources.js', 'source-options.js', 'salary.js', 'greeting-editor.js', 'chat-navigation.js', 'schedules.js', 'schedule-options.js', 'background.js', 'content.js', 'options.html', 'options.js', 'popup.html', 'popup.js', 'ui.css', 'README.md', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/icon.svg'];
fs.mkdirSync(dist, { recursive: true });
if (fs.lstatSync(dist).isSymbolicLink()) throw Error('Build directory cannot be a link');
function outputDirectory(name) {
  const target = path.resolve(dist, name);
  if (!['qutou-edge', 'zhixiang-edge', 'github-upload'].includes(name) || path.dirname(target) !== dist) throw Error('Invalid build target');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('Build target cannot be a link');
  // Reset only verified build outputs so removed modules cannot survive repackaging.
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}
function copyFiles(target, names) {
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(target, name));
  }
}
function listFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error('Source tree cannot contain links');
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(relative) : entry.isFile() ? [relative] : [];
  });
}
function archive(target, prefix, name) {
  const entries = {};
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative + entry.name, file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name + '/');
      else if (entry.isFile()) entries[prefix + '/' + name] = fs.readFileSync(file);
    }
  }
  visit(target);
  fs.writeFileSync(path.join(dist, name), zipSync(entries, { level: 6 }));
  return Object.keys(entries).length;
}
const target = outputDirectory('qutou-edge');
copyFiles(target, runtimeFiles);
archive(target, 'qutou-edge', 'qutou-edge.zip');
fs.copyFileSync(path.join(dist, 'qutou-edge.zip'), path.join(dist, 'qutou-edge-' + version + '.zip'));
// Keep the old install path so extension identity and local records survive upgrades.
const legacy = outputDirectory('zhixiang-edge');
copyFiles(legacy, runtimeFiles);
archive(legacy, 'zhixiang-edge', 'zhixiang-edge.zip');
// Explicit source allowlist excludes backups, local records, profiles and dependencies.
const upload = outputDirectory('github-upload');
copyFiles(upload, [...runtimeFiles, '.gitignore', 'package.json', 'package-lock.json', ...listFiles('scripts'), ...listFiles('tests')]);
const count = archive(upload, 'qutou', 'qutou-github-source-' + version + '.zip');
console.log('Extension: ' + path.join(dist, 'qutou-edge-' + version + '.zip'));
console.log('GitHub upload: ' + upload + ' (' + count + ' files)');
console.log('Source archive: ' + path.join(dist, 'qutou-github-source-' + version + '.zip'));
