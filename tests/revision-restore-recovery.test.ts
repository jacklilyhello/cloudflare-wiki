import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../shared/auth";
import type { AdminTranslation, ContentRevision } from "../shared/content";
import { ApiError } from "../src/admin/api";
import type { PageActionRequest } from "../src/admin/page-action-recovery";
import {
  RevisionRestoreController,
  RevisionRestoreReadError,
  readRestoreRevision,
  readRestoreSnapshot,
} from "../src/admin/revision-restore-recovery";

const time = "2026-09-27T00:00:00.000Z";
const nextTime = "2026-09-27T01:00:00.000Z";
const session: AuthSession = {
  user: { id: 1, username: "fixture-owner", version: 1 },
  csrfToken: "a".repeat(64),
  createdAt: time,
  expiresAt: "2026-09-27T08:00:00.000Z",
  idleExpiresAt: "2026-09-27T00:30:00.000Z",
};
function baseline(overrides: Partial<AdminTranslation> = {}): AdminTranslation {
  return {
    id: "translation-fixture",
    pageId: "bilingual-fixture",
    language: "en",
    path: "guide/current",
    version: 5,
    revisionSeq: 2,
    draftRevisionId: "revision-two",
    publishedRevisionId: "revision-one",
    createdAt: time,
    updatedAt: time,
    publishedAt: time,
    deletedAt: null,
    ...overrides,
  };
}
function source(overrides: Partial<ContentRevision> = {}): ContentRevision {
  return {
    id: "revision-one",
    translationId: "translation-fixture",
    revisionNo: 1,
    title: "Earlier title",
    description: "Earlier description",
    markdown: "# Earlier\n\nBody.",
    tags: ["fixture", "earlier"],
    changeNote: "Original note",
    restoredFromRevisionId: null,
    createdAt: time,
    ...overrides,
  };
}
function originalDraft(): ContentRevision {
  return source({
    id: "revision-two",
    revisionNo: 2,
    markdown: "Current private draft.",
  });
}
function restoredPage(
  overrides: Partial<AdminTranslation> = {},
): AdminTranslation {
  return baseline({
    version: 6,
    revisionSeq: 3,
    draftRevisionId: "revision-three",
    updatedAt: nextTime,
    ...overrides,
  });
}
function restoredDraft(
  overrides: Partial<ContentRevision> = {},
): ContentRevision {
  return source({
    id: "revision-three",
    revisionNo: 3,
    changeNote: "Restore fixture",
    restoredFromRevisionId: "revision-one",
    createdAt: nextTime,
    ...overrides,
  });
}
function snapshot(page = baseline(), draft = originalDraft()) {
  return {
    translation: page,
    draft,
    translations: [baseline({ version: 999 })],
  };
}
function desiredSnapshot() {
  return snapshot(restoredPage(), restoredDraft());
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized deferred.");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("Uninitialized deferred.");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  options: {
    answers?: unknown[];
    source?: ContentRevision;
    before?: AdminTranslation;
    blocked?: boolean;
  } = {},
) {
  const answers = options.answers ?? [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const api: PageActionRequest = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(init) as Promise<T>;
    if (answer === undefined) throw new Error("Missing fixture response.");
    return answer as T;
  };
  const onDone = vi.fn();
  const onSessionRequired = vi.fn();
  const onSessionChange = vi.fn();
  const controller = new RevisionRestoreController({
    source: options.source ?? source(),
    before: options.before ?? baseline(),
    session,
    sessionBlocked: options.blocked ?? false,
    request: api,
    onDone,
    onSessionRequired,
    onSessionChange,
  });
  controller.editNote("  Restore fixture  ");
  return {
    controller,
    calls,
    answers,
    onDone,
    onSessionRequired,
    onSessionChange,
  };
}

describe("restore revision snapshots", () => {
  it("clones the selected immutable revision and reads only the owned translation/draft snapshot", () => {
    const original = source();
    const read = readRestoreRevision(
      original,
      original.translationId,
      original.id,
    );
    original.tags.push("later mutation");
    expect(read.tags).toEqual(["fixture", "earlier"]);
    expect(readRestoreSnapshot(snapshot(), baseline())).toEqual({
      page: baseline(),
      draft: originalDraft(),
    });
  });
  it.each([
    { translationId: "other-page" },
    { id: "wrong" },
    { revisionNo: 0 },
    { title: " padded " },
    { description: "x".repeat(501) },
    { tags: ["duplicate", "duplicate"] },
    { tags: [""] },
    { markdown: "中".repeat(42_667) },
    { changeNote: " padded " },
    { restoredFromRevisionId: "revision-one" },
    { createdAt: "2026-09-27" },
  ])("rejects malformed or mismatched immutable revisions: %j", (changes) => {
    expect(() =>
      readRestoreRevision(
        { ...source(), ...changes },
        "translation-fixture",
        "revision-one",
      ),
    ).toThrow(RevisionRestoreReadError);
  });
  it("rejects a draft whose ID, ownership or revision sequence does not match its translation", () => {
    for (const changes of [
      { id: "other" },
      { translationId: "other" },
      { revisionNo: 1 },
    ])
      expect(() =>
        readRestoreSnapshot(
          snapshot(baseline(), { ...originalDraft(), ...changes }),
          baseline(),
        ),
      ).toThrow();
  });
  it("refuses a source from another translation or from beyond the current history", () => {
    expect(() =>
      setup({ source: source({ translationId: "other" }) }),
    ).toThrow();
    expect(() => setup({ source: source({ revisionNo: 3 }) })).toThrow();
    expect(() =>
      setup({ before: baseline({ language: "fr" as "en" }) }),
    ).toThrow();
  });
});

describe("verified revision restore requests", () => {
  it("retains the exact attempt before POST and verifies its returned immutable draft before completion", async () => {
    const test = setup();
    test.answers.push(
      () => {
        expect(test.controller.state.attempt?.note).toBe("  Restore fixture  ");
        return { translation: restoredPage() };
      },
      { revision: restoredDraft() },
    );
    await test.controller.submit();
    expect(test.calls.map((call) => call.path)).toEqual([
      "pages/translation-fixture/revisions/revision-one/restore",
      "pages/translation-fixture/revisions/revision-three",
    ]);
    expect(JSON.parse(String(test.calls[0]?.init?.body))).toEqual({
      expectedVersion: 5,
      changeNote: "  Restore fixture  ",
    });
    expect(test.calls[0]?.init?.method).toBe("POST");
    expect(test.calls[0]?.init?.headers).toHaveProperty(
      "X-CSRF-Token",
      session.csrfToken,
    );
    expect(test.onDone).toHaveBeenCalledExactlyOnceWith("verified");
    expect(test.controller.state).toMatchObject({
      attempt: null,
      busy: false,
      needsReview: false,
    });
    await test.controller.submit();
    expect(test.calls).toHaveLength(2);
  });
  it.each([
    { path: "guide/moved" },
    { version: 7 },
    { revisionSeq: 4 },
    { draftRevisionId: "revision-two" },
    { draftRevisionId: "revision-one" },
    { publishedRevisionId: "revision-two" },
    { publishedAt: nextTime },
    { createdAt: nextTime },
    { id: "other" },
  ])(
    "retains uncertainty for a malformed successful translation: %j",
    async (changes) => {
      const test = setup({ answers: [{ translation: restoredPage(changes) }] });
      await test.controller.submit();
      expect(test.calls).toHaveLength(1);
      expect(test.controller.state.attempt).not.toBeNull();
      expect(test.controller.canSubmit).toBe(false);
      expect(test.onDone).not.toHaveBeenCalled();
    },
  );
  it.each([
    { title: "Another title" },
    { description: "Another description" },
    { markdown: "Another body" },
    { tags: ["another"] },
    { changeNote: "Another note" },
    { restoredFromRevisionId: null },
    { revisionNo: 2 },
    { createdAt: time },
    { id: "other" },
  ])(
    "requires exact source content and restoration provenance: %j",
    async (changes) => {
      const test = setup({
        answers: [
          { translation: restoredPage() },
          { revision: restoredDraft(changes) },
        ],
      });
      await test.controller.submit();
      expect(test.controller.state.attempt).not.toBeNull();
      expect(test.onDone).not.toHaveBeenCalled();
    },
  );
  it.each([new TypeError("lost response"), new ApiError(503), undefined])(
    "does not retry an uncertain POST result",
    async (failure) => {
      const test = setup({ answers: [failure] });
      await test.controller.submit();
      await test.controller.submit();
      expect(test.calls).toHaveLength(1);
      expect(test.controller.state).toMatchObject({
        busy: false,
        needsReview: true,
      });
      expect(test.controller.state.attempt).not.toBeNull();
    },
  );
  it.each([400, 404, 409, 412, 429])(
    "requires review after a definite POST %s rejection",
    async (status) => {
      const test = setup({ answers: [new ApiError(status)] });
      await test.controller.submit();
      expect(test.controller.state).toMatchObject({
        attempt: null,
        needsReview: true,
        note: "  Restore fixture  ",
      });
      expect(test.controller.canSubmit).toBe(false);
    },
  );
  it.each([401, 403, 404, 503])(
    "retains an already successful POST when its verification GET fails with %s",
    async (status) => {
      const test = setup({
        answers: [{ translation: restoredPage() }, new ApiError(status)],
      });
      await test.controller.submit();
      expect(test.controller.state.attempt).not.toBeNull();
      expect(test.controller.state.blocked).toBe([401, 403].includes(status));
      expect(test.onDone).not.toHaveBeenCalled();
    },
  );
  it("retains the committed attempt when the verification auth callback synchronously blocks parent context", async () => {
    const test = setup({
      answers: [{ translation: restoredPage() }, new ApiError(401)],
    });
    test.onSessionRequired.mockImplementation(() =>
      test.controller.context(session, true),
    );
    await test.controller.submit();
    expect(test.controller.state).toMatchObject({
      busy: false,
      blocked: true,
      needsReview: true,
    });
    expect(test.controller.state.attempt).not.toBeNull();
    expect(test.onDone).not.toHaveBeenCalled();
  });
  it("does not submit the current draft, a deleted page, an oversized note or overflowing versions", async () => {
    for (const test of [
      setup({ source: originalDraft() }),
      setup({
        before: baseline({
          deletedAt: time,
          publishedAt: null,
          publishedRevisionId: null,
        }),
      }),
      setup({ before: baseline({ version: Number.MAX_SAFE_INTEGER }) }),
      setup({ before: baseline({ revisionSeq: Number.MAX_SAFE_INTEGER }) }),
    ]) {
      await test.controller.submit();
      expect(test.calls).toEqual([]);
    }
    const test = setup();
    test.controller.editNote("x".repeat(501));
    await test.controller.submit();
    expect(test.calls).toEqual([]);
  });
});

describe("explicit revision restore inspection and session recovery", () => {
  it.each(["desired", "unchanged", "changed"] as const)(
    "requires two stable reads and explicit acknowledgement of %s state",
    async (outcome) => {
      const value =
        outcome === "desired"
          ? desiredSnapshot()
          : outcome === "unchanged"
            ? snapshot()
            : snapshot(
                baseline({
                  version: 7,
                  revisionSeq: 3,
                  draftRevisionId: "revision-three",
                  updatedAt: nextTime,
                }),
                restoredDraft({ markdown: "Later content" }),
              );
      const test = setup({ answers: [new ApiError(503), value, value] });
      await test.controller.submit();
      test.controller.editNote("Note for a separately confirmed attempt");
      await test.controller.inspect();
      expect(test.calls).toHaveLength(3);
      expect(test.controller.state.comparison?.outcome).toBe(outcome);
      expect(test.controller.canSubmit).toBe(false);
      expect(test.onDone).not.toHaveBeenCalled();
      test.controller.acknowledge();
      expect(test.controller.state.attempt).toBeNull();
      expect(test.controller.state.note).toBe(
        "Note for a separately confirmed attempt",
      );
      if (outcome === "desired")
        expect(test.onDone).toHaveBeenCalledExactlyOnceWith("observed");
      else {
        expect(test.onDone).not.toHaveBeenCalled();
        expect(test.controller.canSubmit).toBe(true);
      }
    },
  );
  it("does not infer that a later unrelated save was the attempted restore", async () => {
    const value = snapshot(
      restoredPage(),
      restoredDraft({ restoredFromRevisionId: null }),
    );
    const test = setup({ answers: [new ApiError(503), value, value] });
    await test.controller.submit();
    await test.controller.inspect();
    expect(test.controller.state.comparison?.outcome).toBe("changed");
  });
  it("rejects changes between reads, including altered immutable content under the same pointer", async () => {
    for (const second of [
      desiredSnapshot(),
      snapshot(baseline(), originalDraftWithChangedBody()),
    ]) {
      const test = setup({ answers: [new ApiError(503), snapshot(), second] });
      await test.controller.submit();
      await test.controller.inspect();
      test.controller.acknowledge();
      expect(test.controller.state.comparison).toBeNull();
      expect(test.controller.state.attempt).not.toBeNull();
      expect(test.controller.canSubmit).toBe(false);
    }
  });
  it("does not adopt unavailable or malformed observations", async () => {
    for (const answer of [
      new ApiError(404),
      new ApiError(503),
      { translation: baseline(), draft: {} },
    ]) {
      const test = setup({ answers: [new ApiError(503), answer] });
      await test.controller.submit();
      await test.controller.inspect();
      test.controller.acknowledge();
      expect(test.controller.state.attempt).not.toBeNull();
      expect(test.onDone).not.toHaveBeenCalled();
    }
  });
  it("preserves the source and note while adopting a stale page's latest baseline", async () => {
    const value = snapshot(baseline({ version: 6, path: "guide/moved" }));
    const test = setup({ answers: [new ApiError(412), value, value] });
    await test.controller.submit();
    await test.controller.inspect();
    expect(test.controller.state.comparison?.outcome).toBeNull();
    test.controller.acknowledge();
    expect(test.controller.state.before).toMatchObject({
      version: 6,
      path: "guide/moved",
    });
    expect(test.controller.state.source).toEqual(source());
    expect(test.controller.state.note).toBe("  Restore fixture  ");
    expect(test.controller.canSubmit).toBe(true);
  });
  it("rechecks deleted and already-current source eligibility after adoption", async () => {
    for (const value of [
      snapshot(
        baseline({
          version: 6,
          deletedAt: nextTime,
          publishedRevisionId: null,
          publishedAt: null,
        }),
      ),
      snapshot(
        baseline({
          version: 6,
          revisionSeq: 1,
          draftRevisionId: "revision-one",
        }),
        source(),
      ),
    ]) {
      const test = setup({ answers: [new ApiError(412), value, value] });
      await test.controller.submit();
      await test.controller.inspect();
      test.controller.acknowledge();
      expect(test.controller.canSubmit).toBe(false);
    }
  });
  it.each([401, 403])(
    "latches authentication after POST %s and never clears it on failed reconnect or prop updates",
    async (status) => {
      const test = setup({
        answers: [
          new ApiError(status),
          new ApiError(503),
          { session: { ...session, csrfToken: "malformed" } },
          { session },
          snapshot(),
          snapshot(),
        ],
      });
      await test.controller.submit();
      expect(test.controller.state.attempt).toBeNull();
      expect(test.onSessionRequired).toHaveBeenCalledOnce();
      test.controller.context(session, false);
      await test.controller.inspect();
      expect(test.calls).toHaveLength(1);
      await test.controller.reconnect();
      expect(test.controller.state.blocked).toBe(true);
      await test.controller.reconnect();
      expect(test.controller.state.blocked).toBe(true);
      await test.controller.reconnect();
      expect(test.controller.state).toMatchObject({
        blocked: false,
        needsReview: true,
        notice: "session",
      });
      expect(test.onSessionChange).toHaveBeenCalledExactlyOnceWith(session);
      expect(test.controller.canSubmit).toBe(false);
      await test.controller.inspect();
      test.controller.acknowledge();
      expect(test.controller.canSubmit).toBe(true);
    },
  );
  it("invalidates an existing comparison on reconnect and when the parent requires authentication", async () => {
    const test = setup({ answers: [snapshot(), snapshot(), { session }] });
    await test.controller.inspect();
    expect(test.controller.state.comparison).not.toBeNull();
    await test.controller.reconnect();
    expect(test.controller.state.comparison).toBeNull();
    test.controller.context(session, true);
    expect(test.controller.state.blocked).toBe(true);
  });
});

function originalDraftWithChangedBody() {
  return { ...originalDraft(), markdown: "Changed immutable body" };
}

describe("restore work retention and late-response fencing", () => {
  it("detaches a stopped POST immediately and ignores its late success during a newer inspection", async () => {
    const post = deferred<unknown>();
    const read = deferred<unknown>();
    const test = setup({
      answers: [() => post.promise, () => read.promise, snapshot()],
    });
    const first = test.controller.submit();
    await test.controller.submit();
    expect(test.calls).toHaveLength(1);
    test.controller.cancel();
    expect(test.calls[0]?.init?.signal?.aborted).toBe(true);
    expect(test.controller.state).toMatchObject({
      busy: false,
      needsReview: true,
    });
    expect(test.controller.state.attempt).not.toBeNull();
    const second = test.controller.inspect();
    post.resolve({ translation: restoredPage() });
    await first;
    expect(test.controller.state.busy).toBe(true);
    expect(test.calls).toHaveLength(2);
    expect(test.onDone).not.toHaveBeenCalled();
    read.resolve(snapshot());
    await second;
    expect(test.controller.state.comparison?.outcome).toBe("unchanged");
  });
  it("ignores late rejection after cancellation without clearing a newer successful comparison", async () => {
    const post = deferred<unknown>();
    const test = setup({
      answers: [() => post.promise, snapshot(), snapshot()],
    });
    const first = test.controller.submit();
    test.controller.cancel();
    await test.controller.inspect();
    const comparison = test.controller.state.comparison;
    post.reject(new ApiError(401));
    await first;
    expect(test.controller.state.comparison).toBe(comparison);
    expect(test.controller.state.blocked).toBe(false);
    expect(test.onSessionRequired).not.toHaveBeenCalled();
  });
  it("cancels in-flight verification without forgetting the submitted restore", async () => {
    const verify = deferred<unknown>();
    const test = setup({
      answers: [{ translation: restoredPage() }, () => verify.promise],
    });
    const pending = test.controller.submit();
    await vi.waitFor(() => expect(test.calls).toHaveLength(2));
    test.controller.cancel();
    verify.resolve({ revision: restoredDraft() });
    await pending;
    expect(test.controller.state.attempt).not.toBeNull();
    expect(test.onDone).not.toHaveBeenCalled();
  });
  it("preserves work during disposal and StrictMode activation while fencing the old response", async () => {
    const post = deferred<unknown>();
    const originalSource = source();
    const originalBefore = baseline();
    const test = setup({
      source: originalSource,
      before: originalBefore,
      answers: [() => post.promise, snapshot(), snapshot()],
    });
    const listener = vi.fn();
    test.controller.subscribe(listener);
    const pending = test.controller.submit();
    const attempt = test.controller.state.attempt;
    originalSource.tags.push("outside edit");
    originalBefore.path = "outside/edit";
    test.controller.dispose();
    const notifications = listener.mock.calls.length;
    test.controller.activate();
    test.controller.editNote("Retained edited note");
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(test.controller.state.attempt).toBe(attempt);
    expect(attempt?.source.tags).toEqual(["fixture", "earlier"]);
    expect(attempt?.before.path).toBe("guide/current");
    expect(test.controller.state.busy).toBe(false);
    await test.controller.inspect();
    post.resolve({ translation: restoredPage() });
    await pending;
    expect(test.controller.state.comparison?.outcome).toBe("unchanged");
    expect(test.controller.state.note).toBe("Retained edited note");
    expect(test.onDone).not.toHaveBeenCalled();
  });
  it("keeps a cancelled reconnect blocked and ignores its later valid session", async () => {
    const reconnect = deferred<unknown>();
    const test = setup({ blocked: true, answers: [() => reconnect.promise] });
    const pending = test.controller.reconnect();
    test.controller.cancel();
    reconnect.resolve({ session });
    await pending;
    expect(test.controller.state.blocked).toBe(true);
    expect(test.onSessionChange).not.toHaveBeenCalled();
  });
  it("immediately stops an operation when the parent reports an authentication failure", async () => {
    const post = deferred<unknown>();
    const test = setup({ answers: [() => post.promise] });
    const pending = test.controller.submit();
    test.controller.context(session, true);
    expect(test.controller.state).toMatchObject({ busy: false, blocked: true });
    post.resolve({ translation: restoredPage() });
    await pending;
    expect(test.controller.state.attempt).not.toBeNull();
    expect(test.onDone).not.toHaveBeenCalled();
  });
});
