import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MetadataSource, PackageMeta, VersionMeta } from '../types.js';

export interface RegistryOptions {
  registry?: string;
  /** undefined = default cache dir, null = no cache */
  cacheDir?: string | null;
  ttlMs?: number;
}

interface RawPackument {
  versions?: Record<
    string,
    {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      deprecated?: string
    }
  >;
}

function normalize(name: string, raw: RawPackument): PackageMeta {
  const versions: VersionMeta[] = Object.entries(raw.versions ?? {}).map(
    ([version, v]) => ({
      version,
      peerDependencies: v.peerDependencies ?? {},
      optionalPeers: Object.entries(v.peerDependenciesMeta ?? {})
        .filter(([, m]) => m?.optional)
        .map(([k]) => k),
      deprecated: Boolean(v.deprecated),
    }),
  );
  return { name, versions };
}

export class NpmRegistry implements MetadataSource {
  private readonly registry: string;
  private readonly cacheDir: string | null;
  private readonly ttlMs: number;

  constructor(opts: RegistryOptions = {}) {
    this.registry = (opts.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    this.cacheDir =
      opts.cacheDir === undefined
        ? join(homedir(), '.cache', 'upgrade-compass')
        : opts.cacheDir;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  }

  async get(name: string): Promise<PackageMeta | null> {
    const cached = await this.readCache(name);
    if (cached) return cached;

    const res = await fetch(`${this.registry}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Registry returned ${res.status} for ${name}`);

    const meta = normalize(name, (await res.json()) as RawPackument);
    await this.writeCache(name, meta);
    return meta;
  }

  private cachePath(name: string): string | null {
    return this.cacheDir ? join(this.cacheDir, `${encodeURIComponent(name)}.json`) : null;
  }

  private async readCache(name: string): Promise<PackageMeta | null> {
    const path = this.cachePath(name);
    if (!path) return null;
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs > this.ttlMs) return null;
      return JSON.parse(await readFile(path, 'utf8')) as PackageMeta;
    } catch {
      return null;
    }
  }

  private async writeCache(name: string, meta: PackageMeta): Promise<void> {
    const path = this.cachePath(name);
    if (!path || !this.cacheDir) return;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(path, JSON.stringify(meta));
    } catch {
      /* cache is best-effort */
    }
  }
}