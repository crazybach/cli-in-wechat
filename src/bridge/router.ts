import { log } from '../utils/logger.js';
import { ILinkClient } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';

interface ParsedMessage {
  type: 'command' | 'chat';
  command?: string;
  args?: string;
  tool?: string;
  prompt?: string;
}

interface ActiveTask {
  abort: AbortController;
  tool: string;
}

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private activeTasks = new Map<string, ActiveTask>();

  constructor(
    ilink: ILinkClient,
    registry: AdapterRegistry,
    sessions: SessionManager,
    config: BridgeConfig,
  ) {
    this.ilink = ilink;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
  }

  start(): void {
    this.ilink.onMessage((msg, text) => {
      this.handleMessage(msg, text).catch((err) => {
        log.error('路由处理异常:', err);
      });
    });
  }

  // ─── Message parsing ───────────────────────────────────

  private parse(text: string): ParsedMessage {
    const trimmed = text.trim();

    // /command
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      const command =
        spaceIdx === -1
          ? trimmed.substring(1)
          : trimmed.substring(1, spaceIdx);
      const args =
        spaceIdx === -1 ? '' : trimmed.substring(spaceIdx + 1).trim();
      return { type: 'command', command: command.toLowerCase(), args };
    }

    // @tool prefix
    const atMatch = trimmed.match(/^@(\w+)\s+([\s\S]+)$/);
    if (atMatch) {
      const tool = atMatch[1].toLowerCase();
      if (this.registry.get(tool)) {
        return { type: 'chat', tool, prompt: atMatch[2].trim() };
      }
    }

    // Plain text → default tool
    return { type: 'chat', prompt: trimmed };
  }

  // ─── Message handler ───────────────────────────────────

  private async handleMessage(
    msg: WeixinMessage,
    text: string,
  ): Promise<void> {
    const userId = msg.from_user_id;

    // Access control
    if (
      this.config.allowedUsers.length > 0 &&
      !this.config.allowedUsers.includes(userId)
    ) {
      log.warn(`拒绝未授权用户: ${userId}`);
      return;
    }

    const parsed = this.parse(text);

    if (parsed.type === 'command') {
      await this.handleCommand(userId, parsed.command!, parsed.args || '');
      return;
    }

    // Busy check
    if (this.activeTasks.has(userId)) {
      await this.ilink.sendText(
        userId,
        '上一个请求还在处理中...\n发送 /cancel 可取消',
      );
      return;
    }

    const tool =
      parsed.tool ||
      this.sessions.getDefaultTool(userId) ||
      this.config.defaultTool;
    const prompt = parsed.prompt || text;

    if (!this.registry.isAvailable(tool)) {
      const available = this.registry.getAvailableNames().join(', ');
      await this.ilink.sendText(
        userId,
        `工具 "${tool}" 不可用\n可用: ${available}`,
      );
      return;
    }

    await this.executeAndReply(userId, tool, prompt);
  }

  // ─── Commands ──────────────────────────────────────────

  private async handleCommand(
    userId: string,
    command: string,
    args: string,
  ): Promise<void> {
    switch (command) {
      case 'help':
      case 'h': {
        const available = this.registry.getAvailableNames();
        const def =
          this.sessions.getDefaultTool(userId) || this.config.defaultTool;
        await this.ilink.sendText(
          userId,
          [
            'WX AI Bridge',
            '',
            '直接输入文字 → 发送给默认工具',
            '@claude <消息> → Claude Code',
            '@codex <消息> → Codex CLI',
            '@gemini <消息> → Gemini CLI',
            '@aider <消息> → Aider',
            '',
            '/switch <工具> — 切换默认工具',
            '/tools — 查看可用工具',
            '/status — 当前状态',
            '/new — 新会话',
            '/cancel — 取消当前任务',
            '/help — 帮助',
            '',
            `默认: ${def} | 可用: ${available.join(', ')}`,
          ].join('\n'),
        );
        break;
      }

      case 'switch':
      case 'sw': {
        const tool = args.toLowerCase().trim();
        if (!tool) {
          await this.ilink.sendText(userId, '用法: /switch claude');
          return;
        }
        if (!this.registry.isAvailable(tool)) {
          const available = this.registry.getAvailableNames().join(', ');
          await this.ilink.sendText(
            userId,
            `"${tool}" 不可用\n可用: ${available}`,
          );
          return;
        }
        this.sessions.setDefaultTool(userId, tool);
        await this.ilink.sendText(userId, `已切换默认工具: ${tool}`);
        break;
      }

      case 'tools': {
        const lines = this.registry.getAll().map((a) => {
          const ok = this.registry.isAvailable(a.name) ? '●' : '○';
          return `${ok} ${a.displayName} (${a.name})`;
        });
        await this.ilink.sendText(userId, lines.join('\n'));
        break;
      }

      case 'status': {
        const def =
          this.sessions.getDefaultTool(userId) || this.config.defaultTool;
        const state = this.sessions.getState(userId);
        const busy = this.activeTasks.get(userId);
        await this.ilink.sendText(
          userId,
          [
            `默认工具: ${def}`,
            `当前会话: ${state.tool || '无'} ${state.sessionId ? `(${state.sessionId.substring(0, 8)}...)` : ''}`,
            `处理中: ${busy ? `${busy.tool} 运行中` : '空闲'}`,
          ].join('\n'),
        );
        break;
      }

      case 'new': {
        this.sessions.clearSession(userId);
        await this.ilink.sendText(userId, '已开始新会话');
        break;
      }

      case 'cancel': {
        const task = this.activeTasks.get(userId);
        if (task) {
          task.abort.abort();
          this.activeTasks.delete(userId);
          await this.ilink.sendText(userId, `已取消 ${task.tool} 任务`);
        } else {
          await this.ilink.sendText(userId, '当前没有运行中的任务');
        }
        break;
      }

      default:
        await this.ilink.sendText(
          userId,
          `未知命令: /${command}\n发送 /help 查看帮助`,
        );
    }
  }

  // ─── Execute CLI and reply ─────────────────────────────

  private async executeAndReply(
    userId: string,
    toolName: string,
    prompt: string,
  ): Promise<void> {
    const adapter = this.registry.get(toolName);
    if (!adapter) return;

    const abort = new AbortController();
    this.activeTasks.set(userId, { abort, tool: toolName });

    const stopTyping = await this.ilink.startTyping(userId);
    const startTime = Date.now();

    try {
      const sessionId = adapter.capabilities.sessionResume
        ? this.sessions.getSessionId(userId, toolName)
        : undefined;

      const toolConfig = this.config.tools[toolName];

      const result = await adapter.execute(prompt, {
        sessionId,
        workDir: this.config.workDir,
        timeout: this.config.cliTimeout,
        extraArgs: toolConfig?.args,
        signal: abort.signal,
      });

      // Don't send if cancelled
      if (abort.signal.aborted) return;

      const elapsed = Date.now() - startTime;

      // Save session for resume
      if (result.sessionId && adapter.capabilities.sessionResume) {
        this.sessions.setSessionId(userId, toolName, result.sessionId);
      }

      const response = formatResponse(result.text, {
        tool: adapter.displayName,
        duration: result.duration || elapsed,
        cost: result.cost,
        error: result.error,
      });

      await this.ilink.sendText(userId, response);
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        log.error(`[${toolName}] 执行失败:`, err);
        await this.ilink.sendText(
          userId,
          `执行失败: ${(err as Error).message || '未知错误'}`,
        );
      }
    } finally {
      stopTyping();
      this.activeTasks.delete(userId);
    }
  }
}
