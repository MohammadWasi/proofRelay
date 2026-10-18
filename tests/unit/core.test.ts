import { describe, expect, it } from 'vitest';
import { CreateWorkInputSchema, WorkContractSchema, contractDigest } from '../../packages/contracts/src/index.js';
import { assertAcyclicDependencies, assertTransition, canTransition } from '../../packages/core/src/state-machine.js';

describe('work contracts and deterministic state transitions', () => {
  it('rejects unknown commands, duplicate criteria, and accidental shell-string configurations', () => {
    expect(() => CreateWorkInputSchema.parse({ objective: 'check', commands: ['npm test'] })).toThrow();
    expect(() => CreateWorkInputSchema.parse({ objective: 'check', criteria: [{ id: 'test', description: 'Tests pass', commandIds: ['missing'] }] })).toThrow(/Unknown command/);
    expect(() => CreateWorkInputSchema.parse({ objective: 'check', commands: [{ id: 'test', executable: 'node', args: [] }, { id: 'test', executable: 'node', args: [] }] })).toThrow(/unique/);
    expect(() => CreateWorkInputSchema.parse({ objective: 'check', arbitraryPolicy: true })).toThrow();
  });

  it('makes natural language a draft with no invented acceptance criteria', () => {
    const draft = CreateWorkInputSchema.parse({ objective: 'Implement login' });
    expect(draft.criteria).toEqual([]);
    expect(draft.limits.maxAttempts).toBe(3);
    expect(draft.policy.requiresHumanReview).toBe(false);
  });

  it('allows observed verification completion but forbids self-attested success and terminal reopening', () => {
    expect(canTransition('running', 'passed')).toBe(false);
    expect(canTransition('awaiting_approval', 'passed')).toBe(false);
    expect(canTransition('verifying', 'passed')).toBe(true);
    expect(canTransition('verifying', 'failed')).toBe(true);
    expect(canTransition('passed', 'ready')).toBe(false);
    expect(canTransition('cancelled', 'claimed')).toBe(false);
    expect(() => assertTransition('running', 'passed')).toThrow(/Cannot transition/);
  });

  it('rejects missing dependencies and cycles before mutation', () => {
    expect(() => assertAcyclicDependencies([{ id: 'a', dependencies: ['b'] }])).toThrow(/does not exist/);
    expect(() => assertAcyclicDependencies([{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }])).toThrow(/cycle/);
    expect(() => assertAcyclicDependencies([{ id: 'a', dependencies: [] }, { id: 'b', dependencies: ['a'] }])).not.toThrow();
  });

  it('binds approval digests to exact contract content with canonical object keys', () => {
    const contract = WorkContractSchema.parse({ objective: 'Check', id: 'one', version: 1, formatVersion: 1,
      repository: { root: '/example', fingerprint: 'repository' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(contractDigest(contract)).toBe(contractDigest({ ...contract, repository: { fingerprint: 'repository', root: '/example' } }));
    expect(contractDigest(contract)).not.toBe(contractDigest({ ...contract, objective: 'Different work' }));
  });
});
