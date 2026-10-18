import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { connectClients } from '../../packages/cli/src/integrations.js';

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'proofrelay-installer-')));
  roots.push(root);
  const serverPath = join(root, 'server.js');
  await writeFile(serverPath, '// fixture only\n');
  return { root, options: { workspace: root, clients: ['claude', 'codex'] as ('claude' | 'codex')[], serverPath } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('safe client installer', () => {
  it('previews without writing files, then creates both project config formats', async () => {
    const { root, options } = await fixture();
    const preview = await connectClients({ ...options, dryRun: true });
    expect(preview.changes.map((change) => change.action)).toEqual(['create', 'create']);
    expect(await readdir(root)).toEqual(['server.js']);
    await connectClients(options);
    const claude = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    const codex = parseToml(await readFile(join(root, '.codex/config.toml'), 'utf8'));
    expect(claude.mcpServers.proofrelay.args).toEqual([options.serverPath, '--workspace', root]);
    expect(codex.mcp_servers).toEqual(claude.mcpServers);
    expect(claude.mcpServers.proofrelay.command).toBe(process.execPath);
  });

  it('preserves unrelated JSON values and TOML comments byte-for-byte, backs up, and is idempotent', async () => {
    const { root, options } = await fixture();
    const json = '{\n  "custom": { "retained": true },\n  "mcpServers": { "other": {"command":"keep","env":{"TOKEN":"fixture-private-value"}} }\n}\n';
    const toml = '# User settings\nmodel = "user-choice"\n\n[mcp_servers.other]\ncommand = "keep" # preserve comment\n';
    await writeFile(join(root, '.mcp.json'), json);
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex/config.toml'), toml);
    const first = await connectClients(options);
    expect(first.changes.every((change) => change.backupPath)).toBe(true);
    expect(await readFile(first.changes[0]!.backupPath!, 'utf8')).toBe(json);
    expect(await readFile(first.changes[1]!.backupPath!, 'utf8')).toBe(toml);
    expect((await readFile(join(root, '.codex/config.toml'), 'utf8')).startsWith(toml)).toBe(true);
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toContain('"custom": { "retained": true }');
    expect(JSON.stringify(first)).not.toContain('fixture-private-value');
    const second = await connectClients(options);
    expect(second.changes.every((change) => change.action === 'unchanged' && !change.backupPath)).toBe(true);
    const removed = await connectClients({ ...options, uninstall: true });
    expect(removed.changes.map((change) => change.action)).toEqual(['remove', 'remove']);
    expect(await readFile(join(root, '.codex/config.toml'), 'utf8')).toBe(toml);
    const restored = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    expect(restored).toEqual(JSON.parse(json));
    expect((await connectClients({ ...options, uninstall: true })).changes.every((change) => change.action === 'unchanged')).toBe(true);
  });

  it('does not change the first client if the second client conflicts', async () => {
    const { root, options } = await fixture();
    await mkdir(join(root, '.codex'));
    const original = '[mcp_servers.proofrelay]\ncommand = "user-managed"\n';
    await writeFile(join(root, '.codex/config.toml'), original);
    await expect(connectClients(options)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect(await readdir(root)).not.toContain('.mcp.json');
    expect(await readFile(join(root, '.codex/config.toml'), 'utf8')).toBe(original);
  });

  it('only writes user configuration when explicitly selected and preserves unrelated preferences', async () => {
    const { root, options } = await fixture();
    const homeDir = join(root, 'fixture-home'); await mkdir(homeDir);
    await writeFile(join(homeDir, '.claude.json'), '{"preferences":{"theme":"dark"},"projects":{"example":{}}}\n');
    const result = await connectClients({ ...options, scope: 'user', homeDir });
    expect(result.scope).toBe('user');
    expect(result.warnings.join(' ')).toContain('pinned');
    expect(JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8')).preferences.theme).toBe('dark');
    expect(await readdir(root)).not.toContain('.mcp.json');
    expect(result.changes[1]!.path).toBe(join(homeDir, '.codex/config.toml'));
  });

  it.each(['{"mcpServers":[],"custom":true}', '{"mcpServers":{},"mcpServers":{}}', '{broken'])('rejects unsafe JSON without clobbering it: %s', async (json) => {
    const { root, options } = await fixture(); await writeFile(join(root, '.mcp.json'), json);
    await expect(connectClients(options)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe(json);
  });

  it('refuses a symlinked configuration directory', async () => {
    const { root, options } = await fixture();
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(root, '.codex'), 'dir');
    await expect(connectClients(options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not remove unrelated content inserted in a managed block', async () => {
    const { root, options } = await fixture(); await connectClients(options);
    const path = join(root, '.codex/config.toml');
    const changed = (await readFile(path, 'utf8')).replace('# END ProofRelay', '[unrelated]\nsetting = true\n# END ProofRelay');
    await writeFile(path, changed);
    await expect(connectClients({ ...options, uninstall: true })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect(await readFile(path, 'utf8')).toBe(changed);
    expect(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers.proofrelay).toBeDefined();
  });

  it('fails when the built server is missing and leaves no client settings', async () => {
    const { root, options } = await fixture();
    await expect(connectClients({ ...options, serverPath: join(root, 'missing.js') })).rejects.toMatchObject({ code: 'SERVER_MISSING' });
    expect(await readdir(root)).toEqual(['server.js']);
  });
  it('rejects a symlinked backup directory before changing either configuration', async () => {
    const { root, options } = await fixture();
    await writeFile(join(root, '.mcp.json'), '{}\n');
    const outside = join(root, 'outside'); await mkdir(outside);
    await symlink(outside, join(root, '.proofrelay'), 'dir');
    await expect(connectClients(options)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe('{}\n');
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(root)).not.toContain('.codex');
  });

  it.runIf(process.env.PROOFRELAY_NATIVE_CODEX === '1')('NATIVE OPT-IN: installed Codex discovers project configuration without invoking a model or server', async () => {
    const { root, options } = await fixture();
    const fixtureCodexHome = join(root, 'isolated-codex-home');
    await mkdir(fixtureCodexHome);
    // Only the child process sees this home. The developer's configuration is untouched.
    await writeFile(join(fixtureCodexHome, 'config.toml'), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
    await writeFile(options.serverPath, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'server-started'))}, 'unexpected launch');\n`);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await connectClients({ ...options, clients: ['codex'] });
    const childOptions = { cwd: root, env: { ...process.env, CODEX_HOME: fixtureCodexHome }, timeout: 10_000, encoding: 'utf8' as const };
    const listed = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], childOptions));
    const retrieved = JSON.parse(execFileSync('codex', ['mcp', 'get', 'proofrelay', '--json'], childOptions));
    const expected = { name: 'proofrelay', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [options.serverPath, '--workspace', root] } };
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'proofrelay', enabled: true })]));
    expect(retrieved).toMatchObject(expected);
    expect(await readdir(root)).not.toContain('server-started');
  });
});
