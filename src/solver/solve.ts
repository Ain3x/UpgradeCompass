import semver from 'semver';
import type {
  Conflict,
  DepSpec,
  MissingPeer,
  PackageMeta,
  Plan,
  PlanItem,
  Target,
  VersionMeta,
} from '../types.js';

type Index = Map<string, Map<string, VersionMeta>>;

const MAX_ITERATIONS = 25;
const GROUP_BUDGET = 20000;
const MAX_SKIPS = 4;

export interface SolveInput {
  deps: DepSpec[];
  targets: Target[];
  metas: Map<string, PackageMeta>;
  bundled?: Record<string, string>;
  allowMajor?: boolean;
  /** Enforce SDK pins even when the installed version is newer than the pin. */
  strictSdk?: boolean;
  overrides?: Record<string, string>;
}

/** Highest stable version of a package that satisfies the range. */
export function resolveTarget(meta: PackageMeta, range: string): string | undefined {
  return meta.versions
    .map((v) => v.version)
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.rcompare)
    .find((v) => semver.satisfies(v, range));
}

function satisfies(version: string, range: string): boolean {
  // Tags, URLs and workspace specs can't be judged, so don't report a conflict.
  if (semver.validRange(range) === null) return true;
  return semver.satisfies(version, range, { includePrerelease: true });
}

function buildIndex(metas: Map<string, PackageMeta>): Index {
  const index: Index = new Map();
  for (const [name, meta] of metas) {
    index.set(name, new Map(meta.versions.map((v) => [v.version, v])));
  }
  return index;
}

/** Conflicts that must be resolved. Optional-peer mismatches are only warnings. */
const hard = (cs: Conflict[]): Conflict[] => cs.filter((c) => !c.optional);

/** The "breaking change boundary": the major, or the minor while on 0.x. */
function compatLine(version: string): string {
  const major = semver.major(version);
  return major > 0 ? String(major) : `0.${semver.minor(version)}`;
}

/** Versions we may move to, in the order we'd like to pick them. Without an SDK
 *  range: never a downgrade, no prereleases or deprecated versions unless already
 *  on one. When capped, versions inside the current breaking-change line come
 *  first (newest first), then the nearest higher lines, so a major bump is only
 *  chosen when nothing in the current line fits. With an SDK range: anything
 *  inside it, even if that means going down. */
function candidatesFor(
  name: string,
  installed: string,
  index: Index,
  capMajor: boolean,
  sdkRange?: string,
): string[] {
  const versions = index.get(name);
  if (!versions) return [];
  const allowPrerelease = semver.prerelease(installed) !== null;
  const all = [...versions.values()]
    .filter((v) => semver.valid(v.version))
    .filter((v) =>
      sdkRange
        ? v.version === installed || satisfies(v.version, sdkRange)
        : semver.gte(v.version, installed),
    )
    .filter(
      (v) =>
        v.version === installed ||
        (!v.deprecated && (allowPrerelease || semver.prerelease(v.version) === null)),
    )
    .map((v) => v.version)
    .sort(semver.rcompare);

  if (sdkRange || !capMajor) return all;

  const line = compatLine(installed);
  const inLine = all.filter((v) => compatLine(v) === line);
  const higher = new Map<string, string[]>();
  for (const v of all) {
    const l = compatLine(v);
    if (l !== line) higher.set(l, [...(higher.get(l) ?? []), v]);
  }
  // `all` is newest-first, so reversing the lines puts the nearest one first.
  return [...inLine, ...[...higher.values()].reverse().flat()];
}

/** Everything wrong with putting `name@version` into the current assignment:
 *  the SDK pin, its own peer ranges, and other packages whose peer ranges name it.
 *  A version that matches the SDK pin is authoritative: third-party packages
 *  that disagree with it are the ones that get blamed, not the pinned package. */
function conflictsFor(
  name: string,
  version: string,
  assignment: Map<string, string>,
  index: Index,
  bundled: Record<string, string> = {},
): Conflict[] {
  const out: Conflict[] = [];
  const sdk = bundled[name];
  const pinned = sdk !== undefined && satisfies(version, sdk);
  if (sdk !== undefined && !pinned) {
    out.push({ kind: 'sdk', peer: name, range: sdk, actual: version });
  }

  const own = index.get(name)?.get(version);
  if (own) {
    for (const [peer, range] of Object.entries(own.peerDependencies)) {
      const actual = assignment.get(peer);
      if (actual && !satisfies(actual, range)) {
        out.push({
          kind: 'own-peer',
          peer,
          range,
          actual,
          ...(own.optionalPeers?.includes(peer) ? { optional: true } : {}),
        });
      }
    }
  }

  for (const [other, otherVersion] of assignment) {
    if (other === name) continue;
    if (pinned && bundled[other] === undefined) continue;
    const otherMeta = index.get(other)?.get(otherVersion);
    const range = otherMeta?.peerDependencies[name];
    if (range && !satisfies(version, range)) {
      out.push({
        kind: 'required-by',
        peer: name,
        range,
        actual: version,
        by: `${other}@${otherVersion}`,
        ...(otherMeta?.optionalPeers?.includes(name) ? { optional: true } : {}),
      });
    }
  }

  return out;
}

/** Groups of movable packages linked by real (non-`*`) peer ranges. */
function components(movable: string[], candidates: Map<string, string[]>, index: Index): string[][] {
  const parent = new Map(movable.map((n) => [n, n] as const));
  const find = (n: string): string => (parent.get(n) === n ? n : find(parent.get(n)!));
  for (const n of movable) {
    for (const v of candidates.get(n)!) {
      for (const [peer, range] of Object.entries(index.get(n)?.get(v)?.peerDependencies ?? {})) {
        if (range !== '*' && parent.has(peer)) parent.set(find(n), find(peer));
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const n of movable) groups.set(find(n), [...(groups.get(find(n)) ?? []), n]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Backtracking search for a consistent set of versions for a whole group.
 *  Members that cannot fit at all may be skipped (sidelined), but we look for
 *  the answer that skips the fewest, so one hopeless library can't veto the rest. */
function solveGroup(
  group: string[],
  candidates: Map<string, string[]>,
  assignment: Map<string, string>,
  index: Index,
  bundled: Record<string, string>,
): { trial: Map<string, string>; skipped: Set<string> } | null {
  // Assign the packages that others depend on first. When two packages disagree,
  // the one that declares the unmet peer range is then the one that gets skipped
  // and reported, rather than the package it depends on.
  const dependents = new Map(group.map((n) => [n, new Set<string>()] as const));
  for (const n of group) {
    for (const v of candidates.get(n)!) {
      for (const [peer, range] of Object.entries(index.get(n)?.get(v)?.peerDependencies ?? {})) {
        if (range !== '*' && peer !== n) dependents.get(peer)?.add(n);
      }
    }
  }
  const order = [...group].sort(
    (a, b) => dependents.get(b)!.size - dependents.get(a)!.size || a.localeCompare(b),
  );

  for (let maxSkips = 0; maxSkips <= Math.min(MAX_SKIPS, group.length); maxSkips++) {
    const trial = new Map(assignment);
    for (const n of group) trial.delete(n); // unassigned members must not constrain others
    const skipped = new Set<string>();
    let budget = GROUP_BUDGET;

    const dfs = (i: number): boolean => {
      if (i === order.length) return true;
      const name = order[i];
      for (const v of candidates.get(name)!) {
        if (budget-- <= 0) return false;
        if (hard(conflictsFor(name, v, trial, index, bundled)).length > 0) continue;
        trial.set(name, v);
        if (dfs(i + 1)) return true;
        trial.delete(name);
      }
      if (skipped.size < maxSkips) {
        skipped.add(name);
        if (dfs(i + 1)) return true;
        skipped.delete(name);
      }
      return false;
    };

    if (dfs(0)) return { trial, skipped };
  }
  return null;
}

/** Required peers of the planned versions that the project does not declare.
 *  Optional peers are ignored. Peers of the missing packages are not followed. */
function collectMissingPeers(
  names: Set<string>,
  finalVersion: (name: string) => string | undefined,
  index: Index,
  bundled: Record<string, string>,
): MissingPeer[] {
  const found = new Map<string, MissingPeer>();
  for (const name of names) {
    const version = finalVersion(name);
    const meta = version ? index.get(name)?.get(version) : undefined;
    if (!version || !meta) continue;
    for (const [peer, range] of Object.entries(meta.peerDependencies)) {
      if (names.has(peer) || meta.optionalPeers?.includes(peer)) continue;
      const entry = found.get(peer) ?? { name: peer, sdkRange: bundled[peer], requiredBy: [] };
      entry.requiredBy.push({ by: `${name}@${version}`, range });
      found.set(peer, entry);
    }
  }
  for (const m of found.values()) m.requiredBy.sort((a, b) => a.by.localeCompare(b.by));
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function solve({
  deps,
  targets,
  metas,
  bundled: bundledIn = {},
  allowMajor = false,
  strictSdk = false,
  overrides = {},
}: SolveInput): Plan {
  const index = buildIndex(metas);
  const pinned = new Map(targets.map((t) => [t.name, t.version] as const));

  const installed = new Map<string, string>();
  const frozen = new Set<string>(); // can't be re-evaluated (no metadata, odd spec)
  for (const d of deps) {
    if (d.installed) installed.set(d.name, d.installed);
    if (!d.installed || !index.get(d.name)?.has(d.installed)) frozen.add(d.name);
  }

  // Packages already newer than the SDK's pin are left alone (reported as AHEAD)
  // unless --strict-sdk is given: downgrading them is rarely what a project wants,
  // and it can itself create conflicts with libraries that need the newer version.
  // Overrides are the project's own decision, so they beat the SDK's pin.
  const overridden = new Set<string>();
  const bundled: Record<string, string> = { ...bundledIn };
  for (const [name, range] of Object.entries(overrides)) {
    if (semver.validRange(range) === null) continue;
    bundled[name] = range;
    overridden.add(name);
  }

  const ahead = new Set<string>();
  if (!strictSdk) {
    for (const [name, range] of Object.entries(bundledIn)) {
      if (overridden.has(name)) continue;
      const inst = installed.get(name);
      if (
        inst &&
        semver.validRange(range) !== null &&
        !satisfies(inst, range) &&
        semver.gtr(inst, range, { includePrerelease: true })
      ) {
        ahead.add(name);
        delete bundled[name];
      }
    }
  }

  const assignment = new Map(installed);
  for (const [name, version] of pinned) assignment.set(name, version);

  const candidates = new Map<string, string[]>();
  const movable: string[] = [];
  for (const name of assignment.keys()) {
    if (pinned.has(name) || frozen.has(name)) continue;
    const capMajor = !allowMajor && !bundled[name];
    candidates.set(
      name,
      ahead.has(name)
        ? [installed.get(name)!]
        : candidatesFor(name, installed.get(name)!, index, capMajor, bundled[name]),
    );
    movable.push(name);
  }
  movable.sort();

  // Packages with no version that fits. They stay at their installed version in
  // the report but are kept out of `assignment` so they can't veto their neighbours.
  const sidelined = new Set<string>();

  // Joint solve for mutually dependent groups (firebase, router + metro-runtime,
  // reanimated + worklets)
  for (const g of components(movable, candidates, index)) {
    const res = solveGroup(g, candidates, assignment, index, bundled);
    if (!res) continue;
    for (const n of g) {
      if (res.skipped.has(n)) {
        assignment.delete(n);
        sidelined.add(n);
      } else {
        assignment.set(n, res.trial.get(n)!);
      }
    }
  }

  // Re-pick each package's best version until nothing changes. One package
  // moving can change what its neighbours allow, hence the loop.
  let converged = false;
  for (let i = 0; i < MAX_ITERATIONS && !converged; i++) {
    converged = true;
    for (const name of movable) {
      const best = candidates
        .get(name)!
        .find((v) => hard(conflictsFor(name, v, assignment, index, bundled)).length === 0);
      if (best === undefined) {
        if (assignment.has(name)) {
          assignment.delete(name);
          sidelined.add(name);
          converged = false;
        }
      } else if (assignment.get(name) !== best) {
        assignment.set(name, best);
        sidelined.delete(name);
        converged = false;
      }
    }
  }

  const tag = (name: string, cs: Conflict[]): Conflict[] =>
    overridden.has(name)
      ? cs.map((c) => (c.kind === 'sdk' ? { ...c, source: 'override' as const } : c))
      : cs;

  const items: PlanItem[] = [];
  const names = new Set([...deps.map((d) => d.name), ...targets.map((t) => t.name)]);

  for (const name of names) {
    const from = installed.get(name);

    if (pinned.has(name)) {
      const to = pinned.get(name)!;
      items.push({
        name,
        status: 'target',
        from,
        to,
        currentConflicts: conflictsFor(name, to, assignment, index, bundled),
        latestConflicts: [],
      });
    } else if (frozen.has(name)) {
      items.push({ name, status: 'unknown', from, currentConflicts: [], latestConflicts: [] });
    } else {
      const final = sidelined.has(name) ? installed.get(name)! : assignment.get(name)!;
      const currentConflicts = tag(name, conflictsFor(name, final, assignment, index, bundled));
      // For AHEAD packages, `latest` is the version Expo recommends, and
      // `latestConflicts` says what following that recommendation would break.
      const latest = ahead.has(name)
        ? candidatesFor(name, installed.get(name)!, index, false, bundledIn[name]).find(
          (v) => v !== installed.get(name),
        )
        : [...candidates.get(name)!].sort(semver.rcompare)[0];
      const status =
        hard(currentConflicts).length > 0
          ? 'blocked'
          : final !== from
            ? 'upgrade'
            : ahead.has(name)
              ? 'ahead'
              : overridden.has(name)
                ? 'pinned'
                : 'ok';
      items.push({
        name,
        status,
        from,
        to: status === 'blocked' ? undefined : final,
        latest,
        sdkRange: ahead.has(name) ? bundledIn[name] : undefined,
        overrideRange: overridden.has(name) ? bundled[name] : undefined,
        currentConflicts,
        latestConflicts:
          latest && latest !== final
            ? tag(name, conflictsFor(name, latest, assignment, index, bundled))
            : [],
      });
    }
  }

  const missingPeers = collectMissingPeers(
    names,
    (n) => pinned.get(n) ?? (frozen.has(n) || sidelined.has(n) ? undefined : assignment.get(n)),
    index,
    bundledIn,
  );

  return { targets, items, converged, missingPeers };
}