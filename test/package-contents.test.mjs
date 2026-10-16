import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const verifyPackage = require('../scripts/verify-package.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, { runnerInManifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'as-package-contents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'resources', 'runtime'), app = join(root, 'resources', 'app');
  mkdirSync(runtime, { recursive: true }); mkdirSync(app, { recursive: true });
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const binaryName = platform === 'win32' ? 'node.exe' : 'node';
  writeFileSync(join(runtime, binaryName), 'synthetic runtime');
  writeFileSync(join(runtime, 'NODE-LICENSE.txt'), 'Synthetic license');
  const sources = { 'app/desktop.mjs': 'synthetic desktop', 'ui/index.html': 'synthetic UI', 'assets/agentspaces.png': 'synthetic image', LICENSE: 'synthetic license', NOTICE: 'synthetic notice', 'scripts/machine-run.py': 'synthetic machine runner' };
  const sourceFiles = {};
  for (const [path, content] of Object.entries(sources)) {
    const file = join(app, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content);
    if (path !== 'scripts/machine-run.py' || runnerInManifest) sourceFiles[path] = hash(content);
  }
  writeFileSync(join(runtime, 'build-manifest.json'), JSON.stringify({ platform, architecture: process.arch, sourceFiles, sourceSHA256: hash(JSON.stringify(sourceFiles)), nodeSHA256: hash('synthetic runtime') }));
  return { root, runtime, app, binaryName, context: { appOutDir: root, electronPlatformName: platform } };
}

test('packaged runtime rejects extra files and directories before running its binary', async t => {
  for (const kind of ['file', 'directory']) {
    const f = fixture(t), entry = join(f.runtime, 'unexpected-state');
    if (kind === 'file') writeFileSync(entry, 'synthetic private-like fixture'); else mkdirSync(entry);
    await assert.rejects(verifyPackage(f.context), /runtime.*unexpected entry/i);
  }
});

test('packaged runtime rejects a linked required file before reading or executing it', async t => {
  const f = fixture(t), target = join(f.root, 'external-synthetic-file');
  writeFileSync(target, 'synthetic external bytes'); rmSync(join(f.runtime, f.binaryName));
  linkSync(target, join(f.runtime, f.binaryName));
  await assert.rejects(verifyPackage(f.context), /runtime.*unlinked regular files/i);
});

test('packaged runtime rejects a symlinked directory without following it', async t => {
  const f = fixture(t), actual = join(f.root, 'empty-runtime'); mkdirSync(actual);
  rmSync(f.runtime, { recursive: true });
  symlinkSync(actual, f.runtime, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPackage(f.context), /runtime.*real directory/i);
});

test('packaged manifest must cover the shared machine runner', async t => {
  const f = fixture(t, { runnerInManifest: false });
  await assert.rejects(verifyPackage(f.context), /manifest.*machine runner/i);
});

test('modified machine runner fails the packaged source hash before runtime execution', async t => {
  const f = fixture(t); writeFileSync(join(f.app, 'scripts/machine-run.py'), 'changed synthetic runner');
  await assert.rejects(verifyPackage(f.context), /Packaged source changed.*machine-run.py/);
});


test('runtime allowlist supports each target and rejects incomplete or mixed-platform contents', t => {
  const { assertRuntimeContents } = require('../scripts/package-contents.cjs');
  const root = mkdtempSync(join(tmpdir(), 'as-runtime-allowlist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const platform of ['win32', 'linux']) {
    const path = join(root, platform); mkdirSync(path);
    assert.doesNotThrow(() => assertRuntimeContents(path, platform, { complete: false }));
    assert.throws(() => assertRuntimeContents(path, platform), /missing required files/);
    for (const name of [platform === 'win32' ? 'node.exe' : 'node', 'NODE-LICENSE.txt', 'build-manifest.json']) writeFileSync(join(path, name), 'synthetic');
    assert.doesNotThrow(() => assertRuntimeContents(path, platform));
    assert.throws(() => assertRuntimeContents(path, platform === 'win32' ? 'linux' : 'win32'), /unexpected entry/);
  }
});

test('preparation refuses leftover state before copying or following any runtime files', { skip: !['win32', 'linux'].includes(process.platform) || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'as-prepare-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'build', 'runtime'), { recursive: true });
  for (const name of ['prepare-package.mjs', 'package-contents.cjs']) copyFileSync(fileURLToPath(new URL('../scripts/' + name, import.meta.url)), join(root, 'scripts', name));
  // Synthetic import stubs keep this test independent of native addon builds.
  for (const [name, module] of [['@agentspaces/client', 'index.js'], ['node-pty', 'index.js'], ['@modelcontextprotocol/sdk', 'server/mcp.js']]) {
    const directory = join(root, 'node_modules', name); mkdirSync(join(directory, module, '..'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, type: 'module', exports: module === 'index.js' ? './index.js' : { './server/mcp.js': './server/mcp.js' } }));
    writeFileSync(join(directory, module), 'export {};');
  }
  const forbidden = join(root, 'build', 'runtime', 'unexpected-state');
  writeFileSync(forbidden, 'SYNTHETIC CONTENT MUST BE PRESERVED');
  const preload = join(root, 'guard.mjs');
  writeFileSync(preload, "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; fs.copyFileSync=()=>{throw Error('unexpected_runtime_copy')}; syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('unexpected_network')};");
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', 'prepare-package.mjs')], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 1); assert.match(run.stderr, /runtime.*unexpected entry/i);
  assert.doesNotMatch(run.stderr, /unexpected_runtime_copy|unexpected_network/);
  assert.equal(readFileSync(forbidden, 'utf8'), 'SYNTHETIC CONTENT MUST BE PRESERVED');
});
