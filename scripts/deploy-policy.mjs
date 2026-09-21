export function validateDeployment(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "jacklilyhello/cloudflare-wiki" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)
  ) {
    throw new Error(
      "Cloudflare writes are allowed only in this repository's main GitHub Actions workflow.",
    );
  }
  const required = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_WORKER_NAME",
    "TEST_DOMAIN",
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `Missing GitHub Actions configuration: ${missing.join(", ")}`,
    );
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"]) {
    if (!/^[a-f0-9]{32}$/i.test(env[name]))
      throw new Error(`Invalid Variable: ${name}`);
  }
  if (env.TEST_DOMAIN !== "cf.emby.wiki")
    throw new Error("Only cf.emby.wiki may be deployed.");
  if (env.CLOUDFLARE_WORKER_NAME !== "cloudflare-wiki")
    throw new Error("Only the cloudflare-wiki Worker may be deployed.");
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))
    throw new Error("Missing or invalid GitHub commit SHA.");
}
