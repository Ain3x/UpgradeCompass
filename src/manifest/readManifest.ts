import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { DepSpec, Manifest } from '../types.js';

async function readJson(path: string): Promise<any | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}

function lockedVersion(lock: any, name: string): string | undefined {
    const v = 
        lock?.packages?.[`node_modules/${name}`]?.version ??
        lock?.dependencies?.[name]?.version;
    return typeof v === 'string' && semver.valid(v) ? v : undefined;
}

export async function readManifest(dir: string): Promise<Manifest> {
    const pkg = await readJson(join(dir, 'package.json'));
    if (!pkg) throw new Error(`No package.json found in ${dir}`);
    const lock = await readJson(join(dir, 'package-lock.json'));

    const deps: DepSpec[] = [];
    for (const section of ['dependencies', 'devDependencies'] as const) {
        for (const [name, range] of Object.entries<string>(pkg[section] ?? {})) {
            let installed = lockedVersion(lock, name);
            if (!installed && semver.validRange(range)) {
                installed = semver.minVersion(range)?.version;
            }
            deps.push({ name, range, installed, section });
        }
    }

    return { name: pkg.name, deps, lockfile: lock ? 'package-lock' : 'none'};
}