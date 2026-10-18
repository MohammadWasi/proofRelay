import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  ApprovalSchema, CheckpointInputSchema, CreateWorkInputSchema, HandoffPackageSchema, PortableStateSchema, VerificationReceiptSchema, WorkContractSchema,
  contractDigest, type Approval, type Checkpoint, type CheckpointInput, type CreateWorkInput, type Decision,
  type HandoffPackage, type PortableState, type TaskState, type VerificationReceipt, type WorkContract, type WorkEvent, type WorkRecord,
} from '../../contracts/src/index.js';
import { RelayError } from '../../core/src/errors.js';
import { assertAcyclicDependencies, assertTransition } from '../../core/src/state-machine.js';
import { redactText, sanitize } from '../../security/src/redact.js';
export { RelayError } from '../../core/src/errors.js';
export type { PortableState } from '../../contracts/src/index.js';

type Row = {
  id: string; contract_json: string; state: TaskState; attempts: number; lease_owner: string | null; lease_token: string | null;
  fencing_token: number; lease_expires_at: string | null; next_attempt_at: string | null; checkpoint_json: string | null; verification_id: string | null;
};
type JsonRow = { json: string };
type AttemptRow = { id: string; task_id: string; token_hash: string; status: string; expires_at: string; contract_digest: string; receipt_json: string | null };
type IdempotencyRow = { payload_hash: string; result_json: string };
export interface StoreOptions { readOnly?: boolean; now?: () => number }
export interface VerificationAttempt { attemptId: string; token: string; work: WorkRecord }
export interface RelayStatus { total: number; states: Record<TaskState, number>; pendingApprovals: Approval[] }

/** Each mutation, its history, and its idempotency record commit together. */
export class RelayStore {
  readonly workspace: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;
  private readonly now: () => number;
  private inTransaction = false;

  constructor(workspace: string, options: StoreOptions = {}) {
    this.workspace = realpathSync(workspace);
    this.readOnly = options.readOnly ?? false;
    this.now = options.now ?? Date.now;
    const directory = join(this.workspace, '.proofrelay');
    for (const path of [directory, join(directory, 'state.sqlite'), join(directory, 'state.sqlite-wal'), join(directory, 'state.sqlite-shm')]) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink > 1)) throw new RelayError('UNSAFE_PATH', `Local state must not be a symlink or shared hard link: ${path}`);
    }
    if (!this.readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.databasePath = join(directory, 'state.sqlite');
    this.db = new DatabaseSync(this.databasePath, { readOnly: this.readOnly, enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!this.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      chmodSync(this.databasePath, 0o600);
      this.migrate();
      this.reapExpiredLeases();
    } else if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== 1) {
      throw new RelayError('UNSUPPORTED_SCHEMA', 'Unsupported local database version');
    }
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 1) throw new RelayError('UNSUPPORTED_SCHEMA', `Database version ${version} is newer than this program supports`);
      if (version === 0) this.db.exec(`
        CREATE TABLE works (id TEXT PRIMARY KEY, contract_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT, lease_token TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, next_attempt_at TEXT, checkpoint_json TEXT, verification_id TEXT);
        CREATE TABLE events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), json TEXT NOT NULL);
        CREATE INDEX events_task ON events(task_id);
        CREATE TABLE decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), json TEXT NOT NULL);
        CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), kind TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX approvals_task ON approvals(task_id, digest, kind, status);
        CREATE TABLE receipts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), attempt_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
        CREATE TABLE handoffs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), json TEXT NOT NULL);
        CREATE TABLE verification_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES works(id), token_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, contract_digest TEXT NOT NULL, receipt_json TEXT);
        CREATE TABLE idempotency (operation TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(operation, key));
        PRAGMA user_version = 1;
      `);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private transaction<T>(action: () => T): T {
    if (this.readOnly) throw new RelayError('READ_ONLY', 'This store was opened read-only');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  private readSnapshot<T>(action: () => T): T {
    if (this.inTransaction) return action();
    this.db.exec('BEGIN DEFERRED');
    this.inTransaction = true;
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM works WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new RelayError('NOT_FOUND', `Work ${id} was not found`);
    return row;
  }
  private rows(): Row[] { return this.db.prepare('SELECT * FROM works ORDER BY rowid').all() as Row[]; }
  private event(id: string, type: string, data: Record<string, unknown> = {}): void {
    const event: WorkEvent = { id: randomUUID(), taskId: id, type, at: this.timestamp(), data };
    this.db.prepare('INSERT INTO events (id, task_id, json) VALUES (?, ?, ?)').run(event.id, id, JSON.stringify(event));
  }
  private setState(row: Row, state: TaskState, reason: string): void {
    assertTransition(row.state, state);
    if (row.state === state) return;
    this.db.prepare('UPDATE works SET state = ? WHERE id = ?').run(state, row.id);
    this.event(row.id, 'state_changed', { from: row.state, to: state, reason });
    row.state = state;
  }
  private clearLease(id: string): void { this.db.prepare('UPDATE works SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=?').run(id); }
  private contract(row: Row): WorkContract { return WorkContractSchema.parse(JSON.parse(row.contract_json)); }
  private approved(contract: WorkContract, kind: Approval['kind'] = 'execution'): boolean {
    return !!this.db.prepare('SELECT id FROM approvals WHERE task_id=? AND digest=? AND kind=? AND status=?').get(contract.id, contractDigest(contract), kind, 'approved');
  }
  hasApproval(id: string, kind: Approval['kind'] = 'execution'): boolean { return this.approved(this.contract(this.row(id)), kind); }
  private dependenciesPassed(contract: WorkContract): boolean { return contract.dependencies.every(id => this.row(id).state === 'passed'); }
  private assertEligible(row: Row): WorkContract {
    const contract = this.contract(row);
    if (!this.approved(contract)) throw new RelayError('APPROVAL_REQUIRED', 'The exact contract version requires trusted CLI approval');
    if (!this.dependenciesPassed(contract)) throw new RelayError('DEPENDENCY_BLOCKED', 'All dependencies must pass before execution');
    if (row.next_attempt_at && Date.parse(row.next_attempt_at) > this.now()) throw new RelayError('BACKOFF', `Retry is available at ${row.next_attempt_at}`);
    return contract;
  }
  private assertLease(row: Row, token: string | undefined, owner?: string): void {
    if (!row.lease_token || row.lease_token !== token || !row.lease_expires_at || Date.parse(row.lease_expires_at) <= this.now() || (owner !== undefined && row.lease_owner !== owner)) {
      throw new RelayError('STALE_LEASE', 'A current lease token belonging to this agent is required');
    }
  }
  private replay(operation: string, key: string | undefined, payload: unknown): unknown {
    if (!key) return undefined;
    const row = this.db.prepare('SELECT payload_hash, result_json FROM idempotency WHERE operation=? AND key=?').get(operation, key) as IdempotencyRow | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== hash(payload)) throw new RelayError('CONFLICT', 'Idempotency key was already used with different input');
    return JSON.parse(row.result_json) as unknown;
  }
  private remember(operation: string, key: string | undefined, payload: unknown, result: unknown): void {
    if (key) this.db.prepare('INSERT INTO idempotency (operation, key, payload_hash, result_json) VALUES (?, ?, ?, ?)').run(operation, key, hash(payload), JSON.stringify(result));
  }

  createWork(input: CreateWorkInput, idempotencyKey?: string): WorkRecord {
    const parsed = CreateWorkInputSchema.parse(input);
    return this.transaction(() => {
      const replay = this.replay('create', idempotencyKey, parsed) as { id: string } | undefined;
      if (replay) return this.getWork(replay.id);
      const now = this.timestamp();
      const contract = WorkContractSchema.parse({ ...parsed, formatVersion: 1, id: randomUUID(), version: 1,
        repository: parsed.repository ?? { root: this.workspace, fingerprint: hash(this.workspace) }, createdAt: now, updatedAt: now });
      assertAcyclicDependencies([...this.rows().map(row => this.contract(row)), contract]);
      this.db.prepare('INSERT INTO works (id, contract_json, state) VALUES (?, ?, ?)').run(contract.id, JSON.stringify(contract), 'awaiting_approval');
      this.event(contract.id, 'created', { contractVersion: 1, digest: contractDigest(contract) });
      this.requestApprovalInternal(contract, 'execution');
      this.remember('create', idempotencyKey, parsed, { id: contract.id });
      return this.getWork(contract.id);
    });
  }

  updateContract(id: string, input: CreateWorkInput): WorkRecord {
    const parsed = CreateWorkInputSchema.parse(input);
    return this.transaction(() => {
      const row = this.row(id);
      if (['claimed', 'running', 'verifying', 'passed', 'cancelled'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', 'Cannot edit an active or terminal contract');
      const previous = this.contract(row);
      const contract = WorkContractSchema.parse({ ...parsed, repository: parsed.repository ?? previous.repository, id, formatVersion: 1,
        version: previous.version + 1, createdAt: previous.createdAt, updatedAt: this.timestamp() });
      assertAcyclicDependencies(this.rows().map(item => item.id === id ? contract : this.contract(item)));
      this.db.prepare('UPDATE works SET contract_json=?, attempts=0, next_attempt_at=NULL WHERE id=?').run(JSON.stringify(contract), id);
      this.supersedeApprovals(id);
      this.setState(row, 'awaiting_approval', 'contract changed');
      this.event(id, 'contract_updated', { contractVersion: contract.version, digest: contractDigest(contract) });
      this.requestApprovalInternal(contract, 'execution');
      return this.getWork(id);
    });
  }
  getWork(id: string): WorkRecord {
    return this.readSnapshot(() => this.getWorkSnapshot(id));
  }
  private getWorkSnapshot(id: string): WorkRecord {
    const row = this.row(id);
    const contract = this.contract(row);
    const approvalRow = this.db.prepare('SELECT json FROM approvals WHERE task_id=? AND digest=? AND kind=? ORDER BY rowid DESC LIMIT 1').get(id, contractDigest(contract), 'execution') as JsonRow | undefined;
    return {
      contract, state: row.state, attempts: row.attempts,
      lease: row.lease_token && row.lease_owner && row.lease_expires_at ? { owner: row.lease_owner, token: row.lease_token, fencingToken: row.fencing_token, expiresAt: row.lease_expires_at } : null,
      nextAttemptAt: row.next_attempt_at, checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Checkpoint : null,
      decisions: this.jsonRows<Decision>('decisions', id), receipts: this.jsonRows<VerificationReceipt>('receipts', id),
      approval: approvalRow ? ApprovalSchema.parse(JSON.parse(approvalRow.json)) : null, events: this.getEvents(id),
    };
  }
  private jsonRows<T>(table: 'decisions' | 'receipts' | 'events' | 'handoffs', id?: string): T[] {
    const rows = id ? this.db.prepare(`SELECT json FROM ${table} WHERE task_id=? ORDER BY rowid`).all(id) : this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all();
    return (rows as JsonRow[]).map(row => JSON.parse(row.json) as T);
  }
  listWorks(): WorkRecord[] { return this.readSnapshot(() => this.rows().map(row => this.getWorkSnapshot(row.id))); }
  listReadyTasks(): WorkRecord[] {
    if (!this.readOnly) this.reapExpiredLeases();
    return this.listWorks().filter(work => work.state === 'ready' && (!work.nextAttemptAt || Date.parse(work.nextAttemptAt) <= this.now()));
  }
  getEvents(id?: string): WorkEvent[] { return this.jsonRows<WorkEvent>('events', id); }

  private requestApprovalInternal(contract: WorkContract, kind: Approval['kind']): Approval {
    const digest = contractDigest(contract);
    const existing = this.db.prepare('SELECT json FROM approvals WHERE task_id=? AND digest=? AND kind=? AND status IN (?, ?) ORDER BY rowid DESC LIMIT 1').get(contract.id, digest, kind, 'pending', 'approved') as JsonRow | undefined;
    if (existing) return ApprovalSchema.parse(JSON.parse(existing.json));
    const approval: Approval = { id: randomUUID(), taskId: contract.id, contractVersion: contract.version, contractDigest: digest, kind, status: 'pending', requestedAt: this.timestamp() };
    this.db.prepare('INSERT INTO approvals (id, task_id, kind, digest, status, json) VALUES (?, ?, ?, ?, ?, ?)').run(approval.id, contract.id, kind, digest, 'pending', JSON.stringify(approval));
    this.event(contract.id, 'approval_requested', { approvalId: approval.id, kind, digest });
    return approval;
  }
  requestApproval(id: string, kind: Approval['kind'] = 'execution'): Approval {
    return this.transaction(() => this.requestApprovalInternal(this.contract(this.row(id)), kind));
  }
  getApproval(id: string): Approval {
    const row = this.db.prepare('SELECT json FROM approvals WHERE id=?').get(id) as JsonRow | undefined;
    if (!row) throw new RelayError('NOT_FOUND', `Approval ${id} was not found`);
    return ApprovalSchema.parse(JSON.parse(row.json));
  }
  /** Trusted local CLI only. Deliberately never register an MCP approval tool. */
  approve(id: string): Approval {
    return this.transaction(() => {
      const approval = this.getApproval(id);
      const row = this.row(approval.taskId);
      if (['passed', 'cancelled'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', 'Cannot approve terminal work');
      if (approval.contractDigest !== contractDigest(this.contract(row)) || approval.status === 'superseded') throw new RelayError('CONFLICT', 'Approval belongs to an older contract version');
      if (approval.status === 'approved') return approval;
      const updated: Approval = { ...approval, status: 'approved', approvedAt: this.timestamp() };
      this.db.prepare('UPDATE approvals SET status=?, json=? WHERE id=?').run('approved', JSON.stringify(updated), id);
      this.event(row.id, 'approval_granted', { approvalId: id, kind: approval.kind, digest: approval.contractDigest });
      if (approval.kind === 'execution') this.refreshReadiness();
      return updated;
    });
  }
  private supersedeApprovals(id: string): void {
    const rows = this.db.prepare('SELECT json FROM approvals WHERE task_id=?').all(id) as JsonRow[];
    for (const row of rows) {
      const approval = ApprovalSchema.parse(JSON.parse(row.json));
      const changed: Approval = { ...approval, status: 'superseded' };
      this.db.prepare('UPDATE approvals SET status=?, json=? WHERE id=?').run('superseded', JSON.stringify(changed), approval.id);
    }
  }
  private refreshReadiness(): void {
    for (const row of this.rows()) {
      if (!['pending', 'ready', 'awaiting_approval'].includes(row.state) || row.lease_token) continue;
      const contract = this.contract(row);
      const state: TaskState = !this.approved(contract) ? 'awaiting_approval' : this.dependenciesPassed(contract) ? 'ready' : 'pending';
      this.setState(row, state, 'approval or dependencies changed');
    }
  }

  claimTask(id: string, owner: string, options: { leaseMs?: number; idempotencyKey?: string } = {}): WorkRecord {
    if (!owner.trim()) throw new RelayError('INVALID_INPUT', 'A nonempty agent name is required');
    const leaseMs = options.leaseMs ?? 300_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new RelayError('INVALID_INPUT', 'Lease duration must be 1–3600000 milliseconds');
    return this.transaction(() => {
      this.recoverInternal();
      const payload = { id, owner, leaseMs };
      const replay = this.replay('claim', options.idempotencyKey, payload) as { token: string } | undefined;
      if (replay) { this.assertLease(this.row(id), replay.token, owner); return this.getWork(id); }
      const row = this.row(id);
      if (!['ready', 'failed'].includes(row.state)) throw new RelayError('CONFLICT', `Work is ${row.state} and cannot be claimed`);
      const contract = this.assertEligible(row);
      if (row.attempts >= contract.limits.maxAttempts) throw new RelayError('RETRY_LIMIT', 'Execution attempt limit reached');
      const token = randomUUID();
      this.db.prepare('UPDATE works SET lease_owner=?, lease_token=?, fencing_token=fencing_token+1, lease_expires_at=?, attempts=attempts+1, next_attempt_at=NULL WHERE id=?')
        .run(owner, token, new Date(this.now() + Math.min(leaseMs, contract.limits.timeoutMs)).toISOString(), id);
      this.setState(row, 'claimed', 'agent claimed lease');
      this.event(id, 'claimed', { owner, fencingToken: row.fencing_token + 1 });
      this.remember('claim', options.idempotencyKey, payload, { token });
      return this.getWork(id);
    });
  }
  checkpoint(id: string, input: CheckpointInput, leaseToken?: string): WorkRecord {
    const parsed = CheckpointInputSchema.parse(sanitize(input));
    return this.transaction(() => {
      const row = this.row(id);
      if (['passed', 'cancelled', 'verifying'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', 'Cannot checkpoint terminal work or an active verification');
      if (row.lease_token || leaseToken) this.assertLease(row, leaseToken, parsed.agent);
      const checkpoint: Checkpoint = { ...parsed, id: randomUUID(), taskId: id, createdAt: this.timestamp() };
      this.db.prepare('UPDATE works SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint), id);
      if (row.state === 'claimed') this.setState(row, 'running', 'checkpoint recorded');
      this.event(id, 'checkpoint', { checkpoint });
      return this.getWork(id);
    });
  }
  recordDecision(id: string, input: { agent: string; text: string }): Decision {
    const parsed = z.object({ agent: z.string().min(1), text: z.string().min(1) }).strict().parse(sanitize(input));
    return this.transaction(() => {
      this.row(id);
      const decision: Decision = { ...parsed, id: randomUUID(), taskId: id, createdAt: this.timestamp() };
      this.db.prepare('INSERT INTO decisions (id, task_id, json) VALUES (?, ?, ?)').run(decision.id, id, JSON.stringify(decision));
      this.event(id, 'decision', { decisionId: decision.id, agent: decision.agent });
      return decision;
    });
  }
  submitResult(id: string, input: { agent: string; summary: string; leaseToken: string }): WorkRecord {
    z.object({ agent: z.string().min(1), summary: z.string().min(1), leaseToken: z.string().min(1) }).strict().parse(input);
    return this.transaction(() => {
      const row = this.row(id);
      this.assertLease(row, input.leaseToken, input.agent);
      if (!['claimed', 'running'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', 'Only claimed or running work can be submitted');
      this.setState(row, 'awaiting_approval', 'agent reported completion; independent verification required');
      this.event(id, 'result_submitted', { agent: redactText(input.agent), summary: redactText(input.summary) });
      return this.getWork(id);
    });
  }
  releaseTask(id: string, leaseToken: string): WorkRecord {
    return this.transaction(() => {
      const row = this.row(id);
      this.assertLease(row, leaseToken);
      if (row.state === 'verifying') throw new RelayError('CONFLICT', 'Cannot release while verification is running');
      this.clearLease(id);
      this.setState(row, this.dependenciesPassed(this.contract(row)) ? 'ready' : 'pending', 'lease released for continuation');
      return this.getWork(id);
    });
  }

  startVerification(id: string, options: { agent?: string; leaseToken?: string } = {}): VerificationAttempt {
    return this.transaction(() => {
      this.recoverInternal();
      const row = this.row(id);
      if (!['ready', 'claimed', 'running', 'awaiting_approval', 'failed'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', `Cannot verify work in state ${row.state}`);
      const contract = this.assertEligible(row);
      if (row.lease_token || options.leaseToken) this.assertLease(row, options.leaseToken, options.agent);
      if (!row.lease_token) {
        if (row.attempts >= contract.limits.maxAttempts) throw new RelayError('RETRY_LIMIT', 'Execution attempt limit reached');
        this.db.prepare('UPDATE works SET attempts=attempts+1 WHERE id=?').run(id);
      }
      const attemptId = randomUUID();
      const token = randomUUID();
      const expiresAt = new Date(this.now() + contract.limits.timeoutMs + 5_000).toISOString();
      this.db.prepare('INSERT INTO verification_attempts (id, task_id, token_hash, status, expires_at, contract_digest) VALUES (?, ?, ?, ?, ?, ?)')
        .run(attemptId, id, hash(token), 'active', expiresAt, contractDigest(contract));
      this.db.prepare('UPDATE works SET verification_id=?, lease_expires_at=CASE WHEN lease_token IS NOT NULL THEN ? ELSE NULL END WHERE id=?').run(attemptId, expiresAt, id);
      this.setState(row, 'verifying', 'approved independent verification started');
      this.event(id, 'verification_started', { attemptId });
      return { attemptId, token, work: this.getWork(id) };
    });
  }
  /** Internal completion capability. Never expose this method or token over MCP. */
  finishVerification(input: VerificationReceipt, token: string): WorkRecord {
    const receipt = VerificationReceiptSchema.parse(input);
    return this.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM verification_attempts WHERE id=?').get(receipt.attemptId) as AttemptRow | undefined;
      if (!attempt || attempt.token_hash !== hash(token)) throw new RelayError('UNAUTHORIZED', 'Invalid verifier capability');
      if (attempt.status === 'completed') {
        if (attempt.receipt_json !== JSON.stringify(receipt)) throw new RelayError('CONFLICT', 'Verification attempt already completed with another receipt');
        return this.getWork(receipt.taskId);
      }
      if (attempt.status !== 'active' || Date.parse(attempt.expires_at) <= this.now()) throw new RelayError('STALE_LEASE', 'Verification attempt expired');
      const row = this.row(receipt.taskId);
      const contract = this.contract(row);
      if (attempt.task_id !== row.id || row.verification_id !== attempt.id || row.state !== 'verifying' || receipt.contractVersion !== contract.version || receipt.contractDigest !== contractDigest(contract) || attempt.contract_digest !== receipt.contractDigest) {
        throw new RelayError('CONFLICT', 'Receipt does not match the active approved contract and verification attempt');
      }
      this.validateReceipt(contract, receipt);
      this.db.prepare('INSERT INTO receipts (id, task_id, attempt_id, json) VALUES (?, ?, ?, ?)').run(receipt.id, row.id, receipt.attemptId, JSON.stringify(receipt));
      this.db.prepare('UPDATE verification_attempts SET status=?, receipt_json=? WHERE id=?').run('completed', JSON.stringify(receipt), attempt.id);
      this.clearLease(row.id);
      const next: TaskState = receipt.status === 'pass' ? 'passed' : receipt.status === 'inconclusive' ? 'blocked' : 'failed';
      this.setState(row, next, `independent verification ${receipt.status}`);
      const backoff = receipt.status === 'fail' ? new Date(this.now() + contract.limits.retryBackoffMs * 2 ** Math.max(0, row.attempts - 1)).toISOString() : null;
      this.db.prepare('UPDATE works SET verification_id=NULL, next_attempt_at=? WHERE id=?').run(backoff, row.id);
      this.event(row.id, 'verification_completed', { receiptId: receipt.id, attemptId: receipt.attemptId, status: receipt.status });
      this.refreshReadiness();
      return this.getWork(row.id);
    });
  }
  private validateReceipt(contract: WorkContract, receipt: VerificationReceipt): void {
    const commands = new Map(receipt.commands.map(command => [command.id, command]));
    if (commands.size !== receipt.commands.length) throw new RelayError('INVALID_INPUT', 'Duplicate command observations');
    for (const observed of receipt.commands) {
      const approved = contract.commands.find(command => command.id === observed.id);
      const safeApproved = approved ? sanitize(approved) : undefined;
      if (!safeApproved || safeApproved.executable !== observed.executable || JSON.stringify(safeApproved.args) !== JSON.stringify(observed.args)) throw new RelayError('UNAUTHORIZED', 'Receipt contains a command outside the approved contract');
    }
    if (receipt.status !== 'pass') return;
    if (!contract.criteria.some(criterion => criterion.required)) throw new RelayError('INVALID_INPUT', 'A contract without required criteria cannot pass');
    if (contract.policy.requiresHumanReview && !this.approved(contract, 'human_review')) throw new RelayError('APPROVAL_REQUIRED', 'Human review is required before verification can pass');
    const criteria = new Map(receipt.criteria.map(criterion => [criterion.id, criterion]));
    if (criteria.size !== receipt.criteria.length || !receipt.repository.beforeFingerprint || !receipt.repository.afterFingerprint || receipt.repository.beforeFingerprint !== receipt.repository.afterFingerprint) throw new RelayError('INVALID_INPUT', 'Invalid or stale verification observations');
    for (const criterion of contract.criteria.filter(item => item.required)) {
      const assessed = criteria.get(criterion.id);
      if (!assessed || assessed.status !== 'pass' || JSON.stringify(assessed.commandIds) !== JSON.stringify(criterion.commandIds)) throw new RelayError('INVALID_INPUT', `Required criterion ${criterion.id} did not pass`);
      for (const id of criterion.commandIds) {
        const command = commands.get(id);
        if (!command || command.exitCode !== 0 || command.timedOut || command.error || (command.status !== undefined && command.status !== 'completed')) throw new RelayError('INVALID_INPUT', `Required command ${id} did not complete successfully`);
      }
    }
  }

  cancelTask(id: string): WorkRecord {
    return this.transaction(() => {
      const row = this.row(id);
      this.setState(row, 'cancelled', 'cancelled by local user');
      this.clearLease(id);
      this.supersedeApprovals(id);
      if (row.verification_id) this.db.prepare('UPDATE verification_attempts SET status=? WHERE id=?').run('cancelled', row.verification_id);
      this.db.prepare('UPDATE works SET verification_id=NULL WHERE id=?').run(id);
      return this.getWork(id);
    });
  }
  retryTask(id: string): WorkRecord {
    return this.transaction(() => {
      this.recoverInternal();
      const row = this.row(id);
      if (!['failed', 'blocked'].includes(row.state)) throw new RelayError('INVALID_TRANSITION', 'Only failed or blocked work can be retried');
      const contract = this.assertEligible(row);
      if (row.attempts >= contract.limits.maxAttempts) throw new RelayError('RETRY_LIMIT', 'Execution attempt limit reached; revise the contract explicitly');
      this.setState(row, 'ready', 'retry requested');
      return this.getWork(id);
    });
  }
  reapExpiredLeases(): number { return this.transaction(() => this.recoverInternal()); }
  private recoverInternal(): number {
    let recovered = 0;
    for (const row of this.rows()) {
      let expired = row.lease_expires_at !== null && Date.parse(row.lease_expires_at) <= this.now();
      if (row.verification_id) {
        const attempt = this.db.prepare('SELECT * FROM verification_attempts WHERE id=?').get(row.verification_id) as AttemptRow | undefined;
        expired = !attempt || Date.parse(attempt.expires_at) <= this.now();
      }
      if (!expired || ['passed', 'cancelled'].includes(row.state)) continue;
      this.clearLease(row.id);
      if (row.verification_id) this.db.prepare('UPDATE verification_attempts SET status=? WHERE id=?').run('expired', row.verification_id);
      this.db.prepare('UPDATE works SET verification_id=NULL WHERE id=?').run(row.id);
      this.setState(row, 'blocked', 'expired lease recovered; inspect for orphaned processes before retrying');
      this.event(row.id, 'lease_recovered', { priorOwner: row.lease_owner, fencingToken: row.fencing_token, checkpointRetained: !!row.checkpoint_json,
        warning: 'Fencing protects coordination state, not native filesystem writes. A trusted local retry requires checking that the prior process has stopped.' });
      recovered++;
    }
    this.refreshReadiness();
    return recovered;
  }
  saveHandoff(input: HandoffPackage): HandoffPackage {
    const handoff = HandoffPackageSchema.parse(input);
    return this.transaction(() => {
      const contract = this.contract(this.row(handoff.taskId));
      if (handoff.contractVersion !== contract.version || handoff.contractDigest !== contractDigest(contract)) throw new RelayError('CONFLICT', 'Handoff references a stale contract');
      this.db.prepare('INSERT INTO handoffs (id, task_id, json) VALUES (?, ?, ?)').run(handoff.id, handoff.taskId, JSON.stringify(handoff));
      this.event(handoff.taskId, 'handoff_created', { handoffId: handoff.id });
      return handoff;
    });
  }
  getHandoff(id: string): HandoffPackage | null {
    const row = this.db.prepare('SELECT json FROM handoffs WHERE id=? OR task_id=? ORDER BY rowid DESC LIMIT 1').get(id, id) as JsonRow | undefined;
    return row ? HandoffPackageSchema.parse(JSON.parse(row.json)) : null;
  }
  getStatus(): RelayStatus {
    return this.readSnapshot(() => this.getStatusSnapshot());
  }
  private getStatusSnapshot(): RelayStatus {
    const states: Record<TaskState, number> = { pending: 0, ready: 0, claimed: 0, running: 0, awaiting_approval: 0, verifying: 0, passed: 0, failed: 0, blocked: 0, cancelled: 0 };
    const rows = this.rows();
    for (const row of rows) states[row.state]++;
    const pendingApprovals = (this.db.prepare('SELECT json FROM approvals WHERE status=? ORDER BY rowid').all('pending') as JsonRow[]).map(row => ApprovalSchema.parse(JSON.parse(row.json)));
    return { total: rows.length, states, pendingApprovals };
  }
  exportState(): PortableState { return this.readSnapshot(() => sanitize({ formatVersion: 1, exportedAt: this.timestamp(), works: this.listWorks(), handoffs: this.jsonRows<HandoffPackage>('handoffs') })); }
  /** Imported state is evidence, never executable authority. Approvals and receipts are not trusted. */
  importState(input: unknown): WorkRecord[] {
    const parsed = PortableStateSchema.parse(input);
    return this.transaction(() => {
      const imported = parsed.works.map(item => WorkContractSchema.parse({ ...item.contract, repository: { root: this.workspace, fingerprint: hash(this.workspace) }, updatedAt: this.timestamp() }));
      assertAcyclicDependencies([...this.rows().map(row => this.contract(row)), ...imported]);
      if (new Set(imported.map(contract => contract.id)).size !== imported.length) throw new RelayError('CONFLICT', 'Import contains duplicate work IDs');
      for (const contract of imported) if (this.db.prepare('SELECT id FROM works WHERE id=?').get(contract.id)) throw new RelayError('CONFLICT', `Work ${contract.id} already exists`);
      for (const [index, contract] of imported.entries()) {
        this.db.prepare('INSERT INTO works (id, contract_json, state) VALUES (?, ?, ?)').run(contract.id, JSON.stringify(contract), 'awaiting_approval');
        const source = parsed.works[index]!;
        const checkpoint = source.checkpoint;
        if (checkpoint && typeof checkpoint === 'object') {
          const checked = CheckpointInputSchema.safeParse(Object.fromEntries(Object.entries(checkpoint).filter(([key]) => ['agent', 'summary', 'nextSteps', 'files', 'facts', 'blockers'].includes(key))));
          if (checked.success) this.db.prepare('UPDATE works SET checkpoint_json=? WHERE id=?').run(JSON.stringify({ ...sanitize(checked.data), id: randomUUID(), taskId: contract.id, createdAt: this.timestamp() }), contract.id);
        }
        for (const previous of source.decisions) {
          const decision: Decision = { ...sanitize(previous), id: randomUUID(), taskId: contract.id };
          this.db.prepare('INSERT INTO decisions (id, task_id, json) VALUES (?, ?, ?)').run(decision.id, contract.id, JSON.stringify(decision));
        }
        this.event(contract.id, 'imported_untrusted', { warning: 'Prior approvals, receipts, leases and state were not imported as authority. Reapprove and rerun checks locally.',
          previousState: source.state, priorReceipts: sanitize(source.receipts), priorEvents: sanitize(source.events),
          priorHandoffs: sanitize(parsed.handoffs.filter(handoff => handoff.taskId === contract.id)) });
        this.requestApprovalInternal(contract, 'execution');
      }
      return imported.map(contract => this.getWork(contract.id));
    });
  }
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
