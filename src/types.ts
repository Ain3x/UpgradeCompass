export interface VersionMeta {
    version: string;
    peerDependencies: Record<string, string>;
    deprecated: boolean;
    optionalPeers?: string[];
}

export interface PackageMeta {
    name: string;
    versions: VersionMeta[];
}

export interface MetadataSource {
    get(name: string): Promise<PackageMeta | null>;
}

export interface DepSpec {
    name: string;
    range: string;
    installed?: string;
    section: 'dependencies' | 'devDependencies';
}

export interface Manifest {
    name?: string;
    deps: DepSpec[];
    lockfile: 'package-lock' | 'none';
}

export interface RawTarget {
    name: string;
    range: string;
}

export interface Target extends RawTarget {
    version: string;
}

export type Status = 'target' | 'ok' | 'upgrade' | 'blocked' | 'ahead' |'unknown';

export interface Conflict {
    kind: 'own-peer' | 'required-by' | 'sdk';
    peer: string;
    range: string;
    actual: string;
    by?: string;
    optional?: boolean;
}

export interface PlanItem {
    name: string;
    status: Status;
    from?: string;
    to?: string;
    latest?: string;
    currentConflicts: Conflict[];
    latestConflicts: Conflict[];
    sdkRange?: string;
}

export interface MissingPeer {
    name: string;
    sdkRange?: string;
    requiredBy: { by: string; range: string }[];
}

export interface Plan {
    targets: Target[];
    items: PlanItem[];
    converged: boolean;
    missingPeers: MissingPeer[];
}