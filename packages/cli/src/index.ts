#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { RelayStore } from '../../storage/src/index.js';
import { RelayService } from '../../workflows/src/index.js';
import { CreateWorkInputSchema, type CreateWorkInput } from '../../contracts/src/index.js';
import { safePath, sanitize } from '../../security/src/index.js';
import { connectClients, type ClientName } from './integrations.js';
import { doctor } from './doctor.js';
import packageJson from '../../../package.json' with { type: 'json' };

const program = new Command().name('proofrelay').version(packageJson.version)
  .description('Local work contracts, agent continuity, and independent verification.')
  .option('--workspace <path>', 'repository directory', process.cwd())
  .option('--json', 'machine-readable JSON output')
  .option('--read-only', 'reject state-changing operations');
const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const serverPath = existsSync(join(bundleDirectory, 'mcp.js')) ? join(bundleDirectory, 'mcp.js') : resolve(bundleDirectory, '../../../dist/mcp.js');
const workspace = () => resolve(program.opts<{ workspace: string }>().workspace);
const output = (value: unknown, revealClaimToken = false) => {
  const clean = sanitize(value);
  if (revealClaimToken && value && clean && typeof value === 'object' && typeof clean === 'object' && 'lease' in value && 'lease' in clean) {
    const source = value.lease as { token?: string } | null;
    const target = clean.lease as { token?: string } | null;
    if (source?.token && target) target.token = source.token;
  }
  if (program.opts().json || typeof clean !== 'string') console.log(JSON.stringify(clean, null, program.opts().json ? undefined : 2));
  else console.log(clean);
};
const writable = () => { if (program.opts().readOnly) throw new Error('This command changes state and is unavailable with --read-only.'); };
async function withStore<T>(fn: (store: RelayStore, relay: RelayService) => T | Promise<T>, mutate = false): Promise<T> {
  if (mutate) writable();
  if (!existsSync(join(workspace(), '.proofrelay', 'state.sqlite'))) throw new Error('Workspace is not initialized. Run proofrelay init.');
  const store = new RelayStore(workspace(), { readOnly: !!program.opts().readOnly });
  try { return await fn(store, new RelayService(workspace(), store)); }
  finally { store.close(); }
}
async function readContract(path: string): Promise<CreateWorkInput> {
  const safe = await safePath(workspace(), path);
  return CreateWorkInputSchema.parse(JSON.parse(await readFile(safe, 'utf8')));
}

program.command('init').description('Initialize private SQLite state and ignore it in Git').option('--dry-run', 'preview only').action(async (options: { dryRun?: boolean }) => {
  const root = await realpath(workspace());
  if (options.dryRun) return output({ workspace: root, changes: ['Create .proofrelay/state.sqlite if absent', 'Append .proofrelay/ to .gitignore if absent'] });
  writable();
  const ignore = await safePath(root, '.gitignore', { allowMissing: true });
  let previous = '';
  try { previous = await readFile(ignore, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!previous.split(/\r?\n/).some(line => line.trim() === '.proofrelay/' || line.trim() === '/.proofrelay/')) {
    await appendFile(ignore, `${previous && !previous.endsWith('\n') ? '\n' : ''}.proofrelay/\n`);
  }
  const store = new RelayStore(root);
  store.close();
  output({ initialized: true, workspace: root, database: join(root, '.proofrelay', 'state.sqlite'), next: 'proofrelay connect --clients claude,codex --dry-run' });
});

for (const name of ['connect', 'uninstall']) {
  program.command(name).description(name === 'connect' ? 'Configure supported MCP clients, preserving unrelated settings' : 'Remove matching ProofRelay MCP entries')
    .option('--clients <names>', 'comma-separated claude,codex', 'claude,codex')
    .option('--scope <scope>', 'project (default) or explicit user scope', 'project')
    .option('--dry-run', 'show proposed changes without writing')
    .action(async (options: { clients: string; scope: string; dryRun?: boolean }) => {
      if (!options.dryRun) writable();
      if (options.scope !== 'project' && options.scope !== 'user') throw new Error('--scope must be project or user.');
      if (name === 'connect' && !options.dryRun && !existsSync(join(workspace(), '.proofrelay', 'state.sqlite'))) throw new Error('Run proofrelay init first so local state and configuration backups remain ignored.');
      output(await connectClients({ workspace: workspace(), clients: options.clients.split(',') as ClientName[], scope: options.scope, dryRun: options.dryRun, uninstall: name === 'uninstall', serverPath }));
    });
}
program.command('doctor').description('Check providers and invoke a real MCP tool over STDIO').action(async () => {
  const result = await doctor(workspace(), serverPath);
  output(result);
  if (!result.mcp.ok) process.exitCode = 1;
});

const task = program.command('task').description('Create and inspect work contracts');
task.command('add').argument('[objective]', 'natural-language objective (creates a draft)').option('--contract <file>', 'structured contract JSON inside the workspace').option('--key <key>', 'idempotency key').action(async (objective: string | undefined, options: { contract?: string; key?: string }) => {
  const input = options.contract ? await readContract(options.contract) : { objective: objective ?? '' };
  output(await withStore((_store, relay) => relay.createWork(input, options.key), true));
});
task.command('show <id>').action(async (id: string) => output(await withStore(store => store.getWork(id))));
task.command('update <id>').requiredOption('--contract <file>', 'replacement contract JSON; invalidates approvals').action(async (id: string, options: { contract: string }) => {
  const input = await readContract(options.contract);
  output(await withStore(store => store.updateContract(id, input), true));
});
program.command('tasks').description('List durable task state').action(async () => output(await withStore(store => store.listWorks().map(work => ({ id: work.contract.id, objective: work.contract.objective, state: work.state, attempts: work.attempts })))));
program.command('status').action(async () => output(await withStore(store => store.getStatus())));
program.command('claim <id>').requiredOption('--agent <agent>', 'agent name').option('--lease-ms <ms>', 'lease duration', '300000').option('--key <key>', 'idempotency key').action(async (id: string, options: { agent: string; leaseMs: string; key?: string }) => output(await withStore(store => store.claimTask(id, options.agent, { leaseMs: Number(options.leaseMs), idempotencyKey: options.key }), true), true));
program.command('checkpoint <id>').requiredOption('--agent <agent>', 'agent name').requiredOption('--summary <text>', 'progress summary').option('--next <steps...>', 'next recommended steps').option('--files <paths...>', 'relative artifact paths').option('--token <token>', 'claim lease token').action(async (id: string, options: { agent: string; summary: string; next?: string[]; files?: string[]; token?: string }) => output(await withStore(store => store.checkpoint(id, { agent: options.agent, summary: options.summary, nextSteps: options.next, files: options.files }, options.token), true)));
program.command('decision <id>').requiredOption('--agent <agent>', 'agent name').requiredOption('--text <text>', 'decision with rationale').action(async (id: string, options: { agent: string; text: string }) => output(await withStore(store => store.recordDecision(id, options), true)));
program.command('submit <id>').requiredOption('--agent <agent>', 'agent name').requiredOption('--summary <text>', 'result summary').requiredOption('--token <token>', 'lease token').action(async (id: string, options: { agent: string; summary: string; token: string }) => output(await withStore(store => store.submitResult(id, { agent: options.agent, summary: options.summary, leaseToken: options.token }), true)));
program.command('release <id>').requiredOption('--token <token>', 'lease token').action(async (id: string, options: { token: string }) => output(await withStore(store => store.releaseTask(id, options.token), true)));
program.command('retry <id>').description('Requeue failed work within its retry budget and backoff').action(async (id: string) => output(await withStore(store => store.retryTask(id), true)));
program.command('cancel <id>').description('Cancel local orchestration; cannot stop a host assistant').action(async (id: string) => output(await withStore(store => store.cancelTask(id), true)));
program.command('recover').description('Fence expired leases and preserve interrupted work for continuation').action(async () => output(await withStore(store => store.reapExpiredLeases(), true)));

program.command('request-approval <taskId>').option('--kind <kind>', 'execution or human_review', 'execution').action(async (id: string, options: { kind: string }) => {
  if (options.kind !== 'execution' && options.kind !== 'human_review') throw new Error('Invalid approval kind.');
  const kind = options.kind;
  output(await withStore(store => store.requestApproval(id, kind), true));
});
program.command('approve <approvalId>').description('Review and approve an exact contract from your interactive terminal').action(async (id: string) => {
  writable();
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Approval requires a human interactive terminal. There is no --yes flag or MCP approval tool.');
  await withStore(async store => {
    const approval = store.getApproval(id);
    const work = store.getWork(approval.taskId);
    // Exact executable/argv must be visible to the human approver. JSON escapes terminal controls.
    console.log(JSON.stringify({ approval, contract: work.contract }, null, 2));
    console.log('These project commands can execute code with your user permissions. Review executable paths, arguments, referenced scripts, and scope.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const expected = `approve ${approval.contractDigest.slice(0, 12)}`;
      const answer = await rl.question(`Type "${expected}" to approve this version: `);
      if (answer.trim() !== expected) throw new Error('Approval was not granted.');
      output(store.approve(id));
    } finally { rl.close(); }
  }, true);
});

program.command('verify <id>').description('Execute human-approved checks and issue an observed receipt').option('--token <token>', 'lease token, required while claimed').option('--dry-run', 'inspect approved commands without running them').action(async (id: string, options: { token?: string; dryRun?: boolean }) => {
  if (options.dryRun) return output(await withStore(store => ({ commands: store.getWork(id).contract.commands, approved: store.hasApproval(id, 'execution') })));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const receipt = await withStore((_store, relay) => relay.verify(id, { leaseToken: options.token, signal: controller.signal }), true);
    output(receipt);
    if (receipt.status !== 'pass') process.exitCode = receipt.status === 'fail' ? 1 : 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
});
program.command('handoff').requiredOption('--task <id>', 'task ID').option('--agent <agent>', 'agent attribution', 'human').option('--max-bytes <bytes>', 'maximum JSON context bytes', '32768').option('--out <relative-base>', 'explicitly export .json and .md files; never overwrite').action(async (options: { task: string; agent: string; maxBytes: string; out?: string }) => {
  output(await withStore(async (_store, relay) => {
    const handoff = await relay.createHandoff(options.task, options.agent, Number(options.maxBytes));
    return options.out ? { handoff, exports: await relay.exportHandoff(handoff, options.out) } : handoff;
  }, true));
});
program.command('get-handoff <id>').action(async (id: string) => output(await withStore((_store, relay) => relay.getHandoff(id))));
program.command('export').requiredOption('--out <file>', 'workspace-relative portable JSON destination').action(async (options: { out: string }) => {
  const path = await safePath(workspace(), options.out, { allowMissing: true });
  const data = await withStore(store => store.exportState());
  writable();
  await writeFile(path, JSON.stringify(sanitize(data), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  output({ exported: path });
});
program.command('import <file>').description('Import portable work as unapproved drafts, never trusting imported approvals').action(async (file: string) => {
  const path = await safePath(workspace(), file);
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  output(await withStore(store => store.importState(data), true));
});

try { await program.parseAsync(); }
catch (error) {
  const result = sanitize({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? 'RELAY_ERROR' });
  console.error(program.opts().json ? JSON.stringify(result) : `ProofRelay: ${result.error}`);
  process.exitCode = 1;
}
