import { readFile, writeFile } from 'node:fs/promises';
const core = await readFile(new URL('../worker/routing-core.mjs', import.meta.url), 'utf8');
const entry = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
if (!entry.startsWith('import ') || !entry.includes("from './routing-core.mjs';")) throw new Error('Unexpected worker import');
const output = core.replace(/^export /gm, '') + '\nconst cleaned = normalize;\n' +
  entry.replace(/^import [^\n]+from '\.\/routing-core\.mjs';\n/, '');
await writeFile(new URL('../dist/server/index.js', import.meta.url), output);
