import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionsDir } from '../config.js';

interface SessionState {
  userId: string;
  tool: string;
  sessionId?: string;
  defaultTool: string;
  lastActive: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  constructor() {
    this.load();
  }

  getState(userId: string): SessionState {
    let state = this.sessions.get(userId);
    if (!state) {
      state = {
        userId,
        tool: '',
        defaultTool: '',
        lastActive: Date.now(),
      };
      this.sessions.set(userId, state);
    }
    return state;
  }

  setDefaultTool(userId: string, tool: string): void {
    const state = this.getState(userId);
    state.defaultTool = tool;
    this.save();
  }

  getDefaultTool(userId: string): string {
    return this.getState(userId).defaultTool;
  }

  setSessionId(userId: string, tool: string, sessionId: string): void {
    const state = this.getState(userId);
    state.tool = tool;
    state.sessionId = sessionId;
    state.lastActive = Date.now();
    this.save();
  }

  getSessionId(userId: string, tool: string): string | undefined {
    const state = this.getState(userId);
    if (state.tool === tool) return state.sessionId;
    return undefined;
  }

  clearSession(userId: string): void {
    const state = this.getState(userId);
    state.sessionId = undefined;
    state.tool = '';
    this.save();
  }

  // ─── Persistence ───────────────────────────────────────

  private filePath(): string {
    return join(getSessionsDir(), 'sessions.json');
  }

  private load(): void {
    const p = this.filePath();
    if (!existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      for (const [key, val] of Object.entries(raw)) {
        this.sessions.set(key, val as SessionState);
      }
    } catch {
      // corrupted file, start fresh
    }
  }

  private save(): void {
    const data: Record<string, SessionState> = {};
    for (const [key, val] of this.sessions) {
      data[key] = val;
    }
    try {
      writeFileSync(this.filePath(), JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
    } catch {
      // ignore write errors
    }
  }
}
