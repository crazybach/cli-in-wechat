import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCodexConfig } from '../src/adapters/codex.js';

function withCodexHome(configToml: string, fn: () => void): void {
  const oldHome = process.env.CODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.toml'), configToml);
    process.env.CODEX_HOME = dir;
    fn();
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readCodexConfig ignores inactive profile-scoped model', () => {
  withCodexHome(`
model = "top-model"
model_reasoning_effort = "high"

[profiles.foo]
model = "foo-model"
model_reasoning_effort = "low"
`, () => {
    assert.deepEqual(readCodexConfig(), { model: 'top-model', reasoning: 'high' });
  });
});

test('readCodexConfig overlays the active Codex profile', () => {
  withCodexHome(`
model = "top-model"
model_reasoning_effort = "high"

[profiles.foo]
model = "foo-model"
model_reasoning_effort = "low"
`, () => {
    assert.deepEqual(readCodexConfig('foo'), { model: 'foo-model', reasoning: 'low' });
  });
});
