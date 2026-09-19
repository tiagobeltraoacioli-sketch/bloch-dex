// Test-only source loader for deterministic migration-destination replacement.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs"))
    return loaded;

  let source = String(loaded.source);
  const attack = (mode) => `      if (process.env.POSTERN_OPERATIONS_MIGRATION_RACE_MODE === ${JSON.stringify(mode)}) {
        const filesystem = await import("node:fs/promises");
        const target = process.env.POSTERN_OPERATIONS_MIGRATION_RACE_TARGET;
        await filesystem.rename(target, \`${"${target}"}.displaced\`);
        await filesystem.mkdir(target, { mode: 0o700 });
      }
`;
  const childAttack = (mode, child) => `  if (process.env.POSTERN_OPERATIONS_MIGRATION_RACE_MODE === ${JSON.stringify(mode)}) {
    const filesystem = await import("node:fs/promises");
    const target = \`${"${process.env.POSTERN_OPERATIONS_MIGRATION_RACE_TARGET}"}/${child}\`;
    await filesystem.rename(target, \`${"${target}"}.displaced\`);
    await filesystem.mkdir(target, { mode: 0o700 });
  }
`;
  const acceptanceCheck = `  await requirePinnedDirectoryIdentity(
    acceptancesDirectory, \`migration acceptance directory ${"${phase}"}\`,
  );`;
  if (!source.includes(acceptanceCheck))
    throw new Error("migration race loader could not find acceptance check");
  source = source.replace(acceptanceCheck,
    childAttack("replace-rotations-between-checks", "rotations") + acceptanceCheck +
    childAttack("replace-acceptances-between-checks", "anchor-acceptances"));

  const copyBoundary = `        await requirePinnedMigrationDestination(
          rootDirectory, rotationsDirectory, acceptancesDirectory, "after rotation copy",
        );`;
  if (!source.includes(copyBoundary))
    throw new Error("migration race loader could not find copy boundary");
  source = source.replace(copyBoundary,
    attack("during-copy") + copyBoundary);

  const checkpointBoundary = `      await requirePinnedMigrationDestination(
        rootDirectory, rotationsDirectory, acceptancesDirectory,
        "before checkpoint publication",
      );`;
  if (!source.includes(checkpointBoundary))
    throw new Error("migration race loader could not find checkpoint boundary");
  source = source.replace(checkpointBoundary,
    attack("before-checkpoint") + checkpointBoundary);

  const finalBoundary = `          await requirePinnedMigrationDestination(
            rootDirectory, rotationsDirectory, acceptancesDirectory,
            "immediately before migration success",
          );`;
  if (!source.includes(finalBoundary))
    throw new Error("migration race loader could not find final success boundary");
  source = source.replace(finalBoundary,
    attack("root-after-final-audit").replaceAll("      ", "          ") + finalBoundary);
  return { ...loaded, source };
}
