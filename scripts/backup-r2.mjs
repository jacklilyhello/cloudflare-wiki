import { BACKUP_PREFIX, LIMITS, fail, sha256 } from "./backup-format.mjs";
import { R2_BUCKET } from "./r2-policy.mjs";

export async function boundedBytes(response, maximum) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    fail("Backup transport exceeded its size limit.");
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        fail("Backup transport exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export function backupR2(env, fetchRequest = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects`;
  async function request(suffix, options = {}) {
    try {
      const response = await fetchRequest(base + suffix, {
        ...options,
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "cf-r2-jurisdiction": "default",
          ...options.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        fail();
      }
      return response;
    } catch {
      fail(
        "Private R2 request failed; permissions are not expanded and mutations are not retried.",
      );
    }
  }
  function path(key) {
    if (
      typeof key !== "string" ||
      !/^(?:files\/[0-9a-f-]{36}|__cloudflare_wiki_owner_v1\.json|__wiki_backups_v1\/[a-f0-9-]{36}\.json\.gz)$/.test(
        key,
      )
    )
      fail("Unexpected private object key.");
    return `/${key}`;
  }
  return {
    async list() {
      const objects = [];
      const seen = new Set();
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 25; page++) {
        const query = new URLSearchParams({ per_page: "1000" });
        if (cursor) query.set("cursor", cursor);
        const payload = JSON.parse(
          (
            await boundedBytes(await request(`?${query}`), 4 * 1024 * 1024)
          ).toString("utf8"),
        );
        if (
          payload.success !== true ||
          !Array.isArray(payload.result) ||
          payload.result.length > 1000 ||
          (payload.result_info !== undefined &&
            (!payload.result_info ||
              typeof payload.result_info !== "object" ||
              Array.isArray(payload.result_info)))
        )
          fail("R2 pagination is unverified.");
        const info = payload.result_info ?? {};
        if (
          (info.is_truncated !== undefined &&
            typeof info.is_truncated !== "boolean") ||
          (info.per_page !== undefined && info.per_page !== 1000) ||
          (info.cursor !== undefined &&
            (typeof info.cursor !== "string" || info.cursor.length > 4096)) ||
          (info.delimited !== undefined &&
            (!Array.isArray(info.delimited) || info.delimited.length !== 0)) ||
          (info.is_truncated === false && info.cursor)
        )
          fail("R2 pagination is unverified.");
        for (const item of payload.result) {
          path(item.key);
          if (
            seen.has(item.key) ||
            !Number.isSafeInteger(item.size) ||
            item.size < 0 ||
            typeof item.etag !== "string" ||
            !/^[a-f0-9]{32}(?:-[1-9][0-9]*)?$/.test(item.etag) ||
            typeof item.last_modified !== "string" ||
            !Number.isFinite(Date.parse(item.last_modified))
          )
            fail("R2 metadata is invalid.");
          seen.add(item.key);
          objects.push(item);
        }
        if (objects.length > LIMITS.objects + LIMITS.retained)
          fail("R2 inventory exceeds its bounded size.");
        // Cloudflare omits result_info on a terminal short page. A full page
        // without an explicit terminal flag or continuation remains unsafe.
        if (info.is_truncated !== true && !info.cursor) {
          if (payload.result.length === 1000 && info.is_truncated !== false)
            fail("R2 pagination is incomplete.");
          return objects.sort((a, b) => a.key.localeCompare(b.key, "en"));
        }
        cursor = info.cursor;
        if (
          typeof cursor !== "string" ||
          !cursor ||
          cursor.length > 4096 ||
          cursors.has(cursor)
        )
          fail("R2 pagination is incomplete.");
        cursors.add(cursor);
      }
      fail("R2 inventory pagination exceeded its limit.");
    },
    async get(key, maximum = LIMITS.object) {
      return boundedBytes(await request(path(key)), maximum);
    },
    async putArchive(key, bytes) {
      if (!key.startsWith(BACKUP_PREFIX) || bytes.length > LIMITS.archive)
        fail();
      // Fresh UUID plus an absent-key preflight, shared Actions lock and a
      // conditional request prevent replacing an earlier backup.
      const response = await request(path(key), {
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "Cache-Control": "no-store",
          "If-None-Match": "*",
        },
        body: bytes,
      });
      await response.body?.cancel();
      const stored = await this.get(key, LIMITS.archive);
      if (sha256(stored) !== sha256(bytes))
        fail("Backup upload readback checksum failed.");
      return stored;
    },
  };
}
