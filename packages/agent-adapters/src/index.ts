import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { sanitize } from '../../security/src/index.js';

export type ProviderName = 'claude' | 'codex';
export type Probe = (executable: string, args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string; errorCode?: string }>;
export interface ProviderDiagnostic {
  provider: ProviderName;
  available: boolean;
  version?: string;
  authentication: 'authenticated' | 'unauthenticated' | 'unknown';
  structuredOutput: boolean;
  readOnlyExecution: boolean;
  message: string;
}
export class AdapterError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AdapterError'; }
}

const defaultProbe: Probe = (executable, args) => new Promise((resolve) => {
  execFile(executable, args, { timeout: 1_500, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    resolve({ exitCode: error ? typeof code === 'number' ? code : null : 0, stdout, stderr,
      ...(typeof code === 'string' ? { errorCode: code } : {}) });
  });
});

const requiredFlags: Record<ProviderName, string[]> = {
  codex: ['--json', '--sandbox', 'read-only', '--cd'],
  claude: ['--output-format', 'stream-json', '--verbose', '--permission-mode', '--tools', '--strict-mcp-config', '--mcp-config', '--max-turns'],
};
export async function detectProvider(provider: ProviderName, probe: Probe = defaultProbe): Promise<ProviderDiagnostic> {
  const version = await probe(provider, ['--version']);
  if (version.exitCode !== 0) return {
    provider, available: false, authentication: 'unknown', structuredOutput: false, readOnlyExecution: false,
    message: `${provider} is unavailable on PATH. Install its official CLI to use this optional provider; local ProofRelay operations remain available.`,
  };
  const [help, authHelp] = await Promise.all([
    probe(provider, provider === 'codex' ? ['exec', '--help'] : ['--help']),
    probe(provider, provider === 'codex' ? ['login', '--help'] : ['auth', '--help']),
  ]);
  const auth = authHelp.exitCode === 0 && /\bstatus\b/.test(authHelp.stdout)
    ? await probe(provider, provider === 'codex' ? ['login', 'status'] : ['auth', 'status']) : null;
  const structuredOutput = help.exitCode === 0 && requiredFlags[provider].every((flag) => help.stdout.includes(flag));
  const authentication = auth === null || auth.errorCode ? 'unknown' : auth.exitCode === 0 ? 'authenticated' : 'unauthenticated';
  return {
    provider, available: true, version: version.stdout.trim().split('\n')[0]?.slice(0, 200) ?? 'unknown', authentication,
    structuredOutput, readOnlyExecution: structuredOutput && provider === 'codex',
    message: !structuredOutput ? 'Installed CLI lacks required structured-output or permission flags. Update the CLI before running.'
      : authentication !== 'authenticated' ? `Run ${provider === 'codex' ? 'codex login' : 'claude auth login'} yourself before optional execution.`
      : provider === 'claude' ? 'Structured events supported. Claude managed runs are disabled until an OS isolation backend is implemented.'
      : 'Supported JSONL and read-only sandbox flags detected. No model was invoked.',
  };
}
export async function doctorProviders(options: { probe?: Probe } = {}): Promise<ProviderDiagnostic[]> {
  return Promise.all((['claude', 'codex'] as const).map((provider) => detectProvider(provider, options.probe)));
}

export const AgentEventSchema = z.object({
  provider: z.enum(['claude', 'codex']), kind: z.enum(['started', 'message', 'tool', 'completed', 'error', 'usage', 'provider_event']),
  eventType: z.string(), at: z.string(), sessionId: z.string().optional(), text: z.string().optional(),
  usage: z.object({ inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(), reportedCostUsd: z.number().nonnegative().optional() }).optional(),
}).strict();
export type AgentEvent = z.infer<typeof AgentEventSchema>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
// Deliberately retain only normalized fields; complete raw events can contain secrets or command output.
const safeText = (value: string) => sanitize(value).slice(0, 16_384);

/** Parse supported JSON events only. Terminal prose is never treated as execution evidence. */
export function parseProviderEvent(provider: ProviderName, line: string): AgentEvent {
  let data: unknown;
  try { data = JSON.parse(line); } catch { throw new AdapterError('INVALID_EVENT', 'Provider emitted a non-JSON event.'); }
  if (!object(data) || typeof data.type !== 'string') throw new AdapterError('INVALID_EVENT', 'Provider event requires a string type.');
  const event: AgentEvent = { provider, kind: 'provider_event', eventType: data.type, at: new Date().toISOString() };
  if (provider === 'codex') {
    if (data.type === 'thread.started') { event.kind = 'started'; if (typeof data.thread_id === 'string') event.sessionId = data.thread_id; }
    if (data.type === 'turn.completed') { event.kind = 'completed'; }
    if (data.type === 'turn.failed' || data.type === 'error') {
      event.kind = 'error';
      if (typeof data.message === 'string') event.text = safeText(data.message);
      else if (object(data.error) && typeof data.error.message === 'string') event.text = safeText(data.error.message);
    }
    if (object(data.item)) {
      if (data.item.type === 'agent_message' && typeof data.item.text === 'string') { event.kind = 'message'; event.text = safeText(data.item.text); }
      else if (data.item.type === 'command_execution' || data.item.type === 'mcp_tool_call') event.kind = 'tool';
    }
  } else {
    if (data.type === 'system' && data.subtype === 'init') event.kind = 'started';
    if (typeof data.session_id === 'string') event.sessionId = data.session_id;
    if (data.type === 'result') {
      event.kind = data.is_error === true || (typeof data.subtype === 'string' && data.subtype !== 'success') ? 'error' : 'completed';
      if (typeof data.result === 'string') event.text = safeText(data.result);
    }
    if (data.type === 'assistant' && object(data.message) && Array.isArray(data.message.content)) {
      const text = data.message.content.filter(object).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
      if (text) { event.kind = 'message'; event.text = safeText(text); }
      else if (data.message.content.filter(object).some((part) => part.type === 'tool_use')) event.kind = 'tool';
    }
  }
  if (object(data.usage)) {
    event.usage = { inputTokens: count(data.usage.input_tokens), outputTokens: count(data.usage.output_tokens) };
  }
  if (provider === 'claude' && count(data.total_cost_usd) !== undefined) {
    event.usage = { ...event.usage, reportedCostUsd: count(data.total_cost_usd) };
  }
  return AgentEventSchema.parse(sanitize(event));
}

export interface AgentRunOptions {
  execute: boolean;
  workspace: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface AgentRunResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  exitCode: number | null;
  events: AgentEvent[];
  startedAt: string;
  finishedAt: string;
  error?: string;
}
export interface AgentAdapter {
  provider: ProviderName;
  detect(): Promise<ProviderDiagnostic>;
  run(options: AgentRunOptions, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
}
type Launch = (executable: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;
const launch: Launch = (executable, args, cwd) => spawn(executable, args, {
  cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});

/** Experimental read-only adapter; durable scheduling and write execution are a separate milestone. */
export function createAgentAdapter(provider: ProviderName, dependencies: { probe?: Probe; launch?: Launch } = {}): AgentAdapter {
  return {
    provider,
    detect: () => detectProvider(provider, dependencies.probe),
    async run(options, onEvent) {
      if (options.execute !== true) throw new AdapterError('EXECUTION_NOT_AUTHORIZED', 'Managed execution requires explicit execute: true from a trusted caller.');
      if (!options.prompt.trim() || options.prompt.length > 128_000) throw new AdapterError('INVALID_PROMPT', 'Prompt must contain 1–128000 characters.');
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000) throw new AdapterError('INVALID_TIMEOUT', 'Timeout must be between 1 and 3600000 ms.');
      if (process.platform === 'win32') throw new AdapterError('ISOLATION_REQUIRED', 'Native Windows managed execution is disabled until process-tree isolation is implemented; use WSL.');
      if (provider === 'claude') throw new AdapterError('ISOLATION_REQUIRED', 'Claude managed execution is disabled until an OS isolation backend is implemented. Tool restrictions alone are not a security sandbox.');
      const workspace = await realpath(options.workspace);
      if (!(await stat(workspace)).isDirectory()) throw new AdapterError('INVALID_WORKSPACE', 'Workspace must be a directory.');
      const diagnostic = await detectProvider(provider, dependencies.probe);
      if (!diagnostic.available || !diagnostic.structuredOutput || diagnostic.authentication !== 'authenticated') throw new AdapterError('PROVIDER_UNAVAILABLE', diagnostic.message);
      const startedAt = new Date().toISOString();
      if (options.signal?.aborted) return { status: 'cancelled', exitCode: null, events: [], startedAt, finishedAt: new Date().toISOString() };
      const args = ['exec', '--json', '--sandbox', 'read-only', '--cd', workspace, '-'];
      return new Promise<AgentRunResult>((resolve) => {
        const child = (dependencies.launch ?? launch)(provider, args, workspace);
        const events: AgentEvent[] = [];
        let pending = '';
        let byteCount = 0;
        let failed = false;
        let completed = false;
        let reason: AgentRunResult['status'] | undefined;
        let errorMessage: string | undefined;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch { /* Process has already exited. */ }
        };
        const stop = (status: AgentRunResult['status'], error?: string) => {
          if (reason) return;
          reason = status; errorMessage = error;
          kill('SIGTERM');
          forceTimer = setTimeout(() => kill('SIGKILL'), 500);
          forceTimer.unref();
        };
        const consume = (line: string) => {
          if (!line.trim() || reason) return;
          try {
            const event = parseProviderEvent(provider, line);
            events.push(event);
            if (event.kind === 'error') failed = true;
            if (event.kind === 'completed') completed = true;
            onEvent?.(event);
          } catch {
            stop('failed', 'Provider emitted invalid structured output or the event callback failed.');
          }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          byteCount += Buffer.byteLength(chunk);
          if (byteCount > 4 * 1024 * 1024 || events.length > 10_000) { stop('failed', 'Provider output exceeded the execution limit.'); return; }
          pending += chunk;
          const lines = pending.split('\n'); pending = lines.pop() ?? '';
          for (const line of lines) consume(line);
        });
        // Drain stderr without persisting arbitrary terminal prose or credential-bearing diagnostics.
        child.stderr.on('data', () => undefined);
        child.on('error', () => stop('failed', 'Provider process could not start.'));
        child.stdin.on('error', () => undefined);
        const cancel = () => stop('cancelled');
        options.signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => stop('timed_out'), options.timeoutMs);
        child.on('close', (exitCode) => {
          if (pending) consume(pending);
          clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
          options.signal?.removeEventListener('abort', cancel);
          // Reap any remaining members of our own process group; worktrees do not isolate processes.
          kill('SIGKILL');
          resolve({ status: reason ?? (exitCode === 0 && completed && !failed ? 'completed' : 'failed'), exitCode, events,
            startedAt, finishedAt: new Date().toISOString(), ...(errorMessage ? { error: errorMessage } : {}) });
        });
        child.stdin.end(options.prompt);
        if (options.signal?.aborted) cancel();
      });
    },
  };
}
