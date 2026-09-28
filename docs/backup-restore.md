# Private site backup and verified isolated restore

**Site Backup** runs on main daily at 02:17 UTC, or manually with `operation=backup|verify-latest`. It uses the existing Actions Cloudflare Secret, owned D1 database and private R2 bucket. No new Cloudflare resource, permission, public endpoint or owner encryption key is required. Normal deployment does not execute a backup or restore. All remote writes are in Actions; local tools only restore into new local emulators.

## What is preserved

The versioned gzip archive contains the reviewed migration names and SHA-256 hashes, source commit, UTC snapshot time, an overall canonical payload checksum, all application entity rows, and every non-backup R2 object's bytes, SHA-256, size and HTTP/custom metadata. This includes pages, independent zh/en translations, draft/published pointers and states, immutable revisions and link bases, events, navigation, redirect registries/routes, site settings, audit records, file hierarchy/descriptors, thumbnails and attachment bytes. Private, unpublished and deleted content stays private. Pending uploads retain their state; a verified attachment missing from R2 fails the backup. Unrecognized source tables or object namespaces fail instead of being silently omitted.

`published_search` is preserved and checked against publication pointers; FTS is rebuilt and verified from its source rows. Cloudflare's [D1 export limitation](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations) affects databases containing virtual tables. This tool never drops the live search table to work around it. A single grouped SQL statement reads all captured rows consistently. Full D1 rows and R2 inventory are compared again after attachment reads; concurrent content/upload changes cause failure, not a partial backup. Deployment/recovery/backup workflows share one Actions concurrency lock.

Sensitive exceptions are deliberate: no administrator password verifier, raw password, setup token hash/expiry, session bearer/hash, IP-derived login counter or GitHub/Cloudflare credential enters the archive. The sole administrator's ID, username, credential version, immutable recovery-use ledger and closed setup state are retained. Restore assigns an unknown random password verifier, increments its credential version, keeps setup consumed, and creates empty session/login-limit tables. Normal login limits resume immediately. The owner must use [Administrator Recovery](administrator-recovery.md) before signing in after any eventual authorized remote restoration; restoring old data cannot revive old sessions or passwords.

## Privacy, retention and alerts

Archives live only under `__wiki_backups_v1/` in `cloudflare-wiki-assets-test`. Ownership and disabled managed/custom public domains are checked before reading and immediately before storing. The application only serves published file IDs backed by matching D1 metadata; backup keys have no application route. Archive uploads use a fresh UUID, an absent-key preflight, conditional request, and complete byte-checksum readback. No archive content, file names, page text, credential or SQL error is printed or uploaded as a GitHub artifact/cache. Runner restoration data lives in a private temporary directory and is removed after the run. Logs contain only aggregate counts and check outcomes.

R2 supplies [automatic encryption at rest and TLS in transit](https://developers.cloudflare.com/r2/reference/data-security/). This is account-controlled private storage, not separately keyed end-to-end encryption. Anyone legitimately granted object read access to this private bucket can read its backups. Keep bucket policy private and existing credentials restricted; do not make the bucket public for branding or attachment delivery.

Retention is **keep every completed archive**, with a fail-closed cap of **90 archives or 1 GiB**. Nothing is automatically deleted or overwritten. At one daily run this provides up to 90 daily restore points; extra manual backups consume slots. Review capacity monthly and retain at least the most recent 30 days before separately authorizing deletion of older verified archives through a reviewed Actions change. If that would require paid capacity or broader permissions, stop for owner approval. A cap failure leaves all earlier backups intact.

Every backup performs an isolated restore before upload, then verifies the uploaded bytes are exactly the tested archive. A failed step marks **Site Backup** failed and emits a fixed Actions error. Enable failed-workflow notifications for the repository in GitHub notification settings and inspect scheduled run history; no external email/Slack recipient or notification integration is added. GitHub may delay scheduled jobs or disable inactive public-repository schedules; the owner should check the latest successful run date. No automatic retry masks failures or an uncertain upload outcome.

Bounded archive limits are 20,000 captured rows / 32 MiB database response data, 2,000 source objects / 128 MiB attachment bytes, 20 MiB per object, and 220 MiB decompressed archive. Oversize, corrupt, incomplete or unknown-schema input fails explicitly. Increasing these bounds or changing schema requires a reviewed change and another drill; restore the archive using the same migration version/commit recorded in it.

## Run and verify

1. Dispatch `gh workflow run site-backup.yml --ref main -f operation=backup`. It verifies current main, ownership, migrations and privacy before capturing data; it never provisions or replaces a resource.
2. Inspect the **Private backup and isolated restore verification** step. A successful report includes snapshot/verification UTC times, per-table counts, object/byte counts, foreign-key and quick-check results, matching public state, rebuilt search, locked credentials, zero sessions and verified upload readback. A dispatched command or green ordinary deployment is not proof of a backup.
3. To repeat a stored-backup drill, dispatch `gh workflow run site-backup.yml --ref main -f operation=verify-latest`. This reads the newest private archive and restores it only into fresh local D1/R2 emulators on the runner. It never updates the live database or attachment keys. No output artifact is published.
4. Investigate any failed run. Editing/upload churn requires a new backup after activity stops; missing bytes, schema drift, ownership/privacy errors and permissions require inspection. Do not relax a guard, request a broader local token or automatically replay a failed mutation.

## Offline isolated restoration

Obtain the selected archive through an authenticated **read-only** R2 client into a private directory outside this checkout (mode 0600). Keep its object key and content out of public issues and PRs. Use the source version identified in its manifest; never execute SQL supplied by an archive.

With Node 24 and this repository's locked dependencies installed, run:

```sh
node scripts/restore-backup.mjs /private/path/site.json.gz /private/path/new-restored-wiki
```

The output directory must not exist and must be outside the repository. It is created mode 0700; existing directories and symlinks are rejected. A fresh local D1 database and R2 bucket are created there through Miniflare. Reviewed table constraints stay enabled, cyclic references are deferred only within the initial insert transaction, and reviewed indexes/audit/immutability triggers are installed after historical inserts. Search is rebuilt. Restored R2 bytes/metadata are read back, and verified file descriptors are assigned the new provider versions. Complete row comparisons allow only the documented credential invalidation and R2 version changes. A failed destination is incomplete and must never be promoted; rerun into a different unused directory after resolving the cause.

The tool checks every table, reference, publication/search relationship and object checksum, plus D1-supported `foreign_key_check`, `quick_check` and FTS integrity. It has no remote target, credential, overwrite or force option. It does not change `.wrangler` development storage or the current test site.

## Remote disaster recovery boundary

No workflow in this change performs a destructive remote restore. A real cutover requires a separately approved Actions change: choose an intact archive and matching source commit, repeat the isolated drill, obtain approval for new isolated D1/R2 resources if needed, verify their ownership and emptiness, import reviewed schema/data, upload/check attachments and assign their new versions, invalidate credentials/sessions, verify private/public behavior, then explicitly authorize binding/cutover and recovery. Keep the old resources and bindings for rollback. Never run D1 Time Travel restore or import against `cloudflare-wiki-test` just to test recovery, and never touch production `emby.wiki`.

D1 Time Travel is an additional provider facility, not a replacement for an independently verified D1-plus-R2 backup. A successful local emulator drill is not evidence of a remote restore or cutover.

## Deployment branding (archive v2)

New backups also capture the deployed `BRANDING_JSON` configuration and each same-origin image after MIME, byte-length and SHA-256 verification. A second read detects deployment changes before storage. The restore validates the complete image again and writes mode-0600 Repository Variable files under a mode-0700 `deployment-variables/` directory, without changing GitHub or Cloudflare. Use `scripts/install-branding.mjs` and a separately chosen main Deploy Test run to restore these settings. Pending GitHub Variable changes are not part of the deployed snapshot. Legacy format-v1 archives remain supported and explicitly report that branding is absent. See [branding configuration](branding.md).
