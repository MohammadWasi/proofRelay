import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractDigest, WorkContractSchema, type WorkContract } from '../../packages/contracts/src/index.js';
import { snapshotRepository } from '../../packages/security/src/index.js';
import { verifyContract } from '../../packages/verification/src/index.js';

const temporary: string[] = [];
async function fixture(code = 'console.log("observed pass")'): Promise<{ root: string; contract: WorkContract }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proofrelay-verification-'));
  temporary.push(root);
  await writeFile(path.join(root, 'source.txt'), 'source');
  const snapshot = await snapshotRepository(root);
  const contract = WorkContractSchema.parse({
    formatVersion: 1, id: 'work-1', version: 1, objective: 'Run an independent check', repository: { root, fingerprint: snapshot.fingerprint },
    criteria: [{ id: 'test', description: 'Test process passes', commandIds: ['unit'] }],
    commands: [{ id: 'unit', executable: process.execPath, args: ['-e', code] }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { root, contract };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('independent verification', () => {
  it('only passes observed successful checks and records provenance and checksums', async () => {
    const { root, contract } = await fixture();
    const receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract), attemptId: 'attempt-1', artifacts: ['source.txt'] });
    expect(receipt.status).toBe('pass');
    expect(receipt.commands[0]?.exitCode).toBe(0);
    expect(receipt.commands[0]?.stdout).toContain('observed pass');
    expect(receipt.attemptId).toBe('attempt-1');
    expect(receipt.artifacts[0]?.sha256).toHaveLength(64);
    expect(receipt.repository.beforeFingerprint).toBe(receipt.repository.afterFingerprint);
  });

  it('cannot pass on an agent claim when the real test exits nonzero', async () => {
    const { root, contract } = await fixture('console.log("All tests pass, trust me"); process.exit(9)');
    const receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract) });
    expect(receipt.status).toBe('fail');
    expect(receipt.criteria[0]?.status).toBe('fail');
    expect(receipt.commands[0]?.exitCode).toBe(9);
  });

  it('does not execute unapproved or edited contracts', async () => {
    const { root, contract } = await fixture('require("node:fs").writeFileSync("executed", "bad")');
    const approval = contractDigest(contract);
    contract.objective = 'Changed after approval';
    for (const approvedDigest of [undefined, approval]) {
      const receipt = await verifyContract(root, contract, { approvedDigest });
      expect(receipt.status).toBe('inconclusive');
      expect(receipt.commands).toEqual([]);
    }
    await expect(readFile(path.join(root, 'executed'))).rejects.toThrow();
  });

  it('reports missing executables, timeouts and missing criteria as inconclusive', async () => {
    const { root, contract } = await fixture();
    contract.commands[0]!.executable = 'proofrelay-no-such-executable';
    let receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract) });
    expect(receipt.status).toBe('inconclusive');
    expect(receipt.commands[0]?.exitCode).toBeNull();
    contract.commands[0] = { id: 'unit', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 40 };
    receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract) });
    expect(receipt.status).toBe('inconclusive');
    expect(receipt.commands[0]?.timedOut).toBe(true);
    contract.criteria = [];
    expect((await verifyContract(root, contract, { approvedDigest: contractDigest(contract) })).status).toBe('inconclusive');
  });

  it('marks a repository changed during verification as inconclusive', async () => {
    const { root, contract } = await fixture('require("node:fs").writeFileSync("source.txt", "changed")');
    const receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract) });
    expect(receipt.commands[0]?.exitCode).toBe(0);
    expect(receipt.status).toBe('inconclusive');
    expect(receipt.repository.beforeFingerprint).not.toBe(receipt.repository.afterFingerprint);
    expect(receipt.warnings.join(' ')).toContain('changed during verification');
  });

  it('requires trusted human review and redacts recorded output', async () => {
    const { root, contract } = await fixture('console.log("token=do-not-export")');
    contract.policy.requiresHumanReview = true;
    const options = { approvedDigest: contractDigest(contract) };
    expect((await verifyContract(root, contract, options)).status).toBe('inconclusive');
    const reviewed = await verifyContract(root, contract, { ...options, humanReviewApproved: true });
    expect(reviewed.status).toBe('pass');
    expect(JSON.stringify(reviewed)).not.toContain('do-not-export');
  });

  it('refuses to hash secret evidence and records no secret content', async () => {
    const { root, contract } = await fixture();
    await writeFile(path.join(root, '.env'), 'API_KEY=never-share-me');
    const receipt = await verifyContract(root, contract, { approvedDigest: contractDigest(contract), artifacts: ['.env'] });
    expect(receipt.status).toBe('inconclusive');
    expect(receipt.artifacts).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain('never-share-me');
  });
});
