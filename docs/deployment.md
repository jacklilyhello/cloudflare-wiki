# Deployment guide / 部署指南

[English README](../README.md) · [中文 README](../README_zh.md)

## English

### What is available today

The checked-in **Deploy Production** workflow updates the existing emby.wiki installation. It requires that the Worker already binds an owned D1 database and private R2 bucket, with every reviewed migration recorded. It does not create resources, apply remote migrations or enable administrator setup.

The repository contains tested provisioning and bootstrap modules, but **does not currently ship an executable first-install command or workflow for arbitrary forks**. New-site deployment requires a developer to adapt the explicit policies and assemble a separately reviewed initialization entry point. This guide documents that work; it is not a claim of a tested, unmodified fork deployment.

The five required Actions settings, their locations and token permissions are in [README → Deployment](../README.md#deployment). All Cloudflare writes, including first initialization, run in GitHub Actions. Local development uses emulated resources without production credentials.

### 1. Choose a coherent site identity

For example, a new installation could use:

| Setting | Example |
| --- | --- |
| Repository / application ID | `YOUR_OWNER/YOUR_REPOSITORY` |
| Worker | `my-wiki` |
| DNS zone | `example.com` |
| Canonical hostname | `wiki.example.com` |
| Canonical origin | `https://wiki.example.com` |
| D1 name | `my-wiki-db` |
| Private R2 bucket | `my-wiki-assets` |

Choose these identities before editing. The zone check must use `example.com`, while `PRODUCTION_DOMAIN` uses `wiki.example.com`. Decide explicitly whether there are additional Custom Domains and how their canonical redirects work. The current upstream's three-hostname arrangement is an example, not a requirement for every wiki.

Use independent resources. Never rename, clear, replace or adopt the live upstream D1/R2. A matching name alone does not prove ownership.

### 2. Adapt the fork's policies together

| File / area | Required review |
| --- | --- |
| `wrangler.jsonc` | Worker name; `DB` database name; `MEDIA` bucket name; `APP_ID`; `PUBLIC_ORIGIN`. Keep binding names and private-bucket settings consistent. The all-zero database UUID is the unresolved local template, not a remote ID. |
| `.github/workflows/deploy-production.yml` | Replace the repository allowlist with your fork; retain main-only deployment and serialized runs. Use a concurrency group unique to the new site. |
| `.github/workflows/deploy-production-run.yml` | Update its separate repository guard, Environment URL and hostname smoke list. Keep exact-commit verification and stale-main rejection. |
| `scripts/deploy-policy.mjs` | Repository identity, Worker name, `PRODUCTION_DOMAIN`, `PUBLIC_ORIGIN`, `PUBLIC_DOMAINS` and their validators. Preserve Actions-only and main-only enforcement. |
| `shared/branding.ts` | `publicOrigin()` currently accepts only the upstream's production/test origins. Adapt this runtime validator; a different variable alone otherwise causes 503 responses. |
| `scripts/deploy-production.mjs` | Active zone name/account validation, configuration readback `APP_ID` and the Vite-generated Wrangler path. Keep domain/DNS/route conflict checks and storage readback. |
| `scripts/d1-policy.mjs` and `migrations/0001_project.sql` | D1 name and ownership marker must agree for a brand-new, empty database. Review the fork's initial marker before its first application. Never change an already-applied migration or the existing upstream marker. |
| `scripts/r2-policy.mjs` | Bucket name, application ownership marker and matching bindings. Keep the marker version/key, Standard/default-jurisdiction validation and private-access checks coherent. |
| `scripts/smoke-browser.mjs`, `scripts/smoke-policy.mjs`, `scripts/preview-smoke.mjs` and tests | Review domain-specific canonical/redirect expectations and generated build paths. Update assertions to the fork's intended behavior without removing checks. |
| Backup, recovery and readiness workflows/scripts | Review every repository/workflow allowlist, resource name, Environment target and origin. This includes `site-backup.mjs`, `administrator-recovery.mjs` and `recovery-protection.mjs`. |
| `scripts/install-branding.mjs` | Its destination is the upstream repository. Adapt it before writing optional branding Variables. |
| `AGENTS.md`, `codex.md` and operational docs | Describe the fork's actual resource boundaries and maintenance policy; do not leave instructions pointing operators at another site's resources. |

Find remaining assumptions with:

```sh
rg -n 'jacklilyhello/cloudflare-wiki|emby\.wiki|cloudflare-wiki|cloudflare_wiki' \
  .github scripts shared tests migrations wrangler.jsonc AGENTS.md codex.md docs
```

This search is an inventory, not a blind replacement instruction. Historical notes, immutable migrations and live-resource markers need individual review. Vite derives the generated Worker directory from the configured name; inspect the build result instead of guessing it.

Run `npm ci` and `npm run verify` after adaptation. CI passing validates local behavior and policies; it does not prove that an unrun cloud initialization succeeded.

### 3. Add a separate first-initialization workflow

Use a manual `workflow_dispatch` entry point restricted to your repository and `refs/heads/main`, with a protected GitHub Environment and the same serialization boundary as deployment. Install pinned dependencies and verify the exact commit before exposing cloud credentials to the initializer.

The initializer needs the five deployment settings plus `ADMIN_SETUP_TOKEN`. Use the initialization permissions described in the README. Generate the setup token from at least 32 cryptographically random bytes, as unpadded base64url; keep the original in a password manager. It is not a Worker variable or a URL parameter.

The existing helpers have these contracts:

| Helper | Inputs and behavior |
| --- | --- |
| `prepareAdminBootstrap(env)` in `scripts/admin-bootstrap.mjs` | Validates Actions/deployment context and the optional setup token; returns its SHA-256 digest. Remove the raw token from both the copied environment and `process.env` before starting any child process. |
| `provisionStorage(input, dependencies)` in `scripts/provision-storage.mjs` | Inspects D1 before any R2 write, creates/verifies private R2, reinspects D1, then creates/migrates only the intended owned D1. It returns `{ config, databaseId }`. Conflicting or unmarked existing resources cause failure. |
| `bootstrapAdmin({ env, databaseId, tokenHash }, { fetch })` | After ownership and the full migration ledger are verified, writes the digest and a 24-hour setup window to D1. An existing administrator or consumed bootstrap cannot be reset by this helper. |
| `productionStorage(input, { fetch })` | Subsequent deployments use this separate read-only path; do not replace it with the provisioner. |

`provisionStorage` takes an `input` object containing `env`, the validated built `config`, absolute `configPath`, absolute `migrationsDirectory`, `.sql` `migrationNames` and current `workerSettings` (or `null` for a confirmed absent Worker). Its dependencies are `fetch`, `writeConfig(resolvedConfig)` and `runWrangler(args)`. The latter two must write the resolved config and run the lockfile-pinned Wrangler with the intended Actions environment.

The following shows **integration order only**, inside an initializer that already performs repository/main checks, zone/domain preflight and configuration validation. It is not a standalone command supplied by this release:

```js
import {
  bootstrapAdmin,
  prepareAdminBootstrap,
} from "./scripts/admin-bootstrap.mjs";
import { provisionStorage } from "./scripts/provision-storage.mjs";

// env, validated input and dependencies come from the reviewed Actions driver.
const tokenHash = prepareAdminBootstrap(env);
delete env.ADMIN_SETUP_TOKEN;
delete process.env.ADMIN_SETUP_TOKEN;
if (tokenHash === null) throw new Error("First setup requires a setup token.");

const initialized = await provisionStorage(input, dependencies);
await bootstrapAdmin(
  { env, databaseId: initialized.databaseId, tokenHash },
  { fetch: dependencies.fetch },
);
// Deploy initialized.config and verify the actual bindings and domains.
```

Ensure `input.env` and child-process environments use the copy with the raw setup token removed. Do not log API responses containing private data, credentials or tokens. An uncertain write result requires inspection, not blind retry or resource replacement.

The ordinary deployment path intentionally refuses a Worker that has not yet bound the expected resources. The initializer must perform the first Worker deployment using the verified resolved config, with automatic provisioning disabled, and verify actual `DB`/`MEDIA` bindings, identity, canonical origin, Custom Domains and disabled workers.dev/Preview URLs afterward. It cannot simply call the unchanged ordinary script before those bindings exist.

### 4. Complete administrator setup and verify

After the first deployment, `GET /api/admin/setup` should expose only `initialized` and `setupAvailable`. Before setup, the expected state is `false` / `true`. Open `/admin` on the canonical HTTPS origin and submit the original setup token and your chosen administrator credentials through the setup form. After successful setup, the expected state is `true` / `false`.

Reusing the same setup token never extends or reopens its window, even after expiry. Creating the administrator consumes setup permanently. Later loss of access uses the separate [administrator recovery runbook](administrator-recovery.md), not reinitialization or database deletion.

Verify both language readers, search, saving a draft, publishing, revision restoration and private/public file behavior. The migrations seed starter articles; they do not clone the current demo's content. Record actual initialization and smoke outcomes in the fork's PR/Actions history.

### 5. Operate the site

Use the normal Deploy Production path for later code updates. Plan any future schema migration as a separate reviewed Actions change; a deployment that refuses a pending migration is working as designed. Keep backups private and validate restoration into isolated resources before relying on them. See [backup/restore](backup-restore.md), [recovery](administrator-recovery.md) and [branding](branding.md).

For the existing upstream, preserve `cloudflare-wiki-test`, `cloudflare-wiki-assets-test` and their historical `test` ownership markers. Runtime production is selected separately with `APP_ENV=production`.

## 中文

### 当前可以怎样部署

仓库中的 **Deploy Production** 用来更新已有 emby.wiki。它要求 Worker 已绑定属于项目的 D1 与私有 R2，且所有已审查迁移都有记录；它不会创建资源、执行远程迁移或开放管理员初始化。

已有经过测试的资源初始化和管理员引导模块，但**当前没有可直接执行、适用于任意 Fork 的首次安装命令或工作流**。新站需要开发者调整显式策略，补充独立初始化入口。本指南描述这项工作，不代表未修改的 Fork 已完成新账号部署验证。

五个必填 Actions 配置、获取位置及权限见 [README → 部署](../README_zh.md#部署)。包括首次初始化在内的真实 Cloudflare 写操作统一放在 GitHub Actions；本地开发使用模拟资源，无需生产凭证。

### 第一步：确定一致的站点身份

| 配置 | 示例 |
| --- | --- |
| 仓库 / 应用 ID | `YOUR_OWNER/YOUR_REPOSITORY` |
| Worker | `my-wiki` |
| DNS 区域 | `example.com` |
| 规范主机名 | `wiki.example.com` |
| 规范来源 | `https://wiki.example.com` |
| D1 名称 | `my-wiki-db` |
| 私有 R2 桶 | `my-wiki-assets` |

先确定这些值，再修改代码。Zone 校验使用 `example.com`，`PRODUCTION_DOMAIN` 使用 `wiki.example.com`；额外 Custom Domains 和规范跳转要明确配置，上游的三个域名并非每个站都必须照搬。

使用独立资源，不重命名、清空、替换或接管线上上游 D1/R2。名字一致不等于归属已验证。

### 第二步：一起调整 Fork 的策略

| 文件 / 范围 | 要检查什么 |
| --- | --- |
| `wrangler.jsonc` | Worker 名、`DB` 数据库名、`MEDIA` 桶名、`APP_ID` 和 `PUBLIC_ORIGIN`；保持绑定名与私有设置一致。全零 UUID 是待解析模板，不是远程 ID。 |
| 两个 `deploy-production*.yml` 工作流 | 分别修改仓库限制、Environment URL 和冒烟域名；保留 main 限制、串行部署、精确提交验证与过期 main 拒绝。并发组使用新站独立名称。 |
| `scripts/deploy-policy.mjs` | 仓库、Worker、`PRODUCTION_DOMAIN`、`PUBLIC_ORIGIN`、`PUBLIC_DOMAINS` 及一致性校验；保留仅 Actions/main 执行限制。 |
| `shared/branding.ts` | `publicOrigin()` 当前只接受上游生产/测试来源；只改变量会使新域名返回 503，需一起调整运行时校验。 |
| `scripts/deploy-production.mjs` | 实际 Zone 名/账号、读回校验的 `APP_ID`、Vite 生成的 Wrangler 路径；保留域名/DNS/路由冲突检查。 |
| `scripts/d1-policy.mjs`、`migrations/0001_project.sql` | 仅对全新空库，在首次应用前审查并统一 D1 名称与初始归属标记。不修改已应用迁移或上游现有标记。 |
| `scripts/r2-policy.mjs` | 桶名、应用归属与绑定一致；保留标记版本/键、Standard/default jurisdiction 与私有访问校验。 |
| 冒烟脚本与测试 | 检查 `smoke-browser.mjs`、`smoke-policy.mjs`、`preview-smoke.mjs` 的规范来源/跳转与构建路径。按目标行为调整断言，不删除检查。 |
| 备份、恢复与就绪检查 | 检查相关工作流和 `site-backup.mjs`、`administrator-recovery.mjs`、`recovery-protection.mjs` 等脚本的仓库/工作流白名单、资源、Environment 和来源。 |
| `scripts/install-branding.mjs` | 写入目标是上游仓库；Fork 使用前改成自己的目标。 |
| `AGENTS.md`、`codex.md` 与运维文档 | 写明 Fork 的真实资源边界和维护规则，避免引导操作者操作另一个站点。 |

使用上方英文部分的 `rg` 命令检查剩余硬编码。这是检查清单，不能盲目批量替换；历史说明、已应用迁移和线上标记需要逐项审查。Vite 的输出目录由 Worker 名生成，请检查实际构建结果。

调整后运行 `npm ci` 和 `npm run verify`。CI 通过说明本地行为与策略验证通过，不代表未运行的云端初始化已经成功。

### 第三步：补充独立首次初始化工作流

使用手动 `workflow_dispatch`，限制自己的仓库与 `refs/heads/main`，配置受保护 GitHub Environment，并与部署共用串行边界。先安装锁定依赖并验证精确提交，再向初始化步骤提供云端凭证。

需要五个部署配置及 `ADMIN_SETUP_TOKEN`，权限按 README 的首次初始化说明配置。令牌至少包含 32 个密码学随机字节，以不带补位的 base64url 编码，原值另存密码管理器，不作为 Worker 变量或 URL 参数。

初始化顺序和模块接口见上方英文表格及集成示例：

1. 完成仓库/main、账号/Zone、域名冲突和构建配置预检。
2. `prepareAdminBootstrap(env)` 获取令牌摘要，然后从 `env` 和 `process.env` 删除原值，子进程只能使用删除后的环境。
3. `provisionStorage(input, dependencies)` 先检查 D1，再创建/验证私有 R2，重新检查 D1 后创建/迁移属于本项目的数据库。遇到无标记或冲突资源应停止。
4. 完整迁移记录验证通过后，`bootstrapAdmin(...)` 将摘要与 24 小时窗口写入 D1；它不能重置已有管理员或已消耗的引导记录。
5. 使用返回的已解析配置完成首次 Worker 部署，关闭自动资源创建，读回确认实际 `DB`/`MEDIA` 绑定、应用身份、规范来源、Custom Domains，以及关闭的 workers.dev/Preview URLs。

`input` 包含 `env`、已验证构建 `config`、绝对 `configPath`、绝对 `migrationsDirectory`、SQL 文件名 `migrationNames` 和当前 `workerSettings`（确认 Worker 不存在时为 `null`）。依赖提供 `fetch`、写入解析配置的 `writeConfig` 和使用锁定 Wrangler/正确 Actions 环境的 `runWrangler`。

英文示例只展示集成顺序，不是本版本已有的可运行初始化命令。普通部署会拒绝尚未绑定预期资源的 Worker，因此首次部署不能直接调用未修改的普通脚本。写操作结果不确定时先检查，不盲目重试或替换资源，不在日志中输出凭证或私有数据。

### 第四步：完成管理员初始化并验证

首次部署后，`GET /api/admin/setup` 应仅返回 `initialized` 与 `setupAvailable`，初始化前为 `false` / `true`。在规范 HTTPS 来源打开 `/admin`，通过表单提交原始设置令牌和自己的管理员凭证。成功后应为 `true` / `false`。

复用同一令牌不会延长或重新开放窗口，即使令牌已经过期。管理员创建成功后永久消耗初始化；以后失去访问权限按[管理员恢复手册](administrator-recovery.md)处理，不重新初始化或删库。

验证中英文阅读、搜索、保存草稿、发布、版本恢复和私有/公开文件行为。迁移提供初始示例，不会复制当前演示站内容；将实际初始化与冒烟结果记录在 Fork 的 PR/Actions 中。

### 第五步：后续维护

代码更新继续使用普通 Deploy Production。未来数据库迁移另走经过审查的 Actions 变更；普通部署拒绝未应用迁移属于预期行为。备份保持私有，并在隔离资源中演练恢复，参见[备份恢复](backup-restore.md)、[账号恢复](administrator-recovery.md)和[品牌配置](branding.md)。

现有上游继续保留 `cloudflare-wiki-test`、`cloudflare-wiki-assets-test` 及原始 `test` 归属标记；运行环境由 `APP_ENV=production` 单独决定。
