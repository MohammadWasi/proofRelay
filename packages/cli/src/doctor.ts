import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { doctorProviders } from './integrations.js';

export async function doctor(workspace: string, serverPath: string) {
  const providers = await doctorProviders();
  const initialized = existsSync(join(workspace, '.proofrelay', 'state.sqlite'));
  let mcp: { ok: boolean; toolCount?: number; invocation?: unknown; error?: string } = { ok: false, error: 'Run proofrelay init first.' };
  if (initialized && existsSync(serverPath)) {
    const client = new Client({ name: 'proofrelay-doctor', version: '0.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--workspace', workspace, '--read-only'], stderr: 'pipe' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'relay_get_status', arguments: {} });
      mcp = { ok: !result.isError && tools.tools.some(tool => tool.name === 'relay_get_status'), toolCount: tools.tools.length, invocation: result.isError ? result : 'relay_get_status succeeded' };
    } catch (error) { mcp = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { await client.close(); }
  } else if (initialized) mcp.error = 'MCP build is missing. Run pnpm build.';
  return { node: process.version, platform: process.platform, workspace, initialized, mcp, providers,
    message: 'Local coordination requires no provider or account. Client discovery and trust prompts must also be checked inside each installed assistant.' };
}
