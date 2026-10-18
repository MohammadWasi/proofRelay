import type { TaskState, WorkContract } from '../../contracts/src/index.js';
import { RelayError } from './errors.js';

const transitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['ready', 'awaiting_approval', 'blocked', 'cancelled'],
  ready: ['claimed', 'verifying', 'awaiting_approval', 'blocked', 'cancelled', 'pending'],
  claimed: ['running', 'ready', 'awaiting_approval', 'verifying', 'blocked', 'cancelled', 'pending'],
  running: ['ready', 'awaiting_approval', 'verifying', 'failed', 'blocked', 'cancelled', 'pending'],
  awaiting_approval: ['ready', 'verifying', 'pending', 'blocked', 'cancelled'],
  verifying: ['passed', 'failed', 'blocked', 'ready', 'pending', 'cancelled'],
  passed: [],
  failed: ['ready', 'claimed', 'verifying', 'blocked', 'awaiting_approval', 'pending', 'cancelled'],
  blocked: ['ready', 'pending', 'awaiting_approval', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean { return from === to || transitions[from].includes(to); }
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new RelayError('INVALID_TRANSITION', `Cannot transition ${from} to ${to}`);
}

/** Validate all edges before a contract edit is persisted. */
export function assertAcyclicDependencies(contracts: readonly Pick<WorkContract, 'id' | 'dependencies'>[]): void {
  const graph = new Map(contracts.map(contract => [contract.id, contract.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new RelayError('DEPENDENCY_CYCLE', `Dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    const dependencies = graph.get(id);
    if (!dependencies) throw new RelayError('DEPENDENCY_BLOCKED', `Dependency ${id} does not exist`);
    visiting.add(id);
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}
