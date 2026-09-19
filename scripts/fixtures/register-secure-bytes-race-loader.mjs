// Node 18.19+, 20.6+ and 21+ support registering an ESM loader from
// `--import`, avoiding the deprecated `--experimental-loader` flag.
import { register } from "node:module";

register("./secure-bytes-race-loader.mjs", import.meta.url);
