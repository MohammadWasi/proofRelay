import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
// npm_execpath is the package manager JS entry point, avoiding shell/cmd interpolation on Windows.
if (!process.env.npm_execpath) throw new Error('Run this script with pnpm audit:licenses.');
const inventory = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'licenses', 'list', '--prod', '--json'], { encoding: 'utf8' }));
const allowed = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD']);
const unexpected = Object.keys(inventory).filter(license => !allowed.has(license));
if (unexpected.length) throw new Error(`Review unexpected runtime licenses before distribution: ${unexpected.join(', ')}`);
const rows = Object.entries(inventory).flatMap(([license, dependencies]) => dependencies.map(item => ({ name: item.name, versions: item.versions, license, homepage: item.homepage })));
await writeFile('docs/dependency-licenses.json', JSON.stringify(rows, null, 2) + '\n');
console.log(`Reviewed ${rows.length} runtime packages: ${Object.keys(inventory).sort().join(', ')}. Inventory: docs/dependency-licenses.json`);
