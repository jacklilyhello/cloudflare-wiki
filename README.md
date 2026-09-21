# Cloudflare Wiki / Emby Wiki

A new Cloudflare-native bilingual Markdown wiki. The current implementation provides a **server-rendered public reader** with original starter documentation. The administrator CMS and persistent content storage are under development. No code/data is inherited from Cloudflare-Native-Wiki.

- Test: <https://cf.emby.wiki>
- Future production: `emby.wiki` — not configured or deployed here.
- Stack: React, TypeScript, Vite, Workers Static Assets, official Cloudflare Vite plugin.
- Read `AGENTS.md`, then `codex.md` before development.

## Public reader

- `/zh/home` and `/en/home`: translated articles, nested navigation, breadcrumbs, contents, heading links, theme selection, code copying, image viewing and responsive layout.
- `/{language}/search?q=...`: server-rendered search over titles, descriptions, body, tags and paths; matches stay in the selected language. Queries are limited to 200 characters.
- `/api/public/search?lang=zh&q=...`: read-only JSON search; only `zh` and `en` are accepted.
- `/sitemap.xml`: current published catalog, with a fixed test origin. Article responses include canonical, translated-language and OpenGraph metadata. The test environment remains noindex and robots-blocked.
- Unknown document routes return a genuine 404; public article and API writes are rejected.

The Worker renders the article before JavaScript runs. React hydrates reading controls; ordinary links, search, content and disclosure blocks work without JavaScript. `content/` contains original starter articles, isolated behind `worker/content/catalog.ts`; it is not yet a persistent CMS. Only this published catalog reaches anonymous visitors.

`shared/markdown.ts` is the shared Markdown renderer intended for both reader and editor preview. It supports CommonMark/GFM, tables, tasks, footnotes, syntax highlighting, heading anchors, `[[guide/reading|internal links]]`, GitHub-style callouts, safe semantic HTML, KaTeX MathML and Mermaid source blocks. Diagram enhancement loads only when needed, uses strict Mermaid settings, and displays sanitized SVG as an image with the source preserved. Raw HTML cannot opt into trusted enhancements. Source size, tree complexity, code, diagram and math workloads are bounded.

Grouped examples use directive syntax with a native disclosure fallback:

```markdown
:::tabs
::tab[Configuration]
Configuration explanation.

::tab[Verification]
Verification explanation.
:::
```

In GFM table cells, escape the Wiki link label separator as `[[guide/reading\|Reading guide]]`. Mermaid enhancement allows up to eight diagrams, 8,000 source characters, 200 statements and 150 edges per diagram; generated SVG is capped at 240 KB. Author configuration, image/icon resources, navigation, CSS and property objects are intentionally unsupported and stay visible as source. Math uses native MathML; HTML is a conservative semantic subset with no scripts, styles, author IDs or event handlers.

No administrator login, saved drafts, publication workflow, D1/R2 storage, file manager or revision restoration is available yet. These belong to the ongoing product work; the reader does not pretend to provide them.

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

Only Worker `cloudflare-wiki` and Custom Domain `cf.emby.wiki` are provisioned and reused. No D1/R2/KV or migrations are needed. Its stable `cloudflare-wiki.<account-subdomain>.workers.dev` address is enabled only for GitHub Actions post-deploy smoke tests; the deployment script reads the account subdomain through Cloudflare's API and publishes the exact URL as a step output. `cf.emby.wiki` remains the actual test Custom Domain. Versioned and aliased Preview URLs remain disabled.

`GET /health` returns uncached public liveness metadata:

```json
{ "status": "ok", "service": "cloudflare-wiki", "environment": "test", "revision": "<commit SHA or local>" }
```

HEAD is supported; writes are rejected. Unknown `/api/*` returns JSON 404 even for browser navigation. Smoke checks verify exact revision, server-rendered articles, language-specific search, genuine reader 404s, metadata, sitemap, JS assets, robots policy and API behavior. Test responses are noindex.

```sh
SMOKE_BASE_URL=https://cf.emby.wiki EXPECTED_SHA=<main-commit-sha> npm run smoke
```

Inspect failed workflow jobs/steps/logs and repair through PR. Never bypass tests or deploy with a local write token. Rollbacks use normal revert PRs and main deployment, not history rewrites or arbitrary old-branch deployment.

`codex.md` records product constraints, implemented boundaries and remaining module/storage plans. Production needs a separate explicit task.
