import { describe, expect, it } from 'vitest';
import { collectOverrides, normalizeOverride } from '../src/manifest/overrides.js';

const direct = { react: '^19.0.0' };

describe('normalizeOverride', () => {
  it('accepts plain, scoped and Yarn-style "**/" names with a usable range', () => {
    expect(normalizeOverride('psl', '1.9.0', direct)).toEqual(['psl', '1.9.0']);
    expect(normalizeOverride('@types/psl', '^1.1.1', direct)).toEqual(['@types/psl', '^1.1.1']);
    expect(normalizeOverride('**/lodash', '4.17.21', direct)).toEqual(['lodash', '4.17.21']);
  });

  it('resolves $name against the project\'s own dependency range', () => {
    expect(normalizeOverride('react-dom', '$react', direct)).toEqual(['react-dom', '^19.0.0']);
    expect(normalizeOverride('react-dom', '$missing', direct)).toBeNull();
  });

  it('skips entries it cannot judge', () => {
    expect(normalizeOverride('foo@^1', '1.2.3', direct)).toBeNull(); // selector
    expect(normalizeOverride('a>b', '1.2.3', direct)).toBeNull(); // parent chain
    expect(normalizeOverride('a/b', '1.2.3', direct)).toBeNull(); // Yarn nested path
    expect(normalizeOverride('foo', { '.': '1.0.0' }, direct)).toBeNull(); // npm nested object
    expect(normalizeOverride('foo', '-', direct)).toBeNull(); // pnpm removal
    expect(normalizeOverride('foo', 'link:./foo', direct)).toBeNull();
    expect(normalizeOverride('foo', 'npm:bar@1.0.0', direct)).toBeNull();
    expect(normalizeOverride('foo', '*', direct)).toBeNull();
  });
});

describe('collectOverrides', () => {
  it('lets later sources win', () => {
    const out = collectOverrides([{ foo: '1.0.0', bar: '2.0.0' }, undefined, { foo: '1.5.0' }], {});
    expect(out).toEqual({ foo: '1.5.0', bar: '2.0.0' });
  });
});