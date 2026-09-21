# Cloudflare Wiki / Emby Wiki — project context

## Origin and initialization boundary

Repository: `jacklilyhello/cloudflare-wiki`. This is an independent greenfield implementation. The owner abandoned `jacklilyhello/Cloudflare-Native-Wiki` as an unfinished project. Its code, data, migrations, Astro architecture and infrastructure choices must not be inherited. This records the owner's decision, not an assessment of unseen legacy code.

The product combines **emby.wiki's documentation organization**, **Wiki.js 3's visual and interaction direction**, and **Cloudflare Native architecture**. Wiki.js is a product reference, not a source-code port: do not copy its Node.js server, PostgreSQL or GraphQL backend. Ground later UI development in then-current product references; initialization does not attempt the full UI.

Initialization is complete. A separate product-development task authorizes the Git/PR/CI/squash/test-deployment loop and goal mode. The current implementation adds a public reader and shared Markdown renderer. CMS, editor, navigation manager, authentication and persistence remain subsequent work; do not report them as implemented.

## Product contract

### Two identities and one administrator

Anonymous visitors never register or log in. They read published documentation, search, switch language, copy code, view images and download public attachments. Drafts/private files/admin revisions must not leak through public endpoints or caches.

There is exactly one owner-configured administrator. Future capabilities: login; create/edit pages; save drafts; publish/unpublish; delete/move/rename; manage navigation and assets/files; inspect version history/diffs; restore revisions; manage redirects and site settings. Every privileged request must verify the sole administrator, including APIs and assets. Secure sessions, CSRF protection where applicable and rate limiting belong in that design. A hidden SPA route is not authorization. Cloudflare Access may be evaluated then; it is not provisioned now.

Excluded: ordinary accounts/login, registration, groups, RBAC, comments, watches, notifications, suggested edits, approval workflows, live collaboration and multisite.

### Chinese and English only

The closed language union is `zh | en` in `shared/contracts.ts`. Future articles have stable identities with Chinese and English versions and language-specific slugs. Translation relationships must survive moves/renames. Navigation is separate per language; search ranks the current language first. Missing translations must be explicit. Do not build a general dozens-of-locales platform. The final header offers `中文 | English`.

### Markdown only

Future administrator editor: Monaco + live preview, lazy-loaded only in the admin bundle. No visual, AsciiDoc or blog editor. Rendering must cover CommonMark, GFM, tables, task lists, footnotes, callouts, tabs, heading anchors, TOC, code blocks, syntax highlighting, copying, Mermaid, KaTeX, internal wiki links and a reviewed safe HTML subset.

`shared/markdown.ts` implements a portable unified/remark/rehype AST pipeline for the reader and future preview. GFM, footnotes, internal wiki links, callouts, directive groups, highlighting and KaTeX MathML are transformed before final explicit sanitization. Per-render provenance prevents raw HTML from forging enhancement properties. The browser lazily renders Mermaid with strict settings, displays sanitized SVG as an image and retains the source. Sanitize after transformations with explicit element/attribute/protocol allowlists. Disallow scripts, event handlers and unsafe URLs. Use Mermaid strict security and resource limits; constrain diagram/math rendering. Test stored XSS, malformed content and size limits. Store Markdown source and immutable revision metadata. A single editor does not make stored HTML trusted.

### Public experience

The reader provides a header, nested left navigation, main article and right TOC; responsive navigation, dark mode, breadcrumbs, current-page highlighting, search, language switching, last updated, code copy and friendly 404. The Worker renders article HTML plus canonical, alternate-language and OpenGraph metadata and a fixed-origin sitemap. Original starter articles live in `content/`, behind the published catalog in `worker/content/catalog.ts`. There is no persistence or administrative publishing yet. Test is deliberately noindex and blocked in robots.txt.

## Architecture decision

Selected: **React 19 + TypeScript + Vite 8 + official Cloudflare Vite plugin + one module Worker with Workers Static Assets**. Versions are pinned in the lockfile. Node 24 is local/CI tooling, never a persistent production server.

React supports the server-rendered reader and future lazy admin UI, with Monaco and document components. Vite gives a familiar, small build surface and fast local updates. Cloudflare's official plugin runs backend code in workerd locally and builds the Worker and assets together. A Web-standard Worker keeps the initial backend small; evaluate Hono only when routing complexity warrants it. SSR meta-frameworks were considered, but impose extra conventions before article requirements exist. This choice does not inherit Astro.

`worker/reader.tsx` renders the same React reader used by browser hydration into the Vite HTML shell using HTMLRewriter. Inert JSON hydration data escapes HTML delimiters, and dynamic responses receive explicit security headers. Article content and metadata do not rely on client JavaScript. Admin can remain client-only. The current no-store policy avoids publication/cache consistency problems before persistent publishing exists.

| Path | Responsibility |
| --- | --- |
| `src/` | SSR-compatible React reader and browser enhancements; no server secrets |
| `worker/` | Request handler and health boundary |
| `shared/` | Portable reader contracts, safe Markdown renderer and closed language model |
| `public/` | Assets, static headers, test robots policy |
| `tests/` | Workerd HTTP tests and deployment-policy tests |
| `scripts/` | Guarded deployment and local/remote smoke checks |
| `.github/workflows/` | CI and deployment |
| `.github/rulesets/` | Reviewable main protection policy |

Every request runs the Worker first. `/assets/*`, favicon and robots use Cloudflare asset serving; documents, health, search and sitemap use explicit Worker handlers. Unknown API routes return JSON 404 and unknown documents return HTML 404, never successful SPA HTML. Health is uncached **liveness**, not a promise of future database readiness. It exposes only service metadata and build revision.

Future modules: lazy admin UI; page/translation domain services; persistent publication and revision repositories; file lifecycle; navigation management; redirects; persistent search; settings; authentication and deliberate caching. Keep storage in Worker-side repositories with portable domain contracts. The current in-memory catalog and substring ranking serve the small starter set; persistent search must be bounded, index-backed and tested with Chinese and English content.

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

`Deploy Test` runs on main pushes and manual main dispatch only. It validates the exact commit again, preflights settings/resources, deploys, confirms the `cf.emby.wiki` Custom Domain binding through Cloudflare API readback, and smoke-checks the stable Workers.dev address for server-rendered articles, search, metadata, sitemap, genuine 404s, JS asset, health JSON, exact revision and robots policy. Main deployment concurrency prevents overlapping writes. PRs never deploy. Only the deploy step receives the token. Read failed run/job/step/log evidence and fix through PRs; do not disable gates. A passing build alone does not complete initialization.

## Security and Codex configuration

Static responses use CSP, frame denial, no-sniff, referrer policy and noindex. APIs use no-store and reveal no credentials. Future uploads require MIME/size limits, safe filenames, normalized paths, authorization and public/private separation; public downloads need safe content disposition. Prevent unbounded rendering work, SSRF in imports, open redirects, unsafe HTML and cache leaks. Validate inputs and authorize writes server-side. Pin dependencies/Actions, review upgrades and scan staged content.

`.codex/config.toml` contains officially documented project settings: on-request approvals and workspace-write sandbox. It does not start a goal, force a model or grant cloud permissions. Trusted-project loading and local configuration precedence apply.

## Official references

- [Wiki.js 3 Markdown editor interaction preview](https://beta.js.wiki/blog/2023-wiki-js-3-feature-preview-markdown-editor/)
- [Wiki.js 3 navigation and search interaction preview](https://beta.js.wiki/blog/2023-wiki-js-3-feature-preview-navigation-search/)
- [Wiki.js 3 file manager interaction preview](https://beta.js.wiki/blog/2023-wiki-js-3-feature-preview-file-manager/)
- [rehype sanitization and transformation order](https://github.com/rehypejs/rehype-sanitize)
- [KaTeX security and expansion options](https://katex.org/docs/options.html)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [React SPA with API](https://developers.cloudflare.com/workers/vite-plugin/tutorial/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Codex project configuration](https://developers.openai.com/codex/config-basic/)
- [GitHub Rulesets API](https://docs.github.com/en/rest/repos/rules)

These describe supported mechanisms. Live deployment/settings are evidenced by Actions and API readback, not this design document.
