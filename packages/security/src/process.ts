import { spawn } from 'node:child_process';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { safePath, SecurityError } from './paths.js';
import { sanitize } from './redact.js';

export interface SafeCommand {
  executable: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  executable: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'unavailable' | 'timed_out' | 'cancelled' | 'rejected';
  timedOut: boolean;
  outputTruncated: boolean;
  error?: string;
}

const envKeys = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']);
export function commandEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => envKeys.has(key.toUpperCase()))), CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
}

export function validateCommand(command: SafeCommand): void {
  if (!command.executable || command.executable.includes('\0') || /[\r\n]/u.test(command.executable) || !Array.isArray(command.args ?? []) || command.args?.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new SecurityError('INVALID_COMMAND', 'A command requires an executable and a string argument array.');
  }
  const base = path.basename(command.executable).toLowerCase();
  if (/^(?:ba|da|z|k|fi|c|tc)?sh(?:\.exe)?$/u.test(base) || /^(?:cmd|powershell|pwsh)(?:\.exe)?$/u.test(base) || /\.(?:bat|cmd|ps1)$/u.test(base)) {
    throw new SecurityError('SHELL_FORBIDDEN', 'Shell executables and shell command wrappers are not permitted; configure a native executable and arguments.');
  }
  if (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3_600_000)) {
    throw new SecurityError('INVALID_TIMEOUT', 'Command timeout must be between 1 and 3600000 milliseconds.');
  }
  if (command.maxOutputBytes !== undefined && (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1 || command.maxOutputBytes > 16_777_216)) {
    throw new SecurityError('INVALID_OUTPUT_LIMIT', 'Output limit must be between 1 byte and 16 MiB.');
  }
}

/** Execute approved code with bounded I/O. This is process hygiene, not a sandbox. */
export async function runSafeCommand(workspace: string, command: SafeCommand, options: { signal?: AbortSignal } = {}): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const base = { executable: command.executable, args: command.args ?? [], ...(command.cwd === undefined ? {} : { cwd: command.cwd }), exitCode: null, stdout: '', stderr: '', startedAt, timedOut: false, outputTruncated: false };
  let cwd: string;
  let executable = command.executable;
  try {
    validateCommand(command);
    cwd = await safePath(workspace, command.cwd ?? '.');
    if (!(await stat(cwd)).isDirectory()) throw new SecurityError('INVALID_CWD', 'Command working directory must be a directory.');
    // Relative executable paths resolve against cwd and cannot escape the workspace.
    if (!path.isAbsolute(executable) && /[\\/]/u.test(executable)) {
      executable = await safePath(workspace, path.relative(await realpath(workspace), path.resolve(cwd, executable)));
    }
  } catch (error) {
    return sanitize({ ...base, status: 'rejected', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
  }
  if (options.signal?.aborted) return sanitize({ ...base, status: 'cancelled', error: 'Execution cancelled before starting.', finishedAt: new Date().toISOString() });
  return new Promise<CommandResult>((resolve) => {
    const maxBytes = command.maxOutputBytes ?? 65_536;
    const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let captured = 0;
    let outputTruncated = false;
    let state: CommandResult['status'] = 'completed';
    let errorMessage: string | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const launch = () => spawn(executable, command.args ?? [], { cwd, env: commandEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let child: ReturnType<typeof launch>;
    try { child = launch(); } catch (error) {
      resolve(sanitize({ ...base, status: 'unavailable', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }));
      return;
    }

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errorMessage ??= 'Unable to terminate the complete process group.';
      }
    };
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      options.signal?.removeEventListener('abort', cancel);
      // A leader can exit while leaving descendants alive or holding stdio open.
      killGroup('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(sanitize({ ...base, exitCode, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), status: state, timedOut: state === 'timed_out', outputTruncated, ...(errorMessage === undefined ? {} : { error: errorMessage }), finishedAt: new Date().toISOString() }));
    };
    const stop = (reason: 'timed_out' | 'cancelled'): void => {
      if (settled || state === 'timed_out' || state === 'cancelled') return;
      state = reason;
      errorMessage = reason === 'timed_out' ? 'Command exceeded its approved timeout.' : 'Execution cancelled.';
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 150);
      finalTimer = setTimeout(() => finish(child.exitCode), 1_000);
    };
    const cancel = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timed_out'), command.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        const remaining = Math.max(0, maxBytes - captured);
        if (chunk.length > remaining) outputTruncated = true;
        if (remaining > 0) {
          const piece = chunk.subarray(0, remaining);
          output[stream].push(piece);
          captured += piece.length;
        }
      });
    }
    child.once('error', (error) => {
      state = 'unavailable';
      errorMessage = error.message;
      finish(null);
    });
    child.once('exit', () => {
      killGroup('SIGKILL');
      if (!finalTimer) finalTimer = setTimeout(() => finish(child.exitCode), 250);
    });
    child.once('close', (code) => finish(code));
  });
}
