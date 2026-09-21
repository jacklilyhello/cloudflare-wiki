import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftInput } from "../shared/content";
import type { NavigationNode } from "../shared/navigation";
import { AuditService } from "../worker/audit/service";
import type { ContentWriteAccess } from "../worker/auth/access";
import { hashPassword, randomToken, sha256 } from "../worker/auth/crypto";
import { AuthService } from "../worker/auth/service";
import { ContentService } from "../worker/content/service";
import { NavigationService } from "../worker/navigation/service";
import { contentFixture, fixtureSessionToken } from "./content-fixture";

// Synthetic inputs exist only in the isolated local D1 test database.
const fixturePassword = "audit-fixture-password-only";
const verifier = await hashPassword(fixturePassword);
let content: ContentService;
let navigation: NavigationService;
let access: ContentWriteAccess;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(1,'fixture-owner',?,?,?)",
  )
    .bind(verifier, now, now)
    .run();
  ({ service: content, access } = await contentFixture(env.DB));
  navigation = new NavigationService(env.DB, access);
});

function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    title: "Audit test article",
    description: "",
    markdown: "## Test body\n\nLocal test content.",
    tags: [],
    changeNote: "Local fixture change",
    ...overrides,
  };
}
function create() {
  return content.createTranslation({
    language: "en",
    path: "audit/test-article",
    ...draft(),
  });
}
function group(id = "group"): NavigationNode {
  return {
    id,
    parentId: null,
    position: 0,
    kind: "group",
    label: "Fixture group",
    translationId: null,
    externalUrl: null,
  };
}
async function rows() {
  return (
    await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
  ).results;
}
async function snapshot() {
  const tables = [
    "pages",
    "page_translations",
    "page_revisions",
    "page_routes",
    "page_events",
    "published_search",
    "published_search_fts",
    "navigation_trees",
    "navigation_nodes",
    "administrators",
    "admin_sessions",
    "audit_records",
  ];
  const results = await env.DB.batch(
    tables.map((table) =>
      env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`),
    ),
  );
  return results.map((result) => result.results);
}
async function failAudit(category: "page" | "navigation" | "administrator") {
  await env.DB.exec(
    `CREATE TRIGGER audit_fixture_failure BEFORE INSERT ON audit_records WHEN NEW.category='${category}' BEGIN SELECT RAISE(ABORT,'local_audit_failure'); END;`,
  );
}

describe("audit records share the real business transaction", () => {
  it("records all content lifecycle actions with their actual committed versions", async () => {
    let page = await create();
    const firstRevision = page.draftRevisionId ?? "";
    page = await content.publish(page.id, page.version, firstRevision);
    page = await content.saveDraft(
      page.id,
      page.version,
      draft({ title: "New draft" }),
    );
    page = await content.restoreRevision(page.id, page.version, firstRevision);
    page = await content.move(page.id, page.version, "audit/moved");
    page = await content.unpublish(page.id, page.version);
    page = await content.softDelete(page.id, page.version);
    page = await content.restoreDeleted(page.id, page.version);
    const result = await new AuditService(env.DB, access).list({
      category: "page",
      subjectId: page.id,
    });
    expect(result.items.map((item) => item.action)).toEqual([
      "page.restore_deleted",
      "page.delete",
      "page.unpublish",
      "page.move",
      "page.restore_revision",
      "page.save_draft",
      "page.publish",
      "page.create",
    ]);
    expect(result.items.map((item) => item.subjectVersion)).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    expect(result.items.every((item) => item.origin === "current")).toBe(true);
    expect(page.publishedRevisionId).toBeNull();
  });

  it("rolls back a new page and its revision when the audit insertion fails", async () => {
    const before = await snapshot();
    await failAudit("page");
    await expect(create()).rejects.toThrow("Content storage operation failed.");
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back publication and search projection when auditing fails", async () => {
    const page = await create();
    const before = await snapshot();
    await failAudit("page");
    await expect(
      content.publish(page.id, page.version, page.draftRevisionId ?? ""),
    ).rejects.toThrow("Content storage operation failed.");
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back the complete navigation replacement when its audit trigger fails", async () => {
    await navigation.save("en", {
      expectedVersion: 1,
      mode: "custom",
      nodes: [group("original")],
    });
    const before = await snapshot();
    await failAudit("navigation");
    await expect(
      navigation.save("en", {
        expectedVersion: 2,
        mode: "custom",
        nodes: [group("replacement")],
      }),
    ).rejects.toThrow("Navigation storage operation failed.");
    expect(await snapshot()).toEqual(before);
  });

  it("retains credentials and active sessions when the credential audit cannot be written", async () => {
    const before = await snapshot();
    await failAudit("administrator");
    await expect(
      new AuthService(env.DB).updateUsername(fixtureSessionToken, {
        expectedVersion: 1,
        currentPassword: fixturePassword,
        username: "renamed-fixture",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await snapshot()).toEqual(before);
    expect(
      await new AuthService(env.DB).getSession(fixtureSessionToken),
    ).not.toBeNull();
  });

  it("writes exactly one event for each winning content and navigation CAS", async () => {
    const page = await create();
    const saves = await Promise.allSettled([
      content.saveDraft(
        page.id,
        page.version,
        draft({ title: "First writer" }),
      ),
      content.saveDraft(
        page.id,
        page.version,
        draft({ title: "Second writer" }),
      ),
    ]);
    expect(
      saves.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const navSaves = await Promise.allSettled([
      navigation.save("en", {
        expectedVersion: 1,
        mode: "custom",
        nodes: [group("first")],
      }),
      navigation.save("en", {
        expectedVersion: 1,
        mode: "custom",
        nodes: [group("second")],
      }),
    ]);
    expect(
      navSaves.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const audit = new AuditService(env.DB, access);
    expect(
      (await audit.list({ subjectId: page.id, action: "page.save_draft" }))
        .items,
    ).toHaveLength(1);
    expect(
      (await audit.list({ action: "navigation.save" })).items,
    ).toHaveLength(1);
  });

  it("adds no business event when logout wins immediately before the write batch", async () => {
    const page = await create();
    const before = await rows();
    let revoked = false;
    const raced = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!revoked) {
              revoked = true;
              await target
                .prepare("DELETE FROM admin_sessions WHERE token_hash=?")
                .bind(access.tokenHash)
                .run();
            }
            return target.batch(statements);
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    await expect(
      new ContentService(raced, access).saveDraft(
        page.id,
        page.version,
        draft(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      navigation.save("en", { expectedVersion: 1, mode: "custom", nodes: [] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await rows()).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT write_version FROM page_translations WHERE id=?",
      )
        .bind(page.id)
        .first("write_version"),
    ).toBe(page.version);
  });

  it("does not copy bodies, notes, navigation labels, URLs or credentials into audit records", async () => {
    const page = await content.createTranslation({
      language: "en",
      path: "audit/sensitive-fixture",
      ...draft({
        markdown: "body-canary-never-audit",
        description: "description-canary-never-audit",
        changeNote: "note-canary-never-audit",
      }),
    });
    await navigation.save("en", {
      expectedVersion: 1,
      mode: "custom",
      nodes: [
        {
          ...group(),
          kind: "link",
          label: "label-canary-never-audit",
          externalUrl: "https://example.com/url-canary-never-audit",
        },
      ],
    });
    const beforeChange = await new AuditService(env.DB, access).list({
      limit: 50,
    });
    await new AuthService(env.DB).changePassword(fixtureSessionToken, {
      expectedVersion: 1,
      currentPassword: fixturePassword,
      newPassword: "password-canary-never-audit",
    });
    const persisted = JSON.stringify(await rows());
    const response = JSON.stringify(beforeChange);
    for (const value of [
      "body-canary-never-audit",
      "description-canary-never-audit",
      "note-canary-never-audit",
      "label-canary-never-audit",
      "url-canary-never-audit",
      "password-canary-never-audit",
      fixturePassword,
      fixtureSessionToken,
      access.tokenHash,
      verifier,
    ]) {
      expect(persisted).not.toContain(value);
      expect(response).not.toContain(value);
    }
    expect(beforeChange.items.some((item) => item.subjectId === page.id)).toBe(
      true,
    );
    const last = (await rows()).at(-1);
    expect(last?.action).toBe("administrator.credentials");
    expect(JSON.parse(String(last?.details_json))).toEqual({
      usernameChanged: false,
      passwordChanged: true,
    });
  });

  it("completes one-time setup when the administrator insertion also creates an audit record", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM admin_sessions"),
      env.DB.prepare("DELETE FROM administrators"),
    ]);
    const token = randomToken();
    await env.DB.prepare(
      "INSERT INTO admin_bootstrap(id,token_hash,expires_at) VALUES(1,?,?)",
    )
      .bind(await sha256(token), Date.now() + 60_000)
      .run();
    const before = (await rows()).length;
    const grant = await new AuthService(env.DB).setup(
      { token, username: "setup-fixture", password: fixturePassword },
      "a".repeat(64),
    );
    expect(grant.session.user.version).toBe(1);
    expect((await rows()).slice(before).map((row) => row.action)).toEqual([
      "administrator.initialize",
    ]);
    expect(
      await env.DB.prepare(
        "SELECT consumed_at FROM admin_bootstrap WHERE id=1",
      ).first("consumed_at"),
    ).not.toBeNull();
    expect(
      await new AuthService(env.DB).getSession(grant.token),
    ).not.toBeNull();
  });
});
