import { readFile, writeFile } from 'node:fs/promises';
const withModel = process.argv.includes('--semantic');
const entry = await readFile(new URL('../worker/' + (withModel ? 'model-api.js' : 'index.js'), import.meta.url), 'utf8');
if (!entry.startsWith('import ') || !entry.includes("from './routing-core.mjs';")) throw new Error('Unexpected worker import');
const stripImports = source => source.replace(/^import [^\n]+from '\.\/(?:routing-core|semantic-review)\.mjs';\n/gm, '');
const modules = await Promise.all((withModel ? ['routing-core.mjs', 'semantic-review.mjs'] : ['routing-core.mjs']).map(name => readFile(new URL('../worker/' + name, import.meta.url), 'utf8')));
const output = modules.map(source => stripImports(source).replace(/^export /gm, '')).join('\n') + '\n' + stripImports(entry);
await writeFile(new URL('../dist/server/index.js', import.meta.url), output);
