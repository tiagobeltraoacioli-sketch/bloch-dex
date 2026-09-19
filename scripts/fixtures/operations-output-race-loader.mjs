// Test-only source loader for deterministic reserved-output mutation windows.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs"))
    return loaded;

  let source = String(loaded.source);
  const beforeValidation =
    "  const bytes = Buffer.from(`${canonicalJson(value)}\\n`, \"utf8\");";
  const preWriteAttack = `${beforeValidation}
  if (process.env.POSTERN_OPERATIONS_OUTPUT_RACE_MODE === "before-validation") {
    const filesystem = await import("node:fs/promises");
    const target = process.env.POSTERN_OPERATIONS_OUTPUT_RACE_TARGET;
    await filesystem.chmod(target, 0o600);
    await filesystem.writeFile(target, "occupied-before-publication\\n");
    await filesystem.chmod(target, 0o444);
  }`;
  if (!source.includes(beforeValidation))
    throw new Error("operations output race loader could not find validation boundary");
  source = source.replace(beforeValidation, preWriteAttack);

  const afterWrite = "  const opened = await reservation.handle.stat({ bigint: true });";
  const postWriteAttack = `  globalThis.__posternOutputReadbackCount =
    (globalThis.__posternOutputReadbackCount ?? 0) + 1;
  const outputRaceMode = process.env.POSTERN_OPERATIONS_OUTPUT_RACE_MODE;
  if ((outputRaceMode === "after-write" &&
      globalThis.__posternOutputReadbackCount === 1) ||
      (outputRaceMode === "after-parent-sync" &&
      globalThis.__posternOutputReadbackCount === 2)) {
    const filesystem = await import("node:fs/promises");
    const target = process.env.POSTERN_OPERATIONS_OUTPUT_RACE_TARGET;
    const changed = await filesystem.readFile(target);
    changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
    await filesystem.chmod(target, 0o600);
    await filesystem.writeFile(target, changed);
    await filesystem.chmod(target, 0o444);
  } else if (!["before-validation", "after-write", "after-parent-sync"]
      .includes(outputRaceMode)) {
    throw new Error("operations output race mode is invalid");
  }
${afterWrite}`;
  if (!source.includes(afterWrite))
    throw new Error("operations output race loader could not find readback boundary");
  source = source.replace(afterWrite, postWriteAttack);
  return { ...loaded, source };
}
