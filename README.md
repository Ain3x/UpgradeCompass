# upgrade-compass

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

**Moving to Expo SDK 57? See what moves with it and what blocks you, before you touch `package.json`.**

`upgrade-compass` is a CLI that plans a dependency upgrade toward a target (for example `expo@57`). It reads your project, pulls peer-dependency metadata from the npm registry, and tells you which packages can upgrade, which are already fine, and which have **no release that fits**, with the exact constraint that blocks each one.

```bash
upgrade-compass plan -t expo@57
```

<!-- TODO: add a terminal GIF of a real run here -->

## Why

Upgrading a React Native / Expo app is a constraint puzzle. Everything peer-depends on everything else, and the SDK pins specific versions of dozens of native modules.

Existing tools answer neighbouring questions:

- `npm-check-updates` and Renovate tell you what is **newest**.
- `expo-doctor` and `expo install --check` tell you what is **wrong with the SDK you're on**.
- npm itself reports **one** `ERESOLVE` conflict at a time.

`upgrade-compass` answers a different one: *if I move to this target, what has to move with it, and what stops me?* It is meant to complement those tools, not replace them.

## Example

Abridged output from a real run against Bluesky's open-source app (pnpm, 215 direct dependencies, run on the project as it is, with no changes):

```text
$ upgrade-compass plan -t expo@57 -d ./social-app

Targets: expo@57.0.30

TARGET    expo                              57.0.24 -> 57.0.30
BLOCKED   @bsky.app/expo-dynamic-app-icon   1.8.5 (no compatible release)
BLOCKED   @emoji-mart/react                 1.1.1 (no compatible release)
UPGRADE   expo-modules-core                 57.0.18 -> 57.0.23
AHEAD     react-native-gesture-handler      3.3.0 (SDK pins ~2.32.0)
PINNED    react-native-reanimated           4.7.1 (override 4.7.1)
OK        react                             19.2.3
...

Blockers
  @bsky.app/expo-dynamic-app-icon@1.8.5
    - this version needs expo ^52 || ^53 || ^54, plan has 57.0.30
  @emoji-mart/react@1.1.1
    - this version needs react ^16.8 || ^17 || ^18, plan has 19.2.3
```

The full run reported three blockers (two are shown above). Each is a declared peer range that the plan violates and that no newer release of that package fixes. Some may be stale ranges the app already runs with today (a library that lists React 18 but works on React 19, for example), so read `BLOCKED` as "check this one", not as "this will break".

## Install

Not published to npm yet. From source:

```bash
git clone https://github.com/Ain3x/upgrade-compass.git
cd upgrade-compass
npm install
npm run dev -- plan -t expo@57 -d /path/to/your/project
```

Or build it:

```bash
npm run build
node dist/cli.js plan -t expo@57 -d /path/to/your/project
```

Requires Node 20 or newer.

## Usage

```text
upgrade-compass plan [options]

  -t, --target <package@range>   target to move to (repeatable)
  -d, --dir <path>               project directory (default: current directory)
  --registry <url>               npm registry URL (default: https://registry.npmjs.org)
  --no-cache                     skip the local metadata cache
  --json                         print the plan as JSON
  --allow-major                  allow major bumps for packages with no SDK pin
  --strict-sdk                   also downgrade packages that are newer than the SDK pin
```

At least one `--target` is required. Targets are `package@range`, for example `expo@57` or `react-native@0.86`. The range is resolved to the highest stable matching version.

**Exit codes:** `0` no blockers, `1` at least one blocker (or a target that conflicts with something), `2` error. That makes it usable as a CI gate. Missing peers, warnings and `PINNED` / `AHEAD` packages are informational and do not change the exit code.

### Reading the output

| Label | Meaning |
|---|---|
| `TARGET` | The version you asked for. |
| `UPGRADE` / `DOWNGRADE` | The package can or has to move for the plan to hold together. `DOWNGRADE` only appears for SDK-pinned packages (see `--strict-sdk`). |
| `AHEAD` | Installed version is newer than what the SDK pins. Left alone by default and shown with the pin. |
| `PINNED` | Your project forces this version through `overrides` / `resolutions`. The tool leaves it alone, and blames any library that disagrees with it. |
| `BLOCKED` | No version of this package fits the plan. The **Blockers** section says why, for this version and for the newest one. |
| `UNKNOWN` | Not enough metadata (not in the registry, a local or aliased dependency, or no usable installed version). |
| `OK` | Fits the plan as it is. |

Extra sections: **Warnings** lists optional peer dependencies that are outside their declared range. **Missing peers** lists packages that something in the plan needs but your `package.json` does not declare, with the SDK's pin when there is one. **Held back** lists packages where a newer version exists but does not fit the plan.

## How it works

1. **Read the project.** `package.json` plus `package-lock.json` or `pnpm-lock.yaml` give the installed version of every direct dependency. Without a lockfile it assumes the lowest version each range allows and says so. Overrides are read at the same time (see below).
2. **Fetch metadata.** Peer-dependency ranges, optional-peer flags and deprecation status for every version of every dependency, from the npm registry. Responses are cached for an hour in `~/.cache/upgrade-compass`.
3. **Load the SDK's pins.** When the target is `expo`, it reads `bundledNativeModules.json` from that exact Expo release. This is the same table `expo install` uses.
4. **Solve.** Find a version for every package such that all peer ranges and SDK pins hold, preferring the smallest safe change.
5. **Report.** Group by status and explain every conflict.

### Lockfiles and overrides

- **npm:** `package-lock.json`.
- **pnpm:** `pnpm-lock.yaml`, lockfile v6 and newer. pnpm 11 can write more than one YAML document into the file (the first describes pnpm itself); the tool finds the one that holds your project.
- **Overrides** are collected from `resolutions`, `overrides`, `pnpm.overrides`, `pnpm-workspace.yaml` and the overrides pnpm records in its lockfile. Later sources win, with the lockfile last. They apply to direct dependencies, by plain package name.

### The solver

The solver is deliberately not "pick the newest version of everything". The hard cases in a React Native upgrade are packages that block each other: `A@2` needs `B@2`, `B@2` needs `A@2`, and neither can move first. A package-by-package approach never finds that pair.

- **Joint search for linked packages.** Packages connected by real peer ranges are solved together with backtracking (newest first, bounded budget), so Firebase-style families and router + runtime pairs move in lockstep.
- **A library that cannot fit does not veto the rest.** The search skips as few members as it can, reports the skipped ones as blockers, and keeps them out of everyone else's constraints.
- **SDK pins are authoritative.** A version that matches the SDK's pin is never blamed for a third-party library's peer range. The library is.
- **Your overrides beat the SDK.** An override is your own decision, so it replaces the SDK's pin for that package, and the same blame rule applies.
- **Minimal jumps.** Without an SDK pin, a package stays inside its current breaking-change line (the major, or the minor while on `0.x`) when something there works. It crosses to a higher major only when nothing in the current one fits, and picks the nearest.
- **Packages ahead of the SDK are left alone** unless you pass `--strict-sdk`. Downgrading them is rarely what a project wants and can itself create conflicts.
- **Optional peer mismatches are warnings**, not blockers.
- Deprecated versions and prereleases are never chosen unless you are already on one.

## Limitations

This is a planning aid, not a resolver. Treat its output as a strong lead, not a guarantee.

- **Peer dependencies only.** Regular `dependencies` ranges and `engines` are not modelled.
- **Two lockfile formats.** `package-lock.json` and `pnpm-lock.yaml` (v6 and newer). No Yarn or bun lockfiles. Monorepos: only the root project is read, not the workspace packages.
- **Overrides are limited.** Only plain package names for direct dependencies are honored. Selectors (`foo@^1`), parent chains (`a>b`), nested objects, and overrides of packages you don't depend on directly are ignored.
- **Local and aliased dependencies are `UNKNOWN`.** That covers `link:`, `file:`, `workspace:`, git URLs and `npm:` aliases.
- **Existing conflicts count as blockers.** The tool does not yet separate conflicts that are already in your current install from conflicts the upgrade introduces.
- **The plan lists everything that can move, not only what must.** Routine patch and minor bumps appear next to the changes the target actually requires.
- **Missing peers are one level deep.** The tool lists peers your `package.json` does not declare, but it does not follow the peers of those packages in turn, and it does not check your lockfile for something else already providing them.
- **SDK pins come from one source.** Pins are only enforced when the target is `expo`. Packages the SDK does not pin (for example `@types/react`) are chosen by peer ranges alone and can drift from related packages.
- **Not checked against a real install.** The plan has not been validated with npm's or pnpm's resolver or a build.
- **Needs network access** to the npm registry and to a CDN for the Expo manifest.

## Development

```bash
npm run dev -- plan -t expo@57 -d <dir>   # run from source
npm run typecheck
npm test                                   # vitest
npm run build
```

Layout:

```text
src/
  cli.ts            command line entry
  plan.ts           ties reading, fetching and solving together
  types.ts
  manifest/         package.json, lockfile (npm, pnpm) and overrides readers
  registry/         npm metadata client, Expo SDK manifest
  solver/           the solver
  report/           output formatting
test/
  solve.test.ts     solver behaviour, including regression cases from real projects
  format.test.ts    output formatting
  pnpmLock.test.ts  pnpm lockfile parsing
  overrides.test.ts override normalisation
```

The tests use small hand-built package graphs and lockfile snippets, so they run offline.

## Roadmap

Ideas, not promises:

- Separate what has to move for the target from optional bumps.
- Separate conflicts that already exist from those the upgrade introduces.
- Try each plan on a git branch or worktree (install, typecheck, tests) and rank the results.
- Suggest the first release that unblocks each blocker, and `explain <package>` for the full constraint chain.
- Say which SDK an AHEAD version belongs to, and which SDK the project fits best overall.
- Validate a plan against `npm install --dry-run`.
- Yarn and bun lockfiles, and workspaces.
- A GitHub Action that comments on PRs.

## License

ISC
