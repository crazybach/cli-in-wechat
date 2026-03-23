import { log } from '../utils/logger.js';
import { ILinkClient } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';
import type { ToolMode, EffortLevel } from '../adapters/base.js';

interface ActiveTask { abort: AbortController; tool: string }

// ─── Lookup tables ───────────────────────────────────────────

const TOOL_ALIASES: Record<string, string> = {
  cc: 'claude', claude: 'claude', c: 'claude',
  cx: 'codex', codex: 'codex', x: 'codex',
  gm: 'gemini', gemini: 'gemini', g: 'gemini',
  ai: 'aider', aider: 'aider',
};

const MODES: Record<string, ToolMode> = {
  auto: 'auto', a: 'auto',
  safe: 'safe', s: 'safe',
  plan: 'plan', p: 'plan',
};

const EFFORTS: Record<string, EffortLevel> = {
  min: 'min', '1': 'min',
  low: 'low', '2': 'low',
  medium: 'medium', med: 'medium', '3': 'medium',
  high: 'high', '4': 'high',
  max: 'max', '5': 'max',
};

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private active = new Map<string, ActiveTask>();

  constructor(ilink: ILinkClient, registry: AdapterRegistry, sessions: SessionManager, config: BridgeConfig) {
    this.ilink = ilink;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
  }

  start(): void {
    this.ilink.onMessage((msg, text) => {
      this.handle(msg, text).catch((e) => log.error('路由异常:', e));
    });
  }

  // ─── Entry ─────────────────────────────────────────────

  private async handle(msg: WeixinMessage, text: string): Promise<void> {
    const uid = msg.from_user_id;
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(uid)) return;

    const trimmed = text.trim();

    // /command
    if (trimmed.startsWith('/')) {
      const si = trimmed.indexOf(' ');
      const cmd = (si === -1 ? trimmed.substring(1) : trimmed.substring(1, si)).toLowerCase();
      const args = si === -1 ? '' : trimmed.substring(si + 1).trim();
      await this.command(uid, cmd, args);
      return;
    }

    // @tool prefix
    let tool: string | undefined;
    let prompt = trimmed;
    const m = trimmed.match(/^@(\w+)\s+([\s\S]+)$/);
    if (m) {
      const resolved = TOOL_ALIASES[m[1].toLowerCase()];
      if (resolved && this.registry.get(resolved)) { tool = resolved; prompt = m[2].trim(); }
    }

    // Busy
    if (this.active.has(uid)) {
      await this.ilink.sendText(uid, '处理中... /cancel 取消');
      return;
    }

    const settings = this.sessions.get(uid);
    const toolName = tool || settings.defaultTool || this.config.defaultTool;

    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n/tools 查看可用`);
      return;
    }

    await this.exec(uid, toolName, prompt);
  }

  // ─── Commands ──────────────────────────────────────────

  private async command(uid: string, cmd: string, args: string): Promise<void> {
    const settings = this.sessions.get(uid);

    // ── Tool shortcuts: /cc /cx /gm /ai ──
    const toolAlias = TOOL_ALIASES[cmd];
    if (toolAlias && !['c'].includes(cmd)) { // /c is cancel, not claude
      if (!this.registry.isAvailable(toolAlias)) {
        await this.ilink.sendText(uid, `${toolAlias} 未安装`);
        return;
      }
      this.sessions.update(uid, { defaultTool: toolAlias });
      await this.ilink.sendText(uid, `→ ${toolAlias}`);
      return;
    }

    switch (cmd) {
      // ─── Mode ───
      case 'auto': case 'safe': case 'plan': {
        const mode = MODES[cmd]!;
        this.sessions.update(uid, { mode });
        const desc: Record<ToolMode, string> = {
          auto: 'AUTO — 全自动\nClaude: --dangerously-skip-permissions\nCodex: --yolo\nGemini: --approval-mode yolo',
          safe: 'SAFE — 需确认\nClaude: default permissions\nCodex: --sandbox read-only\nGemini: --approval-mode default',
          plan: 'PLAN — 只读规划\nClaude: --permission-mode plan\nCodex: --sandbox read-only\nGemini: --approval-mode plan',
        };
        await this.ilink.sendText(uid, desc[mode]);
        break;
      }

      // ─── Effort ───
      case 'effort': case 'e': {
        const level = EFFORTS[args.toLowerCase()];
        if (!level) {
          await this.ilink.sendText(uid, `当前: ${settings.effort}\n/effort <min|low|med|high|max> 或 /e 1-5`);
          return;
        }
        this.sessions.update(uid, { effort: level });
        await this.ilink.sendText(uid, `effort → ${level}\n(Claude: --effort ${level === 'min' ? 'low' : level})`);
        break;
      }

      // ─── Model ───
      case 'model': case 'm': {
        if (!args) {
          await this.ilink.sendText(uid, [
            `当前: ${settings.model || '默认'}`,
            '',
            'Claude: sonnet, opus, claude-sonnet-4-6...',
            'Codex: o3, gpt-5-codex...',
            'Gemini: gemini-2.5-flash, gemini-3-pro...',
            '',
            '/model <名称> | /model reset',
          ].join('\n'));
          return;
        }
        if (args === 'reset' || args === 'default') {
          this.sessions.update(uid, { model: '' });
          await this.ilink.sendText(uid, 'model → 默认');
        } else {
          this.sessions.update(uid, { model: args });
          await this.ilink.sendText(uid, `model → ${args}`);
        }
        break;
      }

      // ─── Turns ───
      case 'turns': case 't': {
        const n = parseInt(args);
        if (!n || n < 1 || n > 200) {
          await this.ilink.sendText(uid, `当前: ${settings.maxTurns}\n/turns <1-200>`);
          return;
        }
        this.sessions.update(uid, { maxTurns: n });
        await this.ilink.sendText(uid, `turns → ${n}`);
        break;
      }

      // ─── Budget (Claude) ───
      case 'budget': case 'b': {
        const v = parseFloat(args);
        if (args === 'off' || args === '0') {
          this.sessions.update(uid, { maxBudget: 0 });
          await this.ilink.sendText(uid, 'budget → 无限制');
        } else if (!isNaN(v) && v > 0) {
          this.sessions.update(uid, { maxBudget: v });
          await this.ilink.sendText(uid, `budget → $${v}\n(Claude: --max-budget-usd ${v})`);
        } else {
          await this.ilink.sendText(uid, `当前: ${settings.maxBudget > 0 ? '$' + settings.maxBudget : '无限制'}\n/budget <美元> | /budget off`);
        }
        break;
      }

      // ─── Search (Codex) ───
      case 'search': {
        const on = !settings.search;
        this.sessions.update(uid, { search: on });
        await this.ilink.sendText(uid, `web search → ${on ? 'ON' : 'OFF'}\n(Codex: --search)`);
        break;
      }

      // ─── Tool switch ───
      case 'use': case 'switch': case 'sw': {
        const t = TOOL_ALIASES[args.toLowerCase()] || args.toLowerCase();
        if (!this.registry.isAvailable(t)) {
          await this.ilink.sendText(uid, `"${t}" 不可用\n可用: ${this.registry.getAvailableNames().join(', ')}`);
          return;
        }
        this.sessions.update(uid, { defaultTool: t });
        await this.ilink.sendText(uid, `→ ${t}`);
        break;
      }

      // ─── Session ───
      case 'new': case 'n': {
        this.sessions.clearSession(uid);
        await this.ilink.sendText(uid, '新会话 (所有工具)');
        break;
      }

      case 'cancel': case 'c': {
        const task = this.active.get(uid);
        if (task) {
          task.abort.abort();
          this.active.delete(uid);
          await this.ilink.sendText(uid, `已取消 ${task.tool}`);
        } else {
          await this.ilink.sendText(uid, '无运行中任务');
        }
        break;
      }

      // ─── Status ───
      case 'status': case 'st': {
        const def = settings.defaultTool || this.config.defaultTool;
        const busy = this.active.get(uid);
        const sessions = Object.entries(settings.sessionIds)
          .map(([k, v]) => `  ${k}: ${v.substring(0, 8)}...`).join('\n') || '  (无)';
        await this.ilink.sendText(uid, [
          `工具: ${def}`,
          `模式: ${settings.mode}`,
          `effort: ${settings.effort}`,
          `model: ${settings.model || '默认'}`,
          `turns: ${settings.maxTurns}`,
          `budget: ${settings.maxBudget > 0 ? '$' + settings.maxBudget : '无限制'}`,
          `search: ${settings.search ? 'ON' : 'OFF'}`,
          `状态: ${busy ? `${busy.tool} 运行中` : '空闲'}`,
          `会话:\n${sessions}`,
        ].join('\n'));
        break;
      }

      // ─── Tools ───
      case 'tools': case 'ls': {
        const lines = this.registry.getAll().map((a) => {
          const ok = this.registry.isAvailable(a.name) ? '●' : '○';
          const caps: string[] = [];
          if (a.capabilities.hasEffort) caps.push('effort');
          if (a.capabilities.hasSearch) caps.push('search');
          if (a.capabilities.hasBudget) caps.push('budget');
          if (a.capabilities.sessionResume) caps.push('resume');
          return `${ok} ${a.displayName} (/${a.name}) [${a.capabilities.modes.join('/')}] ${caps.length ? '{' + caps.join(',') + '}' : ''}`;
        });
        await this.ilink.sendText(uid, lines.join('\n'));
        break;
      }

      // ─── Help ───
      case 'help': case 'h': {
        await this.ilink.sendText(uid, [
          'WX AI Bridge',
          '',
          '— 发消息 —',
          '直接打字 → 默认工具',
          '@claude @codex @gemini @aider',
          '',
          '— 切工具 —',
          '/cc /cx /gm /ai',
          '/use <名称>',
          '',
          '— 模式 —',
          '/auto  全自动(跳过权限)',
          '/safe  安全(需确认)',
          '/plan  只读规划',
          '',
          '— 调参 —',
          '/effort <min|low|med|high|max>',
          '/model <名称> | /model reset',
          '/turns <1-200>',
          '/budget <USD> | /budget off',
          '/search  切换web搜索(Codex)',
          '',
          '— 会话 —',
          '/new     新会话',
          '/cancel  取消任务',
          '/status  当前配置',
          '/tools   工具列表',
        ].join('\n'));
        break;
      }

      default:
        await this.ilink.sendText(uid, `? /${cmd}\n/help 查看帮助`);
    }
  }

  // ─── Execute ───────────────────────────────────────────

  private async exec(uid: string, toolName: string, prompt: string): Promise<void> {
    const adapter = this.registry.get(toolName);
    if (!adapter) return;

    const abort = new AbortController();
    this.active.set(uid, { abort, tool: toolName });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      const settings = this.sessions.get(uid);

      const result = await adapter.execute(prompt, {
        settings,
        workDir: this.config.workDir,
        timeout: this.config.cliTimeout,
        extraArgs: this.config.tools[toolName]?.args,
        signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      if (result.sessionId && adapter.capabilities.sessionResume) {
        this.sessions.setSession(uid, toolName, result.sessionId);
      }

      await this.ilink.sendText(uid, formatResponse(result.text, {
        tool: adapter.displayName,
        mode: settings.mode,
        effort: settings.effort,
        duration: result.duration || (Date.now() - start),
        error: result.error,
      }));
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[${toolName}] 失败:`, err);
        await this.ilink.sendText(uid, `失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(uid);
    }
  }
}
