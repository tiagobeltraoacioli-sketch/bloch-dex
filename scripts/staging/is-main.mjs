// True when the module at `metaUrl` is the script node was started with.
// Both sides are resolved through the filesystem: `import.meta.url` is percent-encoded and
// follows symlinks, `process.argv[1]` is neither, so comparing them as text makes a tool
// started from a path with a space or through a symlink (macOS /tmp, /var) do nothing and
// exit 0. A gate or a keeper that silently does nothing must not look like success.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
