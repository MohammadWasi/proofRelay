import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore } from '../../packages/storage/src/index.js';
import { RelayService } from '../../packages/workflows/src/index.js';

const exec = promisify(execFile);
const temporary: string[] = [];
const stores: RelayStore[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proofrelay-service-security-'));
  temporary.push(root);
  const store = new RelayStore(root);
  stores.push(store);
  return { root, store, relay: new RelayService(root, store) };
}
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('handoff verification provenance', () => {
  it('does not describe changed source as completed based on an earlier passing receipt', async () => {
    const { root, store, relay } = await fixture();
    await writeFile(join(root, 'source.txt'), 'verified source');
    const work = await relay.createWork({
      objective: 'Verify the current source',
      commands: [{ id: 'test', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
      criteria: [{ id: 'acceptance', description: 'Configured check passes', commandIds: ['test'] }],
    });
    store.approve(work.approval!.id);
    expect((await relay.verify(work.contract.id)).status).toBe('pass');
    await writeFile(join(root, 'source.txt'), 'changed after verification');
    const handoff = await relay.createHandoff(work.contract.id);
    expect(handoff.completedTasks).not.toContain(work.contract.id);
    expect(handoff.unfinishedTasks).toContain(work.contract.id);
    expect(handoff.outstandingCriteria).toContain('acceptance');
    expect(handoff.warnings.join(' ')).toMatch(/stale|changed|different|earlier|older/i);
  });

  it('reports stale when HEAD changes without a content change', async () => {
    const { root, relay } = await fixture();
    await exec('git', ['init', '--quiet'], { cwd: root });
    const commit = () => exec('git', ['-c', 'user.name=ProofRelay test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Snapshot'], { cwd: root });
    await commit();
    const work = await relay.createWork({ objective: 'Continue after revision change' });
    const handoff = await relay.createHandoff(work.contract.id);
    expect((await relay.getHandoff(handoff.id)).stale).toBe(false);
    await commit();
    expect((await relay.getHandoff(handoff.id)).stale).toBe(true);
  });
});
