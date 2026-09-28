import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrandingError, encodeBranding, fail } from "./branding-config.mjs";

export async function prepareBranding(configFile, output) {
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const destination = resolve(output);
  const parent = await realpath(dirname(destination));
  const within = relative(root, parent);
  if (
    !within ||
    (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  )
    fail(
      "Encoded image output must be a new private directory outside the checkout.",
    );
  if ((await stat(configFile)).size > 16384)
    fail("Branding configuration file is too large.");
  const variables = await encodeBranding(
    JSON.parse(await readFile(configFile, "utf8")),
    async (path) => {
      const file = resolve(dirname(resolve(configFile)), path);
      if ((await stat(file)).size > 36 * 1024)
        fail("An image exceeds the 36 KiB binary budget (48 KiB encoded).");
      return readFile(file);
    },
  );
  await mkdir(destination, { mode: 0o700 });
  for (const [name, value] of Object.entries(variables))
    await writeFile(resolve(destination, name), value, {
      mode: 0o600,
      flag: "wx",
    });
  return { variables: Object.keys(variables), directoryCreated: true };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [config, output, ...extra] = process.argv.slice(2);
  if (!config || !output || extra.length) {
    console.error(
      "Usage: node scripts/prepare-branding.mjs LOCAL_CONFIG_JSON NEW_PRIVATE_OUTPUT_DIRECTORY",
    );
    process.exitCode = 1;
  } else
    prepareBranding(config, output)
      .then((report) => console.log(JSON.stringify(report)))
      .catch((error) => {
        console.error(
          error instanceof BrandingError
            ? error.message
            : "Branding preparation failed. Check local files and an unused private output directory.",
        );
        process.exitCode = 1;
      });
}
