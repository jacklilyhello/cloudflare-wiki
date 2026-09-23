import type { AuthSession } from "../../shared/auth";
import type { FileEntry, FilePage, FileRole } from "../../shared/files";
import { ApiError, mutation, request } from "./api";
import {
  checkFileAbort,
  type PreparationPhase,
  type PreparedBrowserFile,
  prepareBrowserFile,
} from "./file-preparation";

export type UploadPhase =
  | "select"
  | PreparationPhase
  | "preparing"
  | "source"
  | "upload-thumbnail"
  | "refreshing"
  | "reconciling"
  | "abandoning"
  | "reconnecting"
  | "ready"
  | "complete"
  | "recovery"
  | "abandoned";
export type UploadRecovery = "prepare" | FileRole | "mutation" | null;
export interface FileUploadState {
  file: File | null;
  name: string;
  wantThumbnail: boolean;
  phase: UploadPhase;
  busy: boolean;
  entry: FileEntry | null;
  recovery: UploadRecovery;
  blocked: boolean;
  credentialsChanged: boolean;
  failure: unknown;
  thumbnailOmitted: boolean;
  folderReview: FilePage | null;
  folderReviewed: boolean;
}
export type UploadRequest = <T>(
  path: string,
  options?: RequestInit,
) => Promise<T>;
interface UploadOptions {
  parentId: string | null;
  session: AuthSession;
  onChanged(): void;
  onSessionChange(session: AuthSession): void;
  onSessionRequired?(): void;
  request?: UploadRequest;
  prepare?: typeof prepareBrowserFile;
}
function filePath(id: string) {
  return `files/${encodeURIComponent(id)}`;
}
export function uploadRole(entry: FileEntry): FileRole | null {
  if (entry.deletedAt || entry.publishedAt || entry.state === "abandoned")
    return null;
  if (entry.state === "pending") return "source";
  return entry.thumbnailState === "pending" ? "thumbnail" : null;
}
export function uploadHasUnsavedWork(state: FileUploadState): boolean {
  return (
    state.busy ||
    state.recovery !== null ||
    (state.phase !== "complete" &&
      state.phase !== "abandoned" &&
      Boolean(state.file || state.name || state.entry))
  );
}
export function uploadNeedsReviewBeforeClose(state: FileUploadState): boolean {
  return (
    state.busy ||
    state.recovery !== null ||
    Boolean(state.entry && uploadRole(state.entry))
  );
}
function idlePhase(
  entry: FileEntry | null,
  recovery: UploadRecovery,
): UploadPhase {
  if (recovery || entry?.state === "pending") return "recovery";
  if (!entry) return "select";
  if (entry.state === "abandoned") return "abandoned";
  return uploadRole(entry) ? "ready" : "complete";
}
function checkedEntry(value: FileEntry, previous?: FileEntry): FileEntry {
  if (
    value?.kind !== "file" ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !["pending", "ready", "abandoned"].includes(value.state) ||
    !["none", "pending", "ready", "abandoned"].includes(value.thumbnailState) ||
    typeof value.name !== "string" ||
    (previous && (value.id !== previous.id || value.version < previous.version))
  )
    throw new Error("Invalid file response");
  return value;
}
export function uploadBodyOptions(
  body: Blob,
  version: number,
  csrfToken: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "PUT",
    signal,
    body,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-CSRF-Token": csrfToken,
      "X-File-Version": String(version),
    },
  };
}

// One tab-owned operation. There is deliberately no persistence, automatic
// retry, object replacement, deletion or automatic adoption after a lost POST.
export class FileUploadController {
  state: FileUploadState = {
    file: null,
    name: "",
    wantThumbnail: true,
    phase: "select",
    busy: false,
    entry: null,
    recovery: null,
    blocked: false,
    credentialsChanged: false,
    failure: null,
    thumbnailOmitted: false,
    folderReview: null,
    folderReviewed: false,
  };
  private session: AuthSession;
  private readonly api: UploadRequest;
  private readonly prepare: typeof prepareBrowserFile;
  private prepared: PreparedBrowserFile | null = null;
  private preparedAuthVersion: number | null = null;
  private attempted = new Set<FileRole>();
  private operation: AbortController | null = null;
  private writeContext: UploadRecovery = null;
  private disposed = false;
  private listener: ((state: FileUploadState) => void) | null = null;
  constructor(private readonly options: UploadOptions) {
    this.session = options.session;
    this.api = options.request ?? request;
    this.prepare = options.prepare ?? prepareBrowserFile;
  }
  subscribe(listener: (state: FileUploadState) => void) {
    this.listener = listener;
    listener(this.state);
    return () => {
      this.listener = null;
    };
  }
  private patch(update: Partial<FileUploadState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.listener?.(this.state);
  }
  edit(
    values: Partial<Pick<FileUploadState, "file" | "name" | "wantThumbnail">>,
  ) {
    if (this.state.busy || this.state.entry || this.state.recovery) return;
    this.prepared = null;
    this.patch({ ...values, failure: null, thumbnailOmitted: false });
  }
  cancel() {
    this.operation?.abort();
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    this.prepared = null;
    this.listener = null;
  }
  private folderPath(cursor?: string, limit = 25) {
    const query = new URLSearchParams({
      parentId: this.options.parentId ?? "",
      limit: String(limit),
    });
    if (cursor) query.set("cursor", cursor);
    return `files?${query}`;
  }
  private changed() {
    if (!this.disposed) this.options.onChanged();
  }
  private acceptEntry(entry: FileEntry) {
    const role = uploadRole(entry);
    this.patch({
      entry,
      recovery: role && this.attempted.has(role) ? role : null,
      phase:
        entry.state === "abandoned"
          ? "abandoned"
          : !role
            ? "complete"
            : role === "thumbnail" && !this.attempted.has(role)
              ? "ready"
              : "recovery",
    });
  }
  private async run(
    phase: UploadPhase,
    operation: (signal: AbortSignal) => Promise<void>,
    allowBlocked = false,
  ) {
    if (
      this.operation ||
      this.disposed ||
      (this.state.blocked && !allowBlocked)
    )
      return;
    const controller = new AbortController();
    this.operation = controller;
    this.writeContext = null;
    this.patch({ busy: true, failure: null, phase });
    try {
      await operation(controller.signal);
    } catch (error) {
      const blocked =
        error instanceof ApiError && [401, 403].includes(error.status);
      if (blocked && !this.disposed) this.options.onSessionRequired?.();
      const knownPrepareRejection =
        this.writeContext === "prepare" &&
        error instanceof ApiError &&
        error.status < 500;
      const recovery = knownPrepareRejection
        ? null
        : (this.writeContext ?? this.state.recovery);
      this.patch({
        failure: error,
        blocked: this.state.blocked || blocked,
        recovery,
        phase: idlePhase(this.state.entry, recovery),
        ...(blocked && recovery === "prepare"
          ? { folderReview: null, folderReviewed: false }
          : {}),
      });
    } finally {
      this.operation = null;
      this.writeContext = null;
      this.patch({ busy: false });
    }
  }
  private async put(role: FileRole, signal: AbortSignal) {
    const entry = this.state.entry;
    const object =
      role === "source" ? this.prepared?.source : this.prepared?.thumbnail;
    if (!entry || !object || this.attempted.has(role))
      throw new Error("Upload unavailable");
    checkFileAbort(signal);
    this.writeContext = role;
    this.attempted.add(role);
    this.patch({ phase: role === "source" ? "source" : "upload-thumbnail" });
    const result = await this.api<FileEntry>(
      `${filePath(entry.id)}/upload/${role}`,
      uploadBodyOptions(
        object.body,
        entry.version,
        this.session.csrfToken,
        signal,
      ),
    );
    checkedEntry(result, entry);
    const stored = role === "source" ? result.source : result.thumbnail;
    if (
      result.state !== "ready" ||
      result.version !== entry.version + 1 ||
      !stored ||
      stored.bytes !== object.input.bytes ||
      stored.mime !== object.input.mimeHint ||
      (role === "thumbnail" && result.thumbnailState !== "ready")
    )
      throw new Error("Invalid upload result");
    this.writeContext = null;
    this.acceptEntry(result);
    this.changed();
    checkFileAbort(signal);
  }
  async start() {
    const { file, name, wantThumbnail, entry, recovery } = this.state;
    if (!file || !name.trim() || entry || recovery) return;
    await this.run("checking", async (signal) => {
      this.prepared = await this.prepare(file, {
        thumbnail: wantThumbnail,
        signal,
        onPhase: (phase) => this.patch({ phase }),
      });
      checkFileAbort(signal);
      this.patch({ thumbnailOmitted: this.prepared.thumbnailOmitted });
      const page = await this.api<FilePage>(this.folderPath(undefined, 1), {
        signal,
      });
      checkFileAbort(signal);
      this.patch({ phase: "preparing" });
      this.writeContext = "prepare";
      const result = await this.api<FileEntry>("files/uploads", {
        ...mutation(
          "POST",
          {
            expectedLibraryVersion: page.libraryVersion,
            parentId: this.options.parentId,
            name: name.trim(),
            source: this.prepared.source.input,
            ...(this.prepared.thumbnail
              ? { thumbnail: this.prepared.thumbnail.input }
              : {}),
          },
          this.session.csrfToken,
        ),
        signal,
      });
      checkedEntry(result);
      if (
        result.parentId !== this.options.parentId ||
        result.state !== "pending" ||
        result.version !== 1 ||
        result.source !== null ||
        result.thumbnailState !== (this.prepared.thumbnail ? "pending" : "none")
      )
        throw new Error("Invalid prepare result");
      this.writeContext = null;
      this.preparedAuthVersion = this.session.user.version;
      this.patch({ entry: result });
      this.changed();
      checkFileAbort(signal);
      await this.put("source", signal);
      if (
        this.prepared.thumbnail &&
        this.state.entry?.thumbnailState === "pending"
      )
        await this.put("thumbnail", signal);
    });
  }
  async refresh() {
    const entry = this.state.entry;
    if (!entry) return;
    await this.run("refreshing", async (signal) => {
      const latest = await this.api<FileEntry>(filePath(entry.id), { signal });
      checkFileAbort(signal);
      checkedEntry(latest, entry);
      this.acceptEntry(latest);
      this.changed();
    });
  }
  async reconcile() {
    const entry = this.state.entry;
    const role = entry && uploadRole(entry);
    if (
      !entry ||
      !role ||
      this.state.credentialsChanged ||
      this.state.recovery === "mutation"
    )
      return;
    await this.run("reconciling", async (signal) => {
      this.writeContext = role;
      const result = await this.api<FileEntry>(
        `${filePath(entry.id)}/reconcile/${role}`,
        {
          ...mutation(
            "POST",
            { expectedVersion: entry.version },
            this.session.csrfToken,
          ),
          signal,
        },
      );
      checkedEntry(result, entry);
      if (
        result.state !== "ready" ||
        (role === "source"
          ? result.source === null
          : result.thumbnailState !== "ready" || result.thumbnail === null)
      )
        throw new Error("Invalid reconciliation result");
      this.writeContext = null;
      this.acceptEntry(result);
      this.changed();
    });
  }
  get canUploadThumbnail() {
    return Boolean(
      this.state.entry &&
        uploadRole(this.state.entry) === "thumbnail" &&
        this.prepared?.thumbnail &&
        !this.attempted.has("thumbnail") &&
        !this.state.credentialsChanged &&
        !this.state.recovery,
    );
  }
  async uploadThumbnail() {
    if (!this.canUploadThumbnail) return;
    await this.run("upload-thumbnail", (signal) =>
      this.put("thumbnail", signal),
    );
  }
  async abandon() {
    const entry = this.state.entry;
    if (!entry || !uploadRole(entry) || this.state.recovery === "mutation")
      return;
    await this.run("abandoning", async (signal) => {
      this.writeContext = "mutation";
      const result = await this.api<FileEntry>(
        `${filePath(entry.id)}/abandon`,
        {
          ...mutation(
            "POST",
            { expectedVersion: entry.version },
            this.session.csrfToken,
          ),
          signal,
        },
      );
      checkedEntry(result, entry);
      if (
        entry.state === "pending"
          ? result.state !== "abandoned"
          : result.state !== "ready" || result.thumbnailState !== "abandoned"
      )
        throw new Error("Invalid abandonment result");
      this.writeContext = null;
      this.acceptEntry(result);
      this.prepared = null;
      this.changed();
    });
  }
  restart() {
    if (
      this.state.busy ||
      this.state.recovery ||
      this.state.entry?.state !== "abandoned"
    )
      return;
    this.prepared = null;
    this.preparedAuthVersion = null;
    this.attempted.clear();
    this.patch({
      entry: null,
      phase: "select",
      credentialsChanged: false,
      failure: null,
    });
  }
  async inspectFolder(more = false) {
    if (this.state.entry || this.state.recovery !== "prepare") return;
    const previous = more ? this.state.folderReview : null;
    if (more && !previous?.nextCursor) return;
    await this.run("refreshing", async (signal) => {
      if (!more) this.patch({ folderReview: null, folderReviewed: false });
      try {
        const page = await this.api<FilePage>(
          this.folderPath(previous?.nextCursor ?? undefined),
          { signal },
        );
        checkFileAbort(signal);
        if (previous && previous.libraryVersion !== page.libraryVersion)
          throw new ApiError(412);
        this.patch({
          folderReview: previous
            ? { ...page, items: [...previous.items, ...page.items] }
            : page,
          folderReviewed: !page.nextCursor,
          phase: "recovery",
        });
        this.changed();
      } catch (error) {
        this.patch({ folderReview: null, folderReviewed: false });
        throw error;
      }
    });
  }
  acknowledgeFolder() {
    if (
      this.state.busy ||
      !this.state.folderReviewed ||
      this.state.recovery !== "prepare" ||
      this.state.entry
    )
      return;
    this.prepared = null;
    this.attempted.clear();
    this.patch({
      recovery: null,
      folderReview: null,
      folderReviewed: false,
      phase: "select",
      failure: null,
    });
  }
  async reconnect() {
    await this.run(
      "reconnecting",
      async (signal) => {
        if (this.state.recovery === "prepare")
          this.patch({ folderReview: null, folderReviewed: false });
        const result = await this.api<{ session: AuthSession }>("session", {
          signal,
        });
        checkFileAbort(signal);
        this.session = result.session;
        this.patch({
          blocked: false,
          credentialsChanged:
            this.preparedAuthVersion !== null &&
            this.preparedAuthVersion !== result.session.user.version,
          phase: idlePhase(this.state.entry, this.state.recovery),
        });
        this.options.onSessionChange(result.session);
      },
      true,
    );
  }
}
