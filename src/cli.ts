#!/usr/bin/env node
import { Command } from 'commander';
import { runPlan } from './plan.js';
import { formatPlan } from './report/format.js';
import { NpmRegistry } from './registry/registry.js';
import { createRequire } from 'node:module';
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const collect = (value: string, previous: string[]) => [...previous, value];

const program = new Command();
program
  .name('upgrade-compass')
  .description('Plan dependency upgrades toward a target and see what blocks them')
  .version(version);

program
  .command('plan')
  .description('Work out which dependencies fit a target and which ones block it')
  .option('-t, --target <package@range>', 'target to move to (repeatable)', collect, [] as string[])
  .option('-d, --dir <path>', 'project directory', process.cwd())
  .option('--registry <url>', 'npm registry URL', 'https://registry.npmjs.org')
  .option('--no-cache', 'skip the local metadata cache')
  .option('--json', 'print the plan as JSON')
  .option('--allow-major', 'allow major bumps for packages with no SDK range')
  .option('--strict-sdk', 'also downgrade packages that are newer than the SDK pin')
  .action(async (opts) => {
    if (opts.target.length === 0) {
      program.error('Provide at least one --target, e.g. -t expo@54');
    }
    const registry = new NpmRegistry({
      registry: opts.registry,
      cacheDir: opts.cache ? undefined : null,
    });
    try {
      const plan = await runPlan(
        { dir: opts.dir, targets: opts.target, allowMajor: opts.allowMajor, strictSdk: opts.strictSdk },
        registry,
      );
      console.log(opts.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      const failed = plan.items.some(
        (i) =>
          i.status === 'blocked' ||
          (i.status === 'target' && i.currentConflicts.some((c) => !c.optional)),
      );
      process.exitCode = failed ? 1 : 0;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 2;
    }
  });

await program.parseAsync();