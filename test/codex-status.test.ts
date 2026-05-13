import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { CodexAdapter, readCodexConfig } from '../src/adapters/codex.js';
import { DEFAULT_SETTINGS } from '../src/adapters/base.js';

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

test('Codex status reports none when bridge has no active session', async () => {
  const oldHome = process.env.CODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const workDir = '/tmp/codex-status-workdir';
  try {
    const sessionDir = join(dir, 'sessions', '2026', '05', '06');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-05-06T10-00-00-abc.jsonl'), JSON.stringify({
      timestamp: '2026-05-06T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'abc', cwd: workDir },
    }) + '\n' + JSON.stringify({
      timestamp: '2026-05-06T10:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 250 },
          model_context_window: 1000,
        },
        rate_limits: {
          primary: { used_percent: 25, resets_at: 1778058000 },
          secondary: { used_percent: 40, resets_at: 1778068000 },
        },
      },
    }) + '\n');
    writeFileSync(join(dir, 'config.toml'), '');
    process.env.CODEX_HOME = dir;

    const adapter = new CodexAdapter();
    const status = await adapter.getStatus({
      settings: { ...DEFAULT_SETTINGS, sessionIds: {} },
      workDir,
      timeout: 100,
    });

    assert.match(status.text, /Session: none/);
    assert.match(status.text, /Context Window: 250 \/ 1,000 tokens \(75% left\)/);
    assert.match(status.text, /5h limit: 75% left/);
    assert.match(status.text, /Weekly limit: 60% left/);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex status resolves last only when bridge explicitly stores last', async () => {
  const oldHome = process.env.CODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const workDir = '/tmp/codex-status-workdir';
  try {
    const sessionDir = join(dir, 'sessions', '2026', '05', '06');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-05-06T10-00-00-abc.jsonl'), JSON.stringify({
      timestamp: '2026-05-06T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'abc', cwd: workDir },
    }) + '\n');
    writeFileSync(join(dir, 'config.toml'), '');
    process.env.CODEX_HOME = dir;

    const adapter = new CodexAdapter();
    const status = await adapter.getStatus({
      settings: { ...DEFAULT_SETTINGS, sessionIds: { codex: 'last' } },
      workDir,
      timeout: 100,
    });

    assert.match(status.text, /Session: abc/);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex resume preserves auto-mode bypass flags', { skip: process.platform !== 'win32' }, async () => {
  const oldPath = process.env.PATH;
  const binDir = mkdtempSync(join(tmpdir(), 'codex-resume-bin-'));
  const workDir = mkdtempSync(join(tmpdir(), 'codex-resume-work-'));
  const argsFile = join(binDir, 'args.txt');
  const escapedArgsFile = argsFile.replace(/%/g, '%%');

  try {
    writeFileSync(join(binDir, 'codex.cmd'), [
      '@echo off',
      `echo %*>"${escapedArgsFile}"`,
      'more > nul',
      'echo ok',
      '',
    ].join('\r\n'));
    process.env.PATH = `${binDir}${delimiter}${oldPath || ''}`;

    const adapter = new CodexAdapter();
    const result = await adapter.execute('get news from news.google.com', {
      settings: { ...DEFAULT_SETTINGS, sessionIds: { codex: 'resume-id' } },
      workDir,
      timeout: 5000,
    });

    assert.equal(result.error, false);
    assert.equal(
      readFileSync(argsFile, 'utf8').trim(),
      '"exec" "resume" "--skip-git-repo-check" "--dangerously-bypass-approvals-and-sandbox" "resume-id"',
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
