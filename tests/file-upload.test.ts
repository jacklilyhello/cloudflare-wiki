import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../shared/auth";
import type { FileEntry, FilePage } from "../shared/files";
import { ApiError } from "../src/admin/api";
import type { PreparedBrowserFile } from "../src/admin/file-preparation";
import {
  FileUploadController,
  type UploadRequest,
  uploadHasUnsavedWork,
  uploadNeedsReviewBeforeClose,
} from "../src/admin/file-upload";

const id = "11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const session: AuthSession = {
  user: { id: 1, username: "admin", version: 1 },
  csrfToken: "test-only-csrf",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T08:00:00.000Z",
  idleExpiresAt: "2026-01-01T00:30:00.000Z",
};
function entry(values: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    parentId,
    name: "source.png",
    kind: "file",
    version: 1,
    state: "pending",
    thumbnailState: "pending",
    alt: { zh: "", en: "" },
    source: null,
    thumbnail: null,
    uploadExpiresAt: "2026-01-01T00:15:00.000Z",
    publishedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...values,
  };
}
const source = { bytes: 3, mime: "image/png" as const, width: 1, height: 1 };
const sourceReady = () => entry({ state: "ready", version: 2, source });
const complete = () =>
  entry({
    state: "ready",
    version: 3,
    source,
    thumbnail: { ...source, bytes: 5 },
    thumbnailState: "ready",
  });
const page = (values: Partial<FilePage> = {}): FilePage => ({
  libraryVersion: 42,
  items: [],
  nextCursor: null,
  ...values,
});
function setup(answers: unknown[] = [], thumbnail = true) {
  const sourceFile = new File(["abc"], "source.png", { type: "image/png" });
  const thumbnailBlob = new Blob(["thumb"], { type: "image/png" });
  const prepared: PreparedBrowserFile = {
    source: {
      body: sourceFile,
      input: { bytes: 3, sha256: "a".repeat(64), mimeHint: "image/png" },
    },
    thumbnail: thumbnail
      ? {
          body: thumbnailBlob,
          input: { bytes: 5, sha256: "b".repeat(64), mimeHint: "image/png" },
        }
      : null,
    thumbnailOmitted: false,
  };
  const calls: { path: string; options?: RequestInit }[] = [];
  const api: UploadRequest = async <T>(
    path: string,
    options?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, options });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(options) as Promise<T>;
    if (answer === undefined) throw new Error("No mock response");
    return answer as T;
  };
  const onChanged = vi.fn();
  const onSessionChange = vi.fn();
  const onSessionRequired = vi.fn();
  const prepare = vi.fn(async () => prepared);
  const upload = new FileUploadController({
    parentId,
    session,
    request: api,
    prepare,
    onChanged,
    onSessionChange,
    onSessionRequired,
  });
  upload.edit({ file: sourceFile, name: sourceFile.name });
  return {
    upload,
    calls,
    answers,
    prepared,
    sourceFile,
    thumbnailBlob,
    prepare,
    onChanged,
    onSessionChange,
    onSessionRequired,
  };
}
function body(call: { options?: RequestInit } | undefined) {
  return JSON.parse(String(call?.options?.body)) as Record<string, unknown>;
}

describe("tab-owned file upload recovery", () => {
  it("reads a fresh library version, prepares once and sends sequential raw PUTs with returned versions", async () => {
    const test = setup([page(), entry(), sourceReady(), complete()]);
    await test.upload.start();
    expect(test.calls.map((call) => call.path)).toEqual([
      `files?parentId=${parentId}&limit=1`,
      "files/uploads",
      `files/${id}/upload/source`,
      `files/${id}/upload/thumbnail`,
    ]);
    expect(body(test.calls[1])).toEqual({
      expectedLibraryVersion: 42,
      parentId,
      name: "source.png",
      source: test.prepared.source.input,
      thumbnail: test.prepared.thumbnail?.input,
    });
    expect(test.calls[1]?.options?.headers).toMatchObject({
      "X-CSRF-Token": session.csrfToken,
    });
    expect(test.calls[2]?.options).toMatchObject({
      method: "PUT",
      body: test.sourceFile,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Version": "1",
        "X-CSRF-Token": session.csrfToken,
      },
    });
    expect(test.calls[3]?.options).toMatchObject({
      method: "PUT",
      body: test.thumbnailBlob,
      headers: { "X-File-Version": "2" },
    });
    expect(
      new Headers(test.calls[2]?.options?.headers).has("Content-Length"),
    ).toBe(false);
    expect(test.upload.state.phase).toBe("complete");
    expect(test.onChanged).toHaveBeenCalledTimes(3);
    expect(uploadHasUnsavedWork(test.upload.state)).toBe(false);
  });
  it("omits the optional thumbnail from prepare and makes only one PUT", async () => {
    const test = setup(
      [
        page(),
        entry({ thumbnailState: "none" }),
        entry({ state: "ready", version: 2, source, thumbnailState: "none" }),
      ],
      false,
    );
    await test.upload.start();
    expect(body(test.calls[1])).not.toHaveProperty("thumbnail");
    expect(test.calls).toHaveLength(3);
    expect(test.upload.state.phase).toBe("complete");
  });
  it("never replays an uncertain prepare and never adopts a matching folder entry", async () => {
    const test = setup([page(), new TypeError("network")]);
    await test.upload.start();
    await test.upload.start();
    expect(test.calls).toHaveLength(2);
    expect(test.upload.state).toMatchObject({
      recovery: "prepare",
      entry: null,
    });
    test.upload.acknowledgeFolder();
    expect(test.upload.state.recovery).toBe("prepare");
    test.answers.push(
      page({ items: [entry()], nextCursor: "next-page" }),
      page({ items: [], nextCursor: null }),
    );
    await test.upload.inspectFolder();
    expect(test.upload.state.folderReviewed).toBe(false);
    test.upload.acknowledgeFolder();
    expect(test.upload.state.recovery).toBe("prepare");
    await test.upload.inspectFolder(true);
    expect(test.calls.at(-1)?.path).toContain("cursor=next-page");
    expect(test.upload.state.folderReviewed).toBe(true);
    expect(test.upload.state.entry).toBeNull();
    test.upload.acknowledgeFolder();
    expect(test.upload.state.recovery).toBeNull();
    expect(
      test.calls.filter((call) => call.options?.method === "POST"),
    ).toHaveLength(1);
    expect(test.upload.state.file).toBe(test.sourceFile);
  });
  it("invalidates the complete-folder review when cursor pages see different library versions", async () => {
    const test = setup([
      page(),
      new ApiError(503),
      page({ nextCursor: "next" }),
      page({ libraryVersion: 43 }),
    ]);
    await test.upload.start();
    await test.upload.inspectFolder();
    await test.upload.inspectFolder(true);
    expect(test.upload.state).toMatchObject({
      recovery: "prepare",
      folderReviewed: false,
      folderReview: null,
      failure: expect.objectContaining({ status: 412 }),
    });
  });
  it("does not mistake a rejected prepare for an uncertain object upload", async () => {
    const test = setup([page(), new ApiError(412)]);
    await test.upload.start();
    expect(test.upload.state.recovery).toBeNull();
    expect(test.upload.state.entry).toBeNull();
    expect(test.calls).toHaveLength(2);
    expect(test.upload.state.file).toBe(test.sourceFile);
  });
  it.each([
    new ApiError(503),
    new ApiError(409),
    new ApiError(412),
    new TypeError("network"),
  ])(
    "requires explicit recovery after a source PUT failure (%s)",
    async (failure) => {
      const test = setup([page(), entry(), failure]);
      await test.upload.start();
      expect(test.upload.state.recovery).toBe("source");
      await test.upload.start();
      expect(test.calls).toHaveLength(3);
      test.answers.push(entry());
      await test.upload.refresh();
      expect(test.upload.state.recovery).toBe("source");
      expect(test.upload.canUploadThumbnail).toBe(false);
      expect(
        test.calls.filter((call) => call.options?.method === "PUT"),
      ).toHaveLength(1);
    },
  );
  it("reconciles an uncertain source explicitly and waits for a separate thumbnail action", async () => {
    const test = setup([
      page(),
      entry(),
      new ApiError(503),
      sourceReady(),
      complete(),
    ]);
    await test.upload.start();
    await test.upload.reconcile();
    expect(test.calls.at(-1)?.path).toBe(`files/${id}/reconcile/source`);
    expect(body(test.calls.at(-1))).toEqual({ expectedVersion: 1 });
    expect(test.upload.canUploadThumbnail).toBe(true);
    expect(test.calls).toHaveLength(4);
    await test.upload.uploadThumbnail();
    expect(test.calls.at(-1)?.options?.headers).toMatchObject({
      "X-File-Version": "2",
    });
    expect(test.upload.state.phase).toBe("complete");
  });
  it("does not PUT a thumbnail again after a lost response", async () => {
    const test = setup([
      page(),
      entry(),
      sourceReady(),
      new TypeError("network"),
      sourceReady(),
      complete(),
    ]);
    await test.upload.start();
    expect(test.upload.state.recovery).toBe("thumbnail");
    await test.upload.refresh();
    expect(test.upload.canUploadThumbnail).toBe(false);
    await test.upload.uploadThumbnail();
    expect(test.calls).toHaveLength(5);
    await test.upload.reconcile();
    expect(test.calls.at(-1)?.path).toBe(`files/${id}/reconcile/thumbnail`);
    expect(test.upload.state.phase).toBe("complete");
  });
  it("keeps the authentication block latched across a failed reconnect", async () => {
    const test = setup([
      page(),
      entry(),
      new ApiError(401),
      new ApiError(503),
      { session },
    ]);
    await test.upload.start();
    expect(test.upload.state.blocked).toBe(true);
    expect(test.onSessionRequired).toHaveBeenCalledOnce();
    await test.upload.reconnect();
    expect(test.upload.state.blocked).toBe(true);
    await test.upload.reconcile();
    await test.upload.abandon();
    expect(test.calls).toHaveLength(4);
    expect(test.upload.state.file).toBe(test.sourceFile);
    expect(test.upload.state.name).toBe("source.png");
    await test.upload.reconnect();
    expect(test.upload.state.blocked).toBe(false);
    expect(test.upload.state.recovery).toBe("source");
    expect(test.calls).toHaveLength(5);
    expect(test.onSessionChange).toHaveBeenCalledWith(session);
  });
  it("allows only abandonment when credentials rotate after preparation", async () => {
    const rotated = {
      ...session,
      user: { ...session.user, version: 2 },
      csrfToken: "new-test-csrf",
    };
    const test = setup([
      page(),
      entry(),
      new ApiError(403),
      { session: rotated },
      entry({ state: "abandoned", thumbnailState: "abandoned", version: 2 }),
    ]);
    await test.upload.start();
    await test.upload.reconnect();
    expect(test.upload.state.credentialsChanged).toBe(true);
    await test.upload.reconcile();
    await test.upload.start();
    expect(test.calls).toHaveLength(4);
    await test.upload.abandon();
    expect(test.calls.at(-1)?.path).toBe(`files/${id}/abandon`);
    expect(test.calls.at(-1)?.options?.headers).toMatchObject({
      "X-CSRF-Token": rotated.csrfToken,
    });
    test.upload.restart();
    expect(test.upload.state).toMatchObject({
      entry: null,
      phase: "select",
      credentialsChanged: false,
      name: "source.png",
    });
    expect(test.upload.state.file).toBe(test.sourceFile);
    expect(test.calls).toHaveLength(5);
  });
  it("does not restart after an uncertain abandon until current state confirms it", async () => {
    const test = setup([
      page(),
      entry(),
      new ApiError(503),
      new ApiError(503),
      entry({ state: "abandoned", thumbnailState: "abandoned", version: 2 }),
    ]);
    await test.upload.start();
    await test.upload.abandon();
    test.upload.restart();
    expect(test.upload.state.recovery).toBe("mutation");
    const callsBeforeComparison = test.calls.length;
    await test.upload.abandon();
    await test.upload.reconcile();
    expect(test.calls).toHaveLength(callsBeforeComparison);
    await test.upload.refresh();
    expect(test.upload.state.phase).toBe("abandoned");
    test.upload.restart();
    expect(test.upload.state.entry).toBeNull();
  });
  it("abandons only a pending thumbnail after source completion", async () => {
    const test = setup([
      page(),
      entry(),
      sourceReady(),
      new ApiError(503),
      entry({
        state: "ready",
        version: 3,
        source,
        thumbnailState: "abandoned",
      }),
    ]);
    await test.upload.start();
    await test.upload.abandon();
    expect(body(test.calls.at(-1))).toEqual({ expectedVersion: 2 });
    expect(test.upload.state.phase).toBe("complete");
    test.upload.restart();
    expect(test.upload.state.entry?.source).toEqual(source);
  });
  it("stops after a prepare response received despite cancellation, without a PUT", async () => {
    let resolve: (value: FileEntry) => void = () => {};
    const test = setup([
      page(),
      () =>
        new Promise<FileEntry>((done) => {
          resolve = done;
        }),
    ]);
    const running = test.upload.start();
    await vi.waitFor(() => expect(test.calls).toHaveLength(2));
    test.upload.cancel();
    resolve(entry());
    await running;
    expect(test.upload.state.entry?.id).toBe(id);
    expect(test.calls).toHaveLength(2);
    expect(test.upload.state.failure).toMatchObject({ name: "AbortError" });
  });
  it("treats cancellation while awaiting prepare as unknown and prevents double submission", async () => {
    const test = setup([
      page(),
      (options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("stop", "AbortError")),
          ),
        ),
    ]);
    const running = test.upload.start();
    await vi.waitFor(() => expect(test.calls).toHaveLength(2));
    await test.upload.start();
    test.upload.cancel();
    await running;
    expect(test.calls).toHaveLength(2);
    expect(test.upload.state.recovery).toBe("prepare");
    expect(uploadHasUnsavedWork(test.upload.state)).toBe(true);
  });
  it("does not apply a late response or begin another operation after dialog disposal", async () => {
    let resolve: (value: FileEntry) => void = () => {};
    const test = setup([
      page(),
      () =>
        new Promise<FileEntry>((done) => {
          resolve = done;
        }),
    ]);
    const update = vi.fn();
    test.upload.subscribe(update);
    const running = test.upload.start();
    await vi.waitFor(() => expect(test.calls).toHaveLength(2));
    test.upload.dispose();
    const updates = update.mock.calls.length;
    resolve(entry());
    await running;
    expect(update).toHaveBeenCalledTimes(updates);
    expect(test.onChanged).not.toHaveBeenCalled();
    expect(test.calls).toHaveLength(2);
    await test.upload.start();
    expect(test.calls).toHaveLength(2);
  });

  it("keeps the dialog open until uncertain prepare inspection is acknowledged", async () => {
    const test = setup([page(), new ApiError(503), page()]);
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(false);
    await test.upload.start();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(true);
    await test.upload.inspectFolder();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(true);
    test.upload.acknowledgeFolder();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(false);
    expect(uploadHasUnsavedWork(test.upload.state)).toBe(true);
  });
  it("keeps pending object recovery open until completion or known abandonment", async () => {
    const test = setup([
      page(),
      entry(),
      new ApiError(503),
      entry(),
      entry({ state: "abandoned", version: 2, thumbnailState: "abandoned" }),
    ]);
    await test.upload.start();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(true);
    await test.upload.refresh();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(true);
    await test.upload.abandon();
    expect(uploadNeedsReviewBeforeClose(test.upload.state)).toBe(false);
  });
  it("propagates authentication failure during unknown-prepare folder inspection", async () => {
    const test = setup([
      page(),
      new ApiError(503),
      new ApiError(403),
      new ApiError(503),
    ]);
    await test.upload.start();
    await test.upload.inspectFolder();
    expect(test.onSessionRequired).toHaveBeenCalledOnce();
    expect(test.upload.state.blocked).toBe(true);
    await test.upload.reconnect();
    expect(test.upload.state.blocked).toBe(true);
    expect(test.upload.state.recovery).toBe("prepare");
  });
  it.each([new ApiError(503), new ApiError(401), new TypeError("network")])(
    "discards a previous folder review after a later inspection fails (%s)",
    async (error) => {
      const test = setup([page(), new ApiError(503), page(), error]);
      await test.upload.start();
      await test.upload.inspectFolder();
      expect(test.upload.state.folderReviewed).toBe(true);
      await test.upload.inspectFolder();
      expect(test.upload.state.folderReviewed).toBe(false);
      expect(test.upload.state.folderReview).toBeNull();
      test.upload.acknowledgeFolder();
      expect(test.upload.state.recovery).toBe("prepare");
    },
  );
  it("requires a new folder inspection after reconnecting", async () => {
    const test = setup([page(), new ApiError(503), page(), { session }]);
    await test.upload.start();
    await test.upload.inspectFolder();
    expect(test.upload.state.folderReviewed).toBe(true);
    await test.upload.reconnect();
    expect(test.upload.state.folderReviewed).toBe(false);
    test.upload.acknowledgeFolder();
    expect(test.upload.state.recovery).toBe("prepare");
  });
  it.each([
    null,
    entry({ id: "unexpected" }),
    entry({ state: "ready" }),
    entry({ parentId: null }),
    entry({ version: 2 }),
  ])(
    "does not begin a PUT from a malformed prepare response (%s)",
    async (result) => {
      const test = setup([page(), result]);
      await test.upload.start();
      expect(test.upload.state).toMatchObject({
        entry: null,
        recovery: "prepare",
      });
      expect(test.calls).toHaveLength(2);
    },
  );
  it.each([
    sourceReady(),
    entry({ ...sourceReady(), id: parentId }),
    entry({ ...sourceReady(), version: 1 }),
    entry({ ...sourceReady(), source: { ...source, bytes: 4 } }),
  ])("does not advance an invalid source upload result", async (result) => {
    const malformed =
      result.id === id && result.version === 2 && result.source?.bytes === 3
        ? { ...result, source: undefined }
        : result;
    const test = setup([page(), entry(), malformed]);
    await test.upload.start();
    expect(test.upload.state.recovery).toBe("source");
    expect(test.calls).toHaveLength(3);
  });
});
