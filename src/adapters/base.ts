// ─── Mode & Settings ───────────────────────────────────────

export type ToolMode = 'auto' | 'safe' | 'plan';
export type EffortLevel = 'min' | 'low' | 'medium' | 'high' | 'max';

export interface UserSettings {
  mode: ToolMode;
  effort: EffortLevel;
  model: string;
  maxTurns: number;
  maxBudget: number;       // USD, 0 = unlimited (Claude only)
  search: boolean;         // web search (Codex only)
  defaultTool: string;
  sessionIds: Record<string, string>;
}

export const DEFAULT_SETTINGS: UserSettings = {
  mode: 'auto',
  effort: 'high',
  model: '',
  maxTurns: 30,
  maxBudget: 0,
  search: false,
  defaultTool: '',
  sessionIds: {},
};

// ─── Adapter interface ─────────────────────────────────────

export interface ExecOptions {
  settings: UserSettings;
  workDir?: string;
  timeout?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
}

export interface ExecResult {
  text: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  error?: boolean;
}

export interface AdapterCapabilities {
  streaming: boolean;
  jsonOutput: boolean;
  sessionResume: boolean;
  modes: ToolMode[];
  hasEffort: boolean;
  hasModel: boolean;
  hasSearch: boolean;
  hasBudget: boolean;
}

export interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities;

  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts: ExecOptions): Promise<ExecResult>;
}
