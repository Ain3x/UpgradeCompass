import { readManifest } from './manifest/readManifest.js';
import { resolveTarget, solve } from './solver/solve.js';
import { fetchBundled } from './registry/bundled.js';
import type { MetadataSource, PackageMeta, Plan, RawTarget } from './types.js';

export interface PlanOptions {
  dir: string;
  targets: string[];
  allowMajor?: boolean;
}

export function parseTarget(spec: string): RawTarget {
  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Invalid target "${spec}". Use package@range, e.g. expo@54`);
  }
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

async function fetchAll(
  names: string[],
  source: MetadataSource,
  concurrency = 8,
): Promise<Map<string, PackageMeta>> {
  const metas = new Map<string, PackageMeta>();
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((n) => source.get(n)));
    results.forEach((meta, idx) => {
      if (meta) metas.set(batch[idx], meta);
    });
  }
  return metas;
}

export async function runPlan(opts: PlanOptions, source: MetadataSource): Promise<Plan> {
  const manifest = await readManifest(opts.dir);
  if (manifest.lockfile === 'none') {
    console.error(
      'Note: no package-lock.json found; assuming the lowest version each range allows.',
    );
  }

  const rawTargets = opts.targets.map(parseTarget);
  const names = [...new Set([...manifest.deps.map((d) => d.name), ...rawTargets.map((t) => t.name)])];

  console.error(`Fetching metadata for ${names.length} packages...`);
  const metas = await fetchAll(names, source);

  const targets = rawTargets.map((t) => {
    const meta = metas.get(t.name);
    if (!meta) throw new Error(`Package "${t.name}" was not found in the registry`);
    const version = resolveTarget(meta, t.range);
    if (!version) throw new Error(`No stable version of ${t.name} matches "${t.range}"`);
    return { ...t, version };
  });

  const expo = targets.find((t) => t.name === 'expo');
  const bundled = expo ? await fetchBundled(expo.version) : undefined;
  if (expo && !bundled) console.error('Warning: could not load bundledNativeModules.json; SDK ranges not enforced.');

  return solve({ deps: manifest.deps, targets, metas, bundled, allowMajor: opts.allowMajor });
}