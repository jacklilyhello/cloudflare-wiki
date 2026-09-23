# Cloudflare Wiki / Emby Wiki

A new Cloudflare-native bilingual Markdown wiki with a **server-rendered public reader** and a single-administrator content workspace. It includes original starter documentation, a Monaco Markdown editor, live preview, publication controls, revision history, visual navigation and redirect management, and an administrator audit trail. D1 stores published content, drafts, immutable revisions, a bilingual full-text index, navigation, route aliases and authentication state. Assets and site settings remain future work. No code/data is inherited from Cloudflare-Native-Wiki.

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

`shared/markdown.ts` renders both the reader and authenticated editor preview. It supports CommonMark/GFM, tables, tasks, footnotes, syntax highlighting, heading anchors, `[[guide/reading|internal links]]`, GitHub-style callouts, safe semantic HTML, KaTeX MathML and Mermaid source blocks. Diagram enhancement loads only when needed, uses strict Mermaid settings, and displays sanitized SVG as an image with the source preserved. Raw HTML cannot opt into trusted enhancements. Source size, tree complexity, code, diagram and math workloads are bounded.

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

Every change to an existing translation requires the caller's current write version. A D1 batch guards all revision, route, search and audit changes before advancing that version; stale writers receive HTTP 412 and leave no partial records. An occupied path or translation returns 409. Content SQL also checks the live session hash, credential version and expiry, including every statement that creates a new page. Logout or credential revocation during Markdown validation cannot leave a partial write. Publication selects the explicit current draft. The publication index and pointer change in the same transaction. Revisions and audit events reject updates and deletion at the database level.

Search uses D1 FTS5 with title, tag, description, path and body weights. Normalized English words and adjacent Chinese-character phrases are queried as literal text; punctuation separates words, and FTS/SQL operators are never passed through. Results remain in the selected language and are limited to 30. Raw Markdown delimiters and hidden HTML are omitted from excerpts.

The content APIs under `/api/admin/pages` provide bounded page lists, draft detail, revision/event history and explicit mutation routes. They require an authenticated administrator; all mutations require same-origin and CSRF checks. Lists filter by language, title/path text and active/draft/published/deleted state, with cursor pagination of at most 50 items. Content JSON bodies are streamed with a 1 MiB limit, while Markdown remains limited to 128,000 UTF-8 bytes. Authentication JSON retains its separate 4 KiB limit. `/api/admin/preview` uses the same authenticated protections and shared Markdown renderer, without saving content. Public endpoints remain read-only.

## Content workspace

- `/admin/pages` lists pages, filters/searches them and offers confirmed move, unpublish, soft-delete and restore actions.
- `/admin/pages/new` creates a language-specific draft; `/admin/pages/{id}/edit` edits its title, description, tags, change note and Markdown. The editor offers write, split and preview views, formatting helpers, save/publish controls and a linked translation action. Saving a draft leaves the published revision unchanged. Unsaved editor text stays in the tab's memory, with a navigation warning, Markdown download and session-reconnect controls.
- `/admin/pages/{id}/history` shows immutable revisions, source/preview, a two-version Markdown diff, metadata differences and a paginated activity timeline. Restoring a revision creates a new draft; it does not publish it or restore an old path. Restoring a deleted page also leaves it unpublished.

Monaco and its diff editor load only for the editor/history workspace. These documents require a valid administrator session before the Worker returns the shell; anonymous requests return to sign-in. Navigation into them loads a new document with a fresh style nonce. Monaco's dynamic style elements use that nonce, while only these authenticated documents permit inline style attributes for editor layout. Scripts remain same-origin, `unsafe-eval` is disallowed and editor workers are bundled on the same origin. The reader and other admin documents keep their stricter style policy.

`scripts/monaco-csp.ts` adapts the pinned Monaco sources using exact source hashes and single-constructor checks; changes to a matched source fail the build until reviewed. It also replaces Monaco's embedded sanitizer with the pinned DOMPurify dependency in an isolated instance, so hooks are not shared with Mermaid. The Markdown sanitizer still strips author styles and unsafe HTML. R2/file management and site settings are not implemented yet.

## Visual navigation

`/admin/navigation` manages Chinese and English trees independently through a visual editor, without writing JSON. Trees contain groups, internal pages and external links. Only groups contain children; mixed sibling items can be ordered freely. Internal pages are selected by stable translation identity, so moving an article does not break its navigation entry. External links accept HTTP/HTTPS URLs without embedded credentials and open with `noopener noreferrer`; the server never fetches them.

Each language starts in automatic mode, which derives its public navigation from published article paths. Custom mode uses the saved tree exactly: an empty custom tree produces an empty navigation. Switching back to automatic mode preserves the saved custom nodes for later use. Saving applies the selected mode and entire tree atomically; unsaved edits do not change the reader. Each save requires the loaded version, and a competing save returns 412 instead of overwriting it.

Internal entries appear publicly only while their target is published and not deleted. A blank custom label uses the current published title, never the draft title. Unpublishing hides the entry; republishing makes it available again. Empty groups are pruned. Removing a navigation entry does not delete or unpublish its article, and published articles omitted from navigation remain accessible through direct links, search and the sitemap. External links do not participate in article breadcrumbs or previous/next links.

`GET/PUT /api/admin/navigation/{language}` requires an administrator session. PUT also requires exact same-origin and CSRF checks and accepts at most 500 KiB of streamed JSON. Trees are limited to 300 nodes and eight levels, with bounded labels and URLs. Validation rejects cycles, missing parents, children of non-groups, repeated internal targets and cross-language targets. Every write statement checks the live session and tree version inside the same D1 batch; stale or revoked sessions cannot leave a partial tree. Navigation uses the reader's existing strict CSP and introduces no Cloudflare resource or permission.

## Redirect management

`/admin/redirects` manages Chinese and English route aliases independently. An alias points to a stable page translation, so it follows later moves directly to the current canonical path without creating a redirect chain. Both aliases created by page moves and manually created aliases can be renamed, retargeted or deleted. Their creation origin remains visible. Canonical page paths are protected, including for unpublished or deleted pages; an occupied route cannot be overwritten. Destinations must be existing, non-deleted pages in the same language. A draft target can be configured, but its alias returns 404 publicly until the page is published. Unpublishing or deleting the target also hides its aliases. These are internal redirects only; external URLs are not accepted.

`GET/POST/PUT/DELETE /api/admin/redirects/{language}` requires a live administrator session; mutations additionally require exact Origin and CSRF checks and at most 4 KiB of streamed JSON. POST accepts `{expectedVersion,path,translationId}`; PUT also requires `sourcePath`; DELETE accepts `{expectedVersion,sourcePath}`. Paths use the same canonical validation as articles. GET accepts only `origin`, literal source-path search `q`, `translationId`, exact `sourcePath`, `cursor` and `limit`, without repeated keys. Lists contain at most 50 aliases (25 by default), and their cursors bind the filters, language and registry version.

Each language has one registry version. Content route changes and administrator redirect changes advance it atomically. A stale save or cursor returns 412; the administrator must reload and compare before explicitly retrying. Every mutation checks the live session and expected version inside D1. Redirect changes and their audit records commit together. `migrations/0008_redirects.sql` extends the existing route registry and audit validator without replacing historical records or requiring another Cloudflare resource. The reader and administrator CSP policies are unchanged.

Application rollback must retain the `redirect` audit decoder once redirect events exist, as well as the migration history. Older content writers remain compatible with the new route-origin default; reverting to an older audit decoder would make mixed audit reads unavailable. Repair schema issues with a reviewed forward migration rather than deleting routes or audit records.

## Audit trail

`/admin/audit` provides a read-only history of successful page operations, navigation saves, redirect changes and administrator initialization or credential changes. Filter by category, action, content language or site-wide events, subject ID and time range. Results use descending sequence cursors, with 25 entries by default and at most 50 per page. `GET /api/admin/audit` requires a valid administrator session in both HTTP and SQL; unknown or repeated query parameters are rejected. API timestamps must use UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; `from` is inclusive and `to` exclusive. Cursors are tied to the selected filters.

`migrations/0007_audit.sql` copies existing page events with their original timestamps and marks them `legacy`; their actor provenance is unknown. It does not invent earlier navigation or account history. New records are appended by database triggers in the same transaction as the successful operation, so a failed or stale write leaves no successful audit event. `current` identifies records captured after this migration, not a separate actor identity. Audit rows reject updates and deletion, and there is no log-writing or deletion API.

Audit details contain only a closed set of metadata: revision IDs and old/new paths for page events, mode changes and node counts for navigation, before/after alias paths and target translation IDs for redirects, and boolean change flags for administrator credentials. Redirect subjects identify their language registry and its version; automatic aliases created by page moves remain covered by their page event, while manual creation and edits/deletions of either origin produce redirect events. Page titles come from the referenced revision where available. Markdown, change notes, navigation labels/URLs, usernames, password hashes, session tokens, setup tokens and request details are not copied into the trail. Existing event/revision history is retained. Login/logout, failed attempts and historical account events are not part of this audit view.

## Administrator

Open `/admin` to initialize the sole administrator or sign in. The interface selects the form from the server's initialization state; it has no registration or ordinary user accounts. The dashboard shows content counts and recent changes. `/admin/account` changes the username or password after verifying the current password. The admin module and CSS load only on admin routes, with Chinese and English interface controls.

The owner enables one-time setup by adding **`ADMIN_SETUP_TOKEN` as a GitHub Actions Secret**: an unpadded base64url encoding of at least 32 cryptographically random bytes, 43–256 characters. A password manager's cryptographically generated 64-character token using only letters and digits is a valid option. Keep this token in the owner's password manager and enter it only in the setup form over HTTPS. Do not put it in URLs, repository files, local environment files, Worker secrets, build variables, logs or task messages.

The next authorized main deployment hashes the optional secret with SHA-256 in Actions, after deployment guards pass. After D1 ownership and migrations are verified, a single guarded statement stores only the hash and a 24-hour expiry in `admin_bootstrap`. The raw token is removed from the deployment process environment before Wrangler runs; it is never a Worker binding. Without the secret, deployment skips bootstrap and public reading continues. Removing a configured Actions secret does not invalidate an already active setup window.

Repeated deployments with the **same token do not extend or reopen** its window, even after expiry. Before initialization, changing the Actions secret to a new random token and deploying main replaces the unconsumed hash and starts a new 24-hour window. Once an administrator exists or setup has been consumed, deployments cannot reopen setup or overwrite the administrator. Clear the optional Actions secret after successful initialization. There is no password-reset or administrator-recovery interface yet; do not delete authentication records or clear the consumed marker to regain access.

Passwords contain 12–128 Unicode characters, at most 512 UTF-8 bytes, and are stored as salted scrypt hashes with fixed parameters (`N=16384`, `r=8`, `p=5`). Session bearers contain 32 random bytes and are sent only in a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie; D1 stores their SHA-256 hashes. Sessions expire after eight hours or 30 minutes without activity. Logout revokes the current session; changing either username or password atomically advances the credential version and revokes all sessions, requiring sign-in again.

Authentication requests use bounded JSON bodies and shared D1 attempt limits before password hashing. Setup and login require a same-origin request; authenticated changes also require the session's CSRF token. Anonymous `/api/admin/session` and `/api/admin/overview` requests return 401. Public setup status exposes only `initialized` and `setupAvailable` booleans. Authentication responses are uncached, and the admin shell contains no account or draft data.

Setup confirms its writes from `RETURNING id` rows so that audit-trigger writes cannot change its success result. This compatible setup code must be deployed before `0007_audit.sql` is applied, and retained in any application rollback while those triggers remain installed.

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

HEAD is supported; writes are rejected. Unknown `/api/*` outside the protected admin namespace returns JSON 404 even for browser navigation. Smoke checks verify exact revision, server-rendered articles, language-specific search, genuine reader 404s, metadata, sitemap, JS assets, robots policy and API behavior. Anonymous GET checks also verify the admin shell, protected session/overview/content/navigation/redirect/audit endpoints and setup-status shape in any initialization state. Smoke never submits setup credentials, logs in or consumes a setup token. Test responses are noindex.

```sh
SMOKE_BASE_URL=https://cf.emby.wiki EXPECTED_SHA=<main-commit-sha> npm run smoke
```

Inspect failed workflow jobs/steps/logs and repair through PR. Never bypass tests or deploy with a local write token. Rollbacks use normal revert/fix PRs and main deployment, not history rewrites or arbitrary old-branch deployment. Applied database migrations are immutable and retained in the ledger: use additive forward migrations for schema repairs. Reverting application behavior must preserve the D1 binding and migration files; do not delete the database or undo stored revisions.

`codex.md` records product constraints, implemented boundaries and remaining module/storage plans. Production needs a separate explicit task.
