import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TaskStateSchema = z.enum(['pending', 'ready', 'claimed', 'running', 'awaiting_approval', 'verifying', 'passed', 'failed', 'blocked', 'cancelled']);
export type TaskState = z.infer<typeof TaskStateSchema>;
const Identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const Timestamp = z.string().datetime();
export const CommandSchema = z.object({
  id: Identifier, executable: z.string().min(1).max(4096), args: z.array(z.string()).default([]),
  cwd: z.string().optional(), timeoutMs: z.number().int().min(1).max(3_600_000).default(60_000),
}).strict();
export const CriterionSchema = z.object({
  id: Identifier, description: z.string().min(1).max(16_384), commandIds: z.array(Identifier).min(1), required: z.boolean().default(true),
}).strict();
export const RepositorySchema = z.object({ root: z.string(), fingerprint: z.string().min(1), revision: z.string().optional() }).strict();
export const CreateWorkInputSchema = z.object({
  objective: z.string().min(1).max(32_768), repository: RepositorySchema.optional(),
  scope: z.array(z.string()).default([]), exclusions: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]), dependencies: z.array(Identifier).default([]),
  deliverables: z.array(z.string()).default([]), criteria: z.array(CriterionSchema).default([]), commands: z.array(CommandSchema).default([]),
  policy: z.object({ allowedOperations: z.array(z.string()).default(['read', 'edit', 'test']), requiresHumanReview: z.boolean().default(false) }).strict().default({ allowedOperations: ['read', 'edit', 'test'], requiresHumanReview: false }),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
  limits: z.object({ maxAttempts: z.number().int().min(1).max(100).default(3), timeoutMs: z.number().int().min(1).max(3_600_000).default(300_000), retryBackoffMs: z.number().int().min(0).max(3_600_000).default(1_000) }).strict().default({ maxAttempts: 3, timeoutMs: 300_000, retryBackoffMs: 1_000 }),
  evidenceRequirements: z.array(z.string()).default([]), assignedAgent: z.string().optional(),
}).strict().superRefine((input, ctx) => {
  const ids = new Set(input.commands.map(command => command.id));
  if (ids.size !== input.commands.length) ctx.addIssue({ code: 'custom', message: 'Command IDs must be unique', path: ['commands'] });
  if (new Set(input.criteria.map(criterion => criterion.id)).size !== input.criteria.length) ctx.addIssue({ code: 'custom', message: 'Criterion IDs must be unique', path: ['criteria'] });
  if (new Set(input.dependencies).size !== input.dependencies.length) ctx.addIssue({ code: 'custom', message: 'Dependency IDs must be unique', path: ['dependencies'] });
  for (const [index, criterion] of input.criteria.entries()) {
    for (const id of criterion.commandIds) if (!ids.has(id)) ctx.addIssue({ code: 'custom', message: `Unknown command: ${id}`, path: ['criteria', index, 'commandIds'] });
  }
});
export type CreateWorkInput = z.input<typeof CreateWorkInputSchema>;
export const WorkContractSchema = CreateWorkInputSchema.safeExtend({
  formatVersion: z.literal(1), id: Identifier, version: z.number().int().min(1), repository: RepositorySchema,
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type WorkContract = z.infer<typeof WorkContractSchema>;
export type VerificationCommand = z.infer<typeof CommandSchema>;

export const CommandObservationSchema = z.object({
  id: Identifier, executable: z.string(), args: z.array(z.string()), cwd: z.string().optional(), exitCode: z.number().int().nullable(),
  stdout: z.string(), stderr: z.string(), startedAt: Timestamp, finishedAt: Timestamp,
  timedOut: z.boolean().optional(), error: z.string().optional(), outputTruncated: z.boolean().optional(),
  status: z.enum(['completed', 'unavailable', 'timed_out', 'cancelled', 'rejected']).optional(),
}).strict();
export const VerificationReceiptSchema = z.object({
  formatVersion: z.literal(1), id: Identifier, taskId: Identifier, contractVersion: z.number().int().min(1), contractDigest: z.string(), attemptId: Identifier,
  repository: z.object({ revision: z.string().optional(), diffFingerprint: z.string(), beforeFingerprint: z.string().optional(), afterFingerprint: z.string().optional() }).strict(),
  criteria: z.array(z.object({ id: Identifier, status: z.enum(['pass', 'fail', 'inconclusive']), commandIds: z.array(Identifier) }).strict()),
  commands: z.array(CommandObservationSchema), artifacts: z.array(z.object({ path: z.string(), sha256: z.string(), sizeBytes: z.number().int().optional() }).strict()),
  startedAt: Timestamp, finishedAt: Timestamp, status: z.enum(['pass', 'fail', 'inconclusive']), warnings: z.array(z.string()),
}).strict();
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

export const CheckpointInputSchema = z.object({
  agent: z.string().min(1), summary: z.string().min(1), nextSteps: z.array(z.string()).default([]), files: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]), blockers: z.array(z.string()).default([]),
}).strict();
export type CheckpointInput = z.input<typeof CheckpointInputSchema>;
export const CheckpointSchema = CheckpointInputSchema.extend({ id: Identifier, taskId: Identifier, createdAt: Timestamp });
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const DecisionSchema = z.object({ id: Identifier, taskId: Identifier, agent: z.string(), text: z.string(), createdAt: Timestamp }).strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const ApprovalSchema = z.object({
  id: Identifier, taskId: Identifier, contractVersion: z.number().int().min(1), contractDigest: z.string(), kind: z.enum(['execution', 'human_review']),
  status: z.enum(['pending', 'approved', 'superseded']), requestedAt: Timestamp, approvedAt: Timestamp.optional(),
}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;
export const LeaseSchema = z.object({ owner: z.string(), token: z.string(), fencingToken: z.number().int().positive(), expiresAt: Timestamp }).strict();
export type Lease = z.infer<typeof LeaseSchema>;
export const WorkEventSchema = z.object({ id: Identifier, taskId: Identifier, type: z.string(), at: Timestamp, data: z.record(z.string(), z.unknown()) }).strict();
export type WorkEvent = z.infer<typeof WorkEventSchema>;
export const WorkRecordSchema = z.object({
  contract: WorkContractSchema, state: TaskStateSchema, attempts: z.number().int().nonnegative(), lease: LeaseSchema.nullable(),
  nextAttemptAt: Timestamp.nullable(), checkpoint: CheckpointSchema.nullable(), decisions: z.array(DecisionSchema),
  receipts: z.array(VerificationReceiptSchema), approval: ApprovalSchema.nullable(), events: z.array(WorkEventSchema),
}).strict();
export type WorkRecord = z.infer<typeof WorkRecordSchema>;

export const HandoffPackageSchema = z.object({
  formatVersion: z.literal(1), id: Identifier, taskId: Identifier, contractVersion: z.number().int().positive(), contractDigest: z.string(),
  repository: z.object({ revision: z.string().optional(), fingerprint: z.string(), files: z.array(z.string()), excluded: z.array(z.string()) }).strict(),
  completedTasks: z.array(z.string()), unfinishedTasks: z.array(z.string()), facts: z.array(z.string()), decisions: z.array(DecisionSchema),
  files: z.array(z.string()), artifacts: z.array(z.object({ path: z.string(), sha256: z.string().optional() }).strict()),
  errors: z.array(z.string()), blockers: z.array(z.string()), tests: z.array(VerificationReceiptSchema), nextSteps: z.array(z.string()),
  outstandingCriteria: z.array(z.string()), continuationInstructions: z.string(),
  provenance: z.object({ agent: z.string(), createdAt: Timestamp, source: z.literal('local') }).strict(),
  summary: z.string(), warnings: z.array(z.string()),
}).strict();
export type HandoffPackage = z.infer<typeof HandoffPackageSchema>;
export const PortableStateSchema = z.object({
  formatVersion: z.literal(1), exportedAt: Timestamp, works: z.array(WorkRecordSchema), handoffs: z.array(HandoffPackageSchema),
}).strict();
export type PortableState = z.infer<typeof PortableStateSchema>;

/** Digest immutable approved policy, never mutable execution state. */
export function contractDigest(contract: WorkContract): string {
  return createHash('sha256').update(JSON.stringify(canonical(contract))).digest('hex');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
