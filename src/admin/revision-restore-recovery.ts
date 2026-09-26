import type { AuthSession } from "../../shared/auth";
import {
  type AdminTranslation,
  CONTENT_LIMITS,
  type ContentRevision,
} from "../../shared/content";
import { ApiError, mutation, request } from "./api";
import {
  type PageActionRequest,
  readPageSession,
  readPageTranslation,
  uncertainPageAction,
} from "./page-action-recovery";

export class RevisionRestoreReadError extends Error {
  constructor() {
    super("The revision restore response could not be verified.");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  );
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function text(
  value: unknown,
  limit: number,
  required = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    value === value.trim() &&
    (!required || Boolean(value))
  );
}
function authFailure(error: unknown) {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

export function readRestoreRevision(
  value: unknown,
  expectedTranslationId: string,
  expectedRevisionId?: string,
): ContentRevision {
  if (
    !record(value) ||
    !id(value.id) ||
    (expectedRevisionId !== undefined && value.id !== expectedRevisionId) ||
    !id(value.translationId) ||
    value.translationId !== expectedTranslationId ||
    !positive(value.revisionNo) ||
    !text(value.title, CONTENT_LIMITS.title, true) ||
    !text(value.description, CONTENT_LIMITS.description) ||
    typeof value.markdown !== "string" ||
    // Match the shared renderer without importing its server rendering pipeline.
    value.markdown.length > 128_000 ||
    new TextEncoder().encode(value.markdown).byteLength > 128_000 ||
    !Array.isArray(value.tags) ||
    value.tags.length > CONTENT_LIMITS.tags ||
    value.tags.some((tag) => !text(tag, CONTENT_LIMITS.tag, true)) ||
    new Set(value.tags).size !== value.tags.length ||
    !text(value.changeNote, CONTENT_LIMITS.changeNote) ||
    !(
      value.restoredFromRevisionId === null || id(value.restoredFromRevisionId)
    ) ||
    value.restoredFromRevisionId === value.id ||
    !date(value.createdAt)
  )
    throw new RevisionRestoreReadError();
  return {
    id: value.id,
    translationId: value.translationId,
    revisionNo: value.revisionNo,
    title: value.title,
    description: value.description,
    markdown: value.markdown,
    tags: [...value.tags] as string[],
    changeNote: value.changeNote,
    restoredFromRevisionId: value.restoredFromRevisionId,
    createdAt: value.createdAt,
  };
}

export function readRestoreSnapshot(value: unknown, before: AdminTranslation) {
  if (!record(value)) throw new RevisionRestoreReadError();
  const page = readPageTranslation(value.translation, before);
  const draft = readRestoreRevision(
    value.draft,
    page.id,
    page.draftRevisionId ?? "",
  );
  if (draft.revisionNo !== page.revisionSeq)
    throw new RevisionRestoreReadError();
  // Related translations and publication content are separate, later reads.
  return { page, draft };
}

export interface RestoreAttempt {
  source: ContentRevision;
  before: AdminTranslation;
  note: string;
}
export interface RestoreComparison {
  page: AdminTranslation;
  draft: ContentRevision;
  outcome: "desired" | "unchanged" | "changed" | null;
}
export interface RevisionRestoreState {
  source: ContentRevision;
  before: AdminTranslation;
  note: string;
  busy: boolean;
  blocked: boolean;
  attempt: RestoreAttempt | null;
  needsReview: boolean;
  comparison: RestoreComparison | null;
  failure: unknown;
  notice: "session" | "adopted" | null;
}
export interface RevisionRestoreOptions {
  source: ContentRevision;
  before: AdminTranslation;
  session: AuthSession;
  sessionBlocked: boolean;
  request?: PageActionRequest;
  onSessionRequired(): void;
  onSessionChange(session: AuthSession): void;
  onDone(outcome: "verified" | "observed"): void;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function desiredPage(attempt: RestoreAttempt, page: AdminTranslation) {
  const { before, source } = attempt;
  return (
    Number.isSafeInteger(before.version + 1) &&
    Number.isSafeInteger(before.revisionSeq + 1) &&
    page.version === before.version + 1 &&
    page.revisionSeq === before.revisionSeq + 1 &&
    page.createdAt === before.createdAt &&
    page.path === before.path &&
    page.deletedAt === null &&
    before.deletedAt === null &&
    page.publishedRevisionId === before.publishedRevisionId &&
    page.publishedAt === before.publishedAt &&
    page.draftRevisionId !== before.draftRevisionId &&
    page.draftRevisionId !== source.id
  );
}
function classify(
  attempt: RestoreAttempt,
  page: AdminTranslation,
  draft: ContentRevision,
) {
  if (same(page, attempt.before)) return "unchanged" as const;
  const source = attempt.source;
  return desiredPage(attempt, page) &&
    draft.createdAt === page.updatedAt &&
    draft.revisionNo === page.revisionSeq &&
    draft.restoredFromRevisionId === source.id &&
    draft.title === source.title &&
    draft.description === source.description &&
    draft.markdown === source.markdown &&
    same(draft.tags, source.tags) &&
    draft.changeNote === attempt.note.trim()
    ? ("desired" as const)
    : ("changed" as const);
}

export class RevisionRestoreController {
  state: RevisionRestoreState;
  private session: AuthSession;
  private readonly api: PageActionRequest;
  private operation: AbortController | null = null;
  private disposed = false;
  private completed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly options: RevisionRestoreOptions) {
    if (options.before.language !== "zh" && options.before.language !== "en")
      throw new RevisionRestoreReadError();
    const before = readPageTranslation(options.before, options.before);
    const source = readRestoreRevision(options.source, before.id);
    if (source.revisionNo > before.revisionSeq)
      throw new RevisionRestoreReadError();
    this.session = readPageSession({ session: options.session });
    this.api = options.request ?? request;
    this.state = {
      source,
      before,
      note: "",
      busy: false,
      blocked: options.sessionBlocked,
      attempt: null,
      needsReview: options.sessionBlocked,
      comparison: null,
      failure: null,
      notice: null,
    };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private patch(update: Partial<RevisionRestoreState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  context(session: AuthSession, blocked: boolean) {
    const changed = this.session.csrfToken !== session.csrfToken;
    this.session = readPageSession({ session });
    if (blocked || changed) {
      this.cancel();
      this.patch({
        ...(blocked ? { blocked: true } : {}),
        needsReview: true,
        comparison: null,
        notice: null,
      });
    }
  }
  editNote(note: string) {
    if (!this.state.busy && !this.completed) this.patch({ note, notice: null });
  }
  get canSubmit() {
    const { before, source, note } = this.state;
    return (
      !this.disposed &&
      !this.completed &&
      !this.state.busy &&
      !this.state.blocked &&
      !this.state.attempt &&
      !this.state.needsReview &&
      before.deletedAt === null &&
      before.draftRevisionId !== source.id &&
      source.revisionNo <= before.revisionSeq &&
      Number.isSafeInteger(before.version + 1) &&
      Number.isSafeInteger(before.revisionSeq + 1) &&
      note.length <= CONTENT_LIMITS.changeNote
    );
  }
  private active(operation: AbortController) {
    return (
      this.operation === operation &&
      !operation.signal.aborted &&
      !this.disposed
    );
  }
  private fail(error: unknown) {
    this.patch({ failure: error, comparison: null, needsReview: true });
    if (authFailure(error)) {
      this.patch({ blocked: true });
      this.options.onSessionRequired();
    }
  }
  private async run(kind: "submit" | "inspect" | "reconnect") {
    if (
      this.operation ||
      this.disposed ||
      this.completed ||
      (kind === "submit" && !this.canSubmit) ||
      (kind === "inspect" && this.state.blocked)
    )
      return;
    const operation = new AbortController();
    this.operation = operation;
    this.patch({
      busy: true,
      failure: null,
      notice: null,
      comparison: null,
      ...(kind !== "submit" ? { needsReview: true } : {}),
      ...(kind === "reconnect" ? { blocked: true } : {}),
    });
    let submitted: RestoreAttempt | null = null;
    let postResponded = false;
    try {
      if (kind === "reconnect") {
        const session = readPageSession(
          await this.api("session", { signal: operation.signal }),
        );
        if (!this.active(operation)) return;
        this.session = session;
        this.patch({ blocked: false, notice: "session" });
        this.options.onSessionChange(session);
      } else if (kind === "inspect") {
        const path = `pages/${encodeURIComponent(this.state.before.id)}`;
        const first = readRestoreSnapshot(
          await this.api(path, { signal: operation.signal }),
          this.state.before,
        );
        if (!this.active(operation)) return;
        const second = readRestoreSnapshot(
          await this.api(path, { signal: operation.signal }),
          this.state.before,
        );
        if (!this.active(operation)) return;
        if (!same(first, second)) throw new RevisionRestoreReadError();
        this.patch({
          comparison: {
            ...second,
            outcome: this.state.attempt
              ? classify(this.state.attempt, second.page, second.draft)
              : null,
          },
        });
      } else {
        submitted = {
          source: { ...this.state.source, tags: [...this.state.source.tags] },
          before: { ...this.state.before },
          note: this.state.note,
        };
        this.patch({ attempt: submitted });
        const base = `pages/${encodeURIComponent(submitted.before.id)}/revisions`;
        const response = await this.api<unknown>(
          `${base}/${encodeURIComponent(submitted.source.id)}/restore`,
          {
            ...mutation(
              "POST",
              {
                expectedVersion: submitted.before.version,
                changeNote: submitted.note,
              },
              this.session.csrfToken,
            ),
            signal: operation.signal,
          },
        );
        postResponded = true;
        if (!this.active(operation)) return;
        if (!record(response)) throw new RevisionRestoreReadError();
        const page = readPageTranslation(
          response.translation,
          submitted.before,
        );
        if (!desiredPage(submitted, page)) throw new RevisionRestoreReadError();
        const result = await this.api<unknown>(
          `${base}/${encodeURIComponent(page.draftRevisionId ?? "")}`,
          { signal: operation.signal },
        );
        if (!this.active(operation)) return;
        if (!record(result)) throw new RevisionRestoreReadError();
        const draft = readRestoreRevision(
          result.revision,
          page.id,
          page.draftRevisionId ?? "",
        );
        if (classify(submitted, page, draft) !== "desired")
          throw new RevisionRestoreReadError();
        this.completed = true;
        this.patch({ attempt: null, before: page, needsReview: false });
        this.options.onDone("verified");
      }
    } catch (error) {
      if (!this.active(operation)) return;
      // A rejected verification GET cannot undo an already successful POST.
      if (
        kind === "submit" &&
        submitted &&
        !postResponded &&
        !uncertainPageAction(error)
      )
        this.patch({ attempt: null });
      this.fail(error);
    } finally {
      if (this.operation === operation) {
        this.operation = null;
        this.patch({ busy: false });
      }
    }
  }
  submit() {
    return this.run("submit");
  }
  inspect() {
    return this.run("inspect");
  }
  reconnect() {
    return this.run("reconnect");
  }
  acknowledge() {
    const comparison = this.state.comparison;
    if (
      !comparison ||
      this.disposed ||
      this.completed ||
      this.state.busy ||
      this.state.blocked
    )
      return;
    if (comparison.outcome === "desired") this.completed = true;
    this.patch({
      before: comparison.page,
      attempt: null,
      comparison: null,
      needsReview: false,
      failure: null,
      notice: "adopted",
    });
    if (comparison.outcome === "desired") this.options.onDone("observed");
  }
  cancel() {
    const operation = this.operation;
    if (!operation) return;
    this.operation = null;
    operation.abort();
    this.patch({
      busy: false,
      comparison: null,
      needsReview: true,
      failure: new RevisionRestoreReadError(),
      notice: null,
    });
  }
  activate() {
    this.disposed = false;
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.disposed = true;
    const operation = this.operation;
    this.operation = null;
    operation?.abort();
    this.state = {
      ...this.state,
      busy: false,
      ...(operation
        ? {
            comparison: null,
            needsReview: true,
            failure: new RevisionRestoreReadError(),
            notice: null,
          }
        : {}),
    };
    this.listeners.clear();
  }
}
