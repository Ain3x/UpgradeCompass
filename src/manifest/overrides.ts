import semver from 'semver';

// A plain package name, scoped or not. Rules out pnpm selectors ("foo@^1"),
// parent chains ("a>b") and Yarn nested paths ("a/b").
const PLAIN_NAME = /^(@[^/@\s]+\/)?[^/@>\s]+$/;

/** One override entry -> [package, range], or null when we can't use it
 *  (nested objects, "-", link:/npm:/file: specs, tags, "*"). `$name` refers to
 *  the range the project declares for that dependency. */
export function normalizeOverride(
  key: string,
  value: unknown,
  directRanges: Record<string, string>,
): [string, string] | null {
  const name = key.startsWith('**/') ? key.slice(3) : key;
  if (!PLAIN_NAME.test(name) || typeof value !== 'string') return null;

  let range = value.trim();
  if (range.startsWith('$')) range = directRanges[range.slice(1)] ?? '';
  const valid = range === '' ? null : semver.validRange(range);
  return valid === null || valid === '*' ? null : [name, range];
}

/** Merge override maps from several places. Later sources win, so pass the
 *  least authoritative first (package.json) and the lockfile's last. */
export function collectOverrides(
  sources: Array<Record<string, unknown> | undefined>,
  directRanges: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      const entry = normalizeOverride(key, value, directRanges);
      if (entry) out[entry[0]] = entry[1];
    }
  }
  return out;
}