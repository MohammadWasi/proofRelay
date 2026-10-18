import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentAdapter, detectProvider, doctorProviders, parseProviderEvent, type Probe } from '../../packages/agent-adapters/src/index.js';

const supported: Probe = async (_executable, args) => ({ exitCode: 0, stderr: '', stdout:
  args.includes('--version') ? 'fixture 1.0.0' : args.includes('--help') ? 'status --json --sandbox read-only --cd --output-format stream-json --verbose --permission-mode --tools --strict-mcp-config --mcp-config --max-turns' : 'authenticated',
});
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'proofrelay-adapter-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('provider adapters', () => {
  it('diagnoses missing providers without requiring them for local operations', async () => {
    const missing: Probe = async () => ({ exitCode: null, stdout: '', stderr: '', errorCode: 'ENOENT' });
    const result = await doctorProviders({ probe: missing });
    expect(result).toHaveLength(2);
    expect(result.every((provider) => !provider.available && provider.message.includes('local ProofRelay operations remain available'))).toBe(true);
  });
  it('checks supported flags and authentication without invoking a model', async () => {
    const calls: string[][] = [];
    const result = await doctorProviders({ probe: async (executable, args) => { calls.push([executable, ...args]); return supported(executable, args); } });
    expect(result.every((provider) => provider.authentication === 'authenticated' && provider.structuredOutput)).toBe(true);
    expect(calls).toContainEqual(['codex', 'exec', '--help']);
    expect(calls).toContainEqual(['claude', 'auth', 'status']);
    expect(calls.every((args) => args.includes('--version') || args.includes('--help') || args.includes('status'))).toBe(true);
  });
  it('normalizes Codex JSONL, ignores unrecognized payloads and reports only observed usage', () => {
    expect(parseProviderEvent('codex', '{"type":"thread.started","thread_id":"thread-1"}')).toMatchObject({ kind: 'started', sessionId: 'thread-1' });
    expect(parseProviderEvent('codex', '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7}}')).toMatchObject({ kind: 'completed', usage: { inputTokens: 12, outputTokens: 7 } });
    expect(parseProviderEvent('codex', '{"type":"new.event","secret":"not-retained"}')).toMatchObject({ kind: 'provider_event' });
    expect(JSON.stringify(parseProviderEvent('codex', '{"type":"new.event","secret":"not-retained"}'))).not.toContain('not-retained');
    expect(() => parseProviderEvent('codex', 'all tests passed')).toThrow('non-JSON');
  });
  it('refuses an installed version that lacks required permission flags', async () => {
    const unsupported: Probe = async (_executable, args) => ({ exitCode: 0, stdout: args.includes('--help') ? '--json status' : 'fixture', stderr: '' });
    const result = await doctorProviders({ probe: unsupported });
    expect(result.every((provider) => provider.available && !provider.structuredOutput && !provider.readOnlyExecution)).toBe(true);
  });
  it('normalizes Claude success and error events and redacts message secrets', () => {
    expect(parseProviderEvent('claude', '{"type":"result","subtype":"success","total_cost_usd":0.123,"usage":{"input_tokens":4}}')).toMatchObject({ kind: 'completed', usage: { inputTokens: 4, reportedCostUsd: 0.123 } });
    expect(parseProviderEvent('claude', '{"type":"result","is_error":true}').kind).toBe('error');
    expect(parseProviderEvent('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"token=top-secret-value"}}').text).not.toContain('top-secret-value');
  });
  it('fails closed before launch without execution consent or Claude isolation support', async () => {
    const options = { execute: false, prompt: 'test', workspace: await fixture(), timeoutMs: 1000 };
    await expect(createAgentAdapter('codex').run(options)).rejects.toMatchObject({ code: 'EXECUTION_NOT_AUTHORIZED' });
    await expect(createAgentAdapter('claude').run({ ...options, execute: true })).rejects.toMatchObject({ code: 'ISOLATION_REQUIRED' });
  });
  it.skipIf(process.platform === 'win32')('streams real subprocess JSON events and preserves read-only flags with shell disabled', async () => {
    const calls: string[][] = [];
    const received: string[] = [];
    const adapter = createAgentAdapter('codex', { probe: supported, launch: (_executable, args, cwd) => {
      calls.push(args);
      return spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"thread.started",thread_id:"fixture"}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}));});'], { cwd, stdio: 'pipe', detached: process.platform !== 'win32', shell: false });
    } });
    const result = await adapter.run({ execute: true, workspace: await fixture(), prompt: 'test', timeoutMs: 2000 }, (event) => received.push(event.kind));
    expect(result.status).toBe('completed');
    expect(received).toEqual(['started', 'completed']);
    expect(calls[0]).toContain('read-only');
    expect(calls[0]).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it.skipIf(process.platform === 'win32').each(['timeout', 'abort', 'protocol'] as const)('stops a subprocess on %s and never marks it completed', async (mode) => {
    const controller = new AbortController();
    const adapter = createAgentAdapter('codex', { probe: supported, launch: (_executable, _args, cwd) => spawn(process.execPath, ['-e', mode === 'protocol' ? 'console.log("unstructured text");setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], { cwd, stdio: 'pipe', detached: process.platform !== 'win32', shell: false }) });
    if (mode === 'abort') setTimeout(() => controller.abort(), 100);
    const result = await adapter.run({ execute: true, workspace: await fixture(), prompt: 'test', timeoutMs: mode === 'timeout' ? 100 : 2000, signal: controller.signal });
    expect(result.status).toBe(mode === 'timeout' ? 'timed_out' : mode === 'abort' ? 'cancelled' : 'failed');
  });
  it.skipIf(process.platform === 'win32')('requires a completion event and a successful process exit', async () => {
    const adapter = createAgentAdapter('codex', { probe: supported, launch: (_executable, _args, cwd) => spawn(process.execPath, ['-e', 'console.log(JSON.stringify({type:"turn.completed"}));process.exitCode=1'], { cwd, stdio: 'pipe', detached: process.platform !== 'win32', shell: false }) });
    expect((await adapter.run({ execute: true, workspace: await fixture(), prompt: 'test', timeoutMs: 2000 })).status).toBe('failed');
  });
  it.runIf(process.env.PROOFRELAY_LIVE_CODEX === '1' && process.platform !== 'win32')('LIVE OPT-IN: invokes authenticated Codex in its read-only sandbox', async (context) => {
    const provider = await detectProvider('codex');
    if (!provider.available || !provider.structuredOutput || provider.authentication !== 'authenticated') context.skip();
    const workspace = await fixture();
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    const result = await createAgentAdapter('codex').run({ execute: true, workspace, prompt: 'Reply with exactly PROOFRELAY_SMOKE_OK. Do not invoke tools.', timeoutMs: 60_000 });
    expect(result.status).toBe('completed');
    expect(result.events.some((event) => event.kind === 'message' && event.text?.includes('PROOFRELAY_SMOKE_OK'))).toBe(true);
  }, 70_000);
});
