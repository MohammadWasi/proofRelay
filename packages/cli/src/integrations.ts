import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyEdits, modify, parseTree, type Node as JsonNode } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
export { doctorProviders } from '../../agent-adapters/src/index.js';

export type ClientName = 'claude' | 'codex';
export interface ConnectOptions {
  workspace: string;
  clients: ClientName[];
  serverPath: string;
  scope?: 'project' | 'user';
  dryRun?: boolean;
  uninstall?: boolean;
  homeDir?: string;
}
export interface ConfigChange {
  client: ClientName;
  path: string;
  action: 'create' | 'update' | 'remove' | 'unchanged';
  /** Only the managed entry: unrelated settings may contain credentials. */
  preview: string;
  backupPath?: string;
}
export interface ConnectResult {
  changes: ConfigChange[];
  dryRun: boolean;
  scope: 'project' | 'user';
  warnings: string[];
}
export class IntegrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

const begin = '# BEGIN ProofRelay managed MCP server';
const end = '# END ProofRelay managed MCP server';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// TOML tables deliberately have null prototypes in smol-toml 1.9+. Compare
// configuration values without weakening that parser-side prototype protection.
function sameConfig(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameConfig(actual[index], value));
  if (record(expected)) {
    return record(actual) && Object.keys(actual).length === Object.keys(expected).length
      && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && sameConfig(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
}

async function safePath(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new IntegrationError('UNSAFE_PATH', 'Configuration must remain inside its selected scope.');
  }
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new IntegrationError('UNSAFE_PATH', `Refusing symlink: ${cursor}`);
      if (cursor === path ? !stat.isFile() : !stat.isDirectory()) {
        throw new IntegrationError('UNSAFE_PATH', `Unexpected file type: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function rejectDuplicateKeys(node: JsonNode): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (keys.has(key)) throw new IntegrationError('INVALID_CONFIG', `Duplicate JSON key: ${key}`);
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

function editClaude(before: string | null, entry: Record<string, unknown>, uninstall: boolean): string {
  const source = before ?? '{}\n';
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { throw new IntegrationError('INVALID_CONFIG', 'Claude configuration must be valid JSON; no changes written.'); }
  if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) {
    throw new IntegrationError('INVALID_CONFIG', 'Claude configuration and mcpServers must be objects.');
  }
  const tree = parseTree(source);
  if (!tree) throw new IntegrationError('INVALID_CONFIG', 'Cannot parse Claude configuration.');
  rejectDuplicateKeys(tree);
  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  const existing = servers?.proofrelay;
  if (existing !== undefined && !sameConfig(existing, entry)) {
    throw new IntegrationError('CONFIG_CONFLICT', 'An existing Claude proofrelay entry differs. Resolve it manually; no changes written.');
  }
  if (uninstall ? existing === undefined : existing !== undefined) return source;
  return applyEdits(source, modify(source, ['mcpServers', 'proofrelay'], uninstall ? undefined : entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' },
  }));
}

function editCodex(before: string | null, entry: Record<string, unknown>, uninstall: boolean): string {
  const source = before ?? '';
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(source); }
  catch { throw new IntegrationError('INVALID_CONFIG', 'Codex configuration must be valid TOML; no changes written.'); }
  const servers = parsed.mcp_servers;
  if (servers !== undefined && !record(servers)) throw new IntegrationError('INVALID_CONFIG', 'mcp_servers must be a TOML table.');
  const existing = record(servers) ? servers.proofrelay : undefined;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...source.matchAll(new RegExp(`^${escaped(begin)}\\r?\\n[\\s\\S]*?^${escaped(end)}(?:\\r?\\n|$)`, 'gm'))];
  if ((source.includes(begin) || source.includes(end)) && blocks.length !== 1) {
    throw new IntegrationError('CONFIG_CONFLICT', 'Malformed ProofRelay markers in Codex configuration.');
  }
  if (existing !== undefined && !sameConfig(existing, entry)) {
    throw new IntegrationError('CONFIG_CONFLICT', 'An existing Codex proofrelay entry differs. Resolve it manually; no changes written.');
  }
  if (uninstall) {
    if (existing === undefined && blocks.length === 0) return source;
    if (blocks.length !== 1) throw new IntegrationError('CONFIG_CONFLICT', 'Uninstall will only remove a marked Codex entry installed by ProofRelay.');
    const block = blocks[0]!;
    // Do not remove unrelated settings inserted into the managed region.
    const blockParsed = parseToml(block[0]);
    if (!sameConfig(blockParsed, { mcp_servers: { proofrelay: entry } })) {
      throw new IntegrationError('CONFIG_CONFLICT', 'Managed Codex block contains other settings; remove it manually.');
    }
    return source.slice(0, block.index) + source.slice(block.index! + block[0].length);
  }
  if (existing !== undefined) return source;
  if (blocks.length) throw new IntegrationError('CONFIG_CONFLICT', 'Managed Codex block no longer contains its server.');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const block = [begin, '[mcp_servers.proofrelay]', `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`, end, ''].join(eol);
  const after = source + (source && !source.endsWith('\n') ? eol : '') + block;
  try { parseToml(after); }
  catch { throw new IntegrationError('CONFIG_CONFLICT', 'Cannot safely append a ProofRelay table to this TOML configuration.'); }
  return after;
}

/** Plans all changes before writing any. No client login or model invocation occurs. */
export async function connectClients(options: ConnectOptions): Promise<ConnectResult> {
  if (options.scope !== undefined && options.scope !== 'project' && options.scope !== 'user') {
    throw new IntegrationError('INVALID_SCOPE', 'Choose project or user scope.');
  }
  if (!options.clients.length || options.clients.some((client) => client !== 'claude' && client !== 'codex')) {
    throw new IntegrationError('INVALID_CLIENT', 'Choose claude, codex, or both.');
  }
  const scope = options.scope ?? 'project';
  const workspace = await realpath(resolve(options.workspace));
  const root = scope === 'project' ? workspace : await realpath(resolve(options.homeDir ?? homedir()));
  if (!(await lstat(root)).isDirectory()) throw new IntegrationError('UNSAFE_PATH', 'Selected configuration scope must be a directory.');
  if (scope === 'user' && !options.homeDir) {
    if (options.clients.includes('codex') && process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== join(root, '.codex')) {
      throw new IntegrationError('CUSTOM_CONFIG_HOME', 'CODEX_HOME selects a custom directory. Use project scope or configure the custom user location manually.');
    }
    if (options.clients.includes('claude') && process.env.CLAUDE_CONFIG_DIR && resolve(process.env.CLAUDE_CONFIG_DIR) !== join(root, '.claude')) {
      throw new IntegrationError('CUSTOM_CONFIG_HOME', 'CLAUDE_CONFIG_DIR selects a custom directory. Use project scope or configure the custom user location manually.');
    }
  }
  const serverPath = resolve(options.serverPath);
  if (!options.uninstall) {
    const serverStat = await lstat(serverPath).catch(() => null);
    if (!serverStat?.isFile()) throw new IntegrationError('SERVER_MISSING', `Build the MCP server first: ${serverPath}`);
  }
  const entry = { command: process.execPath, args: [serverPath, '--workspace', workspace] };
  const plans: { root: string; before: string | null; after: string; change: ConfigChange }[] = [];
  for (const client of [...new Set(options.clients)]) {
    const path = client === 'claude' ? join(root, scope === 'project' ? '.mcp.json' : '.claude.json') : join(root, '.codex', 'config.toml');
    await safePath(root, path);
    const before = await readOptional(path);
    const after = client === 'claude' ? editClaude(before, entry, options.uninstall ?? false) : editCodex(before, entry, options.uninstall ?? false);
    const unchanged = (before ?? (client === 'claude' ? '{}\n' : '')) === after;
    if (!unchanged && before !== null) await safePath(root, join(root, '.proofrelay', 'config-backups', 'preflight.bak'));
    plans.push({ root, before, after, change: {
      client, path,
      action: unchanged ? 'unchanged' : options.uninstall ? 'remove' : before === null ? 'create' : 'update',
      preview: options.uninstall ? 'Remove only the matching ProofRelay MCP entry.' : JSON.stringify({ proofrelay: entry }, null, 2),
    } });
  }
  if (!options.dryRun) {
    for (const plan of plans) {
      if (plan.change.action === 'unchanged') continue;
      const { path } = plan.change;
      await safePath(plan.root, path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const lockPath = `${path}.proofrelay.lock`;
      const lock = await open(lockPath, 'wx', 0o600).catch(() => {
        throw new IntegrationError('CONFIG_BUSY', `Configuration is locked: ${lockPath}. If no installer is running, inspect and remove the stale lock.`);
      });
      const tempPath = `${path}.proofrelay-${randomUUID()}.tmp`;
      try {
        await safePath(plan.root, path);
        if (await readOptional(path) !== plan.before) throw new IntegrationError('CONFIG_CHANGED', `Configuration changed during installation: ${path}`);
        if (plan.before !== null) {
          const backupPath = join(plan.root, '.proofrelay', 'config-backups', `${plan.change.client}-${randomUUID()}.bak`);
          await safePath(plan.root, backupPath);
          await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
          await writeFile(backupPath, plan.before, { flag: 'wx', mode: 0o600 });
          plan.change.backupPath = backupPath;
        }
        const mode = plan.before === null ? 0o600 : (await lstat(path)).mode & 0o777;
        await writeFile(tempPath, plan.after, { flag: 'wx', mode });
        if (await readOptional(path) !== plan.before) throw new IntegrationError('CONFIG_CHANGED', `Configuration changed during installation: ${path}`);
        await rename(tempPath, path);
      } finally {
        await unlink(tempPath).catch(() => undefined);
        await lock.close();
        await unlink(lockPath);
      }
    }
  }
  return {
    changes: plans.map((plan) => plan.change), dryRun: options.dryRun ?? false, scope,
    warnings: [
      'Restart the client and approve/trust the project through its native UI; ProofRelay does not bypass that step.',
      ...(scope === 'user' ? [`This user-scoped server is pinned to ${workspace}; use project scope for independent repositories.`] : []),
    ],
  };
}
