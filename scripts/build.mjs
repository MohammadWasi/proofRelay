import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: { cli: 'packages/cli/src/index.ts', mcp: 'packages/mcp-server/src/index.ts' },
  bundle: true, packages: 'external', platform: 'node', target: 'node24',
  format: 'esm', sourcemap: true, outdir: 'dist',
});
await Promise.all(['cli', 'mcp'].map(name => chmod(`dist/${name}.js`, 0o755)));
