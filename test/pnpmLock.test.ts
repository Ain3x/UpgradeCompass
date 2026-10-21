import { describe, expect, it } from 'vitest';
import { parsePnpmLock } from '../src/manifest/pnpmLock.js';

describe('parsePnpmLock', () => {
    it('reads the root importer of a v9 lockfile and strips peer suffixes', () => {
        const text = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.2.3
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.2.3(react@19.2.3)
      local-mod:
        specifier: link:./modules/local-mod
        version: link:./modules/local-mod
    devDependencies:
      typescript:
        specifier: ^6.0.2
        version: 6.0.2
  packages/other:
    dependencies:
      ignored:
        specifier: ^1.0.0
        version: 1.0.0
`;
        const v = parsePnpmLock(text)!.versions;
        expect(v.get('react')).toBe('19.2.3');
        expect(v.get('@scope/pkg')).toBe('1.2.3');
        expect(v.get('typescript')).toBe('6.0.2');
        expect(v.has('local-mod')).toBe(false);
        expect(v.has('ignored')).toBe(false);
    });

    it('skips the leading pnpm-itself document in a multi-document file', () => {
        const text = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 11.0.0
        version: 11.0.0
---
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21
`;
        expect(parsePnpmLock(text)!.versions.get('lodash')).toBe('4.17.21');
    });

    it('reads a single-project v6 lockfile that keeps sections at the top level', () => {
        const text = `
lockfileVersion: '6.0'
dependencies:
  lodash:
    specifier: ^4.17.0
    version: 4.17.21
`;
        expect(parsePnpmLock(text)!.versions.get('lodash')).toBe('4.17.21');
    });

    it('returns null for formats it does not understand', () => {
        expect(parsePnpmLock('lockfileVersion: 5.4\ndependencies:\n  lodash: 4.17.21\n')).toBeNull();
        expect(parsePnpmLock('')).toBeNull();
    });

    it('returns the overrides recorded in the lockfile', () => {
        const text = `
lockfileVersion: '9.0'
overrides:
  react-native-reanimated: 4.7.1
  '@types/estree': 1.0.6
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21
`;
        expect(parsePnpmLock(text)!.overrides).toEqual({
            'react-native-reanimated': '4.7.1',
            '@types/estree': '1.0.6',
        });
    });
});