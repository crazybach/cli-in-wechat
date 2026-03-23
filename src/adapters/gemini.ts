import { spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class GeminiAdapter implements CLIAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly command = 'gemini';
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    jsonOutput: true,
    sessionResume: false,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  execute(prompt: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const args = ['-p', prompt, '--output-format', 'json'];
      if (opts?.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[gemini] ${this.command} -p "${prompt.substring(0, 40)}..."`);

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

        try {
          const result = JSON.parse(stdout);
          resolve({
            text: result.response || result.result || stdout.trim(),
            duration: result.stats?.duration_ms,
            error: !!result.error,
          });
        } catch {
          const output = stripAnsi(stdout.trim() || stderr.trim());
          resolve({
            text: output || `退出码 ${code}`,
            error: code !== 0,
          });
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Gemini CLI: ${err.message}`, error: true });
      });
    });
  }
}
