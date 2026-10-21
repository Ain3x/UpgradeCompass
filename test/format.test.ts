import { describe, expect, it } from 'vitest';
import { formatPlan } from '../src/report/format.js';
import type { Plan } from '../src/types.js';

const base: Plan = {
  targets: [{ name: 'expo', range: '57', version: '57.0.30' }],
  items: [{ name: 'expo', status: 'target', from: '57.0.24', to: '57.0.30', currentConflicts: [], latestConflicts: [] }],
  converged: true,
  missingPeers: [],
};

describe('formatPlan', () => {
  it('omits the missing peers section when there are none', () => {
    expect(formatPlan(base)).not.toContain('Missing peers');
  });

  it('lists missing peers with their requirers and the SDK pin', () => {
    const out = formatPlan({
      ...base,
      missingPeers: [
        {
          name: 'expo-linking',
          sdkRange: '~57.0.13',
          requiredBy: [{ by: 'expo-router@57.0.28', range: '^57.0.13' }],
        },
        { name: 'helper', requiredBy: [{ by: 'lib@1.0.0', range: '^2.0.0' }] },
        { name: 'anything', requiredBy: [{ by: 'lib@1.0.0', range: '*' }] },
      ],
    });
    expect(out).toContain('Missing peers');
    expect(out).toContain('expo-linking  (SDK pins ~57.0.13)');
    expect(out).toContain('- expo-router@57.0.28 needs ^57.0.13');
    expect(out).toMatch(/\n {2}helper\n {4}- lib@1\.0\.0 needs \^2\.0\.0/);
    expect(out).toContain('- lib@1.0.0 needs any version');
  });

  it('labels SDK-pinned downgrades and AHEAD packages', () => {
    const out = formatPlan({
      ...base,
      items: [
        ...base.items,
        { name: 'down', status: 'upgrade', from: '3.0.0', to: '2.0.1', currentConflicts: [], latestConflicts: [] },
        { name: 'newer', status: 'ahead', from: '3.3.0', sdkRange: '~2.32.0', currentConflicts: [], latestConflicts: [] },
      ],
    });
    expect(out).toMatch(/DOWNGRADE down\s+3\.0\.0 -> 2\.0\.1/);
    expect(out).toMatch(/AHEAD\s+newer\s+3\.3\.0 \(SDK pins ~2\.32\.0\)/);
  });

  it('shows an optional-peer mismatch once, on the package that declares it', () => {
    const conflict = { peer: 'w', range: '^1.0.0', actual: '2.0.0', optional: true };
    const out = formatPlan({
      ...base,
      items: [
        ...base.items,
        {
          name: 'a', status: 'upgrade', from: '1.0.0', to: '1.1.0', latestConflicts: [],
          currentConflicts: [{ kind: 'own-peer', ...conflict }],
        },
        {
          name: 'w', status: 'ok', from: '2.0.0', to: '2.0.0', latestConflicts: [],
          currentConflicts: [{ kind: 'required-by', by: 'a@1.1.0', ...conflict }],
        },
      ],
    });
    expect(out).toContain('Warnings');
    expect(out.match(/\(optional peer\)/g)).toHaveLength(1);
    expect(out).not.toContain('a@1.1.0 needs');
  });

  it('trims long lists of reasons under Held back', () => {
    const c = (n: number) => ({ kind: 'own-peer' as const, peer: `p${n}`, range: '^9', actual: '1.0.0' });
    const out = formatPlan({
      ...base,
      items: [
        ...base.items,
        {
          name: 'lib', status: 'ok', from: '1.0.0', to: '1.0.0', latest: '2.0.0', currentConflicts: [],
          latestConflicts: [c(1), c(2), c(3), c(4), c(5)],
        },
      ],
    });
    expect(out).toContain('Held back');
    expect(out).toContain('needs p3 ^9');
    expect(out).not.toContain('needs p4 ^9');
    expect(out).toContain('... and 2 more');
  });
});