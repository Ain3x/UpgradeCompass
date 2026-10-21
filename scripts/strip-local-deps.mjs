import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) {
  console.error('Usage: node scripts/strip-local-deps.mjs <package.json> <outDir>');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(src, 'utf8'));
const local = /^(link:|file:|portal:|workspace:)/;
const removed = [];

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    if (local.test(spec)) {
      delete pkg[section][name];
      removed.push(`${name} (${spec})`);
    }
  }
}
delete pkg.workspaces; // npm would try to resolve folders that don't exist in the copy

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));
console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove');