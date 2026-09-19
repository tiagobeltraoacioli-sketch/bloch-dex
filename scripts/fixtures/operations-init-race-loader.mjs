// Test-only source loader for deterministic operations-store replacement.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs"))
    return loaded;

  let source = String(loaded.source);
  const openBoundary = `  const rootDirectory = await openPinnedDirectory(
    staging, "new operations staging store", null, createdRoot,
  );`;
  const preOpenAttack = `  if (process.env.POSTERN_OPERATIONS_INIT_RACE_MODE === "before-open") {
    const filesystem = await import("node:fs/promises");
    await filesystem.rename(staging, \`${"${staging}"}.displaced\`);
    await filesystem.mkdir(staging, { mode: 0o700 });
  }
${openBoundary}`;
  if (!source.includes(openBoundary))
    throw new Error("operations init race loader could not find root open boundary");
  source = source.replace(openBoundary, preOpenAttack);

  const boundary = `    await executeRenameNoReplace(`;
  const attack = `  if (process.env.POSTERN_OPERATIONS_INIT_RACE_MODE === "before-publication") {
      const filesystem = await import("node:fs/promises");
      await filesystem.mkdir(resolvedRoot, { mode: 0o700 });
      await filesystem.writeFile(
        \`${"${resolvedRoot}"}/attacker-marker\`, "preserve me\\n",
        { flag: "wx", mode: 0o600 },
      );
    }
${boundary}`;
  if (!source.includes(boundary))
    throw new Error("operations init race loader could not find publication boundary");
  source = source.replace(boundary, attack);

  if (process.env.POSTERN_OPERATIONS_INIT_RACE_MODE === "helper-unavailable") {
    const helper = `    const child = spawn("/usr/bin/python3", [`;
    if (!source.includes(helper))
      throw new Error("operations init race loader could not find rename helper");
    source = source.replace(helper, `    const child = spawn("/nonexistent/postern-python3", [`);
  }

  const finalBoundary = `    if (canonicalJson(retained) !== canonicalJson(checkpoint))`;
  const finalAttack = `    if (process.env.POSTERN_OPERATIONS_INIT_RACE_MODE === "after-final-read") {
      const filesystem = await import("node:fs/promises");
      await filesystem.writeFile(
        \`${"${process.env.POSTERN_OPERATIONS_INIT_RACE_TARGET}"}/late-intruder\`,
        "late initialization artifact\\n",
        { flag: "wx", mode: 0o600 },
      );
    }
${finalBoundary}`;
  if (!source.includes(finalBoundary))
    throw new Error("operations init race loader could not find final read boundary");
  source = source.replace(finalBoundary, finalAttack);

  const finalRootBoundary = `  await requirePinnedDirectory(
    rootDirectory, \`new operations store ${"${phase}"}\`,
  );`;
  const finalRootAttack = `  if (phase === "after final checkpoint read" &&
      process.env.POSTERN_OPERATIONS_INIT_RACE_MODE === "before-final-root") {
    const filesystem = await import("node:fs/promises");
    const target = process.env.POSTERN_OPERATIONS_INIT_RACE_TARGET;
    await filesystem.rename(target, \`${"${target}"}.displaced-final\`);
    await filesystem.mkdir(target, { mode: 0o700 });
  }
${finalRootBoundary}`;
  if (!source.includes(finalRootBoundary))
    throw new Error("operations init race loader could not find final root boundary");
  source = source.replace(finalRootBoundary, finalRootAttack);
  return { ...loaded, source };
}
