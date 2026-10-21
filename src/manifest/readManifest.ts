import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import type { DepSpec, Manifest } from '../types.js';
import { collectOverrides } from './overrides.js';
import { parsePnpmLock } from './pnpmLock.js';

async function readJson(path: string): Promise<any | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}

async function readText(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
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
    const pnpmText = lock ? null : await readText(join(dir, 'pnpm-lock.yaml'));
    const pnpm = pnpmText ? parsePnpmLock(pnpmText) : null;

    const deps: DepSpec[] = [];
    for (const section of ['dependencies', 'devDependencies'] as const) {
        for (const [name, range] of Object.entries<string>(pkg[section] ?? {})) {
            let installed = lock ? lockedVersion(lock, name) : pnpm?.versions.get(name);
            if (!installed && semver.validRange(range)) {
                installed = semver.minVersion(range)?.version;
            }
            deps.push({ name, range, installed, section });
        }
    }

    // pnpm-workspace.yaml is optional and best-effort.
    let workspace: any;
    try {
        const text = await readText(join(dir, 'pnpm-workspace.yaml'));
        workspace = text ? parseYaml(text) : undefined;
    } catch {
        workspace = undefined;
    }

    // Least authoritative first; what the lockfile recorded wins.
    const overrides = collectOverrides(
        [pkg.resolutions, pkg.overrides, pkg.pnpm?.overrides, workspace?.overrides, pnpm?.overrides],
        Object.fromEntries(deps.map((d) => [d.name, d.range])),
    );

    return {
        name: pkg.name,
        deps,
        lockfile: lock ? 'package-lock' : pnpm ? 'pnpm-lock' : 'none',
        overrides,
    };
}