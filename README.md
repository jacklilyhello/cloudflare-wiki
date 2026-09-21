# Cloudflare Wiki / Emby Wiki

A new Cloudflare-native bilingual Markdown wiki. The current implementation provides a **server-rendered public reader**, original starter documentation and a single-administrator sign-in, dashboard and account interface. D1 stores published content, drafts, immutable revisions, a bilingual full-text index and authentication state. The content editor and management interfaces remain under development. No code/data is inherited from Cloudflare-Native-Wiki.

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

The Worker renders the article before JavaScript runs. React hydrates reading controls; ordinary links, search, content and disclosure blocks work without JavaScript. `migrations/0003_starter_content.sql` publishes six original starter articles once when the database is initialized. `content/` keeps their original Markdown as reference; changing those files does not overwrite persisted articles. `worker/content/public.ts` reads only the current published revision from D1. Drafts, deleted pages and unpublished translations are excluded from articles, navigation, metadata, search and sitemap.

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

## Content and versions

`worker/content/service.ts` provides the server-side content domain. Each bilingual page has a stable identity; each language has its own path, draft and publication pointer. Saves create immutable snapshots with change notes. A restore copies an old snapshot into a **new draft** and leaves the publication unchanged. Moves preserve direct redirects from old paths; unpublishing or soft deletion also hides its routes and removes search results. Restoring a deleted page leaves it unpublished.

Every change to an existing translation requires the caller's current write version. A D1 batch guards all revision, route, search and audit changes before advancing that version; stale writers receive a conflict and leave no partial records. Publication selects the explicit current draft. The publication index and pointer change in the same transaction. Revisions and audit events reject updates and deletion at the database level.

Search uses D1 FTS5 with title, tag, description, path and body weights. Normalized English words and adjacent Chinese-character phrases are queried as literal text; punctuation separates words, and FTS/SQL operators are never passed through. Results remain in the selected language and are limited to 30. Raw Markdown delimiters and hidden HTML are omitted from excerpts.

These services are tested in workerd but are **not exposed through HTTP mutation endpoints**. The editor, page/version management UI, visual navigation management, R2/file management, redirects management and site settings are not implemented yet.

## Administrator

Open `/admin` to initialize the sole administrator or sign in. The interface selects the form from the server's initialization state; it has no registration or ordinary user accounts. The dashboard shows content counts and recent changes. `/admin/account` changes the username or password after verifying the current password. The admin module and CSS load only on admin routes, with Chinese and English interface controls.

The owner enables one-time setup by adding **`ADMIN_SETUP_TOKEN` as a GitHub Actions Secret**: an unpadded base64url encoding of at least 32 cryptographically random bytes, 43–256 characters. A password manager's cryptographically generated 64-character token using only letters and digits is a valid option. Keep this token in the owner's password manager and enter it only in the setup form over HTTPS. Do not put it in URLs, repository files, local environment files, Worker secrets, build variables, logs or task messages.

The next authorized main deployment hashes the optional secret with SHA-256 in Actions, after deployment guards pass. After D1 ownership and migrations are verified, a single guarded statement stores only the hash and a 24-hour expiry in `admin_bootstrap`. The raw token is removed from the deployment process environment before Wrangler runs; it is never a Worker binding. Without the secret, deployment skips bootstrap and public reading continues. Removing a configured Actions secret does not invalidate an already active setup window.

Repeated deployments with the **same token do not extend or reopen** its window, even after expiry. Before initialization, changing the Actions secret to a new random token and deploying main replaces the unconsumed hash and starts a new 24-hour window. Once an administrator exists or setup has been consumed, deployments cannot reopen setup or overwrite the administrator. Clear the optional Actions secret after successful initialization. There is no password-reset or administrator-recovery interface yet; do not delete authentication records or clear the consumed marker to regain access.

Passwords contain 12–128 Unicode characters, at most 512 UTF-8 bytes, and are stored as salted scrypt hashes with fixed parameters (`N=16384`, `r=8`, `p=5`). Session bearers contain 32 random bytes and are sent only in a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie; D1 stores their SHA-256 hashes. Sessions expire after eight hours or 30 minutes without activity. Logout revokes the current session; changing either username or password atomically advances the credential version and revokes all sessions, requiring sign-in again.

Authentication requests use bounded JSON bodies and shared D1 attempt limits before password hashing. Setup and login require a same-origin request; authenticated changes also require the session's CSRF token. Anonymous `/api/admin/session` and `/api/admin/overview` requests return 401. Public setup status exposes only `initialized` and `setupAvailable` booleans. Authentication responses are uncached, and the admin shell contains no account or draft data.

## Local development

Use Node 24 (`nvm use`) and npm. No Cloudflare token/login is needed.

```sh
npm ci
npm run dev
```

The server prints its local URL. `npm run dev` first applies reviewed migrations to local D1 in `.wrangler/state/`; repeated runs preserve existing data. `npm run db:local` applies pending local migrations separately. Worker code runs locally in workerd. The checked-in DB identifier is a local placeholder with `remote: false`; no real database ID or token is needed.

```sh
npm run verify
```

This runs lint, formatting, TypeScript, Workers-runtime/deployment-policy tests, build and local smoke. `npm run cf:types` generates ignored runtime types. `npm run format` formats supported source/config files. `npm run build` builds; `npm run preview` previews it. `npm run test:preview` applies local migrations and starts/stops its own preview on port 4173. Unit tests apply the same SQL migrations in isolated local D1 storage. Node is tooling, not the production server.

No environment values are required locally. See `.env.example` and `.dev.vars.example`. Local migrations do not open administrator setup; isolated authentication tests supply their own fixtures. Never copy the live setup token locally or put secrets in `VITE_*`; any local Cloudflare credential must be read-only.

## GitHub configuration

Settings → Secrets and variables → Actions:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Owner-provided deployment token; never reveal/copy locally |
| Secret | `ADMIN_SETUP_TOKEN` | Optional owner-generated one-time setup token; Actions hashes it before writing D1 |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Actual account ID |
| Variable | `CLOUDFLARE_ZONE_ID` | Actual active emby.wiki zone ID |
| Variable | `CLOUDFLARE_WORKER_NAME` | `cloudflare-wiki` |
| Variable | `TEST_DOMAIN` | `cf.emby.wiki` (hostname only) |

The existing token must support Worker deployment and Custom Domain management for the selected account/zone, plus preflight reads of zone, DNS, Worker settings, domains and routes, and D1 read/write access for the test database. No new permission is granted by this repository. Missing permissions stop deployment; never expand them automatically. Conflicts stop without deleting resources. Do not enable an additional Cloudflare Git deployment integration.

## Delivery

1. Branch from current main using `feature/`, `fix/`, `chore/`, `docs/`, `refactor/` or `test/`.
2. Implement, run `npm run verify`, inspect secrets and open a PR.
3. Require successful `CI` and resolved conversations; squash merge when authorized.
4. Main push triggers `Deploy Test`: validation, preflight, deployment, smoke test.

PR CI receives no Cloudflare credential and never deploys. Manual deployment accepts only main. `npm run deploy:test` refuses local execution. All cloud writes and remote migrations run in Actions.

After CI exists, import `.github/rulesets/main.json` through **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or apply it via the authenticated Administration API. A file in Git does **not** activate rules. The policy requires PR/CI/conversation resolution and linear history, blocks deletion/force push, has no bypass actors and permits squash only. Prefer squash-only repository merge settings too. Read back live settings before claiming protection is active.

## Deployment and health

Only Worker `cloudflare-wiki`, Custom Domain `cf.emby.wiki` and D1 database `cloudflare-wiki-test` are provisioned and reused. R2 and KV are not provisioned yet. Actions locates the exact D1 name, validates the project ownership marker and migration ledger, applies pending reviewed migrations, and verifies the Worker DB binding after deployment. An existing unmarked database is never adopted or replaced. If creation succeeds but initialization fails before the marker is committed, the workflow stops for explicit recovery; it does not retry creation or delete the resource. Wrangler automatic resource provisioning is disabled. Database creation and remote SQL never run locally. Its stable `cloudflare-wiki.<account-subdomain>.workers.dev` address is enabled only for GitHub Actions post-deploy smoke tests; the deployment script reads the account subdomain through Cloudflare's API and publishes the exact URL as a step output. `cf.emby.wiki` remains the actual test Custom Domain. Versioned and aliased Preview URLs remain disabled.

`GET /health` returns uncached public liveness metadata:

```json
{ "status": "ok", "service": "cloudflare-wiki", "environment": "test", "revision": "<commit SHA or local>" }
```

HEAD is supported; writes are rejected. Unknown `/api/*` outside the protected admin namespace returns JSON 404 even for browser navigation. Smoke checks verify exact revision, server-rendered articles, language-specific search, genuine reader 404s, metadata, sitemap, JS assets, robots policy and API behavior. Anonymous GET checks also verify the admin shell, protected session/overview endpoints and setup-status shape in any initialization state. Smoke never submits setup credentials, logs in or consumes a setup token. Test responses are noindex.

```sh
SMOKE_BASE_URL=https://cf.emby.wiki EXPECTED_SHA=<main-commit-sha> npm run smoke
```

Inspect failed workflow jobs/steps/logs and repair through PR. Never bypass tests or deploy with a local write token. Rollbacks use normal revert/fix PRs and main deployment, not history rewrites or arbitrary old-branch deployment. Applied database migrations are immutable and retained in the ledger: use additive forward migrations for schema repairs. Reverting application behavior must preserve the D1 binding and migration files; do not delete the database or undo stored revisions.

`codex.md` records product constraints, implemented boundaries and remaining module/storage plans. Production needs a separate explicit task.
