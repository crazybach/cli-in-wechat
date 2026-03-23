export interface ExecOptions {
  sessionId?: string;
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
}

export interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities;

  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts?: ExecOptions): Promise<ExecResult>;
}
