import { verifyStagingDeployment } from "./rpc-verifier.mjs";
import { validateStagingConfig, stableJson, sha256 } from "./manifest.mjs";
// Both capture formats use the same bounded canonical, pinned file transport.
export { readPoolCapture as readDeploymentCapture } from "./pool-replay.mjs";
const DOMAIN = "postern.dex.deployment-rpc-capture.v1";
const MAX_BYTES = 4 * 1024 * 1024,
  MAX_CALLS = 80;
const digest = (value) => "0x" + sha256(stableJson(value));
function required(ok, message) {
  if (!ok) throw new Error("deployment replay: " + message);
}
function exact(value, keys) {
  required(
    value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "invalid object fields",
  );
}
function bounded(value) {
  const text = stableJson(value);
  required(
    Buffer.byteLength(text) + 1 <= MAX_BYTES,
    "capture exceeds byte limit",
  );
  return text;
}
function entry(value) {
  exact(value, ["method", "params", "result"]);
  required(
    ["eth_chainId", "eth_getBlockByNumber", "eth_getCode"].includes(
      value.method,
    ),
    "unsupported method",
  );
  required(
    Array.isArray(value.params) &&
      Buffer.byteLength(stableJson(value.params)) <= 1024,
    "invalid parameters",
  );
  if (value.method === "eth_getBlockByNumber") {
    exact(value.result, ["number", "hash"]);
    required(
      typeof value.result.number === "string" &&
        value.result.number.length <= 66 &&
        typeof value.result.hash === "string" &&
        value.result.hash.length === 66,
      "invalid block fields",
    );
  } else
    required(
      typeof value.result === "string" && value.result.length <= 1024 * 1024,
      "invalid or oversized result",
    );
}
export async function captureDeployment(config, request) {
  validateStagingConfig(config);
  const selected = structuredClone(config),
    transcript = [];
  let bytes = 0;
  const observation = await verifyStagingDeployment(
    selected,
    async (method, params) => {
      required(transcript.length < MAX_CALLS, "too many RPC calls");
      const original = await request(method, structuredClone(params));
      const result =
        method === "eth_getBlockByNumber" &&
        original &&
        typeof original === "object"
          ? { number: original.number, hash: original.hash }
          : original;
      const retained = {
        method,
        params: structuredClone(params),
        result: structuredClone(result),
      };
      entry(retained);
      bytes += Buffer.byteLength(stableJson(retained));
      required(bytes <= MAX_BYTES - 65536, "transcript exceeds byte limit");
      transcript.push(retained);
      return structuredClone(result);
    },
  );
  const body = {
    schemaVersion: 1,
    domain: DOMAIN,
    configurationSha256: digest(selected),
    transcript,
    observation,
  };
  const capture = { ...body, captureSha256: digest(body) };
  bounded(capture);
  return capture;
}
export async function replayDeployment(config, capture) {
  validateStagingConfig(config);
  const selected = structuredClone(config),
    retained = JSON.parse(bounded(capture));
  exact(retained, [
    "schemaVersion",
    "domain",
    "configurationSha256",
    "transcript",
    "observation",
    "captureSha256",
  ]);
  required(
    retained.schemaVersion === 1 && retained.domain === DOMAIN,
    "unsupported schema",
  );
  const { captureSha256, ...body } = retained;
  required(digest(body) === captureSha256, "capture digest mismatch");
  required(
    retained.configurationSha256 === digest(selected),
    "different reviewed configuration",
  );
  required(
    Array.isArray(retained.transcript) &&
      retained.transcript.length > 0 &&
      retained.transcript.length <= MAX_CALLS,
    "invalid transcript length",
  );
  retained.transcript.forEach(entry);
  let cursor = 0;
  const observation = await verifyStagingDeployment(
    selected,
    async (method, params) => {
      const observed = retained.transcript[cursor++];
      required(
        observed &&
          observed.method === method &&
          stableJson(observed.params) === stableJson(params),
        "RPC sequence or parameters differ",
      );
      return structuredClone(observed.result);
    },
  );
  required(cursor === retained.transcript.length, "unused RPC responses");
  required(
    stableJson(observation) === stableJson(retained.observation),
    "observation differs from replay",
  );
  return {
    schemaVersion: 1,
    domain: "postern.dex.deployment-offline-replay.v1",
    captureSha256,
    configurationSha256: digest(selected),
    observationSha256: digest(observation),
    transcriptCallsReplayed: cursor,
    observationReproduced: true,
    stateReadsHashPinned: true,
    snapshot: observation.snapshot,
    identities: observation.identities,
    sourceRpcAuthenticated: false,
    finalityAuthenticated: false,
    deploymentAuthenticated: false,
    activationAuthorized: false,
    liquidityEnabled: false,
    broadcastPerformed: false,
  };
}
