import semver from 'semver';
import type { Conflict, Plan, PlanItem, Status } from '../types.js';

const MAX_REASONS = 3;

const ORDER: Status[] = ['target', 'blocked', 'upgrade', 'ahead', 'unknown', 'ok'];
const LABEL: Record<Status, string> = {
  target: 'TARGET',
  blocked: 'BLOCKED',
  upgrade: 'UPGRADE',
  unknown: 'UNKNOWN',
  ahead: 'AHEAD',
  ok: 'OK',
};

function describeCore(c: Conflict): string {
  if (c.kind === 'sdk') return `does not match the expo SDK range ${c.range} (is ${c.actual})`;

  return c.kind === 'own-peer'
    ? `needs ${c.peer} ${c.range}, plan has ${c.actual}`
    : `${c.by} needs ${c.peer} ${c.range}, this version is ${c.actual}`;
}

function describe(c: Conflict): string {
  return (c.optional ? '(optional peer) ' : '') + describeCore(c);
}

function move(i: PlanItem): string {
  if (i.status === 'ahead') return `${i.from} (SDK pins ${i.sdkRange})`;
  if (i.status === 'blocked') return `${i.from} (no compatible release)`;
  if (i.status === 'unknown') return `${i.from ?? 'unresolved'} (not enough metadata)`;
  return i.from && i.to && i.from !== i.to ? `${i.from} -> ${i.to}` : (i.to ?? i.from ?? '?');
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push('Targets: ' + plan.targets.map((t) => `${t.name}@${t.version}`).join(', '));
  if (!plan.converged) {
    lines.push('Warning: the solver did not converge; treat this plan as unreliable.');
  }
  lines.push('');

  const items = [...plan.items].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
  );
  const width = Math.max(7, ...items.map((i) => i.name.length));
  for (const i of items) {
    const label =
      i.status === 'upgrade' && i.from && i.to && semver.lt(i.to, i.from) ? 'DOWNGRADE' : LABEL[i.status];
    lines.push(`${label.padEnd(9)} ${i.name.padEnd(width)}  ${move(i)}`);
  }

  const blocked = items.filter((i) => i.status === 'blocked');
  if (blocked.length > 0) {
    lines.push('', 'Blockers');
    for (const b of blocked) {
      lines.push(`  ${b.name}@${b.from}`);
      for (const c of b.currentConflicts) lines.push(`    - this version ${describe(c)}`);
      if (b.latest && b.latest !== b.from) {
        for (const c of b.latestConflicts) lines.push(`    - newest ${b.latest} ${describe(c)}`);
      }
    }
    lines.push('', 'For each blocker: wait for a release, replace the library, pin it with an override, or patch it.');
  }

  // The package that declares an optional peer reports the mismatch; the package
  // on the other side would only repeat it.
  const warned = items
    .filter((i) => i.status !== 'blocked')
    .map((i) => ({ i, cs: i.currentConflicts.filter((c) => !(c.kind === 'required-by' && c.optional)) }))
    .filter((w) => w.cs.length > 0);
  if (warned.length > 0) {
    lines.push('', 'Warnings');
    for (const { i, cs } of warned) {
      lines.push(`  ${i.name}@${i.to ?? i.from}`);
      for (const c of cs) lines.push(`    - ${describe(c)}`);
    }
  }

  if (plan.missingPeers.length > 0) {
    lines.push('', 'Missing peers (needed by packages in the plan, not declared in your package.json)');
    for (const m of plan.missingPeers) {
      lines.push(`  ${m.name}${m.sdkRange ? `  (SDK pins ${m.sdkRange})` : ''}`);
      for (const r of m.requiredBy) lines.push(`    - ${r.by} needs ${r.range === '*' ? 'any version' : r.range}`);
    }
    lines.push('', 'Add them with `npx expo install <name>` (SDK-managed) or `npm install <name>@<range>`.');
  }

  const heldBack = items
    .filter((i) => i.status === 'ok' || i.status === 'upgrade')
    .map((i) => ({ i, cs: i.latestConflicts.filter((c) => c.kind !== 'sdk') }))
    .filter((h) => h.cs.length > 0);
  if (heldBack.length > 0) {
    lines.push('', 'Held back (a newer version exists but does not fit the plan)');
    for (const { i, cs } of heldBack) {
      lines.push(`  ${i.name}: ${i.latest}`);
      for (const c of cs.slice(0, MAX_REASONS)) lines.push(`    - ${describe(c)}`);
      if (cs.length > MAX_REASONS) lines.push(`    - ... and ${cs.length - MAX_REASONS} more`);
    }
  }

  return lines.join('\n');
}