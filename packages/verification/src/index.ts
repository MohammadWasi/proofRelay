import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { contractDigest, VerificationReceiptSchema, WorkContractSchema, type VerificationReceipt, type WorkContract } from '../../contracts/src/index.js';
import { runSafeCommand, sanitize, sha256Artifact, snapshotRepository, type RepositorySnapshot } from '../../security/src/index.js';

export interface VerificationOptions {
  /** Must come from trusted local approval storage, never an agent-supplied claim. */
  approvedDigest?: string;
  attemptId?: string;
  humanReviewApproved?: boolean;
  signal?: AbortSignal;
  artifacts?: string[];
}

/** Independently observe explicitly approved commands; this function does not write task state. */
export async function verifyContract(workspace: string, input: WorkContract, options: VerificationOptions = {}): Promise<VerificationReceipt> {
  const contract = WorkContractSchema.parse(input);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const digest = contractDigest(contract);
  const warnings: string[] = [];
  const commands: VerificationReceipt['commands'] = [];
  const artifacts: VerificationReceipt['artifacts'] = [];
  let before: RepositorySnapshot | undefined;
  let after: RepositorySnapshot | undefined;
  let inconclusive = false;
  let mayExecute = true;

  if (options.approvedDigest !== digest) {
    warnings.push('Execution requires a trusted local approval for this exact contract digest.');
    mayExecute = false;
    inconclusive = true;
  }
  if (!contract.policy.allowedOperations.some((operation) => operation === 'test' || operation === 'verify')) {
    warnings.push('The contract policy does not permit verification commands.');
    mayExecute = false;
    inconclusive = true;
  }
  if (contract.criteria.length === 0 || !contract.criteria.some((criterion) => criterion.required)) {
    warnings.push('No required machine-checkable acceptance criteria are configured.');
    mayExecute = false;
    inconclusive = true;
  }
  try {
    if (await realpath(contract.repository.root) !== await realpath(workspace)) {
      warnings.push('The approved contract belongs to a different workspace.');
      mayExecute = false;
      inconclusive = true;
    }
    before = await snapshotRepository(workspace);
  } catch (error) {
    warnings.push(`Repository snapshot unavailable: ${message(error)}`);
    mayExecute = false;
    inconclusive = true;
  }

  if (mayExecute) {
    const referenced = new Set(contract.criteria.flatMap((criterion) => criterion.commandIds));
    for (const command of contract.commands.filter((candidate) => referenced.has(candidate.id))) {
      const remaining = contract.limits.timeoutMs - (Date.now() - startedMs);
      if (remaining <= 0) {
        warnings.push('The overall verification timeout was reached; remaining checks were not run.');
        inconclusive = true;
        break;
      }
      const result = await runSafeCommand(workspace, { ...command, timeoutMs: Math.min(command.timeoutMs, remaining) }, options.signal ? { signal: options.signal } : {});
      commands.push({ id: command.id, ...result });
      if (result.outputTruncated) warnings.push(`Output for ${command.id} was truncated to the capture limit.`);
      if (result.status !== 'completed' || result.exitCode === null) warnings.push(`${command.id}: ${result.error ?? 'No normal process exit was observed.'}`);
      if (result.status === 'cancelled' || options.signal?.aborted) {
        inconclusive = true;
        break;
      }
    }
    for (const relativePath of options.artifacts ?? []) {
      try { artifacts.push(await sha256Artifact(workspace, relativePath)); } catch (error) {
        warnings.push(`Artifact could not be hashed: ${message(error)}`);
        inconclusive = true;
      }
    }
  }

  try { after = await snapshotRepository(workspace); } catch (error) {
    warnings.push(`Final repository snapshot unavailable: ${message(error)}`);
    inconclusive = true;
  }
  if (before && after && (before.fingerprint !== after.fingerprint || before.revision !== after.revision)) {
    warnings.push('The repository changed during verification. Run checks again against a stable workspace.');
    inconclusive = true;
  }
  if (contract.policy.requiresHumanReview && !options.humanReviewApproved) {
    warnings.push('Required human review has not been approved through the trusted local CLI.');
    inconclusive = true;
  }
  if (contract.evidenceRequirements.length > 0 && !options.humanReviewApproved) {
    warnings.push('Prose evidence requirements require explicit human review; command exits alone cannot assess them.');
    inconclusive = true;
  }

  const criteria: VerificationReceipt['criteria'] = contract.criteria.map((criterion) => {
    const observations = criterion.commandIds.map((id) => commands.find((command) => command.id === id));
    const failed = observations.some((observation) => observation?.status === 'completed' && observation.exitCode !== null && observation.exitCode !== 0);
    const passed = observations.length > 0 && observations.every((observation) => observation?.status === 'completed' && observation.exitCode === 0);
    return { id: criterion.id, commandIds: criterion.commandIds, status: failed ? 'fail' : passed ? 'pass' : 'inconclusive' };
  });
  const required = criteria.filter((criterion) => contract.criteria.some((original) => original.id === criterion.id && original.required));
  const failed = required.some((criterion) => criterion.status === 'fail');
  const allPassed = required.length > 0 && required.every((criterion) => criterion.status === 'pass');
  const status = inconclusive ? 'inconclusive' : failed ? 'fail' : allPassed ? 'pass' : 'inconclusive';
  if (criteria.some((criterion) => criterion.status !== 'pass' && !required.includes(criterion))) warnings.push('One or more optional criteria did not pass.');
  warnings.push('A passing receipt covers only the configured checks; it is not proof of complete correctness or security.');
  return VerificationReceiptSchema.parse(sanitize({
    formatVersion: 1,
    id: randomUUID(),
    taskId: contract.id,
    contractVersion: contract.version,
    contractDigest: digest,
    attemptId: options.attemptId ?? randomUUID(),
    repository: {
      ...(after?.revision === undefined ? {} : { revision: after.revision }),
      diffFingerprint: after?.fingerprint ?? before?.fingerprint ?? 'unavailable',
      ...(before === undefined ? {} : { beforeFingerprint: before.fingerprint }),
      ...(after === undefined ? {} : { afterFingerprint: after.fingerprint }),
    },
    criteria, commands, artifacts, startedAt, finishedAt: new Date().toISOString(), status, warnings,
  }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
