import { log } from '../utils/logger.js';
import { ILinkClient } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';

interface ActiveTask { abort: AbortController; tool: string }

const TOOL_ALIASES: Record<string, string> = {
  claude: 'claude', cc: 'claude',
  codex: 'codex', cx: 'codex',
  gemini: 'gemini', gm: 'gemini',
  aider: 'aider', ai: 'aider',
};

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private active = new Map<string, ActiveTask>();
  private lastResponse = new Map<string, { tool: string; text: string }>();

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

  private async handle(msg: WeixinMessage, text: string): Promise<void> {
    const uid = msg.from_user_id;
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(uid)) return;

    const trimmed = text.trim();

    // Busy check
    if (this.active.has(uid)) {
      await this.ilink.sendText(uid, '处理中...');
      return;
    }

    // ── /command → ALL / messages are commands, never pass through ──
    if (trimmed.startsWith('/')) {
      await this.handleSlash(uid, trimmed);
      return;
    }

    // ── Parse: @tool1>tool2 chain, @tool single, >> relay, plain text ──

    // Pattern: @tool1>tool2 prompt  →  chain: tool1 processes, output feeds tool2
    const chainMatch = trimmed.match(/^@(\w+)>(\w+)\s+([\s\S]+)$/);
    if (chainMatch) {
      const t1 = TOOL_ALIASES[chainMatch[1].toLowerCase()];
      const t2 = TOOL_ALIASES[chainMatch[2].toLowerCase()];
      const prompt = chainMatch[3].trim();
      if (t1 && t2 && this.registry.isAvailable(t1) && this.registry.isAvailable(t2)) {
        await this.chain(uid, t1, t2, prompt);
        return;
      }
    }

    // Pattern: >> prompt  →  relay: prepend last response as context
    if (trimmed.startsWith('>>')) {
      const rest = trimmed.substring(2).trim();
      const prev = this.lastResponse.get(uid);
      if (!prev) {
        await this.ilink.sendText(uid, '没有上一条回复可接力');
        return;
      }

      // >> @tool prompt  →  relay to specific tool
      let tool: string | undefined;
      let prompt = rest;
      const atMatch = rest.match(/^@(\w+)\s+([\s\S]+)$/);
      if (atMatch) {
        const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
        if (resolved && this.registry.isAvailable(resolved)) {
          tool = resolved;
          prompt = atMatch[2].trim();
          this.sessions.update(uid, { defaultTool: resolved });
        }
      }

      const toolName = tool || this.sessions.get(uid).defaultTool || this.config.defaultTool;
      const fullPrompt = `以下是 ${prev.tool} 的输出:\n\n${prev.text}\n\n---\n\n${prompt}`;
      await this.exec(uid, toolName, fullPrompt);
      return;
    }

    // Pattern: @tool prompt  →  single tool
    let tool: string | undefined;
    let prompt = trimmed;
    const atMatch = trimmed.match(/^@(\w+)\s+([\s\S]+)$/);
    if (atMatch) {
      const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
      if (resolved && this.registry.isAvailable(resolved)) {
        tool = resolved;
        prompt = atMatch[2].trim();
        this.sessions.update(uid, { defaultTool: resolved });
      }
    }

    const toolName = tool || this.sessions.get(uid).defaultTool || this.config.defaultTool;
    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n可用: ${this.registry.getAvailableNames().join(', ')}`);
      return;
    }

    await this.exec(uid, toolName, prompt);
  }

  // ─── /command → ALL are commands, never pass through ────

  private async handleSlash(uid: string, text: string): Promise<boolean> {
    const parts = text.substring(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const settings = this.sessions.get(uid);
    const reply = (msg: string) => this.ilink.sendText(uid, msg);

    switch (cmd) {
      // ═══════════════════════════════════════════
      // 通用
      // ═══════════════════════════════════════════

      case 'help': case 'h':
        await reply([
          '— 通用 —',
          '/status  查看所有配置',
          '/new  新会话(清除所有工具session)',
          '/cancel  取消当前任务',
          '/model <名>  切模型 (reset=默认)',
          '/mode <auto|safe|plan>  权限模式',
          '/dir <路径>  切换工作目录',
          '/system <提示>  追加系统提示词',
          '/reset  重置所有设置为默认',
          '/yolo  快捷: mode=auto + effort=max',
          '',
          '— Claude Code —',
          '/effort <low|med|high|max>  思考深度',
          '/fast  快捷: effort=low',
          '/turns <数字>  最大agent轮次',
          '/budget <美元>  API预算 (off=无限)',
          '/tools <列表>  允许的工具(逗号分隔)',
          '/notool <列表>  禁用的工具',
          '/verbose  切换详细输出',
          '/bare  切换bare模式(跳过配置加载)',
          '/adddir <路径>  添加额外目录访问',
          '/name <名>  会话命名',
          '',
          '— Codex —',
          '/sandbox <ro|write|full|off>  沙箱',
          '/search  切换web搜索',
          '/ephemeral  切换临时模式(不存session)',
          '/profile <名>  加载配置profile',
          '',
          '— Gemini —',
          '/approval <default|auto_edit|yolo|plan>',
          '/include <目录>  添加上下文目录',
          '/ext <名|none>  指定extensions',
          '',
          '— 工具切换 —',
          '/cc /cx /gm /ai  快速切换',
          '@claude @codex @gemini  指定工具发消息',
          '',
          '— 接力 —',
          '>> <消息>  传上条结果给当前工具',
          '>> @tool <消息>  传给指定工具',
          '@tool1>tool2 <消息>  链式调用',
        ].join('\n'));
        return true;

      case 'status': case 'st': {
        const def = settings.defaultTool || this.config.defaultTool;
        const sids = Object.entries(settings.sessionIds).map(([k, v]) => `${k}:${String(v).substring(0, 8)}`).join(' ') || '无';
        const lines = [
          `工具: ${def}`,
          `模式: ${settings.mode}`,
          `effort: ${settings.effort}`,
          `model: ${settings.model || '默认'}`,
          `turns: ${settings.maxTurns}`,
          `budget: ${settings.maxBudget > 0 ? '$' + settings.maxBudget : '无限'}`,
          `sandbox: ${settings.sandbox || '无'}`,
          `search: ${settings.search ? 'ON' : 'OFF'}`,
          `verbose: ${settings.verbose ? 'ON' : 'OFF'}`,
          `system: ${settings.systemPrompt ? settings.systemPrompt.substring(0, 40) + '...' : '无'}`,
          `dir: ${settings.workDir || this.config.workDir}`,
          `会话: ${sids}`,
          `可用: ${this.registry.getAvailableNames().join(', ')}`,
        ];
        await reply(lines.join('\n'));
        return true;
      }

      case 'new': case 'n':
        this.sessions.clearSession(uid);
        await reply('新会话');
        return true;

      case 'cancel': case 'c': {
        const task = this.active.get(uid);
        if (task) { task.abort.abort(); this.active.delete(uid); await reply(`已取消 ${task.tool}`); }
        else { await reply('无任务'); }
        return true;
      }

      case 'model': case 'm':
        if (!arg || arg === 'reset' || arg === 'default') {
          this.sessions.update(uid, { model: '' });
          await reply('model → 默认');
        } else {
          this.sessions.update(uid, { model: arg });
          await reply(`model → ${arg}`);
        }
        return true;

      case 'mode': {
        const modes: Record<string, string> = { auto: 'auto', safe: 'safe', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply('/mode <auto|safe|plan>\nauto=最高权限 safe=需确认 plan=只读'); return true; }
        this.sessions.update(uid, { mode: v as any });
        const desc: Record<string, string> = {
          auto: 'AUTO\nClaude: --dangerously-skip-permissions\nCodex: --yolo\nGemini: --approval-mode yolo',
          safe: 'SAFE\nClaude: 默认权限\nCodex: --full-auto\nGemini: --approval-mode default',
          plan: 'PLAN\nClaude: --permission-mode plan\nCodex: --sandbox read-only\nGemini: --approval-mode plan',
        };
        await reply(desc[v]);
        return true;
      }

      case 'dir': case 'cd':
        if (!arg) { await reply(`当前: ${settings.workDir || this.config.workDir}`); return true; }
        this.sessions.update(uid, { workDir: arg });
        await reply(`dir → ${arg}`);
        return true;

      case 'system': case 'sys':
        if (!arg || arg === 'clear' || arg === 'reset') {
          this.sessions.update(uid, { systemPrompt: '' });
          await reply('system prompt → 清除');
        } else {
          this.sessions.update(uid, { systemPrompt: arg });
          await reply(`system prompt → ${arg.substring(0, 60)}...`);
        }
        return true;

      // ═══════════════════════════════════════════
      // Claude Code
      // ═══════════════════════════════════════════

      case 'effort': case 'e': {
        const map: Record<string, string> = {
          min: 'low', low: 'low', med: 'medium', medium: 'medium', high: 'high', max: 'max',
          '1': 'low', '2': 'low', '3': 'medium', '4': 'high', '5': 'max',
        };
        const v = map[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.effort}\n/effort <low|med|high|max>`); return true; }
        this.sessions.update(uid, { effort: v });
        await reply(`effort → ${v}`);
        return true;
      }

      case 'turns': case 't': {
        const n = parseInt(arg);
        if (!n || n < 1) { await reply(`当前: ${settings.maxTurns}\n/turns <数字>`); return true; }
        this.sessions.update(uid, { maxTurns: n });
        await reply(`turns → ${n}`);
        return true;
      }

      case 'budget': case 'b':
        if (!arg || arg === 'off' || arg === '0') {
          this.sessions.update(uid, { maxBudget: 0 });
          await reply('budget → 无限');
        } else {
          const v = parseFloat(arg);
          if (isNaN(v)) { await reply('/budget <美元> 或 /budget off'); return true; }
          this.sessions.update(uid, { maxBudget: v });
          await reply(`budget → $${v}`);
        }
        return true;

      case 'tools':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { allowedTools: '' });
          await reply('allowedTools → 全部');
        } else {
          this.sessions.update(uid, { allowedTools: arg });
          await reply(`allowedTools → ${arg}`);
        }
        return true;

      case 'notool':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { disallowedTools: '' });
          await reply('disallowedTools → 无');
        } else {
          this.sessions.update(uid, { disallowedTools: arg });
          await reply(`disallowedTools → ${arg}`);
        }
        return true;

      case 'verbose': case 'v':
        this.sessions.update(uid, { verbose: !settings.verbose });
        await reply(`verbose → ${!settings.verbose ? 'ON' : 'OFF'}`);
        return true;

      // ═══════════════════════════════════════════
      // Codex
      // ═══════════════════════════════════════════

      case 'sandbox': case 'sb': {
        const aliases: Record<string, string> = {
          ro: 'read-only', 'read-only': 'read-only', readonly: 'read-only',
          ws: 'workspace-write', 'workspace-write': 'workspace-write', write: 'workspace-write',
          full: 'danger-full-access', 'danger-full-access': 'danger-full-access', danger: 'danger-full-access',
          off: '', reset: '',
        };
        const v = aliases[arg.toLowerCase()];
        if (v === undefined) { await reply(`当前: ${settings.sandbox || '无'}\n/sandbox <read-only|write|full|off>`); return true; }
        this.sessions.update(uid, { sandbox: v });
        await reply(v ? `sandbox → ${v}` : 'sandbox → OFF (yolo)');
        return true;
      }

      case 'search':
        this.sessions.update(uid, { search: !settings.search });
        await reply(`search → ${!settings.search ? 'ON' : 'OFF'}`);
        return true;

      case 'ephemeral':
        this.sessions.update(uid, { ephemeral: !settings.ephemeral });
        await reply(`ephemeral → ${!settings.ephemeral ? 'ON' : 'OFF'}`);
        return true;

      case 'profile':
        if (!arg) { await reply(`当前: ${settings.profile || '无'}\n/profile <名称> 或 /profile reset`); return true; }
        this.sessions.update(uid, { profile: arg === 'reset' ? '' : arg });
        await reply(arg === 'reset' ? 'profile → 默认' : `profile → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // Gemini
      // ═══════════════════════════════════════════

      case 'approval': {
        const modes: Record<string, string> = { default: 'default', auto_edit: 'auto_edit', yolo: 'yolo', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.approvalMode || 'yolo'}\n/approval <default|auto_edit|yolo|plan>`); return true; }
        this.sessions.update(uid, { approvalMode: v });
        await reply(`approval-mode → ${v}`);
        return true;
      }

      case 'include': case 'inc':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { includeDirs: '' });
          await reply('include dirs → 清除');
        } else {
          this.sessions.update(uid, { includeDirs: arg });
          await reply(`include dirs → ${arg}`);
        }
        return true;

      case 'ext': case 'extensions':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { extensions: '' });
          await reply('extensions → 默认');
        } else {
          this.sessions.update(uid, { extensions: arg });
          await reply(`extensions → ${arg}`);
        }
        return true;

      // ═══════════════════════════════════════════
      // 快捷组合
      // ═══════════════════════════════════════════

      case 'yolo':
        this.sessions.update(uid, { mode: 'auto', effort: 'max' } as any);
        await reply('YOLO: mode=auto + effort=max');
        return true;

      case 'fast':
        this.sessions.update(uid, { effort: 'low' });
        await reply('effort → low (快速模式)');
        return true;

      case 'reset':
        this.sessions.update(uid, {
          mode: 'auto', effort: 'high', model: '', maxTurns: 30, maxBudget: 0,
          allowedTools: '', disallowedTools: '', verbose: false, sandbox: '',
          search: false, systemPrompt: '', workDir: '', bare: false, addDir: '',
          sessionName: '', ephemeral: false, profile: '', approvalMode: '',
          includeDirs: '', extensions: '',
        } as any);
        await reply('所有设置已重置');
        return true;

      // ═══════════════════════════════════════════
      // Claude 额外
      // ═══════════════════════════════════════════

      case 'bare':
        this.sessions.update(uid, { bare: !settings.bare } as any);
        await reply(`bare → ${!(settings as any).bare ? 'ON (跳过配置加载)' : 'OFF'}`);
        return true;

      case 'adddir': case 'add-dir':
        if (!arg) { await reply(`当前: ${(settings as any).addDir || '无'}\n/adddir <路径>`); return true; }
        this.sessions.update(uid, { addDir: arg } as any);
        await reply(`add-dir → ${arg}`);
        return true;

      case 'name':
        if (!arg) { await reply(`当前: ${(settings as any).sessionName || '无'}\n/name <名称>`); return true; }
        this.sessions.update(uid, { sessionName: arg } as any);
        await reply(`session name → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // 工具切换
      // ═══════════════════════════════════════════

      case 'claude': case 'cc':
        this.sessions.update(uid, { defaultTool: 'claude' }); await reply('→ claude'); return true;
      case 'codex': case 'cx':
        this.sessions.update(uid, { defaultTool: 'codex' }); await reply('→ codex'); return true;
      case 'gemini': case 'gm':
        this.sessions.update(uid, { defaultTool: 'gemini' }); await reply('→ gemini'); return true;
      case 'aider': case 'ai':
        this.sessions.update(uid, { defaultTool: 'aider' }); await reply('→ aider'); return true;

      // ═══════════════════════════════════════════
      // 未识别
      // ═══════════════════════════════════════════

      default:
        await reply(`未知命令: /${cmd}\n/help 查看所有命令`);
        return true;
    }
  }

  // ─── Chain: tool1 → tool2 ─────────────────────────────

  private async chain(uid: string, tool1: string, tool2: string, prompt: string): Promise<void> {
    const adapter1 = this.registry.get(tool1);
    const adapter2 = this.registry.get(tool2);
    if (!adapter1 || !adapter2) return;

    const abort = new AbortController();
    this.active.set(uid, { abort, tool: `${tool1}>${tool2}` });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();

    try {
      const settings = this.sessions.get(uid);

      // Step 1: run tool1
      log.debug(`[chain] step1: ${tool1}`);
      const r1 = await adapter1.execute(prompt, {
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout, signal: abort.signal,
      });

      if (abort.signal.aborted || r1.error) {
        if (!abort.signal.aborted) {
          await this.ilink.sendText(uid, formatResponse(r1.text, { tool: adapter1.displayName, error: true }));
        }
        return;
      }

      if (r1.sessionId && adapter1.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool1, r1.sessionId);
      }

      // Step 2: run tool2 with tool1's output as context
      log.debug(`[chain] step2: ${tool2}`);
      const chainPrompt = `以下是 ${adapter1.displayName} 对「${prompt}」的分析结果:\n\n${r1.text}\n\n---\n\n请基于以上内容继续工作。`;

      const r2 = await adapter2.execute(chainPrompt, {
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout, signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      if (r2.sessionId && adapter2.capabilities.sessionResume) {
        this.sessions.setSession(uid, tool2, r2.sessionId);
      }

      this.sessions.update(uid, { defaultTool: tool2 });
      this.lastResponse.set(uid, { tool: adapter2.displayName, text: r2.text });

      const elapsed = Date.now() - start;
      await this.ilink.sendText(uid, formatResponse(r2.text, {
        tool: `${adapter1.displayName} → ${adapter2.displayName}`,
        duration: elapsed,
        error: r2.error,
      }));
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[chain] 失败:`, err);
        await this.ilink.sendText(uid, `链式调用失败: ${(err as Error).message}`);
      }
    } finally {
      stopTyping();
      this.active.delete(uid);
    }
  }

  // ─── Execute single tool ──────────────────────────────

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
        settings, workDir: this.config.workDir,
        timeout: this.config.cliTimeout,
        extraArgs: this.config.tools[toolName]?.args,
        signal: abort.signal,
      });

      if (abort.signal.aborted) return;

      if (result.sessionId && adapter.capabilities.sessionResume) {
        this.sessions.setSession(uid, toolName, result.sessionId);
      }

      // Store for >> relay
      this.lastResponse.set(uid, { tool: adapter.displayName, text: result.text });

      await this.ilink.sendText(uid, formatResponse(result.text, {
        tool: adapter.displayName,
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
