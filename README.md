# Cloudflare Wiki / Emby Wiki

A new Cloudflare-native bilingual Markdown wiki foundation. Current scope: **test page and health endpoint**, not a complete CMS. No code/data is inherited from Cloudflare-Native-Wiki.

- Test: <https://cf.emby.wiki>
- Future production: `emby.wiki` — not configured or deployed here.
- Stack: React, TypeScript, Vite, Workers Static Assets, official Cloudflare Vite plugin.
- Read `AGENTS.md`, then `codex.md` before development.

## Local development

Use Node 24 (`nvm use`) and npm. No Cloudflare token/login is needed.

```sh
npm ci
npm run dev
```

The server prints its local URL. Worker code runs locally in workerd. Keep development bindings local.

```sh
npm run verify
```

This runs lint, formatting, TypeScript, Workers-runtime/deployment-policy tests, build and local smoke. `npm run cf:types` generates ignored runtime types. `npm run format` formats supported source/config files. `npm run build` builds; `npm run preview` previews it. `npm run test:preview` starts/stops its own preview on port 4173. Node is tooling, not the production server.

No environment values are required locally. See `.env.example` and `.dev.vars.example`. Never put secrets in `VITE_*`; any local Cloudflare credential must be read-only.

## GitHub configuration

Settings → Secrets and variables → Actions:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Owner-provided deployment token; never reveal/copy locally |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Actual account ID |
| Variable | `CLOUDFLARE_ZONE_ID` | Actual active emby.wiki zone ID |
| Variable | `CLOUDFLARE_WORKER_NAME` | `cloudflare-wiki` |
| Variable | `TEST_DOMAIN` | `cf.emby.wiki` (hostname only) |

The existing token must support Worker deployment and Custom Domain management for the selected account/zone, plus preflight reads of zone, DNS, Worker settings, domains and routes. Missing permissions stop deployment; never expand them automatically. Conflicts stop without deleting resources. Do not enable an additional Cloudflare Git deployment integration.

## Delivery

1. Branch from current main using `feature/`, `fix/`, `chore/`, `docs/`, `refactor/` or `test/`.
2. Implement, run `npm run verify`, inspect secrets and open a PR.
3. Require successful `CI` and resolved conversations; squash merge when authorized.
4. Main push triggers `Deploy Test`: validation, preflight, deployment, smoke test.

PR CI receives no Cloudflare credential and never deploys. Manual deployment accepts only main. `npm run deploy:test` refuses local execution. All cloud writes and future remote migrations run in Actions.

After CI exists, import `.github/rulesets/main.json` through **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or apply it via the authenticated Administration API. A file in Git does **not** activate rules. The policy requires PR/CI/conversation resolution and linear history, blocks deletion/force push, has no bypass actors and permits squash only. Prefer squash-only repository merge settings too. Read back live settings before claiming protection is active.

## Deployment and health

Only Worker `cloudflare-wiki` and Custom Domain `cf.emby.wiki` are provisioned and reused. No D1/R2/KV or migrations are needed. workers.dev and preview URLs are disabled.

`GET /health` returns uncached public liveness metadata:

```json
{ "status": "ok", "service": "cloudflare-wiki", "environment": "test", "revision": "<commit SHA or local>" }
```

HEAD is supported; writes are rejected. Unknown `/api/*` returns JSON 404 even for browser navigation. Smoke checks verify exact revision, homepage, JS asset, robots policy and API behavior. Test responses are noindex.

```sh
SMOKE_BASE_URL=https://cf.emby.wiki EXPECTED_SHA=<main-commit-sha> npm run smoke
```

Inspect failed workflow jobs/steps/logs and repair through PR. Never bypass tests or deploy with a local write token. Rollbacks use normal revert PRs and main deployment, not history rewrites or arbitrary old-branch deployment.

`codex.md` contains future product constraints and module/storage plans. Initialization does not begin that feature work. Production needs a separate explicit task.
