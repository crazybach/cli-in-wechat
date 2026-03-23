import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class AiderAdapter implements CLIAdapter {
  readonly name = 'aider';
  readonly displayName = 'Aider';
  readonly command = 'aider';
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    jsonOutput: false,
    sessionResume: false,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  execute(prompt: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const args = [
        '--yes-always',
        '--no-pretty',
        '--no-stream',
        '--no-auto-commits',
        '-m', prompt,
      ];

      if (opts?.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[aider] ${this.command} -m "${prompt.substring(0, 40)}..."`);

      const proc = spawn(this.command, args, {
        cwd: opts?.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      setupAbort(proc, opts?.signal);
      const timer = setupTimeout(proc, opts?.timeout);

      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);

        if (opts?.signal?.aborted) {
          resolve({ text: '已取消', error: true });
          return;
        }

        const output = stripAnsi(stdout.trim() || stderr.trim());
        resolve({
          text: output || `退出码 ${code}`,
          error: code !== 0,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Aider: ${err.message}`, error: true });
      });
    });
  }
}
