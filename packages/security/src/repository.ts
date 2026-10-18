import { createHash } from 'node:crypto';
import { lstat, readlink, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSensitivePath, safePath, sha256Artifact } from './paths.js';
import { commandEnvironment, runSafeCommand } from './process.js';

const execFileAsync = promisify(execFile);

export interface RepositorySnapshot {
  fingerprint: string;
  revision?: string;
  files: string[];
  excluded: string[];
}

const excludedDirectories = new Set(['.git', '.proofrelay', 'node_modules']);
function excluded(relative: string): boolean {
  return isSensitivePath(relative) || relative.split('/').some((part) => excludedDirectories.has(part));
}

export async function snapshotRepository(workspace: string): Promise<RepositorySnapshot> {
  const root = await realpath(workspace);
  let names: string[];
  const skipped: string[] = [];
  try {
    // Private raw capture preserves NUL delimiters. This fixed Git invocation cannot execute
    // repository hooks; disabling fsmonitor also prevents its optional external helper.
    const git = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, env: commandEnvironment(), shell: false, timeout: 10_000, maxBuffer: 16_777_216, encoding: 'utf8',
    });
    names = git.stdout.split('\0').filter(Boolean);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT' || failure.stderr?.includes('not a git repository')) names = await inventory(root, '', skipped);
    else throw new Error('Cannot safely inventory the repository.', { cause: error });
  }
  const revisionResult = await runSafeCommand(root, { executable: 'git', args: ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], timeoutMs: 10_000 });
  const revision = revisionResult.status === 'completed' && revisionResult.exitCode === 0 && /^[a-f\d]{40,64}$/u.test(revisionResult.stdout.trim()) ? revisionResult.stdout.trim() : undefined;
  const hash = createHash('sha256');
  const files: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    if (excluded(name)) { skipped.push(name); continue; }
    // Resolve parents before lstat, without dereferencing a final symlink.
    const parent = await safePath(root, path.dirname(name), { allowMissing: true });
    const absolute = path.join(parent, path.basename(name));
    let entry;
    try { entry = await lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update(JSON.stringify([name, 'missing'])); continue; }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      // Record link identity without opening the target, which can be outside the workspace.
      hash.update(JSON.stringify([name, 'symlink', await readlink(absolute)]));
      files.push(name);
    } else if (entry.isFile()) {
      const artifact = await sha256Artifact(root, name);
      hash.update(JSON.stringify([name, artifact.sha256, entry.mode & 0o111]));
      files.push(name);
    } else if (!entry.isDirectory()) {
      skipped.push(name);
    }
  }
  return { fingerprint: hash.digest('hex'), ...(revision === undefined ? {} : { revision }), files, excluded: [...new Set(skipped)].sort() };
}

async function inventory(root: string, directory: string, skipped: string[]): Promise<string[]> {
  const entries = await readdir(await safePath(root, directory || '.'), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (excluded(relative)) { skipped.push(relative); continue; }
    if (entry.isDirectory()) names.push(...await inventory(root, relative, skipped));
    else names.push(relative);
  }
  return names;
}
