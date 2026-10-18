import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contractDigest, type CreateWorkInput, type VerificationReceipt, type WorkRecord } from '../../packages/contracts/src/index.js';
import { RelayStore, type VerificationAttempt } from '../../packages/storage/src/index.js';
import { sanitize } from '../../packages/security/src/redact.js';

const paths: string[] = [];
const stores: RelayStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* Already closed by restart tests. */ } }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function workspace(): string { const path = mkdtempSync(join(tmpdir(), 'proofrelay-store-')); paths.push(path); return path; }
function open(path = workspace(), now?: () => number): RelayStore { const store = new RelayStore(path, now ? { now } : {}); stores.push(store); return store; }
function input(extra: Partial<CreateWorkInput> = {}): CreateWorkInput {
  return { objective: 'Validate a deterministic fixture', commands: [{ id: 'check', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
    criteria: [{ id: 'works', description: 'Fixture command exits successfully', commandIds: ['check'] }], ...extra };
}
function approved(store: RelayStore, extra: Partial<CreateWorkInput> = {}): WorkRecord {
  const work = store.createWork(input(extra));
  store.approve(work.approval!.id);
  return store.getWork(work.contract.id);
}
/** Fixture observations exercise persistence only; process execution is tested in verification tests. */
function receipt(attempt: VerificationAttempt, status: 'pass' | 'fail' = 'pass'): VerificationReceipt {
  const contract = attempt.work.contract;
  const at = new Date().toISOString();
  return { formatVersion: 1, id: randomUUID(), taskId: contract.id, contractVersion: contract.version,
    contractDigest: contractDigest(contract), attemptId: attempt.attemptId,
    repository: { diffFingerprint: 'fixture', beforeFingerprint: 'fixture', afterFingerprint: 'fixture' },
    criteria: contract.criteria.map(criterion => ({ id: criterion.id, status, commandIds: criterion.commandIds })),
    commands: contract.commands.map(command => ({ id: command.id, executable: command.executable, args: command.args,
      exitCode: status === 'pass' ? 0 : 1, stdout: '', stderr: '', status: 'completed', startedAt: at, finishedAt: at })),
    artifacts: [], startedAt: at, finishedAt: at, status, warnings: [] };
}

describe('durable SQLite coordination', () => {
  it('requires local approval and preserves decisions/checkpoints through restart', () => {
    const path = workspace();
    let store = open(path);
    const work = store.createWork(input(), 'create-once');
    expect(work.state).toBe('awaiting_approval');
    expect(() => store.claimTask(work.contract.id, 'claude')).toThrow();
    expect(store.createWork(input(), 'create-once').contract.id).toBe(work.contract.id);
    expect(() => store.createWork(input({ objective: 'Different' }), 'create-once')).toThrow(/different input/);
    store.approve(work.approval!.id);
    const claimed = store.claimTask(work.contract.id, 'claude');
    store.checkpoint(work.contract.id, { agent: 'claude', summary: 'Implementation unfinished', nextSteps: ['Add regression test'] }, claimed.lease!.token);
    store.recordDecision(work.contract.id, { agent: 'claude', text: 'Use durable SQLite transactions' });
    store.close();
    store = open(path);
    expect(store.getWork(work.contract.id).checkpoint?.nextSteps).toEqual(['Add regression test']);
    expect(store.getWork(work.contract.id).decisions[0]?.text).toContain('SQLite');
    expect(store.getWork(work.contract.id).state).toBe('running');
    expect(() => store.checkpoint(work.contract.id, { agent: 'codex', summary: 'Overwrite' })).toThrow(/lease token/);
  });

  it('fences expired agents, recovers checkpoints, and rejects stale idempotent claims', () => {
    let now = Date.now();
    const path = workspace();
    let store = open(path, () => now);
    const work = approved(store);
    const first = store.claimTask(work.contract.id, 'claude', { leaseMs: 100, idempotencyKey: 'first' });
    expect(store.claimTask(work.contract.id, 'claude', { leaseMs: 100, idempotencyKey: 'first' }).lease?.token).toBe(first.lease?.token);
    store.checkpoint(work.contract.id, { agent: 'claude', summary: 'Keep this interrupted work' }, first.lease!.token);
    store.close();
    now += 101;
    store = open(path, () => now);
    expect(store.getWork(work.contract.id).state).toBe('blocked');
    expect(store.getWork(work.contract.id).checkpoint?.summary).toContain('interrupted');
    expect(() => store.claimTask(work.contract.id, 'claude', { leaseMs: 100, idempotencyKey: 'first' })).toThrow(/lease token/);
    store.retryTask(work.contract.id);
    const second = store.claimTask(work.contract.id, 'codex');
    expect(second.lease!.fencingToken).toBe(first.lease!.fencingToken + 1);
    expect(() => store.submitResult(work.contract.id, { agent: 'claude', summary: 'Done', leaseToken: first.lease!.token })).toThrow(/lease token/);
  });

  it('rejects self-attested completion, permits only verifier capability, and deduplicates completion', () => {
    const store = open();
    const work = approved(store);
    const claim = store.claimTask(work.contract.id, 'codex');
    expect(store.submitResult(work.contract.id, { agent: 'codex', summary: 'Everything passed', leaseToken: claim.lease!.token }).state).not.toBe('passed');
    expect(() => store.startVerification(work.contract.id)).toThrow(/lease token/);
    const attempt = store.startVerification(work.contract.id, { agent: 'codex', leaseToken: claim.lease!.token });
    const result = receipt(attempt, 'fail');
    expect(() => store.finishVerification(result, 'forged-token')).toThrow(/capability/);
    expect(store.finishVerification(result, attempt.token).state).toBe('failed');
    expect(store.finishVerification(result, attempt.token).receipts).toHaveLength(1);
    expect(() => store.finishVerification({ ...result, status: 'pass' }, attempt.token)).toThrow(/already completed/);
  });

  it('will not accept a passing receipt with missing required checks or repository drift', () => {
    const store = open();
    const work = approved(store);
    const attempt = store.startVerification(work.contract.id);
    const observed = receipt(attempt);
    expect(() => store.finishVerification({ ...observed, commands: [] }, attempt.token)).toThrow(/did not complete/);
    expect(() => store.finishVerification({ ...observed, repository: { ...observed.repository, afterFingerprint: 'changed' } }, attempt.token)).toThrow(/stale/);
    expect(store.getWork(work.contract.id).state).toBe('verifying');
    expect(store.finishVerification(observed, attempt.token).state).toBe('passed');
  });

  it('compares sanitized command observations without requiring credential disclosure', () => {
    const store = open();
    const work = approved(store, { commands: [{ id: 'check', executable: process.execPath, args: ['-e', 'api_key=fixture-private-credential'] }] });
    const attempt = store.startVerification(work.contract.id);
    const observed = sanitize(receipt(attempt));
    expect(JSON.stringify(observed)).not.toContain('fixture-private-credential');
    expect(store.finishVerification(observed, attempt.token).state).toBe('passed');
  });

  it('invalidates approvals on edits and schedules dependencies only after verification passes', () => {
    const store = open();
    const first = approved(store);
    const second = approved(store, { dependencies: [first.contract.id] });
    expect(second.state).toBe('pending');
    expect(store.listReadyTasks().map(work => work.contract.id)).toEqual([first.contract.id]);
    expect(() => store.updateContract(first.contract.id, input({ dependencies: [second.contract.id] }))).toThrow(/cycle/);
    const attempt = store.startVerification(first.contract.id);
    store.finishVerification(receipt(attempt), attempt.token);
    expect(store.getWork(second.contract.id).state).toBe('ready');
    const changed = store.updateContract(second.contract.id, input({ objective: 'A changed exact contract', dependencies: [first.contract.id] }));
    expect(changed.contract.version).toBe(2);
    expect(changed.state).toBe('awaiting_approval');
    expect(() => store.approve(second.approval!.id)).toThrow(/older contract/);
  });

  it('enforces retry backoff and attempt budgets', () => {
    let now = Date.now();
    const store = open(workspace(), () => now);
    const work = approved(store, { limits: { maxAttempts: 1, timeoutMs: 1_000, retryBackoffMs: 50 } });
    const attempt = store.startVerification(work.contract.id);
    store.finishVerification(receipt(attempt, 'fail'), attempt.token);
    expect(() => store.retryTask(work.contract.id)).toThrow(/Retry is available/);
    now += 51;
    expect(() => store.retryTask(work.contract.id)).toThrow(/attempt limit/);
  });

  it('recovers an abandoned verification without minting completion evidence', () => {
    let now = Date.now();
    const path = workspace();
    let store = open(path, () => now);
    const work = approved(store, { limits: { timeoutMs: 10, maxAttempts: 3 } });
    const attempt = store.startVerification(work.contract.id);
    store.close();
    now += 5_011;
    store = open(path, () => now);
    expect(store.getWork(work.contract.id).state).toBe('blocked');
    expect(store.getWork(work.contract.id).receipts).toEqual([]);
    expect(() => store.finishVerification(receipt(attempt), attempt.token)).toThrow(/expired/);
  });

  it('imports portable work as untrusted drafts and redacts persisted secret-looking notes', () => {
    const source = open();
    const work = approved(source);
    source.checkpoint(work.contract.id, { agent: 'claude', summary: 'api_key=super-secret-value', facts: ['Bearer hidden-secret'] });
    source.recordDecision(work.contract.id, { agent: 'codex', text: 'password=private-value' });
    const exported = source.exportState();
    expect(JSON.stringify(exported)).not.toContain('super-secret-value');
    expect(JSON.stringify(exported)).not.toContain('private-value');
    const target = open();
    const imported = target.importState(exported)[0]!;
    expect(imported.state).toBe('awaiting_approval');
    expect(imported.approval?.status).toBe('pending');
    expect(imported.receipts).toEqual([]);
    expect(imported.decisions[0]?.text).toContain('[REDACTED]');
    expect(target.hasApproval(imported.contract.id)).toBe(false);
    expect(() => target.importState(exported)).toThrow(/already exists/);
    expect(target.listWorks()).toHaveLength(1);
  });

  it('keeps ownership capabilities out of portable exports and cancels outstanding approvals', () => {
    const store = open();
    const work = approved(store);
    const claim = store.claimTask(work.contract.id, 'codex');
    expect(JSON.stringify(store.exportState())).not.toContain(claim.lease!.token);
    store.requestApproval(work.contract.id, 'human_review');
    store.cancelTask(work.contract.id);
    expect(store.getStatus().pendingApprovals).toEqual([]);
    expect(() => store.startVerification(work.contract.id)).toThrow(/cancelled/);
  });

  it('supports read-only inspection and refuses symlink state directories', () => {
    const path = workspace();
    const store = open(path);
    const work = store.createWork(input());
    const reader = new RelayStore(path, { readOnly: true });
    stores.push(reader);
    expect(reader.getWork(work.contract.id).contract.objective).toContain('fixture');
    expect(() => reader.createWork(input())).toThrow(/read-only/);
    const other = workspace();
    symlinkSync(join(path, '.proofrelay'), join(other, '.proofrelay'), 'dir');
    expect(() => new RelayStore(other)).toThrow(/symlink/);
    const dangling = workspace();
    const initial = open(dangling);
    initial.close();
    rmSync(join(dangling, '.proofrelay', 'state.sqlite'));
    symlinkSync(join(path, 'outside-does-not-exist.db'), join(dangling, '.proofrelay', 'state.sqlite'));
    expect(() => new RelayStore(dangling)).toThrow(/symlink/);
  });

  it('serializes competing claims from two actual Node processes', async () => {
    const path = workspace();
    const store = open(path);
    const work = approved(store);
    const source = new URL('../../packages/storage/src/index.ts', import.meta.url).href;
    const children = ['claude', 'codex'].map(owner => {
      const code = `import { RelayStore } from ${JSON.stringify(source)};
        const store = new RelayStore(process.argv[1]);
        console.log('ready');
        process.stdin.once('data', () => {
          try { const w = store.claimTask(process.argv[2], process.argv[3]); console.log(JSON.stringify({ claimed: true, owner: w.lease.owner })); }
          catch (error) { console.log(JSON.stringify({ claimed: false, code: error.code })); }
          finally { store.close(); process.stdin.destroy(); }
        });`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, path, work.contract.id, owner], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let readyResolve: () => void;
      const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      child.stdout.on('data', data => { output += String(data); if (output.includes('ready\n')) readyResolve(); });
      child.stderr.on('data', data => { errors += String(data); });
      const done = new Promise<{ claimed: boolean }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          if (code !== 0) reject(new Error(errors));
          else resolve(JSON.parse(output.trim().split('\n').at(-1)!) as { claimed: boolean });
        });
      });
      return { child, ready, done };
    });
    await Promise.all(children.map(child => child.ready));
    for (const { child } of children) child.stdin.end('claim\n');
    const outcomes = await Promise.all(children.map(child => child.done));
    expect(outcomes.filter(outcome => outcome.claimed)).toHaveLength(1);
    expect(store.getWork(work.contract.id).attempts).toBe(1);
  }, 15_000);
});
