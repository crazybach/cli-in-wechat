import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { commandExists, spawnProc } from '../src/adapters/base.js';

test('spawnProc runs Windows .cmd shims without shell:true argument warnings', { skip: process.platform !== 'win32' }, async () => {
  const oldPath = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), 'cli-in-wechat-bin-'));
  const shim = join(dir, 'ciw-shim.cmd');

  try {
    writeFileSync(shim, '@echo off\r\necho first=%~1\r\necho second=%~2\r\n');
    process.env.PATH = `${dir}${delimiter}${oldPath || ''}`;

    assert.equal(await commandExists('ciw-shim'), true);

    const stderrChunks: Buffer[] = [];
    const stdout = await new Promise<string>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const proc = spawnProc('ciw-shim', ['two words', '50% done'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`exit ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      });
    });

    assert.match(stdout, /first=two words/);
    assert.match(stdout, /second=50% done/);
    assert.doesNotMatch(Buffer.concat(stderrChunks).toString('utf8'), /DEP0190|shell option true/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnProc resolves explicit Windows npm shim paths to .cmd wrappers', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-in-wechat-npm-shim-'));
  const extensionlessShim = join(dir, 'codex');
  const cmdShim = `${extensionlessShim}.cmd`;

  try {
    writeFileSync(extensionlessShim, '#!/bin/sh\nexit 1\n');
    writeFileSync(cmdShim, '@echo off\r\necho prompt=%~1\r\n');

    const stdout = await new Promise<string>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const proc = spawnProc(extensionlessShim, ['hello from wechat'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`exit ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      });
    });

    assert.match(stdout, /prompt=hello from wechat/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
