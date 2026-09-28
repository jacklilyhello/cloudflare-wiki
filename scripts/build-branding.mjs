import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRAND_VARIABLES,
  BrandingError,
  decodeBranding,
  fail,
  MANIFEST_VARIABLE,
} from "./branding-config.mjs";

export async function buildBranding(variables, root = process.cwd()) {
  // Complete validation precedes filesystem mutations. Only generated hash-named
  // files in this reserved directory may be replaced; unfamiliar files stop it.
  const decoded = await decodeBranding(variables);
  const assets = resolve(root, "public/assets/branding");
  const configuration = resolve(root, ".branding");
  await mkdir(assets, { recursive: true });
  const old = await readdir(assets, { withFileTypes: true });
  if (
    old.some(
      (file) =>
        !file.isFile() ||
        !/^(logoLight|logoDark|favicon|appleTouch|ogImage)-[a-f0-9]{64}\.(png|jpg|webp)$/.test(
          file.name,
        ),
    )
  )
    fail("Unexpected file in the reserved generated branding directory.");
  for (const file of old) await unlink(resolve(assets, file.name));
  for (const { asset, bytes } of decoded.files)
    await writeFile(resolve(assets, basename(asset.path)), bytes, {
      flag: "wx",
    });
  await mkdir(configuration, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(configuration, "branding.json"),
    JSON.stringify(decoded.branding),
    { mode: 0o600 },
  );
  return {
    images: decoded.files.length,
    configuredLanguages: Object.keys(decoded.branding.locales),
  };
}
export async function readBuiltBranding(root = process.cwd()) {
  const config = JSON.parse(
    await readFile(resolve(root, ".branding/branding.json"), "utf8"),
  );
  const variables = { [MANIFEST_VARIABLE]: JSON.stringify(config) };
  // Validate the manifest before using its path to read the build tree.
  const { parseBranding } = await import("../shared/branding.ts");
  const validated = parseBranding(variables[MANIFEST_VARIABLE]);
  for (const [role, asset] of Object.entries(validated.assets))
    variables[BRAND_VARIABLES[role]] = (
      await readFile(resolve(root, "dist/client", asset.path.slice(1)))
    ).toString("base64");
  await decodeBranding(variables);
  return variables[MANIFEST_VARIABLE];
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const variables = Object.fromEntries(
    [MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)].map((name) => [
      name,
      process.env[name] ?? "",
    ]),
  );
  for (const name of Object.keys(variables)) delete process.env[name];
  buildBranding(variables)
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(
        error instanceof BrandingError
          ? error.message
          : "Branding build failed; no deployment was attempted.",
      );
      process.exitCode = 1;
    });
}
