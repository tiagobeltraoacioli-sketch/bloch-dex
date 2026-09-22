#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySemanticLaunchPackage } from "./semantic-launch-package.mjs";

const args = process.argv.slice(2);
const basic = args.length === 2 && args[0] === "--package";
const authenticated =
  args.length === 6 &&
  args[0] === "--package" &&
  args[2] === "--trust-roots" &&
  args[4] === "--expected-trust-roots-sha256";
const capObserved =
  args.length === 22 &&
  args[0] === "--package" &&
  args[2] === "--trust-roots" &&
  args[4] === "--expected-trust-roots-sha256" &&
  args[6] === "--cap-approval" &&
  args[8] === "--cap-authority-policy" &&
  args[10] === "--expected-cap-authority-policy-sha256" &&
  args[12] === "--expected-cap-ceremony-id" &&
  args[14] === "--cap-risk-signature" &&
  args[16] === "--cap-security-signature" &&
  args[18] === "--ssh-keygen" &&
  args[20] === "--expected-ssh-keygen-sha256";
if (!basic && !authenticated && !capObserved) {
  console.error(
    "Usage: node scripts/staging/check-semantic-launch-package.mjs --package <repo-relative-package.json> [--trust-roots <repo-relative-trust-roots.json> --expected-trust-roots-sha256 <caller-supplied-0x-sha256> [--cap-approval <repo-relative-approval.json> --cap-authority-policy <repo-relative-allowed-signers> --expected-cap-authority-policy-sha256 <caller-supplied-0x-sha256> --expected-cap-ceremony-id <caller-supplied-0x-id> --cap-risk-signature <repo-relative.sig> --cap-security-signature <repo-relative.sig> --ssh-keygen <absolute-root-administered-path> --expected-ssh-keygen-sha256 <caller-supplied-0x-sha256>]]",
  );
  process.exit(2);
}
try {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const options = authenticated || capObserved
    ? {
        trustRootsPath: args[3],
        expectedTrustRootsSha256: args[5],
        ...(capObserved
          ? {
              capApproval: {
                approvalPath: args[7],
                authorityPolicyPath: args[9],
                expectedAuthorityPolicySha256: args[11],
                expectedCeremonyId: args[13],
                riskSignaturePath: args[15],
                securitySignaturePath: args[17],
                sshKeygenPath: args[19],
                expectedSshKeygenSha256: args[21],
              },
            }
          : {}),
      }
    : undefined;
  const report = await verifySemanticLaunchPackage(repository, args[1], options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.readyForReviewedActivation ? 0 : 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "semantic launch package: refused",
  );
  process.exitCode = 1;
}
