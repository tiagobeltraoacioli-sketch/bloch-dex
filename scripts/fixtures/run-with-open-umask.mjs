import { fileURLToPath } from "node:url";

const cli = new URL("../publication-quorum-transport-operations.mjs", import.meta.url);
process.umask(0);
process.argv = [process.execPath, fileURLToPath(cli), ...process.argv.slice(2)];
await import(cli);
