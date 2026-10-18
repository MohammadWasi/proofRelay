import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore } from '../../packages/storage/src/index.js';
import { RelayService } from '../../packages/workflows/src/index.js';
import type { WorkRecord } from '../../packages/contracts/src/index.js';

const roots: string[] = [];
const clients: Client[] = [];
const children = new Set<number>();
const serverPath = fileURLToPath(new URL('../../packages/mcp-server/src/index.ts', import.meta.url));

async function eventually<T>(observe: () => T | Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value: T;
  do {
    value = await observe();
    if (accepted(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error('Expected subprocess/receipt state was not observed within five seconds.');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proofrelay-mcp-cancel-'));
  roots.push(root);
  const store = new RelayStore(root);
  let taskId: string;
  try {
    const relay = new RelayService(root, store);
    const work = await relay.createWork({
      objective: 'Observe cancellation of an independently running check',
      commands: [{
        id: 'wait', executable: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(".proofrelay/child.pid", String(process.pid)); setInterval(() => {}, 1000);'],
        timeoutMs: 15_000,
      }],
      criteria: [{ id: 'check', description: 'Check completes successfully', commandIds: ['wait'] }],
      limits: { timeoutMs: 20_000, maxAttempts: 2 },
    });
    // Approval belongs to the trusted local test fixture, never an MCP tool.
    store.approve(work.approval!.id);
    taskId = work.contract.id;
  } finally { store.close(); }
  const client = new Client({ name: 'cancellation-fixture', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', serverPath, '--workspace', root], stderr: 'pipe',
  });
  await client.connect(transport);
  const started = async () => {
    const pid = await eventually(async () => {
      try { return Number(await readFile(join(root, '.proofrelay', 'child.pid'), 'utf8')); } catch { return 0; }
    }, (value) => Number.isSafeInteger(value) && value > 0);
    children.add(pid);
    return pid;
  };
  return { root, taskId, client, transport, started };
}

function readWork(root: string, taskId: string): WorkRecord {
  const store = new RelayStore(root, { readOnly: true });
  try { return store.getWork(taskId); }
  finally { store.close(); }
}

async function assertCancelled(root: string, taskId: string, pid: number) {
  const work = await eventually(() => readWork(root, taskId), (value) => value.receipts.length === 1);
  expect(work.state).toBe('blocked');
  expect(work.receipts).toHaveLength(1);
  expect(work.receipts[0]?.status).toBe('inconclusive');
  expect(work.receipts[0]?.commands[0]?.status).toBe('cancelled');
  expect(work.receipts[0]?.commands[0]?.exitCode).not.toBe(0);
  expect(work.lease).toBeNull();
  await eventually(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, Boolean);
  children.delete(pid);
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const pid of children) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* Already reaped. */ }
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('real MCP verification cancellation', () => {
  it('propagates client request cancellation, terminates the check, and persists an inconclusive receipt', async () => {
    const { root, taskId, client, started } = await fixture();
    const controller = new AbortController();
    const settled = client.callTool({ name: 'relay_verify_work', arguments: { taskId } }, { signal: controller.signal })
      .then(() => 'completed', () => 'cancelled');
    const pid = await started();
    controller.abort();
    expect(await settled).toBe('cancelled');
    await assertCancelled(root, taskId, pid);
    // Request cancellation does not tear down the still-usable coordination server.
    expect((await client.listTools()).tools.some((tool) => tool.name === 'relay_get_status')).toBe(true);
  });

  it('persists cancellation before closing SQLite when the STDIO client disconnects', async () => {
    const { root, taskId, client, started } = await fixture();
    const settled = client.callTool({ name: 'relay_verify_work', arguments: { taskId } })
      .then(() => 'completed', () => 'disconnected');
    const pid = await started();
    await client.close();
    expect(await settled).toBe('disconnected');
    await assertCancelled(root, taskId, pid);
  });

  it.skipIf(process.platform === 'win32')('drains active verification before the server exits on SIGTERM', async () => {
    const { root, taskId, client, transport, started } = await fixture();
    const settled = client.callTool({ name: 'relay_verify_work', arguments: { taskId } })
      .then(() => 'completed', () => 'disconnected');
    const pid = await started();
    expect(transport.pid).toBeGreaterThan(0);
    process.kill(transport.pid!, 'SIGTERM');
    expect(await settled).toBe('disconnected');
    await assertCancelled(root, taskId, pid);
  });
});
