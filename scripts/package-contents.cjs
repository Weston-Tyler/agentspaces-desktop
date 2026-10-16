const { lstatSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

// Reject rather than deleting unexpected files: a build must never scoop up
// old private material or follow a link while preparing redistributable bytes.
function assertRuntimeContents(directory, platform, { complete = true } = {}) {
  if (!['linux', 'win32'].includes(platform)) throw new Error('Unsupported bundled runtime platform');
  const root = lstatSync(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Bundled runtime must be a real directory');
  const expected = new Set([platform === 'win32' ? 'node.exe' : 'node', 'NODE-LICENSE.txt', 'build-manifest.json']);
  const names = readdirSync(directory);
  for (const name of names) {
    if (!expected.has(name)) throw new Error('Bundled runtime contains an unexpected entry');
    const stat = lstatSync(join(directory, name));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('Bundled runtime entries must be unlinked regular files');
  }
  if (complete && expected.size !== names.length) throw new Error('Bundled runtime is missing required files');
}

module.exports = { assertRuntimeContents };
