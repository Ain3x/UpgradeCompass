import semver from 'semver';
import { parseAllDocuments } from 'yaml';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface PnpmLock {
  /** Installed version of each direct dependency. */
  versions: Map<string, string>;
  /** The `overrides` map recorded in the lockfile (raw, not yet validated). */
  overrides: Record<string, unknown>;
}

function hasDeps(importer: any): boolean {
  return SECTIONS.some((s) => importer?.[s] && Object.keys(importer[s]).length > 0);
}

/** Reads one project out of a pnpm-lock.yaml (lockfile v6 and newer). pnpm 11 can
 *  write several YAML documents into one file (the first one describes pnpm itself),
 *  so we look for the document that holds the project's dependencies.
 *  Returns null when the format isn't understood. */
export function parsePnpmLock(text: string, importerId = '.'): PnpmLock | null {
  for (const document of parseAllDocuments(text).reverse()) {
    const doc = document.toJS() as any;
    if (parseInt(String(doc?.lockfileVersion ?? '0'), 10) < 6) continue;

    // Workspaces and v9 use `importers`; single-project v6 keeps the sections at the top.
    const importer = doc?.importers ? doc.importers[importerId] : doc;
    if (!hasDeps(importer)) continue;

    const versions = new Map<string, string>();
    for (const section of SECTIONS) {
      for (const [name, entry] of Object.entries<any>(importer[section] ?? {})) {
        // "19.2.3(react@19.2.3)": drop the peer-resolution suffix.
        const version = String(entry?.version ?? '').split('(')[0];
        if (semver.valid(version)) versions.set(name, version);
      }
    }
    return { versions, overrides: doc.overrides ?? {} };
  }
  return null;
}