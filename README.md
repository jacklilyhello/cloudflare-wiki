<h1 align="center">☁️ Cloudflare Wiki</h1>

<p align="center">
  <strong>A bilingual Markdown wiki, built for the Cloudflare edge.</strong><br>
  A public documentation reader. One administrator. One Worker.
</p>

<p align="center">
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2E8B57" alt="MIT license"></a>
  <a href="https://github.com/jacklilyhello/cloudflare-wiki/actions/workflows/ci.yml"><img src="https://github.com/jacklilyhello/cloudflare-wiki/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/jacklilyhello/cloudflare-wiki/stargazers"><img src="https://img.shields.io/github/stars/jacklilyhello/cloudflare-wiki?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README_zh.md">简体中文</a><br>
  <a href="https://emby.wiki/">Live demo</a> · <a href="#deployment">Deployment</a> · <a href="https://github.com/jacklilyhello/cloudflare-wiki/issues">Issues</a> · <a href="https://hellogithub.com/user/IDCJ570U6V8P4sn">HelloGitHub profile</a>
</p>

![Cloudflare Wiki cover — the live emby.wiki example](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWDmq_y9q4Y-KWmh_JpoI81rNtK89xAALvDmsb1nn4UTVN2R3CzA2qAQADAgADeQADPQQ.jpg)

Cloudflare Wiki is a documentation and knowledge-base application built with **React, TypeScript, Cloudflare Workers, D1 and private R2 storage**. Write Markdown in the administrator workspace, preview it beside the source, and publish it to a server-rendered reader with bilingual navigation and search.

The production example is **[emby.wiki](https://emby.wiki/)**. The application serves documentation; it does not install or run an Emby media server. It is an independent implementation inspired by documentation-site layouts and Wiki.js editor interactions, rather than a port of Wiki.js.

> [!IMPORTANT]
> The current upstream deployment is configured specifically for emby.wiki and its existing resources. **Forking and adding Secrets alone will not deploy a new site.** Repository, hostname, canonical-origin and storage policies must be adapted in your fork, and a separate first-time initialization workflow is required. See [Deployment](#deployment) and the [detailed deployment guide](docs/deployment.md#english).

<details>
<summary><strong>Contents</strong></summary>

- [Live demo](#live-demo)
- [Features](#features)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Deployment](#deployment)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)
- [Security and operations](#security-and-operations)
- [Contributing](#contributing)
- [Links and acknowledgements](#links-and-acknowledgements)
- [License](#license)

</details>

## Live demo

| Experience | Link |
| --- | --- |
| Handbook cover and language selection | [emby.wiki](https://emby.wiki/) |
| Chinese documentation | [中文阅读](https://emby.wiki/zh/home) |
| English documentation | [English reader](https://emby.wiki/en/home) |
| Administrator sign-in | [Administrator workspace](https://emby.wiki/admin) — owner access only |

The public demo is available to readers. Administrator screenshots below show the owner's workspace; no shared administrator credentials are provided. A fresh database receives the original starter articles from the migrations, **not the current live site's article library**.

## Features

| | What you get |
| --- | --- |
| 📖 Reading | Server-rendered articles, nested navigation, breadcrumbs, a table of contents, heading links, code copying and an image viewer |
| 🌏 Bilingual content | Chinese and English articles with linked translations, independent navigation trees and language-specific search |
| ✍️ Authoring | Monaco Markdown editor, write/split/preview modes, formatting helpers, tags and change notes |
| 🗂️ Publishing | Separate draft saves and publication, immutable revision history, source comparison and restoration into a new draft |
| 🧭 Organization | Page directories, reviewed subtree moves, visual navigation editing and internal redirects that follow page moves |
| 🖼️ Files | Private R2 uploads, folders, image previews, bilingual alt text, explicit publication and Markdown insertion |
| 🔎 Search | D1 FTS5 over published titles, descriptions, tags, paths and article text; drafts stay out of results |
| 🎨 Appearance | Light/dark mode, responsive layouts, bilingual site settings, accent choices and optional deployment branding |
| 🔐 Administration | A single administrator, protected sessions, CSRF/origin checks, conflict detection and a read-only audit trail |
| 💾 Operations | GitHub Actions validation and deployment, private backups, isolated restore drills and a separate administrator recovery workflow |

Markdown includes GFM tables and task lists, footnotes, syntax highlighting, internal wiki links, callouts, tabbed sections, KaTeX math and Mermaid diagrams. The reader and editor preview share the same sanitized rendering pipeline.

The product supports **one administrator and two languages (`zh` / `en`)**. Registration, ordinary user accounts, comments, team roles and collaborative editing are outside its current scope. Translations are written and linked by the administrator; automatic translation is not included.

## Screenshots

These are browser captures of the live emby.wiki reader and authenticated workspace, taken on 2 October 2026. Site branding and article content are examples; the administrator interface can switch between Chinese and English.

### English reader

![English documentation reader with navigation and table of contents](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWEGq_zDC_DUDNffTkJX_6GFbk35i4AALzDmsb1nn4UcJwjX4o3TKrAQADAgADeQADPQQ.jpg)

### Markdown editor with live preview

![Monaco Markdown source beside its live preview](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWFmq_zHntvDcn1MChdJiJiZ_SdI3OAAL5Dmsb1nn4UWEEQbAJl8FVAQADAgADeQADPQQ.jpg)

### Administrator overview

![Administrator dashboard with publication counts and recent updates](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWFGq_zG9qEXEy2H3zP4AUxDPEb4mwAAL3Dmsb1nn4USjGhtNk3V2zAQADAgADeQADPQQ.jpg)

<details>
<summary><strong>Explore all interfaces: reader, search, versions, navigation, files and settings</strong></summary>

**Chinese reader**

![Chinese documentation reader](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWD2q_zBWL6-fnxUMFQ502GtRCjdPFAALyDmsb1nn4UWLcdjBMsdJDAQADAgADeQADPQQ.jpg)

**Dark appearance**

![English reader in dark mode](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWEWq_zDb_T1anY7YLx8LD6RuZXe-lAAL0Dmsb1nn4UQRIEy1sWWVsAQADAgADeQADPQQ.jpg)

**Full-text search**

![Published-document search results](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWEmq_zDzpqGuU4_qHEKTYPw54i3z4AAL1Dmsb1nn4Uewybn7_09oEAQADAgADeQADPQQ.jpg)

**Administrator sign-in**

![Administrator sign-in page](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWE2q_zGlxOQQlGH6eNagVQe4LHBF1AAL2Dmsb1nn4UQOUts9dwzqJAQADAgADeQADPQQ.jpg)

**Page directories**

![Bilingual page directory browser](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWFWq_zHS16ZdWLt1oQBT0rNopbOGEAAL4Dmsb1nn4UTon8qpBuQfHAQADAgADeQADPQQ.jpg)

**Revision history and comparison**

![Immutable revisions and Markdown comparison](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWF2q_zH9YWjwloP9LNjz5HZRKrQ_qAAL6Dmsb1nn4UQcZXA0YthU6AQADAgADeQADPQQ.jpg)

**Visual navigation editor**

![Navigation tree and selected entry properties](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWGGq_zLffuJqF5Stm726GQSfhz6OqAAL7Dmsb1nn4UTiSG55TNcR7AQADAgADeQADPQQ.jpg)

**File Manager**

![Private file library with folders and publication controls](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWGWq_zLzN9gSYR0MhSgT6emCRq8vTAAL8Dmsb1nn4UWmavkb5quBlAQADAgADeQADPQQ.jpg)

**Redirect Manager**

![Internal page aliases and redirect targets](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWGmq_zMPrOE_XfqkggNlWpdaVZ0etAAL9Dmsb1nn4URO8XZZ_1Bw8AQADAgADeQADPQQ.jpg)

**Site settings and deployed branding**

![Bilingual site identity and deployed brand assets](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWG2q_zMkn-_zHJEZHs2VO6AInE2tYAAL-Dmsb1nn4UZppGxmXqBJCAQADAgADeQADPQQ.jpg)

**Audit trail**

![Read-only administrator audit trail](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWHGq_zM4pv9OSQL1jTZZy1z76hyZDAAL_Dmsb1nn4UcGDq71Ys7xiAQADAgADeQADPQQ.jpg)

**Administrator account**

![Single-administrator account settings](https://photo.lily.lat/file/AgACAgQAAyEGAASLgSpZAAIWHWq_zNPB9Ej4c4hw6zB7RYs1ZMtMAAMPaxvWefhRshn4cnBX48cBAAMCAAN5AAM9BA.jpg)

</details>

## Architecture

| Component | Role |
| --- | --- |
| React 19 + TypeScript + Vite 8 | Public reader, browser enhancements and lazy-loaded administrator UI |
| Cloudflare Workers | Server-rendered documents, authentication, public APIs and administrator APIs |
| Workers Static Assets | Same-origin JavaScript, styles, editor workers and brand assets |
| Cloudflare D1 | Articles, translations, drafts, revisions, search, navigation, redirects, settings, file metadata and authentication state |
| Private Cloudflare R2 | Immutable attachment objects, thumbnails and private backup archives |
| GitHub Actions | CI, deployment, backup verification and controlled recovery |

Production runs on a **single Worker with D1 and R2 bindings**. It needs no VPS, persistent Node server, external database or separate Cloudflare Pages project. Node 24 is used for development and CI tooling. KV, Workers AI, Queues and Durable Objects are not required by the current implementation.

The [implementation reference](docs/implementation.md) documents the transaction, rendering, file-service and session details.

## Deployment

### Required resources

| Resource | Purpose | Where to find it |
| --- | --- | --- |
| Cloudflare account | Owns the Worker, D1 and R2 resources | [Cloudflare dashboard](https://dash.cloudflare.com/) |
| Active DNS zone | Holds your custom hostname(s) | Dashboard → select your domain |
| One Worker | Hosts the application and static assets | Workers & Pages |
| One D1 database | Stores wiki and administrator state | Storage & databases → D1 |
| One private R2 bucket | Stores files and backups | R2 object storage |
| GitHub repository with Actions enabled | Runs CI and all cloud writes | Repository → Actions |

R2 must be enabled on your account. Use a private bucket with **r2.dev access disabled and no public custom domain**; public file delivery goes through the application. Quotas, usage charges and R2 account activation are governed by your own plan. Check the official [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) pricing pages; this project does not guarantee zero-cost hosting.

### GitHub Secrets and Variables

Open your repository → **Settings → Secrets and variables → Actions**.

[Open the upstream configuration page](https://github.com/jacklilyhello/cloudflare-wiki/settings/secrets/actions). For a fork, use the same path under **your own repository**. Forks do not inherit the upstream Secret or Variable values.

Add the token under **Secrets → New repository secret**. Add the other four values under **Variables → New repository variable**:

| Type | Name | Value / example | Where to obtain it |
| --- | --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | The deployment API token; keep the value private | Cloudflare → profile → API Tokens → Create Token → Custom token |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Your 32-character account ID | Domain Overview → API section → Account ID, or your account details |
| Variable | `CLOUDFLARE_ZONE_ID` | Your 32-character zone ID | Domain Overview → API section → Zone ID |
| Variable | `CLOUDFLARE_WORKER_NAME` | Upstream: `cloudflare-wiki`; a fork needs its reviewed independent Worker name | Choose a name in the fork's policy; it is a name, not a Worker ID |
| Variable | `PRODUCTION_DOMAIN` | Upstream: `emby.wiki`; a fork uses its reviewed hostname, e.g. `wiki.example.com` | Choose a hostname in the active zone; omit `https://`, paths and trailing slashes |

For `wiki.example.com`, the zone ID belongs to **example.com**. All resources must belong to the selected account. See Cloudflare's [account/zone ID guide](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

The upstream resolves its D1 UUID from the existing Worker binding. **It does not read a `CLOUDFLARE_DATABASE_ID` Secret**, and the zero UUID in `wrangler.jsonc` is a local placeholder. A new site's initialization must resolve and bind its own real database UUID.

<details>
<summary><strong>Optional setup, branding and recovery configuration</strong></summary>

| Type | Name | When it is used |
| --- | --- | --- |
| Secret | `ADMIN_SETUP_TOKEN` | First-time initialization in a separately reviewed workflow, before the sole administrator exists; normal Deploy Production does not read it |
| Variable | `WIKI_BRAND_MANIFEST` | Generated manifest for optional deployment branding |
| Variable | `WIKI_BRAND_LOGO_LIGHT_B64` | Prepared light logo |
| Variable | `WIKI_BRAND_LOGO_DARK_B64` | Prepared dark logo |
| Variable | `WIKI_BRAND_FAVICON_B64` | Prepared favicon |
| Variable | `WIKI_BRAND_APPLE_TOUCH_B64` | Prepared Apple Touch Icon |
| Variable | `WIKI_BRAND_OG_IMAGE_B64` | Prepared sharing image |

Generate a setup token from at least 32 random bytes, encoded as unpadded base64url. Keep it in your password manager and the initialization Secret; never put it in source, Worker variables, URLs or logs. The bootstrap window expires after 24 hours and is consumed by successful setup.

Follow [branding configuration](docs/branding.md) for formats, preparation and limits. The supplied branding installer targets the upstream repository, so a fork must adapt its destination before using it. Basic identity, theme and accent choices are also available in admin settings. The [administrator recovery runbook](docs/administrator-recovery.md) describes its separate protected GitHub Environment and Secret.

</details>

### Cloudflare API token permissions

Create a **dedicated deployment token**, scoped to the intended account and zone. A separate token per fork makes revocation easier. Do not use the Global API Key or copy the Actions deployment token to a local development machine.

The upstream's normal workflow deploys the Worker, manages Custom Domains and performs read-only storage preflight:

| Scope | Permission | Purpose |
| --- | --- | --- |
| Account | Workers **Editor** at product scope; legacy UI: **Workers Scripts → Edit** | Deploy code/assets and inspect Worker configuration; current Custom Domain support needs product scope |
| Account | **D1 → Read** | Inspect the existing database, ownership marker and migration ledger |
| Account | **Workers R2 Storage → Read** | Inspect the private bucket, ownership marker and public-domain state |
| Zone | **Workers Routes → Write / Edit** | Manage Custom Domains and inspect conflicting routes |
| Zone | **Zone → Read** | Verify the zone, account and active status |
| Zone | **DNS → Read** | Inspect records before binding hostnames |

**First-time provisioning** additionally needs product-level **Workers Admin** for Worker creation (or its legacy Workers Scripts Edit equivalent), **D1 Write / Edit** for creation/migrations/bootstrap and **Workers R2 Storage Write / Edit** for creation/marker uploads. The private backup workflow also writes R2 objects. Keep initialization/recovery permissions separate from a routine deploy token where practical.

Set resource filters to **Include → Specific account → your account** and **Include → Specific zone → your zone**. In legacy labels, `Edit` is the write permission. Account Settings Read may be needed for Wrangler account discovery; do not add unrelated write permissions to address an unexplained 403. KV, Email Routing, Workers AI and billing-write permissions are not required.

Cloudflare is introducing Workers roles alongside legacy permissions. Consult the official [Workers authorization guide](https://developers.cloudflare.com/workers/authorization/workers/) and [API token permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) when labels differ.

### Deploy a new fork

**This is currently an advanced setup, not a one-click installer.** The release carries the original site's explicit deployment safeguards.

1. [Fork this repository](https://github.com/jacklilyhello/cloudflare-wiki/fork) and enable Actions in your fork.
2. Choose an independent Worker, D1 name, private R2 bucket and hostname. A new site needs separate resources and administrator state, even in the same account.
3. Add the five required Secrets/Variables and review the initialization permissions above.
4. Adapt repository/resource allowlists, the runtime canonical-origin validator, zone checks, build-output paths and domain-specific smoke assertions **in your fork**. The [deployment guide](docs/deployment.md#english) lists the exact files; changing only `PRODUCTION_DOMAIN` is insufficient.
5. Add a reviewed, manual, main-only **initialization workflow** using the supplied provisioning and bootstrap helpers. It must create/verify the fork's owned resources, apply migrations, bind the real D1 UUID and prepare the one-time setup digest. Normal production deployment refuses missing resources and pending migrations.
6. Validate and run initialization. Inspect Actions results and Cloudflare bindings. Resolve DNS/domain conflicts explicitly; never adopt an unrelated database or bucket.
7. Open `https://YOUR_HOST/admin`, complete one-time setup and create the sole administrator. Verify both readers, search, editing, publication and private/public files.
8. Keep later updates on the normal read-only-storage path. Adapt backup and recovery workflows for the fork separately.

The [detailed guide](docs/deployment.md) explains adaptation and the initialization helper contract. It does not claim that an unmodified fork has been tested on a new Cloudflare account.

### Update the existing upstream site

| Setting | Current value |
| --- | --- |
| Repository | `jacklilyhello/cloudflare-wiki` |
| Worker | `cloudflare-wiki` |
| Custom Domains | `emby.wiki`, `www.emby.wiki`, `cf.emby.wiki` |
| Canonical origin | `https://emby.wiki` |
| Existing D1 | `cloudflare-wiki-test` |
| Existing private R2 | `cloudflare-wiki-assets-test` |

The historical `-test` storage names do not determine the environment: the Worker uses `APP_ENV=production`. Do not replace these resources to remove that suffix.

Changes go through a branch and PR with successful **CI**. After an authorized squash merge, main pushes run **Deploy Production**: validation → domain/storage preflight → deployment → authenticated configuration readback → anonymous browser smoke on all three domains. Manual runs are available from **Actions → Deploy Production → Run workflow → main**.

PRs never deploy. `workers.dev` and Preview URLs stay disabled. The existing `www` redirect is separate Cloudflare configuration; a Custom Domain alone does not create it. Normal deployment does not create resources, apply remote migrations, clear data or reset the administrator.

## Local development

Use **Node 24** and npm. Production credentials are not required:

```sh
git clone https://github.com/jacklilyhello/cloudflare-wiki.git
cd cloudflare-wiki
npm ci
npm run dev
```

Open the URL printed by Vite. The command applies local migrations and runs workerd with local D1/R2 emulation; repeated runs preserve local data. `content/` contains starter Markdown references, and editing them does not overwrite persisted articles.

```sh
npm run verify
```

This runs lint, formatting, Worker types, TypeScript checks, runtime/deployment-policy tests, a build and local HTTP smoke. Individual commands include `npm test`, `npm run build`, `npm run db:local` and `npm run test:preview`.

Local migrations do not enable administrator setup by themselves; authentication tests use isolated fixtures. `npm run deploy:production` refuses local execution. Actual Cloudflare writes belong in Actions.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Deploy job is skipped in a fork | Both deployment workflows still guard the upstream repository; follow the fork adaptation guide |
| Domain/Worker policy rejects deployment | Variables disagree with explicit constants; a new domain needs coherent fork configuration |
| New hostname returns 503 after changing variables | `shared/branding.ts` still rejects a different canonical origin; adapt the runtime validator |
| Cloudflare API returns 403 | Check expiry, account/zone scope and the failed operation's permissions; zone security blocks can also return 403, so use the error context |
| Empty database fails storage preflight | Normal deployment requires owned resources and a complete migration ledger; use separate new-site initialization |
| Setup form is unavailable | Check bootstrap preparation, initialization state, token expiry and whether setup was consumed |
| Images/attachments return 404 | Check upload completion and explicit publication; private files cannot be inserted publicly |
| Save returns 412 | Another operation advanced the version; reload and compare before retrying |
| Save/move returns 409 | A translation, page or reserved route conflicts with the destination |
| CI/browser smoke fails | Inspect the failed job and assertions; preserve tests and deployment guards when repairing the cause |

## Security and operations

- Public reads return published content only. Drafts, private files and revision history need administrator access.
- Passwords use salted scrypt hashes. Cookies are Secure, HttpOnly and SameSite=Strict; credential changes revoke sessions.
- Privileged writes check the session, exact origin, CSRF and expected version. Stale changes are rejected.
- Markdown uses sanitization and bounded rendering; editor preview and reader share the pipeline. Mermaid uses strict settings.
- File publication is explicit. R2 remains private. Credentials never belong in `VITE_*`, source, screenshots or logs.
- [Backup/isolated restore](docs/backup-restore.md), [administrator recovery](docs/administrator-recovery.md) and [branding](docs/branding.md) have separate runbooks. Recovery does not expose a public password-reset endpoint.

These are implemented controls, not a claim of an independent security audit. Report suspected vulnerabilities privately to the maintainer before posting exploit details publicly.

## Contributing

Bug reports, documentation improvements and focused PRs are welcome. Include a reproducible example, runtime/browser information and sanitized logs.

Read [AGENTS.md](AGENTS.md), [codex.md](codex.md) and the [implementation reference](docs/implementation.md). Use a task branch, run `npm ci` and `npm run verify`, and record validation in the PR. Keep credentials, database dumps and private files out of Git.

## Links and acknowledgements

- [Live example: emby.wiki](https://emby.wiki/)
- [Source, issues and pull requests](https://github.com/jacklilyhello/cloudflare-wiki)
- [Maintainer on HelloGitHub](https://hellogithub.com/user/IDCJ570U6V8P4sn)
- [Wiki.js](https://js.wiki/) — visual and interaction inspiration
- [Cloudflare developer documentation](https://developers.cloudflare.com/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/), [Mermaid](https://mermaid.js.org/) and [KaTeX](https://katex.org/)

If the project is useful to you, a star helps other readers discover it.

## License

Project code and original repository documentation use the **[MIT License](LICENSE)**. Dependencies retain their licenses. Third-party brands, logos and content shown in the live example retain their rights; the code license does not grant rights to those third-party materials.
