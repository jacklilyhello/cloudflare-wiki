# Implementation reference

This document preserves the detailed engineering reference for the current upstream deployment. For the project introduction and setup overview, start with [English README](../README.md) or [中文 README](../README_zh.md). For deployment boundaries, read [the deployment guide](deployment.md).

A new Cloudflare-native bilingual Markdown wiki with a **server-rendered public reader** and a single-administrator content workspace. It includes original starter documentation, a Monaco Markdown editor, live preview, publication controls, revision history, visual navigation and redirect management, an administrator audit trail, and bilingual site settings with appearance controls. D1 stores published content, drafts, immutable revisions, a bilingual full-text index, navigation, route aliases, site settings and authentication state. Private R2 stores immutable file objects with D1 metadata, authenticated upload and explicit public delivery APIs. The visual File Manager supports private uploads, folder organization and explicit publication; the editor inserts published images and attachments. No code/data is inherited from Cloudflare-Native-Wiki.

- Production: <https://emby.wiki> and <https://www.emby.wiki>.
- Retained public domain: <https://cf.emby.wiki>. Canonical URLs use `https://emby.wiki` on all three hosts.
- The existing Cloudflare WWW redirect preserves path/query and sends `www.emby.wiki` to the canonical root domain.
- Stack: React, TypeScript, Vite, Workers Static Assets, official Cloudflare Vite plugin.
- Read `AGENTS.md`, then `codex.md` before development.

## Public reader

- `/`: server-rendered Emby handbook cover with shared light/dark appearance, Chinese/English selection and Continue links to `/zh/home` or `/en/home`. `/?lang=zh` and `/?lang=en` retain the reading choice on refresh and work without JavaScript. The root has its own canonical/website metadata and permits production indexing.
- `/zh/home` and `/en/home`: translated articles, nested navigation, breadcrumbs, contents, heading links, theme selection, code copying, image viewing and responsive layout.
- `/{language}/search?q=...`: server-rendered search over titles, descriptions, body, tags and paths; matches stay in the selected language. Queries are limited to 200 characters.
- `/api/public/search?lang=zh&q=...`: read-only JSON search; only `zh` and `en` are accepted.
- `/sitemap.xml`: current published catalog, with the fixed production origin `https://emby.wiki`. Article responses include canonical, translated-language and OpenGraph metadata. Production permits public indexing; admin, APIs, search results and errors remain noindex. `/robots.txt` advertises the sitemap and excludes private/operational routes.
- Unknown document routes return a genuine 404; public article and API writes are rejected.

The Worker renders the article before JavaScript runs. React hydrates reading controls; ordinary links, search, content and disclosure blocks work without JavaScript. `migrations/0003_starter_content.sql` publishes six original starter articles once when the database is initialized. `content/` keeps their original Markdown as reference; changing those files does not overwrite persisted articles. `worker/content/public.ts` reads only the current published revision from D1. Drafts, deleted pages and unpublished translations are excluded from articles, navigation, metadata, search and sitemap.

`shared/markdown.ts` renders both the reader and authenticated editor preview. It supports CommonMark/GFM, tables, tasks, footnotes, syntax highlighting, heading anchors, `[[guide/reading|internal links]]`, GitHub-style callouts, safe semantic HTML, KaTeX MathML and Mermaid source blocks. Diagram enhancement loads only when needed, uses strict Mermaid settings, and displays sanitized SVG as an image with the source preserved. Raw HTML cannot opt into trusted enhancements. Source size, tree complexity, code, diagram and math workloads are bounded.

Grouped examples use directive syntax. The reader and editor preview enhance them into keyboard-accessible tabs; without JavaScript, each section remains an ordinary expandable disclosure:

```markdown
:::tabs
::tab[Configuration]
Configuration explanation.

::tab[Verification]
Verification explanation.
:::
```

Left/Right arrows cycle through a group's tabs; Home/End select its first/last tab. Nested groups stay independent, and links or TOC entries to a hidden heading reveal its containing panels. Preview fragment links scroll within the preview without leaving the draft. Print styles expose all enhanced panels. Each group permits up to 12 tabs; use an extra colon in the outer directive fence when nesting groups.

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

Historical restoration keeps the chosen source, change note and exact submitted request in the history tab, including while its dialog is closed or the session needs verification. A successful response is checked against the new immutable draft. An interrupted or unverifiable request is never automatically replayed: read the latest state, compare it with the submitted snapshot, then explicitly acknowledge it. Two matching reads establish an observation, not which request committed; later changes are shown for review. A retry uses the explicitly adopted current version. Leaving the document or signing out warns before discarding this in-memory work and does not undo a request already sent to the server.

Monaco and its diff editor load only for the editor/history workspace and follow the current light, dark or system appearance without replacing editor models. These documents require a valid administrator session before the Worker returns the shell; anonymous requests return to sign-in. Navigation into them loads a new document with a fresh style nonce. Monaco's dynamic style elements use that nonce, while only these authenticated documents permit inline style attributes for editor layout. Scripts remain same-origin, `unsafe-eval` is disallowed and editor workers are bundled on the same origin. The reader and other admin documents keep their stricter style policy.

`scripts/monaco-csp.ts` adapts the pinned Monaco sources using exact source hashes and single-constructor checks; changes to a matched source fail the build until reviewed. It also replaces Monaco's embedded sanitizer with the pinned DOMPurify dependency in an isolated instance, so hooks are not shared with Mermaid. The Markdown sanitizer still strips author styles and unsafe HTML. The file service and its visual manager are described below.

## Page directories

The authenticated directory API derives folders from active canonical page paths independently for `zh` and `en`. A path can be both a page and a parent of other pages; directory entries include its landing-page summary and whether it has children. Empty folders are not stored. `GET /api/admin/directories/{language}` accepts only unique `path`, `cursor` and `limit` parameters. Root uses an empty path, pages default to 25 entries and are limited to 50, and cursors bind the language, directory and route-registry version. Deleted pages remain in the existing flat Trash list.

`POST /api/admin/directories/{language}/preview` accepts `{fromPath,toPath}` and returns every affected active page, including a source landing page. `POST /move` also requires the reviewed `expectedVersion` and exact `expectedMembers` array of `{id,version}`. Both POST endpoints require the administrator session, exact Origin, CSRF and closed JSON of at most 16 KiB. Moves contain at most 25 pages and fail as a whole if larger. Root and overlapping-prefix moves are rejected. The entire destination prefix must be unused, including aliases and paths reserved by unpublished or deleted pages.

One D1 transaction validates the complete membership and versions, adds new routes, updates published search paths, records each page move and changes canonical paths. It checks the completed page, route, search, event and audit records before committing; an incomplete result rolls back the whole move. Draft and published revision pointers, publication times, bilingual identities and navigation targets stay intact. Old paths remain aliases directly to the current page. Deleted pages stay in their original location. Markdown bodies and their immutable URL-resolution bases are unchanged, so relative links retain their original meaning after a path move. There is no automatic write retry.

`/admin/pages` opens a bilingual directory browser with breadcrumbs, direct children and separate controls for a landing page and its descendants. Entering a page-only node lets you create children beneath it. New pages can inherit the current directory; this context survives the editor's login return path without marking an otherwise untouched form dirty. Search, Drafts, Published and Trash remain paginated flat views, and switching back to directories remembers each language's location.

Directory move/rename shows every affected page and its old/new path before an explicit confirmation. Both single-page and directory previews list relative links in the current draft and publication, their original destinations and expected destinations after the move (including missing targets). The workspace preserves an uncertain request across dialog closure, blocks another page mutation and offers read-only comparison of the original IDs. Two complete read rounds and registry fences detect changes during inspection; a stable observation still requires explicit acknowledgement, and another move requires a fresh preview. Session failures retain inputs and pending actions until a verified reconnect. Single-page move, unpublish, delete and restore use the same explicit comparison principle. Leaving or signing out warns while input, a request or an unresolved operation remains in the tab. Nothing is automatically replayed; closing the document after confirming departure discards its in-memory recovery record.

Migration `0011_page_directories.sql` adds transaction-claim state and invalidates directory cursors on page deletion/restoration. It is compatible with the previous Worker during migration-first deployment. Keep applied migrations on rollback and repair schema issues through forward migrations.

Relative Markdown and sanitized HTML links/images resolve with normal browser URL rules against the revision's **link base**, shown in the editor. The base is captured on creation, inherited by subsequent draft saves and retained across moves; historical restoration inherits the selected revision's base. To target another directory while editing a moved document, use an explicit `/zh/...`, `/en/...` or `/files/...` URL. Fragment-only and query-only links still address the current document. Encoded paths, queries and fragments are preserved; alias redirects retain the query. Code blocks, inline code and ordinary text are never rewritten. Existing revision bases start from their current canonical paths when migration `0012_revision_link_bases.sql` is applied; this does not guess or retroactively repair links broken by older moves.

Link bases are separately immutable records; neither a move nor a draft save modifies an old revision. Missing link context blocks the entire move. A preview is limited to 256 relative links per revision and 1,024 distinct page targets per operation; a blocked preview identifies the affected page or suggests a smaller directory / absolute paths. New links are not silently created for missing targets. The existing version/session and subtree transaction guards remain authoritative. Keep migration 0012 on application rollback.

## File Manager

`/admin/files` provides a folder browser, current-folder search, paginated library and global Trash view, with a properties panel for previews, size, image dimensions, publication state and bilingual alternative text. Create folders, rename/move items, update alt text, publish/unpublish, download, copy public URLs and soft-delete/restore. Files are private after upload and restoration; publication is a separate confirmation. Folders containing active children cannot be deleted.

Upload one file at a time with optional browser-generated thumbnails. The browser validates bounded raster headers before decoding, computes SHA-256 and generates an optional thumbnail before preparing the source/thumbnail descriptors. Source upload precedes thumbnail upload using the newly returned version. Preparation, source upload and thumbnail upload have distinct states. Selected bytes and unsaved input stay in the tab's memory; no file or credential is saved in browser storage.

Interrupted or unconfirmed uploads require explicit state inspection/reconciliation, and pending uploads can be abandoned. No transfer is replayed automatically. An unconfirmed preparation without a returned ID requires inspecting every current-folder page before acknowledging a new attempt. Conflicting metadata changes preserve input and require reviewing the latest state. A failed session reconnect keeps changes blocked. Closing an uncertain folder-create dialog retains its original name/location for later paginated comparison. Navigation/signout warns before discarding pending work.

The Monaco toolbar's file picker browses the same library and inserts only freshly checked, ready, published files. Images use `/files/:id/image`; attachments and explicit download links use `/files/:id/download`. Labels default to the article language's alt text or filename and are escaped as literal Markdown text. Private files can be previewed but cannot be inserted. Selection, editor model/version and current session state are checked again before insertion, preserving undo and focus. Manage/publicize files in the separate manager; the picker never publishes them implicitly.

## File service

The APIs under `/api/admin/files` require a live administrator session. Mutations additionally require exact Origin and CSRF checks. D1 stores folders, stable file IDs, bilingual alt text, versions and immutable object receipts; R2 stores bytes under server-generated keys. Creates use the current library version; later changes use the entry version. Stale changes and invalidated list cursors return 412. Lists are bounded to 50 entries and support a folder, literal name search and Trash filter. Active sibling names are normalized for collision checks; folders allow at most eight levels, and moves reject cycles and excessive subtree depth.

`POST /uploads` prepares a private upload with name, parent, expected byte count, SHA-256 and MIME hint, plus an optional thumbnail descriptor. `PUT /:id/upload/source` streams raw `application/octet-stream` bytes with `X-File-Version`; thumbnail upload follows source completion. The preparation expires after 15 minutes and unfinished uploads remain tied to their original credential version. R2 writes require object absence and verify checksum, size, metadata and the returned object version before the guarded D1 finalization. Ambiguous outcomes require explicit `POST /:id/reconcile/source` or `/thumbnail`; a completed upload cannot be overwritten. D1 and R2 do not share a transaction: failed/cancelled operations can leave private objects, which this service does not automatically retry, delete or garbage-collect.

Attachments are limited to 20 MiB. Inline images accept PNG, JPEG and WebP up to 10 MiB and 25 million pixels, with bounded header/type/dimension inspection rather than complete image decoding. Optional thumbnails accept those image types up to 256 KiB and 320 pixels per edge. Everything else, including SVG and HTML, uses an octet-stream download. Names, folders and alt text never become R2 keys or response headers without validation/encoding.

Ready files support rename, move, bilingual alt text, publish/unpublish and soft deletion/restoration. Folders must be empty of active children before deletion. Restore is private, and publication/deletion abandons any unfinished optional thumbnail. Cancelling an unfinished source upload is terminal. No operation deletes stored bytes. Only explicitly published, ready, non-deleted files are available at `/files/:id/image`, `/files/:id/thumbnail` and `/files/:id/download`; stable URLs survive renames and moves. Private previews/downloads use the corresponding authenticated admin routes. Every response is no-store with safe content disposition and no-sniff; GET, HEAD, ETag and single-byte-range handling all recheck D1 visibility/session after R2 access. File audit events record changed field names only, never filenames, alt text, object keys or upload receipts.

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

## Site settings and appearance

`/admin/settings` edits the Chinese and English site names and short descriptions, default language, default theme (`system`, `light`, `dark`), accent (`forest`, `ocean`, `plum`) and built-in logo (`emby`, `book`, `none`). Names are required and limited to 80 UTF-16 code units; descriptions may be empty and are limited to 300. Control characters are rejected. These are public presentation values, never a place for credentials, arbitrary CSS, scripts or remote logo URLs.

The reader uses the current language's identity in its header, footer, title and OpenGraph metadata. An article's own description takes precedence; the site description is its fallback. `/` and search requests without an explicit language use the configured default; `/zh/...` and `/en/...` remain explicit. The production canonical origin and bilingual sitemap remain fixed; indexing policy is independent of editable presentation settings. A visitor's saved light/dark choice takes precedence over the site default. A small same-origin script applies it before styles load without broadening CSP; system mode follows the browser preference.

`GET/PUT /api/admin/settings` accepts no query parameters and requires a live administrator session. PUT additionally requires exact Origin, CSRF and closed JSON of at most 4 KiB. The version condition and live session are checked again inside the D1 update. A changed save increments the version once and records only changed field names atomically; an unchanged save leaves its version, timestamp and audit trail unchanged. A stale version returns 412. The UI preserves input on conflict, connection loss or session changes, requires explicit comparison with the latest settings before retrying an uncertain save, and never retries a write automatically.

`migrations/0009_site_settings.sql` seeds a protected singleton once. Missing or invalid stored settings fail closed with 503 rather than silently restoring defaults. The admin shell exposes only public presentation values; versions and update timestamps remain in the authenticated API. Existing content/authentication writers remain compatible while Actions applies the migration before deploying the new Worker. Rollback must retain the settings-aware audit decoder once settings events exist, along with the migration history; repair schema issues with a forward migration.

## Audit trail

`/admin/audit` provides a read-only history of successful page operations, navigation saves, redirect changes, file and folder operations, site settings updates and administrator initialization or credential changes. Filter by category, action, content language or site-wide events, subject ID and time range. Results use descending sequence cursors, with 25 entries by default and at most 50 per page. `GET /api/admin/audit` requires a valid administrator session in both HTTP and SQL; unknown or repeated query parameters are rejected. API timestamps must use UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; `from` is inclusive and `to` exclusive. Cursors are tied to the selected filters.

`migrations/0007_audit.sql` copies existing page events with their original timestamps and marks them `legacy`; their actor provenance is unknown. It does not invent earlier navigation or account history. New records are appended by database triggers in the same transaction as the successful operation, so a failed or stale write leaves no successful audit event. `current` identifies records captured after this migration, not a separate actor identity. Audit rows reject updates and deletion, and there is no log-writing or deletion API.

Audit details contain only a closed set of metadata: revision IDs and old/new paths for page events, mode changes and node counts for navigation, before/after alias paths and target translation IDs for redirects, boolean change flags for administrator credentials, and changed field names for site settings and files. Settings values, filenames, alt text, object keys and upload receipts are not copied into audit records. Redirect subjects identify their language registry and its version; automatic aliases created by page moves remain covered by their page event, while manual creation and edits/deletions of either origin produce redirect events. Page titles come from the referenced revision where available. Markdown, change notes, navigation labels/URLs, usernames, password hashes, session tokens, setup tokens and request details are not copied into the trail. Existing event/revision history is retained. Login/logout, failed attempts and historical account events are not part of this audit view.

## Administrator

Open `/admin` to initialize the sole administrator or sign in. The interface selects the form from the server's initialization state; it has no registration or ordinary user accounts. The dashboard shows content counts and recent changes. `/admin/account` changes the username or password after verifying the current password. The admin module and CSS load only on admin routes, with Chinese and English interface controls.

One-time initialization is complete. Normal **Deploy Production** never reads `ADMIN_SETUP_TOKEN`, writes bootstrap state, or changes administrator credentials. The original optional Actions setup Secret and `scripts/admin-bootstrap.mjs` belong to the completed initialization; they cannot reopen setup after an administrator exists or its marker is consumed. Never clear authentication records or bootstrap markers to regain access.

The owner-controlled **Administrator Recovery** manual Actions workflow can recover the original administrator through a protected Environment Secret; it does not expose an HTTP reset interface or reopen setup. Follow [the recovery runbook](administrator-recovery.md). Keep all setup/recovery credentials outside repository files, Worker/browser variables, URLs and logs.

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
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Actual account ID |
| Variable | `CLOUDFLARE_ZONE_ID` | Actual active emby.wiki zone ID |
| Variable | `CLOUDFLARE_WORKER_NAME` | `cloudflare-wiki` |
| Variable | `PRODUCTION_DOMAIN` | `emby.wiki` (hostname only); the fixed domain set also includes `www.emby.wiki` and `cf.emby.wiki` |

The existing token must support Worker deployment and Custom Domain management for the selected account/zone, plus preflight reads of zone, DNS, Worker settings, domains and routes, and D1 inspection of the retained database. Normal deployment performs no D1/R2 writes; separate authorized backup/recovery workflows retain their existing permissions. No new permission is granted by this repository. Missing permissions stop deployment; never expand them automatically. Conflicts stop without deleting resources. Do not enable an additional Cloudflare Git deployment integration.

## Delivery

1. Branch from current main using `feature/`, `fix/`, `chore/`, `docs/`, `refactor/` or `test/`.
2. Implement, run `npm run verify`, inspect secrets and open a PR.
3. Require successful `CI` and resolved conversations; squash merge when authorized.
4. Main push triggers `Deploy Production`: validation, preflight, deployment, smoke test.

PR CI receives no Cloudflare credential and never deploys. Manual deployment accepts only main. `npm run deploy:production` refuses local execution. All cloud writes run in Actions. The production deployment refuses absent resources or pending migrations; database changes require a separate authorized task.

After CI exists, import `.github/rulesets/main.json` through **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or apply it via the authenticated Administration API. A file in Git does **not** activate rules. The policy requires PR/CI/conversation resolution and linear history, blocks deletion/force push, has no bypass actors and permits squash only. Prefer squash-only repository merge settings too. Read back live settings before claiming protection is active.

## Read-only R2 readiness

The manual **R2 Readiness** Actions workflow inspects the fixed `cloudflare-wiki-assets-test` bucket using the existing deployment secret without copying it locally. Run it on current main:

```sh
gh workflow run r2-readiness.yml --ref main
```

It makes GET requests only: bounded bucket inventory, the existing Worker settings, and—if the bucket exists—its project ownership marker and public-domain state. It shares the deployment concurrency lock, rejects stale/non-main runs, and prints only a fixed status or sanitized failure. An existing bucket must have the exact project marker, use the default jurisdiction, have its managed public domain disabled and have no custom domains. Missing/incorrect markers or conflicting bindings stop the check; nothing is adopted, repaired or deleted.

A successful inventory read establishes visibility, not write permission or permission to enable a subscription. The workflow does not inspect token policies or billing, create resources, upload objects, change bindings, migrate D1 or deploy. Missing permissions or subscription access require an owner decision; no permission expansion or paid activation happens automatically.

## Private file storage

The Worker has one `MEDIA` binding to `cloudflare-wiki-assets-test`. Its local `remote: false` configuration uses emulated R2 without credentials. This existing bucket and its original `environment: test` ownership marker are retained as provenance; its historical name does not select the application environment. The bucket uses default jurisdiction, with no managed public domain or custom domain. Creation explicitly requests Standard storage; a returned non-Standard storage class is rejected. Omitted storage-class metadata is accepted without treating it as proof of the existing class. The Worker mediates every file request; no bucket URL is exposed to readers.

`scripts/production-storage.mjs` verifies the already deployed Worker ownership, exact DB/MEDIA bindings, existing D1 ownership and complete migration ledger, and existing R2 ownership/private-domain state. Missing or conflicting resources stop deployment. This path never invokes provisioning and executes only D1 SELECTs and R2 GETs; it never creates resources, applies remote migrations, writes markers, uploads files or reopens administrator setup. Historical initialization helpers remain separately tested, outside the normal production path.

The existing Actions credential is reused without permission expansion, paid activation or new storage domains. Post-deployment readback checks the same database UUID and MEDIA bucket. Deployment smoke remains anonymous and never writes live user files.

## Deployment and health

Actions deploys Worker `cloudflare-wiki` to exactly three Custom Domains: `emby.wiki`, `www.emby.wiki` and `cf.emby.wiki`. The canonical origin is `https://emby.wiki`; workers.dev and Preview URLs remain disabled. Preflight rejects conflicting Worker ownership, domains, routes or address/alias DNS records while preserving unrelated TXT/CAA records. Wrangler manages Custom Domain DNS/certificates through Actions only.

Production keeps the existing D1 `cloudflare-wiki-test` and private R2 `cloudflare-wiki-assets-test`, including their original ownership markers. `APP_ENV=production` controls application behavior independently of those retained resource names. The local DB UUID remains a placeholder; Actions resolves and verifies the already bound database and refuses creation or pending migrations. Both automatic-provisioning flags are disabled.

`GET /health` returns only uncached public liveness:

```json
{ "ok": true, "timestamp": "2026-10-01T00:00:00.000Z" }
```

The timestamp is the current server response time. HEAD is supported; writes are rejected. Build SHA remains an internal Worker binding verified through authenticated Cloudflare API readback; public health exposes no environment, service or revision metadata.

Actions smoke checks every Custom Domain for server-rendered bilingual articles, search, genuine reader/API/file 404s, canonical metadata, sitemap, JS/branding assets, generic health, public indexing and robots policy. Anonymous GET checks also verify the admin shell, protected session/overview/content/navigation/redirect/settings/audit/file endpoints, exact editor/history redirects and setup-status shape. Smoke never submits credentials, logs in or consumes a setup token. CSP, no-store, no-sniff, framing and authentication/CSRF policies remain intact.

The Actions runner uses its installed Chrome under Xvfb with a fresh temporary profile and Chrome's sandbox/default security controls. It executes the same HTTP assertions through actual browser GET responses, retaining response status/headers/body for editor redirects and assets. WWW checks first require an exact 301 to the same HTTPS root path/query. No bot-protection settings, challenge solvers or stealth flags are used; a browser that cannot reach the reader fails the deployment smoke. The ordinary Node smoke remains available for local or independent HTTP checks.

```sh
SMOKE_BASE_URL=https://emby.wiki npm run smoke
gh workflow run deploy-production.yml --repo jacklilyhello/cloudflare-wiki --ref main
```

Inspect failed workflow jobs/steps/logs and repair through PRs. Never bypass tests or deploy with a local write token. Rollbacks use normal revert/fix PRs and main deployment, retaining the original D1/R2 bindings, production-domain/disabled workers.dev policy and stored revisions. Applied database migrations and ownership markers stay immutable. Storage or schema changes require a separately reviewed task; never delete the database or undo stored revisions.

`codex.md` records product constraints, implemented boundaries and remaining module/storage plans. Product development and any data/schema migration need a separate explicit task.

## Private backups and isolated restore

The main-only **Site Backup** Actions workflow captures application D1 data and private R2 attachment bytes, verifies a fresh local D1/R2 restoration, and stores only a private archive in the existing bucket. It runs daily or manually; `verify-latest` repeats a stored-backup drill. Credentials/sessions are invalidated on restore, and no workflow overwrites live data. See [backup, retention, failure handling and restore instructions](backup-restore.md).

## Deployment branding

Custom light/dark logos, favicon, Apple Touch Icon, Open Graph image and bilingual footer/copyright use validated GitHub Repository Variables and same-origin deployment assets. Missing configuration keeps the existing built-in appearance. See [branding configuration and private image preparation](branding.md) for formats, limits, previews, precedence and the manual main Deploy Production workflow.
