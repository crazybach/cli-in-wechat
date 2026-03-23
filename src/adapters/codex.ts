import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class CodexAdapter implements CLIAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly command = 'codex';
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    jsonOutput: true,
    sessionResume: true,
    modes: ['auto', 'safe', 'plan'],
    hasEffort: false,
    hasModel: true,
    hasSearch: true,
    hasBudget: false,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const args: string[] = [];

      // ── Session resume ──
      const sid = settings.sessionIds[this.name];
      if (sid) {
        args.push('exec', 'resume', sid, prompt);
      } else {
        args.push('exec');

        // ── Mode ──
        // auto:  --yolo (bypass all approvals + sandbox)
        // safe:  --sandbox read-only, --ask-for-approval untrusted
        // plan:  --sandbox read-only, --ask-for-approval untrusted
        switch (settings.mode) {
          case 'auto':
            args.push('--dangerously-bypass-approvals-and-sandbox');
            break;
          case 'safe':
            args.push('--sandbox', 'read-only', '--ask-for-approval', 'untrusted');
            break;
          case 'plan':
            args.push('--sandbox', 'read-only', '--ask-for-approval', 'untrusted');
            break;
        }

        args.push('--skip-git-repo-check');

        // ── Model ──
        if (settings.model) args.push('-m', settings.model);

        // ── Web search ──
        if (settings.search) args.push('--search');

        args.push(prompt);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} search=${settings.search}`);

      const proc = spawn(this.command, args, {
        cwd: opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);

      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const output = stripAnsi(stdout.trim() || stderr.trim());
        resolve({ text: output || `exit ${code}`, error: code !== 0 });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }
}
