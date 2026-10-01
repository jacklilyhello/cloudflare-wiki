import { execFileSync, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRAND_VARIABLES,
  BrandingError,
  checkVariableLimits,
  decodeBranding,
  fail,
  MANIFEST_VARIABLE,
} from "./branding-config.mjs";

const repository = "jacklilyhello/cloudflare-wiki";
// Uses the owner's local gh login only. No GitHub credential enters the Worker
// or Cloudflare; values travel through stdin, never command arguments/output.
export async function installBranding(
  directory,
  { execute = execFileSync, spawn = spawnSync } = {},
) {
  const variables = {};
  for (const name of [MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)]) {
    const file = resolve(directory, name);
    try {
      if ((await stat(file)).size > 48 * 1024) fail();
      variables[name] = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!variables[MANIFEST_VARIABLE])
    fail(
      "A prepared manifest is required, including when restoring default branding.",
    );
  await decodeBranding(variables);
  const pages = JSON.parse(
    execute(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/actions/variables?per_page=100`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const existing = pages.flatMap((page) => page.variables ?? []);
  if (
    !pages.length ||
    pages.some((page) => page.total_count !== existing.length) ||
    new Set(existing.map((item) => item.name)).size !== existing.length
  )
    fail("Repository Variable inventory is incomplete.");
  const merged = Object.fromEntries(
    existing
      .filter(
        (item) =>
          ![MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)].includes(
            item.name,
          ),
      )
      .map((item) => [item.name, item.value]),
  );
  checkVariableLimits({ ...merged, ...variables });
  const run = (args, input) => {
    const result = spawn("gh", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0)
      fail(
        "Repository Variable update failed; do not deploy. Rerun the complete installer after correcting GitHub access.",
      );
  };
  // The manifest commits the complete set last. Mixed generations fail checksum
  // validation if an owner starts deployment during configuration changes.
  for (const name of Object.values(BRAND_VARIABLES)) {
    if (variables[name])
      run(["variable", "set", name, "--repo", repository], variables[name]);
    else if (existing.some((item) => item.name === name))
      run(["variable", "delete", name, "--repo", repository]);
  }
  run(
    ["variable", "set", MANIFEST_VARIABLE, "--repo", repository],
    variables[MANIFEST_VARIABLE],
  );
  const confirmedPages = JSON.parse(
    execute(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/actions/variables?per_page=100`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const confirmed = Object.fromEntries(
    confirmedPages
      .flatMap((page) => page.variables)
      .map((item) => [item.name, item.value]),
  );
  for (const name of [MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)])
    if ((confirmed[name] ?? "") !== (variables[name] ?? ""))
      fail("Repository Variable readback mismatch; do not deploy.");
  checkVariableLimits(confirmed);
  return {
    repository,
    configuredVariables: Object.keys(variables),
    readback: "verified",
    deployment: "Run Deploy Production manually on main",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) {
    console.error(
      "Usage: node scripts/install-branding.mjs PREPARED_PRIVATE_DIRECTORY",
    );
    process.exitCode = 1;
  } else
    installBranding(directory)
      .then((report) => console.log(JSON.stringify(report)))
      .catch((error) => {
        console.error(
          error instanceof BrandingError
            ? error.message
            : "Repository branding configuration failed. No value was logged; check local files and GitHub access.",
        );
        process.exitCode = 1;
      });
}
