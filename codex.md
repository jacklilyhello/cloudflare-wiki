# Cloudflare Wiki / Emby Wiki — project context

## Origin and initialization boundary

Repository: `jacklilyhello/cloudflare-wiki`. This is an independent greenfield implementation. The owner abandoned `jacklilyhello/Cloudflare-Native-Wiki` as an unfinished project. Its code, data, migrations, Astro architecture and infrastructure choices must not be inherited. This records the owner's decision, not an assessment of unseen legacy code.

The product combines **emby.wiki's documentation organization**, **Wiki.js 3's visual and interaction direction**, and **Cloudflare Native architecture**. Wiki.js is a product reference, not a source-code port: do not copy its Node.js server, PostgreSQL or GraphQL backend. Ground later UI development in then-current product references; initialization does not attempt the full UI.

Initialization provides only a reproducible engineering foundation, minimal public test page and health endpoint. No CMS, editor, navigation manager, authentication or persistence is implemented. Stop after validation/reporting without establishing a long-running goal. Future local Codex may use goal mode for separately requested work.

## Product contract

### Two identities and one administrator

Anonymous visitors never register or log in. They read published documentation, search, switch language, copy code, view images and download public attachments. Drafts/private files/admin revisions must not leak through public endpoints or caches.

There is exactly one owner-configured administrator. Future capabilities: login; create/edit pages; save drafts; publish/unpublish; delete/move/rename; manage navigation and assets/files; inspect version history/diffs; restore revisions; manage redirects and site settings. Every privileged request must verify the sole administrator, including APIs and assets. Secure sessions, CSRF protection where applicable and rate limiting belong in that design. A hidden SPA route is not authorization. Cloudflare Access may be evaluated then; it is not provisioned now.

Excluded: ordinary accounts/login, registration, groups, RBAC, comments, watches, notifications, suggested edits, approval workflows, live collaboration and multisite.

### Chinese and English only

The closed language union is `zh | en` in `shared/contracts.ts`. Future articles have stable identities with Chinese and English versions and language-specific slugs. Translation relationships must survive moves/renames. Navigation is separate per language; search ranks the current language first. Missing translations must be explicit. Do not build a general dozens-of-locales platform. The final header offers `中文 | English`.

### Markdown only

Future administrator editor: Monaco + live preview, lazy-loaded only in the admin bundle. No visual, AsciiDoc or blog editor. Rendering must cover CommonMark, GFM, tables, task lists, footnotes, callouts, tabs, heading anchors, TOC, code blocks, syntax highlighting, copying, Mermaid, KaTeX, internal wiki links and a reviewed safe HTML subset.

Use a shared parser/AST pipeline for preview and published output. Evaluate unified/remark/rehype and dedicated plugins during implementation; do not install unused packages now. Sanitize after transformations with explicit element/attribute/protocol allowlists. Disallow scripts, event handlers and unsafe URLs. Use Mermaid strict security and resource limits; constrain diagram/math rendering. Test stored XSS, malformed content and size limits. Store Markdown source and immutable revision metadata. A single editor does not make stored HTML trusted.

### Public experience

Target desktop: header, left navigation, main article, right TOC. Later requirements: responsive layout, mobile drawer, dark mode, breadcrumb, current-page highlighting, auto-expanded navigation, search, language switching, last updated, SEO, OpenGraph, sitemap, robots.txt, friendly 404 and code copy. These are future requirements, not initialization features. Test is deliberately noindex and blocked in robots.txt.

## Architecture decision

Selected: **React 19 + TypeScript + Vite 8 + official Cloudflare Vite plugin + one module Worker with Workers Static Assets**. Versions are pinned in the lockfile. Node 24 is local/CI tooling, never a persistent production server.

React supports the reader SPA and future lazy admin SPA, with Monaco and document components. Vite gives a familiar, small build surface and fast local updates. Cloudflare's official plugin runs backend code in workerd locally and builds the Worker and assets together. A Web-standard Worker keeps the initial backend small; evaluate Hono only when routing complexity warrants it. SSR meta-frameworks were considered, but impose extra conventions before article requirements exist. This choice does not inherit Astro.

Trade-off: an SPA alone does not solve dynamic article SEO. Before public article publishing, add Worker-rendered/prerendered article HTML and per-page metadata, or adopt an officially supported SSR integration behind these boundaries. Do not rely only on client JavaScript for published article SEO. Admin can remain client-only. Revisit this before production.

| Path | Responsibility |
| --- | --- |
| `src/` | React initialization page; no server secrets |
| `worker/` | Request handler and health boundary |
| `shared/` | Portable contracts and closed language model |
| `public/` | Assets, static headers, test robots policy |
| `tests/` | Workerd HTTP tests and deployment-policy tests |
| `scripts/` | Guarded deployment and local/remote smoke checks |
| `.github/workflows/` | CI and deployment |
| `.github/rulesets/` | Reviewable main protection policy |

Static assets use Cloudflare asset serving. `/health`, `/api` and `/api/*` explicitly run the Worker first, including browser navigation requests: API errors cannot become successful SPA HTML. Health is uncached **liveness**, not a promise of future database readiness. It exposes only service metadata and build revision.

Future modules, created only when needed: reader routes/components; lazy admin UI; Markdown renderer; page/translation domain services; publication and revision repositories; file lifecycle; per-language navigation; redirects; search; settings; authentication; cache and SEO rendering. Keep storage in Worker-side repositories with portable domain contracts.

D1 likely fits articles, translations, revisions, navigation, redirects and settings; R2 likely fits files with D1 metadata. KV is optional for explicitly eventually consistent cases, not the authoritative database by default. Cache API may serve published content with language/version keys and deliberate invalidation. Queues, Workflows, Durable Objects, Images, Access, Workers AI, Vectorize, Browser Rendering and Containers are allowed only with concrete need. Provision none speculatively. Remote migrations must be reviewed/repeatable and run in Actions, with recovery planning before destructive changes.

Forbidden infrastructure: VPS, persistent production Node servers, always-on Docker servers, external PostgreSQL/MySQL/Redis and traditional independently maintained backend servers.

## Environments and permissions

Current test Custom Domain: `https://cf.emby.wiki`, Worker `cloudflare-wiki`. The stable `cloudflare-wiki.<account-subdomain>.workers.dev` address is enabled only for GitHub Actions automated smoke testing; the deployment script reads the account subdomain through Cloudflare's API rather than hardcoding it. Preview URLs remain disabled. Future production: `https://emby.wiki`; no current workflow/config may deploy it. No production environment, route, wildcard route or migration command exists.

Local Codex uses Cloudflare read-only credentials for authorized inspection of Workers/D1/R2/KV, routes/domains, configurations/state and readable logs. Never deploy, create/delete/modify resources, migrate remotely, change DNS/routes, upload R2 or write KV locally. Do not use write-capable OAuth locally. Actual token permissions enforce this boundary; scripts and written rules add guardrails but cannot replace IAM.

All writes use `secrets.CLOUDFLARE_API_TOKEN` in Actions only. Never retrieve its value or place it in local files, docs, browser variables, artifacts or logs. Actions Variables: actual `CLOUDFLARE_ACCOUNT_ID`, actual `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_WORKER_NAME=cloudflare-wiki`, `TEST_DOMAIN=cf.emby.wiki`. Missing values are reported by name, never fabricated.

Preflight verifies zone/account, existing Worker ownership and domain associations and rejects conflicting DNS/routes. The ownership marker is a consistency check, not authentication. Wrangler creates/updates the fixed Worker and test Custom Domain; repeated runs reuse them. No D1/R2/KV or migrations exist. Stop for payment, permission expansion, resource deletion, production changes or weaker security. Incompatible existing resources need an owner decision, not silent replacement.

## Git, CI and deployment

Sync main, create an allowed task branch, develop, validate, commit, push, PR, passing CI, resolved conversations, authorized squash merge. Never develop/push directly to main, force push or rewrite history. Apply the supplied main Ruleset after CI exists: PR required, current `CI` required, resolved conversations, no deletion/force push, linear history and squash only. No bypass actors. Zero mandatory external approvals accommodates one maintainer; PR/CI remain mandatory.

`CI` runs on PRs and main pushes: locked dependency install, lint, format check, generated Worker types, separate frontend/Worker/tooling typechecks, tests, build and smoke against built output in workerd. It has no deployment credential.

`Deploy Test` runs on main pushes and manual main dispatch only. It validates the exact commit again, preflights settings/resources, deploys, confirms the `cf.emby.wiki` Custom Domain binding through Cloudflare API readback, and smoke-checks the stable Workers.dev address for homepage, JS asset, health JSON, exact revision, API 404 and robots policy. Main deployment concurrency prevents overlapping writes. PRs never deploy. Only the deploy step receives the token. Read failed run/job/step/log evidence and fix through PRs; do not disable gates. A passing build alone does not complete initialization.

## Security and Codex configuration

Static responses use CSP, frame denial, no-sniff, referrer policy and noindex. APIs use no-store and reveal no credentials. Future uploads require MIME/size limits, safe filenames, normalized paths, authorization and public/private separation; public downloads need safe content disposition. Prevent unbounded rendering work, SSRF in imports, open redirects, unsafe HTML and cache leaks. Validate inputs and authorize writes server-side. Pin dependencies/Actions, review upgrades and scan staged content.

`.codex/config.toml` contains officially documented project settings: on-request approvals and workspace-write sandbox. It does not start a goal, force a model or grant cloud permissions. Trusted-project loading and local configuration precedence apply.

## Official references

- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [React SPA with API](https://developers.cloudflare.com/workers/vite-plugin/tutorial/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Codex project configuration](https://developers.openai.com/codex/config-basic/)
- [GitHub Rulesets API](https://docs.github.com/en/rest/repos/rules)

These describe supported mechanisms. Live deployment/settings are evidenced by Actions and API readback, not this design document.
