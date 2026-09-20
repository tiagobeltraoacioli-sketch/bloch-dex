// Test-only source loader for deterministic mutation after evidence collection.
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs")) return loaded;

  let source = String(loaded.source);
  const boundary = `    await requirePinnedDirectory(
      rotationsDirectory, "checkpoint recovery rotation history after audit",
    );`;
  const attack = `    if (!globalThis.__posternCheckpointEvidenceRaceInjected) {
      globalThis.__posternCheckpointEvidenceRaceInjected = true;
      const filesystem = await import("node:fs");
      const target = process.env.POSTERN_CHECKPOINT_EVIDENCE_RACE_TARGET;
      const mode = process.env.POSTERN_CHECKPOINT_EVIDENCE_RACE_MODE;
      if (mode === "same-inode-post-read") {
        const bytes = filesystem.readFileSync(target);
        bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
        filesystem.chmodSync(target, 0o600);
        filesystem.writeFileSync(target, bytes);
        filesystem.chmodSync(target, 0o400);
      } else if (mode === "history-namespace") {
        filesystem.renameSync(target, target + ".displaced");
        filesystem.writeFileSync(target, filesystem.readFileSync(target + ".displaced"), { mode: 0o400 });
      } else if (mode === "hardlink") {
        filesystem.linkSync(target, target + ".alias");
      } else if (mode === "third-head") {
        filesystem.renameSync(target, target + ".approved-displaced");
        filesystem.copyFileSync(process.env.POSTERN_CHECKPOINT_EVIDENCE_RACE_REPLACEMENT, target);
      } else if (mode === "guard-sigstop") {
        // The helper was stopped immediately after READY; reaching this point
        // would itself demonstrate a broken timeout test, but do not mask it.
      } else {
        throw new Error("unknown checkpoint evidence race mode");
      }
    }
${boundary}`;
  if (!source.includes(boundary))
    throw new Error("checkpoint evidence race loader could not find proof boundary");
  source = source.replace(boundary, attack);
  if (process.env.POSTERN_CHECKPOINT_EVIDENCE_RACE_MODE === "guard-sigstop") {
    const readyBoundary = `    if (await nextGuardLine(lines, child) !== "READY")
      fail("checkpoint recovery namespace guard failed to arm");`;
    if (!source.includes(readyBoundary))
      throw new Error("checkpoint evidence race loader could not find guard boundary");
    source = source.replace(readyBoundary, `${readyBoundary}
    child.kill("SIGSTOP");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));`);
  }
  return { ...loaded, source };
}
