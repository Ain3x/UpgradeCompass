export async function fetchBundled(expoVersion: string): Promise<Record<string, string> | undefined> {
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/npm/expo@${expoVersion}/bundledNativeModules.json`);
    return res.ok ? ((await res.json()) as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}