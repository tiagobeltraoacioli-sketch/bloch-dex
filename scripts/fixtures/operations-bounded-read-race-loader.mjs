// Test-only source loader for deterministic post-stat file growth.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs"))
    return loaded;

  let source = String(loaded.source);
  const boundary = "  const buffer = Buffer.alloc(maximum + 1);";
  const attack = `${boundary}
  if (!globalThis.__posternBoundedReadRaceInjected) {
    globalThis.__posternBoundedReadRaceInjected = true;
    const filesystem = await import("node:fs/promises");
    await filesystem.appendFile(
      process.env.POSTERN_OPERATIONS_BOUNDED_READ_RACE_TARGET,
      Buffer.alloc(64_001, 0x20),
    );
  }`;
  if (!source.includes(boundary))
    throw new Error("operations bounded-read race loader could not find read boundary");
  source = source.replace(boundary, attack);
  return { ...loaded, source };
}
