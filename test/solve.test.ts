import { describe, expect, it } from 'vitest';
import { solve } from '../src/solver/solve.js';
import type { DepSpec, PackageMeta, Plan } from '../src/types.js';

function meta(
  name: string,
  versions: Record<string, Record<string, string>>,
  optional: Record<string, string[]> = {},
): PackageMeta {
  return {
    name,
    versions: Object.entries(versions).map(([version, peerDependencies]) => ({
      version,
      peerDependencies,
      optionalPeers: optional[version] ?? [],
      deprecated: false,
    })),
  };
}

function dep(name: string, installed: string): DepSpec {
  return { name, range: installed, installed, section: 'dependencies' };
}

const item = (plan: Plan, name: string) => plan.items.find((i) => i.name === name)!;
const metasOf = (...ms: PackageMeta[]) => new Map(ms.map((m) => [m.name, m] as const));

const rn = meta('react-native', { '0.76.0': {}, '0.81.4': {} });
const rnTarget = [{ name: 'react-native', range: '0.81', version: '0.81.4' }];
const expoTarget = [{ name: 'expo', range: '2', version: '2.0.0' }];

describe('solve', () => {
  it('upgrades a library whose newer release supports the target', () => {
    const metas = new Map([
      ['react-native', rn],
      ['some-lib', meta('some-lib', { '1.0.0': { 'react-native': '^0.76.0' }, '2.0.0': { 'react-native': '>=0.80' } })],
    ]);
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('some-lib', '1.0.0')],
      targets: rnTarget,
      metas,
    });
    expect(item(plan, 'some-lib')).toMatchObject({ status: 'upgrade', from: '1.0.0', to: '2.0.0' });
    expect(plan.converged).toBe(true);
  });

  it('reports a blocker when no release fits the target', () => {
    const metas = new Map([
      ['react-native', rn],
      ['old-lib', meta('old-lib', { '1.0.0': { 'react-native': '^0.76.0' } })],
    ]);
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('old-lib', '1.0.0')],
      targets: rnTarget,
      metas,
    });
    const old = item(plan, 'old-lib');
    expect(old.status).toBe('blocked');
    expect(old.currentConflicts[0]).toMatchObject({ kind: 'own-peer', peer: 'react-native' });
  });

  it('respects peer ranges that other packages declare on it', () => {
    const metas = new Map([
      ['expo', meta('expo', { '54.0.0': { react: '~19.0.0' } })],
      ['react', meta('react', { '18.2.0': {}, '19.0.0': {}, '19.1.0': {} })],
    ]);
    const plan = solve({
      deps: [dep('react', '18.2.0')],
      targets: [{ name: 'expo', range: '54', version: '54.0.0' }],
      metas,
    });
    expect(item(plan, 'react')).toMatchObject({ status: 'upgrade', to: '19.0.0' });
  });

  it('keeps a working version and explains why the newest one was held back', () => {
    const metas = new Map([
      ['react-native', rn],
      ['fine-lib', meta('fine-lib', { '1.0.0': { 'react-native': '>=0.76' }, '2.0.0': { 'react-native': '>=0.90' } })],
    ]);
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('fine-lib', '1.0.0')],
      targets: rnTarget,
      metas,
    });
    const lib = item(plan, 'fine-lib');
    expect(lib.status).toBe('ok');
    expect(lib.latest).toBe('2.0.0');
    expect(lib.latestConflicts).toHaveLength(1);
  });

  it('marks packages without registry metadata as unknown', () => {
    const plan = solve({
      deps: [dep('mystery', '1.0.0'), dep('react-native', '0.76.0')],
      targets: rnTarget,
      metas: metasOf(rn),
    });
    expect(item(plan, 'mystery').status).toBe('unknown');
  });
});

describe('version selection', () => {
  it('stays inside the current major when that already works', () => {
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('lib', '1.0.0')],
      targets: rnTarget,
      metas: metasOf(rn, meta('lib', { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} })),
    });
    expect(item(plan, 'lib')).toMatchObject({ status: 'upgrade', to: '1.5.0', latest: '2.0.0' });
  });

  it('crosses a major only when nothing in the current one fits, and picks the nearest', () => {
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('lib', '1.0.0')],
      targets: rnTarget,
      metas: metasOf(
        rn,
        meta('lib', {
          '1.0.0': { 'react-native': '^0.76.0' },
          '2.0.0': { 'react-native': '>=0.80' },
          '3.0.0': { 'react-native': '>=0.80' },
        }),
      ),
    });
    expect(item(plan, 'lib')).toMatchObject({ status: 'upgrade', to: '2.0.0' });
  });

  it('jumps to the newest major with allowMajor', () => {
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('lib', '1.0.0')],
      targets: rnTarget,
      metas: metasOf(rn, meta('lib', { '1.0.0': {}, '2.0.0': {} })),
      allowMajor: true,
    });
    expect(item(plan, 'lib')).toMatchObject({ status: 'upgrade', to: '2.0.0' });
  });

  it('treats the minor as the breaking boundary while on 0.x', () => {
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('preset', '0.86.3')],
      targets: rnTarget,
      metas: metasOf(rn, meta('preset', { '0.86.3': {}, '0.86.5': {}, '0.88.0': {} })),
    });
    expect(item(plan, 'preset')).toMatchObject({ status: 'upgrade', to: '0.86.5' });
  });

  it('never picks a deprecated or prerelease version, and never downgrades', () => {
    const lib: PackageMeta = {
      name: 'lib',
      versions: [
        { version: '1.0.0', peerDependencies: {}, deprecated: false },
        { version: '1.0.1', peerDependencies: {}, deprecated: false },
        { version: '1.1.0', peerDependencies: {}, deprecated: true },
        { version: '1.2.0-beta.1', peerDependencies: {}, deprecated: false },
      ],
    };
    const old: PackageMeta = {
      name: 'old',
      versions: [
        { version: '1.0.0', peerDependencies: {}, deprecated: false },
        { version: '1.5.0', peerDependencies: {}, deprecated: false },
      ],
    };
    const plan = solve({
      deps: [dep('react-native', '0.76.0'), dep('lib', '1.0.0'), dep('old', '1.5.0')],
      targets: rnTarget,
      metas: metasOf(rn, lib, old),
    });
    expect(item(plan, 'lib')).toMatchObject({ status: 'upgrade', to: '1.0.1' });
    expect(item(plan, 'old')).toMatchObject({ status: 'ok', to: '1.5.0' });
  });
});

describe('groups that must move together', () => {
  // Each release pins the other package exactly, so neither can move first.
  const router = meta('router', { '1.0.0': { metro: '1.0.0' }, '1.1.0': { metro: '1.1.0' } });
  const metro = meta('metro', { '1.0.0': {}, '1.1.0': {} });

  it('moves two mutually pinned packages in lockstep', () => {
    const plan = solve({
      deps: [dep('router', '1.0.0'), dep('metro', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(router, metro),
    });
    expect(item(plan, 'router')).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    expect(item(plan, 'metro')).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    expect(plan.converged).toBe(true);
  });

  it('moves a whole family that pins one root package (firebase-style)', () => {
    const app = meta('fb-app', { '1.0.0': {}, '1.1.0': {} });
    const auth = meta('fb-auth', { '1.0.0': { 'fb-app': '1.0.0' }, '1.1.0': { 'fb-app': '1.1.0' } });
    const db = meta('fb-db', { '1.0.0': { 'fb-app': '1.0.0' }, '1.1.0': { 'fb-app': '1.1.0' } });
    const plan = solve({
      deps: [dep('fb-app', '1.0.0'), dep('fb-auth', '1.0.0'), dep('fb-db', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(app, auth, db),
    });
    for (const n of ['fb-app', 'fb-auth', 'fb-db']) {
      expect(item(plan, n)).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    }
  });

  it('does not let a library that cannot fit veto the rest of its group', () => {
    // legacy-lib is linked to metro but needs expo ^1, which the target rules out.
    const legacy = meta('legacy-lib', { '1.0.0': { expo: '^1.0.0', metro: '>=1.0.0' } });
    const plan = solve({
      deps: [dep('router', '1.0.0'), dep('metro', '1.0.0'), dep('legacy-lib', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(router, metro, legacy),
    });
    expect(item(plan, 'router')).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    expect(item(plan, 'metro')).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    const l = item(plan, 'legacy-lib');
    expect(l.status).toBe('blocked');
    expect(l.currentConflicts[0]).toMatchObject({ kind: 'own-peer', peer: 'expo' });
  });
});

describe('SDK pins (bundledNativeModules)', () => {
  const libA = meta('lib-a', { '1.0.0': {}, '2.0.1': {}, '2.1.0': {}, '3.0.0': {} });

  it('moves an SDK-managed package to the pinned range, not the newest release', () => {
    const plan = solve({
      deps: [dep('lib-a', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(libA),
      bundled: { 'lib-a': '~2.0.0' },
    });
    expect(item(plan, 'lib-a')).toMatchObject({ status: 'upgrade', to: '2.0.1' });
  });

  it('leaves a package that is newer than the pin alone and calls it AHEAD', () => {
    const plan = solve({
      deps: [dep('lib-a', '3.0.0')],
      targets: expoTarget,
      metas: metasOf(libA),
      bundled: { 'lib-a': '~2.0.0' },
    });
    expect(item(plan, 'lib-a')).toMatchObject({
      status: 'ahead',
      to: '3.0.0',
      sdkRange: '~2.0.0',
      latest: '2.0.1',
    });
  });

  it('downgrades a package that is newer than the pin with strictSdk', () => {
    const plan = solve({
      deps: [dep('lib-a', '3.0.0')],
      targets: expoTarget,
      metas: metasOf(libA),
      bundled: { 'lib-a': '~2.0.0' },
      strictSdk: true,
    });
    expect(item(plan, 'lib-a')).toMatchObject({ status: 'upgrade', from: '3.0.0', to: '2.0.1' });
  });

  it('keeps AHEAD packages from blocking libraries that need the newer version', () => {
    const gesture = meta('gesture', { '2.32.0': {}, '3.3.0': {} });
    const drawer = meta('drawer', { '1.0.0': { gesture: '>=3.0.0' } });
    const input = {
      deps: [dep('gesture', '3.3.0'), dep('drawer', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(gesture, drawer),
      bundled: { gesture: '~2.32.0' },
    };

    const lenient = solve(input);
    expect(item(lenient, 'gesture').status).toBe('ahead');
    expect(item(lenient, 'drawer').status).toBe('ok');
    // what following the SDK would break is still reported
    expect(item(lenient, 'gesture')).toMatchObject({ latest: '2.32.0' });
    expect(item(lenient, 'gesture').latestConflicts[0]).toMatchObject({ kind: 'required-by' });

    const strict = solve({ ...input, strictSdk: true });
    expect(item(strict, 'gesture')).toMatchObject({ status: 'upgrade', to: '2.32.0' });
    expect(item(strict, 'drawer').status).toBe('blocked');
  });

  it('blames the third-party library, not the SDK-pinned package', () => {
    const react = meta('react', { '19.2.3': {}, '19.3.1': {} });
    const emoji = meta('emoji-react', { '1.1.1': { react: '^16.8 || ^17 || ^18' } });
    const plan = solve({
      deps: [dep('react', '19.2.3'), dep('emoji-react', '1.1.1')],
      targets: expoTarget,
      metas: metasOf(react, emoji),
      bundled: { react: '19.2.3' },
    });
    expect(item(plan, 'react').status).toBe('ok');
    const e = item(plan, 'emoji-react');
    expect(e.status).toBe('blocked');
    expect(e.currentConflicts[0]).toMatchObject({ kind: 'own-peer', peer: 'react' });
  });

  it('reports an SDK conflict when nothing in the pinned range exists', () => {
    const plan = solve({
      deps: [dep('lib-a', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(meta('lib-a', { '1.0.0': {}, '3.0.0': {} })),
      bundled: { 'lib-a': '~2.0.0' },
    });
    const a = item(plan, 'lib-a');
    expect(a.status).toBe('blocked');
    expect(a.currentConflicts[0]).toMatchObject({ kind: 'sdk', range: '~2.0.0' });
  });
});

describe('optional peers', () => {
  it('reports an optional peer mismatch as a warning instead of blocking', () => {
    const core = meta(
      'core-lib',
      { '1.0.0': { worklets: '^0.10.0' }, '1.1.0': { worklets: '^0.10.0' } },
      { '1.0.0': ['worklets'], '1.1.0': ['worklets'] },
    );
    const worklets = meta('worklets', { '0.13.0': {} });
    const plan = solve({
      deps: [dep('core-lib', '1.0.0'), dep('worklets', '0.13.0')],
      targets: expoTarget,
      metas: metasOf(core, worklets),
    });
    const c = item(plan, 'core-lib');
    expect(c).toMatchObject({ status: 'upgrade', to: '1.1.0' });
    expect(c.currentConflicts[0]).toMatchObject({ kind: 'own-peer', peer: 'worklets', optional: true });
    expect(item(plan, 'worklets').status).toBe('ok');
  });

  it('still blocks on the same mismatch when the peer is required', () => {
    const core = meta('core-lib', { '1.0.0': { worklets: '^0.10.0' } });
    const worklets = meta('worklets', { '0.13.0': {} });
    const plan = solve({
      deps: [dep('core-lib', '1.0.0'), dep('worklets', '0.13.0')],
      targets: expoTarget,
      metas: metasOf(core, worklets),
    });
    expect(item(plan, 'core-lib').status).toBe('blocked');
  });
});

describe('missing peers', () => {
  const lib = meta('lib', { '1.0.0': { helper: '^2.0.0', 'opt-helper': '^1.0.0' } }, { '1.0.0': ['opt-helper'] });

  it('lists required peers the project does not declare', () => {
    const plan = solve({ deps: [dep('lib', '1.0.0')], targets: expoTarget, metas: metasOf(lib) });
    expect(plan.missingPeers).toEqual([
      { name: 'helper', sdkRange: undefined, requiredBy: [{ by: 'lib@1.0.0', range: '^2.0.0' }] },
    ]);
  });

  it('ignores optional peers', () => {
    const plan = solve({ deps: [dep('lib', '1.0.0')], targets: expoTarget, metas: metasOf(lib) });
    expect(plan.missingPeers.map((m) => m.name)).not.toContain('opt-helper');
  });

  it('does not report peers that are declared, even at the wrong version', () => {
    const plan = solve({
      deps: [dep('lib', '1.0.0'), dep('helper', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(lib, meta('helper', { '1.0.0': {} })),
    });
    expect(plan.missingPeers).toEqual([]);
  });

  it('includes the SDK pin when the manifest has one', () => {
    const plan = solve({
      deps: [dep('lib', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(lib),
      bundled: { helper: '~2.0.1' },
    });
    expect(plan.missingPeers[0]).toMatchObject({ name: 'helper', sdkRange: '~2.0.1' });
  });

  it('merges several requirers of the same peer into one entry', () => {
    const other = meta('other', { '1.0.0': { helper: '>=2' } });
    const plan = solve({
      deps: [dep('lib', '1.0.0'), dep('other', '1.0.0')],
      targets: expoTarget,
      metas: metasOf(lib, other),
    });
    expect(plan.missingPeers).toHaveLength(1);
    expect(plan.missingPeers[0].requiredBy.map((r) => r.by)).toEqual(['lib@1.0.0', 'other@1.0.0']);
  });

  it('looks at the version the plan moves to, not the installed one', () => {
    const moving = meta('moving', {
      '1.0.0': { 'old-peer': '*' },
      '1.1.0': { 'new-peer': '*' },
    });
    const plan = solve({ deps: [dep('moving', '1.0.0')], targets: expoTarget, metas: metasOf(moving) });
    expect(item(plan, 'moving').to).toBe('1.1.0');
    expect(plan.missingPeers.map((m) => m.name)).toEqual(['new-peer']);
  });

  it('includes the peers of the target itself', () => {
    const expo = meta('expo', { '2.0.0': { linking: '^2.0.0' } });
    const plan = solve({ deps: [], targets: expoTarget, metas: metasOf(expo) });
    expect(plan.missingPeers).toEqual([
      { name: 'linking', sdkRange: undefined, requiredBy: [{ by: 'expo@2.0.0', range: '^2.0.0' }] },
    ]);
  });

  it('skips peers of packages that are blocked', () => {
    const blockedLib = meta('blocked-lib', { '1.0.0': { expo: '^1.0.0', 'extra-peer': '*' } });
    const plan = solve({ deps: [dep('blocked-lib', '1.0.0')], targets: expoTarget, metas: metasOf(blockedLib) });
    expect(item(plan, 'blocked-lib').status).toBe('blocked');
    expect(plan.missingPeers).toEqual([]);
  });

  describe('overrides', () => {
    const libA = meta('lib-a', { '2.0.1': {}, '3.0.0': {}, '3.1.0': {} });

    it('keeps an overridden package where the project forces it, even against the SDK pin', () => {
      const plan = solve({
        deps: [dep('lib-a', '3.0.0')],
        targets: expoTarget,
        metas: metasOf(libA),
        bundled: { 'lib-a': '~2.0.0' },
        overrides: { 'lib-a': '3.0.0' },
      });
      expect(item(plan, 'lib-a')).toMatchObject({ status: 'pinned', to: '3.0.0', overrideRange: '3.0.0' });
    });

    it('does not move an overridden package even when a newer release fits', () => {
      const without = solve({ deps: [dep('lib-a', '3.0.0')], targets: expoTarget, metas: metasOf(libA) });
      expect(item(without, 'lib-a')).toMatchObject({ status: 'upgrade', to: '3.1.0' });

      const withOverride = solve({
        deps: [dep('lib-a', '3.0.0')],
        targets: expoTarget,
        metas: metasOf(libA),
        overrides: { 'lib-a': '3.0.0' },
      });
      expect(item(withOverride, 'lib-a')).toMatchObject({ status: 'pinned', to: '3.0.0' });
    });

    it('blames the library that disagrees with an override, not the overridden package', () => {
      const react = meta('react', { '19.2.3': {}, '19.3.1': {} });
      const emoji = meta('emoji-react', { '1.1.1': { react: '^16.8 || ^17 || ^18' } });
      const plan = solve({
        deps: [dep('react', '19.2.3'), dep('emoji-react', '1.1.1')],
        targets: expoTarget,
        metas: metasOf(react, emoji),
        overrides: { react: '19.2.3' },
      });
      expect(item(plan, 'react').status).toBe('pinned');
      expect(item(plan, 'emoji-react').status).toBe('blocked');
    });

    it('labels an unsatisfiable override as the override, not the SDK', () => {
      const plan = solve({
        deps: [dep('lib-a', '2.0.1')],
        targets: expoTarget,
        metas: metasOf(libA),
        overrides: { 'lib-a': '^9.0.0' },
      });
      const a = item(plan, 'lib-a');
      expect(a.status).toBe('blocked');
      expect(a.currentConflicts[0]).toMatchObject({ kind: 'sdk', source: 'override' });
    });
  });
});