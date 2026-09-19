export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/publication-quorum-transport-operations.mjs"))
    return loaded;

  let source = String(loaded.source);
  const readBoundary = `      const { bytesRead } = await handle.read(
        buffer, length, buffer.length - length, null,
      );`;
  const interceptedRead = `${readBoundary}
      if (process.env.POSTERN_SECURE_BYTES_RACE_TARGET === path &&
          process.env.POSTERN_SECURE_BYTES_RACE_MODE === "grow-during-read" &&
          length === 0 && bytesRead > 0) {
        const filesystem = await import("node:fs/promises");
        await filesystem.chmod(path, 0o600);
        await filesystem.appendFile(path, Buffer.alloc(64_001, 0x20));
        await filesystem.chmod(path, Number(before.mode & 0o777n));
      }`;
  if (!source.includes(readBoundary))
    throw new Error("secure-bytes race loader could not find handle.read");
  source = source.replace(readBoundary, interceptedRead);

  const statBoundary = "    const after = await handle.stat({ bigint: true });";
  const afterEofMutation = `
    if (process.env.POSTERN_SECURE_BYTES_RACE_TARGET === path) {
      const filesystem = await import("node:fs/promises");
      const mode = process.env.POSTERN_SECURE_BYTES_RACE_MODE;
      if (mode === "same-inode-rewrite") {
        await filesystem.chmod(path, 0o600);
        await filesystem.writeFile(path, bytes);
        await filesystem.chmod(path, Number(before.mode & 0o777n));
      } else if (mode === "hardlink-after-eof") {
        await filesystem.link(path, path + ".alias");
      } else if (mode === "pathname-replacement") {
        await filesystem.rename(path, path + ".displaced");
        await filesystem.writeFile(path, bytes, {
          flag: "wx", mode: Number(before.mode & 0o777n),
        });
      } else if (mode !== "grow-during-read") {
        throw new Error("secure-bytes race mode is invalid");
      }
    }
`;
  if (!source.includes(statBoundary))
    throw new Error("secure-bytes race loader could not find the post-read stat");
  source = source.replace(statBoundary, `${afterEofMutation}${statBoundary}`);
  return { ...loaded, source };
}
