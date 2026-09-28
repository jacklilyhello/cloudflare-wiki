# Owner-controlled administrator recovery

Recovery keeps the original administrator ID and username. It never reopens setup or creates an account. There is no reset HTTP endpoint. Ordinary `Deploy Test` runs never read the recovery Secret or execute recovery SQL.

## Protection and configuration

Create the GitHub Environment **`administrator-recovery`** with the sole required reviewer `jacklilyhello`, and one deployment branch policy: type `branch`, name `main`. The owner can approve their own recovery because this project has one owner. The workflow verifies the actual environment and branch rules through GitHub's read-only API; an absent/unprotected environment fails before Cloudflare inspection or recovery. Repository main PR/CI protection still applies.

The manual **Administrator Recovery** workflow accepts only `operation=status|apply` (default `status`). It shares the test deployment lock, rejects stale main and validates the fixed test Worker, owned D1 database and complete migration ledger. Its token has only `contents: read` and `actions: read` GitHub permissions. Cloudflare operations use the existing Actions deployment Secret; no permission expansion or new Cloudflare resource is needed.

Configure **`ADMIN_RECOVERY_BUNDLE` as an Environment Secret in `administrator-recovery`**. Do not use a Repository Variable, dispatch input, URL, repository file or workflow artifact. The Secret is a closed JSON object containing:

| Field | Meaning |
| --- | --- |
| `password` | New password, 12–128 Unicode characters and at most 512 UTF-8 bytes |
| `token` | A fresh, canonical base64url encoding of 32 cryptographically random bytes |
| `expectedVersion` | The original administrator's current credential version from `status` |
| `expiresAt` | Exact UTC ISO timestamp with milliseconds, in the future and at most 24 hours away |

## Recovery procedure

1. Run `gh workflow run administrator-recovery.yml --ref main -f operation=status` and approve the protected environment job in GitHub. Read the credential version from the sanitized status output. This operation performs no mutations.
2. Save the intended new password in a private file outside the checkout using a password manager or secure editor. The file bytes are the exact password, including any newline; do not use a command-line password argument or display the file in a terminal transcript.
3. With Node 24, run `node scripts/prepare-admin-recovery.mjs /private/path/password.txt CURRENT_VERSION /private/path/recovery.json`, substituting the non-secret version and actual private paths. The tool generates a fresh token and a one-hour expiry, validates the bundle and exclusively creates a mode-0600 file outside the checkout. It never prints the password, token or JSON.
4. Set the protected Secret through stdin: `gh secret set ADMIN_RECOVERY_BUNDLE --repo jacklilyhello/cloudflare-wiki --env administrator-recovery < /private/path/recovery.json`. Keep the new password in the owner's password manager. The JSON is sensitive even though it expires.
5. Run `gh workflow run administrator-recovery.yml --ref main -f operation=apply` and review/approve the protected job. Successful output is `recovered` with the new credential version. Only salted scrypt and token hashes reach D1; nothing is added to Worker bindings.
6. Sign in at `https://cf.emby.wiki/admin` with the **original username** and new password. Old credentials and all previous sessions are revoked. The existing `administrator.credentials` audit record has only boolean change flags; the private immutable recovery ledger records a token hash and versions, never the token or password.
7. Remove the consumed Environment Secret through GitHub's Secrets settings and remove the two private local files when no longer needed. Do not remove the D1 ledger or consumed setup marker. Do not print secret values while doing cleanup.

The guarded update advances the credential version, consumes the recovery request, revokes all sessions, resets transient login attempt counters and appends credential audit in the same database statement/transaction. Login limits immediately resume their normal enforcement. A concurrent credential change, expired request or competing recovery cannot partially commit.

## Unknown outcomes, retries and expiry

No network mutation is automatically retried. If the workflow fails after dispatch, first run `status` and inspect the successful audit / recovery result through the protected workflow. An explicitly rerun, still-valid identical bundle returns `already-used` if its digest is in the ledger, without changing credentials. A stale version or an expired bundle stops; creating a fresh bundle requires explicitly reading the current version and selecting a new password/token. Replacing a Secret does not automatically launch the workflow. Never clear auth rows, delete the original account, weaken environment protection or rotate the password just to test the procedure.

## Validation and rollback

`npm run verify` includes real workerd/D1 isolation tests for forgotten-password recovery, original identity, old password/session invalidation, new login, closed setup, concurrent recovery, expiry, atomic failure and secret-free audit. Node tests exercise the Actions driver, fixed password profile, readback, replay/ambiguous-write handling, environment guard and private bundle tool. These fixtures are separate from the current test site; they are not evidence that its real administrator was reset.

Keep migration `0013_administrator_recovery.sql` and its immutable ledger when reverting application/workflow code. The prior Worker remains compatible with the new nullable column and triggers. Restoring an older database requires the separately reviewed backup procedure and invalidation of sessions and credentials; do not use a destructive restore as a password reset.

GitHub's [environment protection documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) and [environment API](https://docs.github.com/en/rest/deployments/environments) describe the owner review and branch policy controls.
