import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore } from '../../packages/storage/src/index.js';
import { RelayService } from '../../packages/workflows/src/index.js';
import type { HandoffPackage, WorkRecord, VerificationReceipt } from '../../packages/contracts/src/index.js';

const exec = promisify(execFile);
const roots: string[] = [];
const clients: Client[] = [];
const cliPath = fileURLToPath(new URL('../../packages/cli/src/index.ts', import.meta.url));
const serverPath = fileURLToPath(new URL('../../packages/mcp-server/src/index.ts', import.meta.url));
async function cli(root: string, ...args: string[]) {
  const result = await exec(process.execPath, ['--import', 'tsx', cliPath, '--workspace', root, '--json', ...args]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'proofrelay-e2e-'));
  roots.push(root);
  await cli(root, 'init');
  return root;
}
async function client(root: string, readOnly = false) {
  const c = new Client({ name: `fixture-${clients.length}`, version: '1.0.0' });
  clients.push(c);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', serverPath, '--workspace', root, ...(readOnly ? ['--read-only'] : [])], stderr: 'pipe' }));
  return c;
}
async function tool<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await c.callTool({ name, arguments: args });
  if (!Array.isArray(response.content)) throw new Error('Missing MCP content');
  const item = response.content[0] as { text?: string };
  const value = JSON.parse(item.text ?? '{}') as T;
  if (response.isError) throw new Error(JSON.stringify(value));
  return value;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CLI and real MCP STDIO interoperability', () => {
  it('creates through CLI; Claude checkpoints; a fresh Codex client continues the same durable work (B/H)', async () => {
    const root = await workspace();
    const created = await cli(root, 'task', 'add', 'Implement the fixture') as unknown as WorkRecord;
    const claude = await client(root);
    const listed = await claude.listTools();
    expect(listed.tools.map(t => t.name)).toContain('relay_verify_work');
    expect(listed.tools.map(t => t.name)).not.toContain('relay_approve');
    expect((await tool<WorkRecord>(claude, 'relay_get_work', { taskId: created.contract.id })).contract.objective).toBe('Implement the fixture');
    await tool(claude, 'relay_checkpoint', { taskId: created.contract.id, checkpoint: { agent: 'claude', summary: 'Implementation started', nextSteps: ['Add a failing regression test'] } });
    await tool(claude, 'relay_record_decision', { taskId: created.contract.id, agent: 'claude', text: 'Use SQLite transactions' });
    const handoff = await tool<HandoffPackage>(claude, 'relay_create_handoff', { taskId: created.contract.id, agent: 'claude' });
    await claude.close();
    const codex = await client(root);
    const continuation = await tool<{ handoff: HandoffPackage; stale: boolean }>(codex, 'relay_get_handoff', { handoffId: handoff.id });
    expect(continuation.stale).toBe(false);
    expect(continuation.handoff.nextSteps).toEqual(['Add a failing regression test']);
    expect(continuation.handoff.decisions[0]?.text).toBe('Use SQLite transactions');
    const shown = await cli(root, 'task', 'show', created.contract.id) as unknown as WorkRecord;
    expect(shown.checkpoint?.agent).toBe('claude');
    await writeFile(join(root, 'changed.ts'), 'export const changed = true;\n');
    expect((await tool<{ stale: boolean }>(codex, 'relay_get_handoff', { handoffId: handoff.id })).stale).toBe(true);
  });

  it('does not trust claimed success, executes approved checks, and persists failure (C)', async () => {
    const root = await workspace();
    await writeFile(join(root, 'check.cjs'), 'process.stderr.write("actual failure\\n"); process.exit(7);');
    await writeFile(join(root, 'contract.json'), JSON.stringify({ objective: 'Fix the failing project', commands: [{ id: 'test', executable: process.execPath, args: ['check.cjs'] }], criteria: [{ id: 'passes', description: 'Check exits zero', commandIds: ['test'] }] }));
    const created = await cli(root, 'task', 'add', '--contract', 'contract.json') as unknown as WorkRecord;
    const c = await client(root);
    await expect(tool(c, 'relay_verify_work', { taskId: created.contract.id })).rejects.toThrow(/approval/i);
    // Trusted test fixture grants approval through the local library, never MCP.
    const store = new RelayStore(root);
    store.approve(created.approval!.id);
    store.close();
    const claimed = await tool<WorkRecord>(c, 'relay_claim_task', { taskId: created.contract.id, agent: 'codex' });
    expect(claimed.lease?.token).toMatch(/^[0-9a-f-]{36}$/);
    const read = await tool<WorkRecord>(c, 'relay_get_work', { taskId: created.contract.id });
    expect(read.lease?.token).not.toBe(claimed.lease?.token);
    const submitted = await tool<WorkRecord>(c, 'relay_submit_result', { taskId: created.contract.id, agent: 'codex', summary: 'All done and all tests pass', leaseToken: claimed.lease!.token });
    expect(submitted.state).not.toBe('passed');
    const receipt = await tool<VerificationReceipt>(c, 'relay_verify_work', { taskId: created.contract.id, leaseToken: claimed.lease!.token });
    expect(receipt.status).toBe('fail');
    expect(receipt.commands[0]?.exitCode).toBe(7);
    expect(receipt.commands[0]?.stderr).toContain('actual failure');
    expect((await tool<WorkRecord>(c, 'relay_get_work', { taskId: created.contract.id })).state).toBe('failed');
  });

  it('passes real configured checks and refuses MCP writes on a read-only server', async () => {
    const root = await workspace();
    const store = new RelayStore(root);
    const relay = new RelayService(root, store);
    const work = await relay.createWork({ objective: 'Observe successful Node command', commands: [{ id: 'node', executable: process.execPath, args: ['-e', 'console.log("observed success")'] }], criteria: [{ id: 'ok', description: 'Exit zero', commandIds: ['node'] }] });
    store.approve(work.approval!.id);
    store.close();
    const c = await client(root);
    const receipt = await tool<VerificationReceipt>(c, 'relay_verify_work', { taskId: work.contract.id });
    expect(receipt.status).toBe('pass');
    expect(receipt.commands[0]?.stdout).toContain('observed success');
    const reader = await client(root, true);
    expect((await tool<WorkRecord>(reader, 'relay_get_work', { taskId: work.contract.id })).state).toBe('passed');
    await expect(tool(reader, 'relay_create_work', { contract: { objective: 'Forbidden write' } })).rejects.toThrow(/read-only/);
  });

  it('redacts secret notes, excludes sensitive artifacts, bounds context and never overwrites exports (F)', async () => {
    const root = await workspace();
    await writeFile(join(root, '.env'), 'API_KEY=private-secret');
    await writeFile(join(root, 'source.ts'), 'export const answer = 42;');
    const store = new RelayStore(root);
    try {
      const relay = new RelayService(root, store);
      const work = await relay.createWork({ objective: 'Continue securely' });
      store.checkpoint(work.contract.id, { agent: 'claude', summary: 'password=secret-value', files: ['.env', 'source.ts'], nextSteps: ['a'.repeat(20_000)] });
      const handoff = await relay.createHandoff(work.contract.id, 'claude', 2048);
      expect(Buffer.byteLength(JSON.stringify(handoff))).toBeLessThanOrEqual(2048);
      expect(JSON.stringify(handoff)).not.toContain('secret-value');
      expect(handoff.files).not.toContain('.env');
      const exported = await relay.exportHandoff(handoff, 'handoff');
      expect(await readFile(exported.markdownPath, 'utf8')).toContain('ProofRelay handoff');
      await expect(relay.exportHandoff(handoff, 'handoff')).rejects.toThrow();
    } finally { store.close(); }
  });

  it('rejects noninteractive approval, protecting the MCP-to-CLI approval boundary', async () => {
    const root = await workspace();
    const work = await cli(root, 'task', 'add', 'Draft') as unknown as WorkRecord;
    await expect(cli(root, 'approve', work.approval!.id)).rejects.toThrow(/human interactive terminal/);
    const shown = await cli(root, 'task', 'show', work.contract.id) as unknown as WorkRecord;
    expect(shown.approval?.status).toBe('pending');
  });

  it('survives an actually terminated claimant process and preserves unfinished work (D)', async () => {
    const root = await workspace();
    const store = new RelayStore(root);
    const work = store.createWork({ objective: 'Interrupted work', limits: { timeoutMs: 200, maxAttempts: 3 } });
    store.approve(work.approval!.id);
    store.close();
    const source = new URL('../../packages/storage/src/index.ts', import.meta.url).href;
    const code = `import { RelayStore } from ${JSON.stringify(source)}; const s = new RelayStore(process.argv[1]); const w = s.claimTask(process.argv[2], 'claude', {leaseMs:100}); s.checkpoint(w.contract.id, {agent:'claude',summary:'Durable before kill'}, w.lease.token); console.log('checkpointed'); setInterval(()=>{}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, root, work.contract.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');
    const reopened = new RelayStore(root, { now: () => Date.now() + 1000 });
    try {
      expect(reopened.getWork(work.contract.id).checkpoint?.summary).toBe('Durable before kill');
      expect(reopened.getWork(work.contract.id).receipts).toEqual([]);
      expect(reopened.getWork(work.contract.id).lease).toBeNull();
    } finally { reopened.close(); }
  });
});
