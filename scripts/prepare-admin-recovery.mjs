import { randomBytes } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseRecoveryBundle } from "./administrator-recovery.mjs";

// Never accepts a password/token in argv or prints the resulting bundle. Keep
// its private output outside the checkout and pass it to gh secret set via stdin.
export async function prepareRecoveryFile(
  { passwordFile, expectedVersion, output },
  now = Date.now(),
) {
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const parent = await realpath(dirname(resolve(output)));
  const within = relative(root, parent);
  if (
    !within ||
    (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  )
    throw new Error("Recovery output must be outside the repository.");
  const password = await readFile(passwordFile, "utf8");
  const bundle = {
    password,
    token: randomBytes(32).toString("base64url"),
    expectedVersion,
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  };
  const encoded = JSON.stringify(bundle);
  parseRecoveryBundle(encoded, now);
  await writeFile(output, encoded, { mode: 0o600, flag: "wx" });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [passwordFile, version, output, ...extra] = process.argv.slice(2);
  if (!passwordFile || !version || !output || extra.length) {
    console.error(
      "Usage: node scripts/prepare-admin-recovery.mjs PASSWORD_FILE EXPECTED_VERSION PRIVATE_OUTPUT_FILE",
    );
    process.exitCode = 1;
  } else
    prepareRecoveryFile({
      passwordFile,
      expectedVersion: Number(version),
      output,
    })
      .then(() =>
        console.log(
          "Private recovery bundle created; install as the protected Actions Secret without displaying its contents.",
        ),
      )
      .catch(() => {
        console.error(
          "Recovery bundle creation failed. Check inputs and an unused path outside the repository.",
        );
        process.exitCode = 1;
      });
}
