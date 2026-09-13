import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensurePrivateDirectory,
  pruneExpiredCacheFiles,
  writePrivateFile,
} from '../src/cache-retention.js';

test('prunes only expired JSON cache files recursively', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysql-mcp-cache-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'queries', '2026-09-13');
  await fs.promises.mkdir(nested, { recursive: true });
  const oldJson = path.join(nested, 'old.json');
  const freshJson = path.join(nested, 'fresh.json');
  const oldText = path.join(nested, 'keep.txt');
  await Promise.all([
    fs.promises.writeFile(oldJson, '{}'),
    fs.promises.writeFile(freshJson, '{}'),
    fs.promises.writeFile(oldText, 'keep'),
  ]);
  const now = Date.UTC(2026, 8, 13);
  const old = new Date(now - 31 * 24 * 60 * 60 * 1000);
  await Promise.all([
    fs.promises.utimes(oldJson, old, old),
    fs.promises.utimes(oldText, old, old),
  ]);

  const result = await pruneExpiredCacheFiles(root, 30, now);

  assert.deepEqual(result, { scannedFiles: 2, removedFiles: 1 });
  await assert.rejects(fs.promises.access(oldJson));
  await fs.promises.access(freshJson);
  await fs.promises.access(oldText);
});

test('does not follow directory symlinks', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysql-mcp-cache-'));
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysql-mcp-outside-'));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  });
  const protectedFile = path.join(outside, 'old.json');
  await fs.promises.writeFile(protectedFile, '{}');
  const old = new Date(0);
  await fs.promises.utimes(protectedFile, old, old);
  await fs.promises.symlink(outside, path.join(root, 'linked-cache'));

  const result = await pruneExpiredCacheFiles(root, 1, Date.now());

  assert.deepEqual(result, { scannedFiles: 0, removedFiles: 0 });
  await fs.promises.access(protectedFile);
});

test('rejects an invalid retention value without touching the cache', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysql-mcp-cache-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'old.json');
  await fs.promises.writeFile(file, '{}');

  await assert.rejects(pruneExpiredCacheFiles(root, 0), /positive number/);
  await fs.promises.access(file);
});

test('uses private POSIX modes for cache directories and files', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysql-mcp-cache-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const file = path.join(directory, 'result.json');

  await fs.promises.mkdir(directory, { mode: 0o755 });
  await ensurePrivateDirectory(directory);
  await writePrivateFile(file, '{}');

  assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
});
