export type ToolMode = 'auto' | 'safe' | 'plan';

export interface UserSettings {
  // ── Universal ──
  defaultTool: string;
  mode: ToolMode;
  model: string;
  sessionIds: Record<string, string>;
  systemPrompt: string;
  workDir: string;

  // ── Claude Code ──
  effort: string;
  maxTurns: number;
  maxBudget: number;
  allowedTools: string;
  disallowedTools: string;
  verbose: boolean;
  bare: boolean;
  addDir: string;
  sessionName: string;

  // ── Codex ──
  sandbox: string;
  search: boolean;
  ephemeral: boolean;
  profile: string;

  // ── Gemini ──
  approvalMode: string;
  includeDirs: string;
  extensions: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultTool: '',
  mode: 'auto',
  model: '',
  sessionIds: {},
  systemPrompt: '',
  workDir: '',
  effort: 'high',
  maxTurns: 30,
  maxBudget: 0,
  allowedTools: '',
  disallowedTools: '',
  verbose: false,
  bare: false,
  addDir: '',
  sessionName: '',
  sandbox: '',
  search: false,
  ephemeral: false,
  profile: '',
  approvalMode: '',
  includeDirs: '',
  extensions: '',
};

export interface AskUserRequest {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface ExecOptions {
  settings: UserSettings;
  workDir?: string;
  timeout?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
  askUser?: (req: AskUserRequest) => Promise<Record<string, string>>;
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
