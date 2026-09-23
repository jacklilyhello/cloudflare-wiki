import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../shared/auth";
import type { PageSummary } from "../shared/content";
import { ApiError } from "../src/admin/api";
import {
  classifyPageAction,
  createPageActionAttempt,
  type PageAction,
  type PageActionAttempt,
  PageActionController,
  PageActionReadError,
  type PageActionRequest,
  pageActionEligible,
  readPageSummary,
} from "../src/admin/page-action-recovery";

const timestamp = "2026-09-23T00:00:00.000Z";
const nextTime = "2026-09-23T01:00:00.000Z";
const session: AuthSession = {
  user: { id: 1, username: "fixture-admin", version: 1 },
  csrfToken: "a".repeat(64),
  createdAt: timestamp,
  expiresAt: "2026-09-23T08:00:00.000Z",
  idleExpiresAt: "2026-09-23T00:30:00.000Z",
};
function page(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    id: "page-fixture",
    pageId: "bilingual-fixture",
    language: "en",
    path: "guide/start",
    version: 5,
    revisionSeq: 2,
    draftRevisionId: "draft-two",
    publishedRevisionId: "published-one",
    publishedAt: timestamp,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    title: "Fixture title",
    description: "Description",
    tags: ["fixture"],
    ...overrides,
  };
}
function initial(kind: PageAction) {
  return page(
    kind === "restore"
      ? { deletedAt: timestamp, publishedRevisionId: null, publishedAt: null }
      : {},
  );
}
function desired(kind: PageAction, before = initial(kind)): PageSummary {
  return {
    ...before,
    version: before.version + 1,
    updatedAt: nextTime,
    ...(kind === "move"
      ? { path: "new/path" }
      : {
          publishedRevisionId: null,
          publishedAt: null,
          deletedAt: kind === "delete" ? nextTime : null,
        }),
  };
}
function detail(state = page()) {
  return {
    translation: state,
    draft: {
      id: state.draftRevisionId,
      translationId: state.id,
      title: state.title,
      description: state.description,
      tags: state.tags,
    },
    translations: [page({ path: "unrelated/later-read", version: 100 })],
  };
}
function setup(
  options: {
    kind?: PageAction;
    before?: PageSummary;
    attempt?: PageActionAttempt | null;
    blocked?: boolean;
    answers?: unknown[];
  } = {},
) {
  const kind = options.kind ?? "move";
  const before = options.before ?? initial(kind);
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
    if (answer === undefined) throw new Error("Missing test response.");
    return answer as T;
  };
  const onAttemptChange = vi.fn();
  const onSessionRequired = vi.fn();
  const onSessionChange = vi.fn();
  const onDone = vi.fn();
  const controller = new PageActionController({
    selection: { kind, page: before },
    session,
    sessionBlocked: options.blocked ?? false,
    attempt: options.attempt ?? null,
    request: api,
    onAttemptChange,
    onSessionRequired,
    onSessionChange,
    onDone,
  });
  if (!options.attempt && kind === "move") controller.editPath("new/path");
  return {
    controller,
    calls,
    answers,
    before,
    onAttemptChange,
    onSessionRequired,
    onSessionChange,
    onDone,
  };
}
function submittedBody(test: ReturnType<typeof setup>, index = 0) {
  return JSON.parse(String(test.calls[index]?.init?.body));
}

describe("page action observations", () => {
  it.each(["move", "delete", "restore", "unpublish"] as const)(
    "classifies exact %s completion and unchanged state",
    (kind) => {
      const before = initial(kind);
      const attempt = createPageActionAttempt(
        { kind, page: before },
        "new/path",
      );
      expect(classifyPageAction(attempt, before)).toBe("unchanged");
      expect(classifyPageAction(attempt, desired(kind, before))).toBe(
        "desired",
      );
      expect(
        classifyPageAction(attempt, {
          ...desired(kind, before),
          version: before.version + 2,
        }),
      ).toBe("changed");
      expect(
        classifyPageAction(attempt, {
          ...desired(kind, before),
          draftRevisionId: "different-draft",
        }),
      ).toBe("changed");
    },
  );
  it("does not mistake an active private page or republished restore for the requested outcome", () => {
    const removed = createPageActionAttempt(
      { kind: "delete", page: page() },
      "",
    );
    expect(classifyPageAction(removed, desired("unpublish"))).toBe("changed");
    const restore = createPageActionAttempt(
      { kind: "restore", page: initial("restore") },
      "",
    );
    expect(
      classifyPageAction(restore, page({ version: 6, updatedAt: nextTime })),
    ).toBe("changed");
    const moved = createPageActionAttempt(
      { kind: "move", page: page() },
      "new/path",
    );
    expect(classifyPageAction(moved, desired("delete"))).toBe("changed");
    expect(
      classifyPageAction(moved, {
        ...desired("move"),
        publishedRevisionId: null,
        publishedAt: null,
      }),
    ).toBe("changed");
  });
  it.each([
    { id: "another-page" },
    { language: "zh" },
    { pageId: "another-group" },
    { version: Number.NaN },
    { version: "6" },
    { path: "../bad" },
    { publishedRevisionId: null },
    { createdAt: "not-a-date" },
    { deletedAt: timestamp },
  ])("rejects malformed or mismatched translation metadata %j", (invalid) => {
    expect(() =>
      readPageSummary(detail(page(invalid as Partial<PageSummary>)), page()),
    ).toThrow(PageActionReadError);
  });
  it("uses the owned draft and original translation snapshot rather than related rows", () => {
    expect(readPageSummary(detail(), page())).toEqual(page());
    const value = detail();
    value.draft.translationId = "other-owner";
    expect(() => readPageSummary(value, page())).toThrow(PageActionReadError);
  });
  it("defensively retains the exact attempted selection and path", () => {
    const before = page();
    const attempt = createPageActionAttempt(
      { kind: "move", page: before },
      "new/path",
    );
    before.path = "edited/later";
    before.tags.push("later");
    expect(attempt.selection.page.path).toBe("guide/start");
    expect(attempt.selection.page.tags).toEqual(["fixture"]);
    expect(attempt.destination).toBe("new/path");
  });
  it("requires active move/delete, published unpublish and deleted restore states", () => {
    const deleted = initial("restore");
    expect(pageActionEligible("move", deleted)).toBe(false);
    expect(pageActionEligible("delete", deleted)).toBe(false);
    expect(pageActionEligible("restore", page())).toBe(false);
    expect(
      pageActionEligible(
        "unpublish",
        page({ publishedRevisionId: null, publishedAt: null }),
      ),
    ).toBe(false);
    expect(pageActionEligible("restore", deleted)).toBe(true);
  });
});

describe("page action request and recovery lifecycle", () => {
  it.each(["move", "delete", "restore", "unpublish"] as const)(
    "dispatches one %s with exact version and CSRF, then clears the retained attempt",
    async (kind) => {
      const test = setup({ kind, answers: [{ translation: desired(kind) }] });
      await test.controller.submit();
      expect(test.calls).toHaveLength(1);
      expect(test.calls[0]?.path).toBe(
        kind === "delete" ? "pages/page-fixture" : `pages/page-fixture/${kind}`,
      );
      expect(test.calls[0]?.init?.method).toBe(
        kind === "delete" ? "DELETE" : "POST",
      );
      expect(
        new Headers(test.calls[0]?.init?.headers).get("X-CSRF-Token"),
      ).toBe(session.csrfToken);
      expect(submittedBody(test)).toEqual({
        expectedVersion: 5,
        ...(kind === "move" ? { path: "new/path" } : {}),
      });
      expect(test.onAttemptChange.mock.calls[0]?.[0]).toMatchObject({
        selection: { kind, page: { id: test.before.id, version: 5 } },
      });
      expect(test.onAttemptChange).toHaveBeenLastCalledWith(null);
      expect(test.onDone).toHaveBeenCalledExactlyOnceWith(kind);
    },
  );
  it.each([
    new TypeError("Network failed"),
    new ApiError(500),
    new ApiError(503),
  ])(
    "retains an uncertain attempt and prevents replay for %s",
    async (error) => {
      const test = setup({ answers: [error] });
      await test.controller.submit();
      test.controller.editPath("edited/path");
      await test.controller.submit();
      expect(test.calls).toHaveLength(1);
      expect(test.controller.state.attempt?.destination).toBe("new/path");
      expect(test.controller.state.path).toBe("edited/path");
      expect(test.controller.canSubmit).toBe(false);
      expect(test.onDone).not.toHaveBeenCalled();
    },
  );
  it("treats a malformed successful response as uncertain", async () => {
    const test = setup({
      answers: [{ translation: desired("move", page({ id: "another-id" })) }],
    });
    await test.controller.submit();
    expect(test.controller.state.attempt).not.toBeNull();
    expect(test.controller.state.failure).toBeInstanceOf(PageActionReadError);
    expect(test.onDone).not.toHaveBeenCalled();
  });
  it.each([400, 409, 429])(
    "clears an attempted write on known rejection %i",
    async (status) => {
      const test = setup({ answers: [new ApiError(status)] });
      await test.controller.submit();
      expect(test.controller.state.attempt).toBeNull();
      expect(test.controller.state.path).toBe("new/path");
      expect(test.controller.canSubmit).toBe(true);
    },
  );
  it.each([401, 403])(
    "latches auth after %i until verified session and fresh state adoption",
    async (status) => {
      const freshSession = { ...session, csrfToken: "b".repeat(64) };
      const test = setup({
        answers: [
          new ApiError(status),
          new ApiError(503),
          { session: freshSession },
          detail(),
        ],
      });
      await test.controller.submit();
      expect(test.controller.state.attempt).toBeNull();
      expect(test.onSessionRequired).toHaveBeenCalledTimes(1);
      test.controller.context(session, false);
      await test.controller.submit();
      expect(test.calls).toHaveLength(1);
      await test.controller.reconnect();
      expect(test.controller.state.blocked).toBe(true);
      expect(test.controller.state.path).toBe("new/path");
      await test.controller.reconnect();
      expect(test.onSessionChange).toHaveBeenCalledExactlyOnceWith(
        freshSession,
      );
      expect(test.controller.state.blocked).toBe(false);
      expect(test.controller.canSubmit).toBe(false);
      await test.controller.inspect();
      expect(test.controller.canSubmit).toBe(false);
      test.controller.acknowledge();
      expect(test.controller.canSubmit).toBe(true);
      test.answers.push({ translation: desired("move") });
      await test.controller.submit();
      expect(
        new Headers(test.calls.at(-1)?.init?.headers).get("X-CSRF-Token"),
      ).toBe(freshSession.csrfToken);
    },
  );
  it("requires explicit adoption after 412 and preserves a typed destination", async () => {
    const latest = page({
      version: 6,
      title: "Latest title",
      draftRevisionId: "draft-three",
      revisionSeq: 3,
    });
    const test = setup({
      answers: [
        new ApiError(412),
        detail(latest),
        { translation: desired("move", latest) },
      ],
    });
    await test.controller.submit();
    expect(test.controller.state.attempt).toBeNull();
    await test.controller.inspect();
    await test.controller.submit();
    expect(test.calls).toHaveLength(2);
    expect(test.controller.state.page.version).toBe(5);
    test.controller.acknowledge();
    expect(test.controller.state.page.version).toBe(6);
    expect(test.controller.state.path).toBe("new/path");
    await test.controller.submit();
    expect(submittedBody(test, 2)).toEqual({
      expectedVersion: 6,
      path: "new/path",
    });
  });
  it.each(["desired", "unchanged", "changed"] as const)(
    "reads an ambiguous %s outcome without writing and waits for acknowledgement",
    async (outcome) => {
      const attempt = createPageActionAttempt(
        { kind: "move", page: page() },
        "new/path",
      );
      const observed =
        outcome === "desired"
          ? desired("move")
          : outcome === "unchanged"
            ? page()
            : page({ version: 8, path: "somewhere/else" });
      const test = setup({ attempt, answers: [detail(observed)] });
      await test.controller.submit();
      expect(test.calls).toEqual([]);
      await test.controller.inspect();
      expect(test.calls.map((call) => call.path)).toEqual([
        "pages/page-fixture",
      ]);
      expect(test.calls[0]?.init?.method).toBeUndefined();
      expect(test.controller.state.comparison?.outcome).toBe(outcome);
      expect(test.controller.state.attempt).toEqual(attempt);
      expect(test.onDone).not.toHaveBeenCalled();
      test.controller.acknowledge();
      expect(test.controller.state.attempt).toBeNull();
      expect(test.controller.state.page).toEqual(observed);
      expect(test.controller.state.path).toBe("new/path");
      expect(test.calls).toHaveLength(1);
      if (outcome === "desired")
        expect(test.onDone).toHaveBeenCalledExactlyOnceWith("move");
      else expect(test.onDone).not.toHaveBeenCalled();
    },
  );
  it.each([new ApiError(401), new ApiError(503), new TypeError("read failed")])(
    "invalidates a previous comparison when a fresh inspection fails: %s",
    async (error) => {
      const attempt = createPageActionAttempt(
        { kind: "move", page: page() },
        "new/path",
      );
      const test = setup({ attempt, answers: [detail(), error] });
      await test.controller.inspect();
      expect(test.controller.state.comparison).not.toBeNull();
      await test.controller.inspect();
      test.controller.acknowledge();
      expect(test.controller.state.comparison).toBeNull();
      expect(test.controller.state.attempt).toEqual(attempt);
      expect(test.controller.canSubmit).toBe(false);
    },
  );
  it("invalidates comparison on reconnect and rejects malformed session data", async () => {
    const attempt = createPageActionAttempt(
      { kind: "move", page: page() },
      "new/path",
    );
    const test = setup({
      attempt,
      answers: [detail(), { session: { ...session, csrfToken: "invalid" } }],
    });
    await test.controller.inspect();
    await test.controller.reconnect();
    test.controller.acknowledge();
    expect(test.controller.state.blocked).toBe(true);
    expect(test.controller.state.comparison).toBeNull();
    expect(test.controller.state.attempt).toEqual(attempt);
  });
  it("rechecks eligibility after adopting a now-unpublished page", async () => {
    const latest = desired("unpublish");
    const test = setup({
      kind: "unpublish",
      answers: [new ApiError(412), detail(latest)],
    });
    await test.controller.submit();
    await test.controller.inspect();
    test.controller.acknowledge();
    await test.controller.submit();
    expect(test.calls).toHaveLength(2);
    expect(test.controller.canSubmit).toBe(false);
  });
  it("prevents duplicate in-flight submissions and retains cancellation for explicit recovery", async () => {
    const test = setup({
      answers: [
        (init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ],
    });
    const pending = test.controller.submit();
    await test.controller.submit();
    expect(test.controller.state.busy).toBe(true);
    expect(test.calls).toHaveLength(1);
    test.controller.cancel();
    await pending;
    expect(test.controller.state.busy).toBe(false);
    expect(test.controller.state.attempt).not.toBeNull();
    expect(test.controller.canSubmit).toBe(false);
  });
  it("preserves the parent's exact attempt across disposal and reopening", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const test = setup({
      answers: [
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ],
    });
    const pending = test.controller.submit();
    const retained = test.onAttemptChange.mock
      .calls[0]?.[0] as PageActionAttempt;
    test.controller.dispose();
    resolve?.({ translation: desired("move") });
    await pending;
    expect(test.onDone).not.toHaveBeenCalled();
    expect(test.onAttemptChange).toHaveBeenCalledTimes(1);
    const reopened = setup({
      attempt: retained,
      answers: [detail(desired("move"))],
    });
    expect(reopened.controller.state.path).toBe("new/path");
    expect(reopened.controller.canSubmit).toBe(false);
    await reopened.controller.inspect();
    reopened.controller.acknowledge();
    expect(reopened.onDone).toHaveBeenCalledExactlyOnceWith("move");
  });
  it("supports React's effect cleanup/setup cycle without discarding state", async () => {
    const test = setup({ answers: [{ translation: desired("move") }] });
    test.controller.dispose();
    test.controller.activate();
    await test.controller.submit();
    expect(test.onDone).toHaveBeenCalledExactlyOnceWith("move");
  });
  it.each(["api/private", "../path", "Mixed/Case", "", "guide/start"])(
    "does not dispatch invalid or unchanged move path %s",
    async (path) => {
      const test = setup();
      test.controller.editPath(path);
      await test.controller.submit();
      expect(test.calls).toEqual([]);
    },
  );
  it("does not dispatch when the parent session latch is set", async () => {
    const test = setup({ blocked: true });
    await test.controller.submit();
    await test.controller.inspect();
    expect(test.calls).toEqual([]);
  });
});
