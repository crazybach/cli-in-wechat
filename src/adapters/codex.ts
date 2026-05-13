import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, StatusOptions } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, isSessionError, WIN } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';

function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;
  
  const copiedMedia = workDir ? media.map(m => copyMediaToWorkDir(m, workDir)) : media;
  
  const fileList = copiedMedia.map(m => {
    const relativePath = workDir && m.path.startsWith(workDir) 
      ? m.path.slice(workDir.length).replace(/^[\/\\]/, '')
      : m.path;
    const typeNames: Record<string, string> = { image: '图片', file: '文件', video: '视频' };
    const sizeStr = m.size ? `${(m.size / 1024).toFixed(1)}KB` : '未知大小';
    return `- ${m.fileName}\n  类型: ${typeNames[m.type] || '文件'}\n  大小: ${sizeStr}\n  路径: ${relativePath}`;
  }).join('\n\n');
  
  const userPrompt = prompt.trim() && !prompt.startsWith('[文件:') && !prompt.startsWith('[图片:') && !prompt.startsWith('[视频:')
    ? `\n\n用户说：${prompt}`
    : '';
  
  return `已接收到用户通过微信发送的文件：

${fileList}

文件已保存到工作目录。请勿主动读取或处理这些文件，等待用户明确指示需要做什么。${userPrompt}`;
}

interface CodexConfigSummary {
  model?: string;
  reasoning?: string;
}

interface CodexAccountSummary {
  label: string;
}

interface CodexSessionSummary {
  id: string;
  path?: string;
  cwd?: string;
}

interface CodexTokenUsage {
  total_tokens?: number;
}

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexTokenSnapshot {
  info?: {
    last_token_usage?: CodexTokenUsage;
    total_token_usage?: CodexTokenUsage;
    model_context_window?: number;
  } | null;
  rate_limits?: {
    primary?: CodexRateLimitWindow;
    secondary?: CodexRateLimitWindow;
  } | null;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function parseTomlStringValue(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`));
  return match?.[1];
}

function normalizeTomlTableName(table: string): string {
  return table.split('.').map((part) => part.trim().replace(/^"|"$/g, '')).join('.');
}

export function readCodexConfig(profile?: string): CodexConfigSummary {
  try {
    const path = join(getCodexHome(), 'config.toml');
    const text = readFileSync(path, 'utf8');
    const sections = new Map<string, CodexConfigSummary>([['', {}]]);
    let currentTable = '';

    for (const line of text.split('\n')) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        currentTable = normalizeTomlTableName(table[1]);
        if (!sections.has(currentTable)) sections.set(currentTable, {});
        continue;
      }

      const section = sections.get(currentTable)!;
      const model = parseTomlStringValue(line, 'model');
      if (model !== undefined) section.model = model;
      const reasoning = parseTomlStringValue(line, 'model_reasoning_effort');
      if (reasoning !== undefined) section.reasoning = reasoning;
    }

    const topLevel = sections.get('') || {};
    if (!profile) return { ...topLevel };

    const profileConfig = sections.get(`profiles.${profile}`);
    return { ...topLevel, ...(profileConfig || {}) };
  } catch {
    return {};
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function readCodexAccount(): CodexAccountSummary {
  try {
    const path = join(getCodexHome(), 'auth.json');
    const auth = JSON.parse(readFileSync(path, 'utf8')) as {
      auth_mode?: string;
      OPENAI_API_KEY?: string | null;
      tokens?: { id_token?: string };
    };

    if (auth.auth_mode === 'apikey' || auth.OPENAI_API_KEY) return { label: 'API key' };

    const payload = auth.tokens?.id_token ? decodeJwtPayload(auth.tokens.id_token) : undefined;
    const email = typeof payload?.email === 'string' ? payload.email : '';
    const authInfo = payload?.['https://api.openai.com/auth'];
    let plan = '';
    if (authInfo && typeof authInfo === 'object' && 'chatgpt_plan_type' in authInfo) {
      const raw = (authInfo as { chatgpt_plan_type?: unknown }).chatgpt_plan_type;
      if (typeof raw === 'string' && raw) plan = raw[0].toUpperCase() + raw.slice(1);
    }

    if (email && plan) return { label: `${email} (${plan})` };
    if (email) return { label: email };
    if (auth.auth_mode) return { label: auth.auth_mode };
    return { label: 'unknown' };
  } catch {
    return { label: 'not logged in or unreadable' };
  }
}

function findAgentsFile(workDir: string): string {
  let dir = workDir;
  while (dir && dir !== dirname(dir)) {
    const candidate = join(dir, 'AGENTS.md');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }

  const userAgents = join(getCodexHome(), 'AGENTS.md');
  return existsSync(userAgents) ? userAgents : 'none';
}

function sessionIdFromFileName(path: string): string {
  return basename(path, '.jsonl').replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
}

function readCodexSessionMeta(path: string): CodexSessionSummary | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(8192);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    if (!/"type"\s*:\s*"session_meta"/.test(prefix)) return undefined;

    const id = prefix.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
    if (!id) return undefined;

    const cwd = prefix.match(/"cwd"\s*:\s*"([^"]*)"/)?.[1];
    return { id, cwd, path };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function listJsonlFilesRecursive(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) return listJsonlFilesRecursive(path);
      return name.endsWith('.jsonl') ? [path] : [];
    });
  } catch {
    return [];
  }
}

function findLatestCodexSession(workDir?: string, minMtime = 0): CodexSessionSummary | undefined {
  const baseDir = join(getCodexHome(), 'sessions');
  const candidates = listJsonlFilesRecursive(baseDir)
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtime.getTime() };
      } catch {
        return { path, mtime: 0 };
      }
    })
    .filter(({ mtime }) => mtime >= minMtime)
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of candidates) {
    const meta = readCodexSessionMeta(candidate.path);
    if (workDir && meta?.cwd !== workDir) continue;
    return meta || { id: sessionIdFromFileName(candidate.path), path: candidate.path };
  }

  return undefined;
}

function readLatestTokenSnapshot(path?: string): CodexTokenSnapshot | undefined {
  if (!path) return undefined;

  try {
    let latest: CodexTokenSnapshot | undefined;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('"type":"token_count"')) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          payload?: { type?: string; info?: CodexTokenSnapshot['info']; rate_limits?: CodexTokenSnapshot['rate_limits'] };
        };
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
          latest = { info: obj.payload.info, rate_limits: obj.payload.rate_limits };
        }
      } catch {
        continue;
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatContextWindow(snapshot?: CodexTokenSnapshot): string {
  const info = snapshot?.info;
  const window = info?.model_context_window;
  const used = info?.last_token_usage?.total_tokens ?? info?.total_token_usage?.total_tokens;
  if (!window || !used) return 'Context Window: unknown';

  const boundedUsed = Math.min(used, window);
  const left = Math.max(0, window - boundedUsed);
  const leftPercent = Math.round((left / window) * 100);
  return `Context Window: ${formatNumber(boundedUsed)} / ${formatNumber(window)} tokens (${leftPercent}% left)`;
}

function formatResetTime(epochSeconds?: number): string {
  if (!epochSeconds) return 'reset unknown';
  return `resets ${new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatRateLimit(label: string, limit?: CodexRateLimitWindow): string {
  if (!limit || typeof limit.used_percent !== 'number') return `${label}: unknown`;
  const left = Math.max(0, Math.round(100 - limit.used_percent));
  return `${label}: ${left}% left (${formatResetTime(limit.resets_at)})`;
}

function formatPermissions(settings: StatusOptions['settings']): string {
  if (settings.sandbox === 'read-only' || settings.mode === 'plan') return 'Read Only';
  if (settings.sandbox === 'workspace-write') return 'Workspace';
  if (settings.sandbox === 'danger-full-access') return 'Full Access';
  if (settings.mode === 'auto') return 'Full Access (approvals and sandbox bypassed)';
  return 'Workspace (full-auto)';
}

function shouldBypassApprovalsAndSandbox(settings: ExecOptions['settings']): boolean {
  return (settings.mode === 'auto' && !settings.sandbox) || (WIN && settings.sandbox === 'danger-full-access');
}

export class CodexAdapter implements CLIAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly command = 'codex';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: [], hasEffort: false, hasModel: true, hasSearch: true, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async getStatus(opts: StatusOptions): Promise<ExecResult> {
    const { settings } = opts;
    const workDir = settings.workDir || opts.workDir || process.cwd();
    const config = readCodexConfig(settings.profile || undefined);
    const model = settings.model || config.model || 'default';
    const reasoning = config.reasoning ? ` (reasoning ${config.reasoning})` : '';
    const version = await this.getCliVersion(opts.timeout);
    const account = readCodexAccount();
    const configuredSession = settings.sessionIds[this.name];
    const latestSession = configuredSession
      ? configuredSession === 'last'
        ? findLatestCodexSession(workDir)
        : { id: configuredSession }
      : undefined;
    const tokenSnapshotSession = latestSession?.path ? latestSession : findLatestCodexSession(workDir);
    const tokenSnapshot = readLatestTokenSnapshot(tokenSnapshotSession?.path);
    const sessionLabel = latestSession?.id || configuredSession || 'none';
    const sessionPath = latestSession?.path ? `\nSession file: ${latestSession.path}` : '';

    const lines = [
      `OpenAI Codex (${version})`,
      '',
      'Visit https://chatgpt.com/codex/settings/usage for up-to-date rate limits and credits.',
      '',
      `Model: ${model}${reasoning}`,
      `Directory: ${workDir}`,
      `Permissions: ${formatPermissions(settings)}`,
      `Agents.md: ${findAgentsFile(workDir)}`,
      `Account: ${account.label}`,
      `Session: ${sessionLabel}${sessionPath}`,
      formatContextWindow(tokenSnapshot),
      formatRateLimit('5h limit', tokenSnapshot?.rate_limits?.primary),
      formatRateLimit('Weekly limit', tokenSnapshot?.rate_limits?.secondary),
      `Search: ${settings.search ? 'on' : 'off'}`,
      `Ephemeral: ${settings.ephemeral ? 'on' : 'off'}`,
      `Profile: ${settings.profile || 'default'}`,
    ];

    return { text: lines.join('\n') };
  }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];
      const hasSession = settings.sessionIds[this.name];
      const startedAt = Date.now();

      if (hasSession) {
        args.push('exec', 'resume');
        if (WIN) {
          args.push('--skip-git-repo-check');
          if (shouldBypassApprovalsAndSandbox(settings)) {
            args.push('--dangerously-bypass-approvals-and-sandbox');
          }
        }
        if (settings.model) args.push('-m', settings.model);
        if (settings.ephemeral) args.push('--ephemeral');
        if (hasSession === 'last') args.push('--last');
        else args.push(hasSession);
      } else {
        args.push('exec');

        // Mode / sandbox
        if (shouldBypassApprovalsAndSandbox(settings)) {
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else if (settings.sandbox) {
          args.push('--sandbox', settings.sandbox);
        } else {
          args.push('--full-auto');
        }

        args.push('--skip-git-repo-check');

        // Model
        if (settings.model) args.push('-m', settings.model);

        // Web search
        if (settings.search) args.push('--search');

        // Ephemeral
        if (settings.ephemeral) args.push('--ephemeral');

        // Profile
        if (settings.profile) args.push('--profile', settings.profile);

        // Add directory
        if (settings.addDir) args.push('--add-dir', settings.addDir);
      }

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} sandbox=${settings.sandbox || 'yolo'} search=${settings.search}`);
      const proc = spawnProc(this.command, args, {
        cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Pass prompt via stdin to avoid Windows cmd.exe Unicode encoding issues
      log.debug(`[codex] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
      proc.stdin!.write(fullPrompt, 'utf8');
      proc.stdin!.end();

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      let stdout = '', stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const text = stripAnsi(stdout.trim() || stderr.trim()) || `exit ${code}`;
        const createdSession = !hasSession && code === 0
          ? findLatestCodexSession(workDir, startedAt - 1000)
          : undefined;
        resolve({
          text,
          sessionId: code === 0 ? (createdSession?.id || hasSession || 'last') : undefined,
          error: code !== 0,
          sessionExpired: code !== 0 && !!hasSession && isSessionError(text),
        });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }

  private getCliVersion(timeout?: number): Promise<string> {
    return new Promise((resolve) => {
      const proc = spawnProc(this.command, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      const timer = setupTimeout(proc, Math.min(timeout || 3000, 3000));
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('close', () => {
        if (timer) clearTimeout(timer);
        const text = stripAnsi(stdout.trim() || stderr.trim());
        resolve(text.replace(/^codex-cli\s+/, 'v') || 'unknown');
      });
      proc.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve('unknown');
      });
    });
  }
}
