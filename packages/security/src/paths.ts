import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class SecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

const sensitiveDirectories = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', 'secrets', '.secrets']);
const sensitiveNames = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;

export function isSensitivePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/u).some((part) => sensitiveDirectories.has(part.toLowerCase()) || sensitiveNames.test(part));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve a workspace-relative path, including every existing symlink ancestor. */
export async function safePath(workspace: string, requested: string, options: { allowMissing?: boolean; allowSensitive?: boolean } = {}): Promise<string> {
  if (requested.includes('\0') || path.isAbsolute(requested) || path.win32.isAbsolute(requested) || requested.split(/[\\/]+/u).includes('..')) {
    throw new SecurityError('UNSAFE_PATH', 'Paths must be workspace-relative and must not contain traversal.');
  }
  if (!options.allowSensitive && isSensitivePath(requested)) {
    throw new SecurityError('SENSITIVE_PATH', 'Sensitive files cannot be read or exported.');
  }
  const root = await realpath(workspace);
  const parts = requested.split(/[\\/]+/u).filter((part) => part !== '' && part !== '.');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    current = path.join(current, part);
    try {
      current = await realpath(current);
    } catch (error) {
      if (options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const unresolved = await lstat(current).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code === 'ENOENT') return undefined;
          throw failure;
        });
        if (unresolved?.isSymbolicLink()) throw new SecurityError('DANGLING_SYMLINK', 'A dangling symlink cannot be used for a new workspace path.');
        return path.join(current, ...parts.slice(index + 1));
      }
      throw error;
    }
    if (!isWithin(root, current)) {
      throw new SecurityError('SYMLINK_ESCAPE', 'A symlink resolves outside the workspace.');
    }
    if (!options.allowSensitive && isSensitivePath(path.relative(root, current))) {
      throw new SecurityError('SENSITIVE_PATH', 'A symlink resolves to a sensitive file.');
    }
  }
  return current;
}

/** Hash only explicit, ordinary workspace files; never follow an unchecked final symlink. */
export async function sha256Artifact(workspace: string, relativePath: string): Promise<{ path: string; sha256: string; sizeBytes: number }> {
  const resolved = await safePath(workspace, relativePath);
  const before = await lstat(resolved);
  if (!before.isFile()) throw new SecurityError('NOT_REGULAR_FILE', 'Evidence must reference an ordinary file.');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev) {
      throw new SecurityError('FILE_CHANGED', 'Artifact changed while opening it.');
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new SecurityError('FILE_CHANGED', 'Artifact changed while hashing it.');
    }
    return { path: relativePath.replaceAll('\\', '/'), sha256: hash.digest('hex'), sizeBytes: after.size };
  } finally {
    await handle.close();
  }
}
