import type { AuthSession } from "../../shared/auth";
import type { AdminTranslation, PageSummary } from "../../shared/content";
import { isContentPath } from "../../shared/page-path";
import { ApiError, mutation, request } from "./api";

export type PageAction = "move" | "delete" | "restore" | "unpublish";
export interface PageActionSelection {
  kind: PageAction;
  page: PageSummary;
}
export interface PageActionAttempt {
  selection: PageActionSelection;
  destination: string | null;
}
export type PageActionOutcome = "desired" | "unchanged" | "changed";
export type PageActionRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>;

export class PageActionReadError extends Error {
  constructor() {
    super("The page response could not be verified.");
  }
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function id(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function readPageTranslation(
  value: unknown,
  before: AdminTranslation,
): AdminTranslation {
  if (
    !record(value) ||
    value.id !== before.id ||
    value.pageId !== before.pageId ||
    value.language !== before.language ||
    !id(value.id) ||
    !id(value.pageId) ||
    !isContentPath(value.path) ||
    !positive(value.version) ||
    !positive(value.revisionSeq) ||
    !id(value.draftRevisionId) ||
    !(value.publishedRevisionId === null || id(value.publishedRevisionId)) ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    !(value.publishedAt === null || date(value.publishedAt)) ||
    !(value.deletedAt === null || date(value.deletedAt)) ||
    (value.publishedRevisionId === null) !== (value.publishedAt === null) ||
    (value.deletedAt !== null && value.publishedRevisionId !== null)
  ) {
    throw new PageActionReadError();
  }
  return {
    id: value.id,
    pageId: value.pageId,
    language: before.language,
    path: value.path as string,
    version: value.version,
    revisionSeq: value.revisionSeq,
    draftRevisionId: value.draftRevisionId,
    publishedRevisionId: value.publishedRevisionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    publishedAt: value.publishedAt,
    deletedAt: value.deletedAt,
  };
}

export function readPageSummary(
  value: unknown,
  before: AdminTranslation,
): PageSummary {
  if (!record(value)) throw new PageActionReadError();
  const translation = readPageTranslation(value.translation, before);
  const draft = value.draft;
  if (
    !record(draft) ||
    draft.id !== translation.draftRevisionId ||
    draft.translationId !== translation.id ||
    typeof draft.title !== "string" ||
    !draft.title.trim() ||
    draft.title.length > 200 ||
    typeof draft.description !== "string" ||
    draft.description.length > 500 ||
    !Array.isArray(draft.tags) ||
    draft.tags.length > 16 ||
    draft.tags.some((tag) => typeof tag !== "string" || tag.length > 64)
  ) {
    throw new PageActionReadError();
  }
  // getDetail's related translations are a later read; only this translation
  // and its owned immutable draft describe the comparison's version.
  return {
    ...translation,
    title: draft.title,
    description: draft.description,
    tags: [...draft.tags],
  };
}

export function pageActionEligible(
  kind: PageAction,
  page: AdminTranslation,
): boolean {
  if (kind === "restore") return page.deletedAt !== null;
  if (page.deletedAt !== null) return false;
  return kind !== "unpublish" || page.publishedRevisionId !== null;
}

export function createPageActionAttempt(
  selection: PageActionSelection,
  path: string,
): PageActionAttempt {
  if (
    !pageActionEligible(selection.kind, selection.page) ||
    (selection.kind === "move" &&
      (!isContentPath(path) || path === selection.page.path))
  ) {
    throw new PageActionReadError();
  }
  return {
    selection: {
      kind: selection.kind,
      page: { ...selection.page, tags: [...selection.page.tags] },
    },
    destination: selection.kind === "move" ? path : null,
  };
}

export function classifyPageAction(
  attempt: PageActionAttempt,
  current: AdminTranslation,
): PageActionOutcome {
  const { kind, page: before } = attempt.selection;
  const latest = readPageTranslation(current, before);
  const preserved =
    latest.createdAt === before.createdAt &&
    latest.revisionSeq === before.revisionSeq &&
    latest.draftRevisionId === before.draftRevisionId;
  if (
    preserved &&
    latest.version === before.version &&
    latest.path === before.path &&
    latest.deletedAt === before.deletedAt &&
    latest.publishedRevisionId === before.publishedRevisionId &&
    latest.publishedAt === before.publishedAt &&
    latest.updatedAt === before.updatedAt
  )
    return "unchanged";
  if (
    !preserved ||
    !Number.isSafeInteger(before.version + 1) ||
    latest.version !== before.version + 1
  )
    return "changed";
  if (kind === "move")
    return latest.path === attempt.destination &&
      latest.deletedAt === null &&
      latest.publishedRevisionId === before.publishedRevisionId &&
      latest.publishedAt === before.publishedAt
      ? "desired"
      : "changed";
  if (
    latest.path !== before.path ||
    latest.publishedRevisionId !== null ||
    latest.publishedAt !== null
  )
    return "changed";
  return (
    kind === "delete"
      ? latest.deletedAt !== null
      : latest.deletedAt === null
  )
    ? "desired"
    : "changed";
}

export function uncertainPageAction(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}
function authFailure(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}
export function readPageSession(value: unknown): AuthSession {
  if (!record(value) || !record(value.session)) throw new PageActionReadError();
  const session = value.session;
  if (
    !record(session.user) ||
    session.user.id !== 1 ||
    !positive(session.user.version) ||
    typeof session.user.username !== "string" ||
    !session.user.username ||
    typeof session.csrfToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(session.csrfToken) ||
    !date(session.createdAt) ||
    !date(session.expiresAt) ||
    !date(session.idleExpiresAt)
  )
    throw new PageActionReadError();
  return session as AuthSession;
}

export interface PageActionState {
  page: PageSummary;
  path: string;
  busy: boolean;
  blocked: boolean;
  attempt: PageActionAttempt | null;
  needsReview: boolean;
  comparison: { page: PageSummary; outcome: PageActionOutcome | null } | null;
  failure: unknown;
  notice: "session" | "adopted" | null;
}
interface Options {
  selection: PageActionSelection;
  session: AuthSession;
  sessionBlocked: boolean;
  attempt: PageActionAttempt | null;
  request?: PageActionRequest;
  onAttemptChange(attempt: PageActionAttempt | null): void;
  onSessionRequired(): void;
  onSessionChange(session: AuthSession): void;
  onDone(kind: PageAction): void;
}

export class PageActionController {
  state: PageActionState;
  readonly kind: PageAction;
  private session: AuthSession;
  private readonly api: PageActionRequest;
  private operation: AbortController | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly options: Options) {
    const retained = options.attempt;
    if (
      retained &&
      (retained.selection.kind !== options.selection.kind ||
        retained.selection.page.id !== options.selection.page.id ||
        retained.selection.page.language !== options.selection.page.language)
    )
      throw new PageActionReadError();
    const selection = retained?.selection ?? options.selection;
    this.kind = selection.kind;
    this.session = options.session;
    this.api = options.request ?? request;
    this.state = {
      page: { ...selection.page, tags: [...selection.page.tags] },
      path: retained?.destination ?? selection.page.path,
      busy: false,
      blocked: options.sessionBlocked,
      attempt: retained,
      needsReview: Boolean(retained) || options.sessionBlocked,
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
  private patch(update: Partial<PageActionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  context(session: AuthSession, blocked: boolean) {
    this.session = session;
    if (blocked && !this.state.blocked)
      this.patch({ blocked: true, needsReview: true, comparison: null });
  }
  editPath(path: string) {
    if (!this.state.busy) this.patch({ path, notice: null });
  }
  get canSubmit(): boolean {
    return (
      !this.disposed &&
      !this.state.busy &&
      !this.state.blocked &&
      !this.state.attempt &&
      !this.state.needsReview &&
      pageActionEligible(this.kind, this.state.page) &&
      (this.kind !== "move" ||
        (isContentPath(this.state.path) &&
          this.state.path !== this.state.page.path))
    );
  }
  private attempt(value: PageActionAttempt | null) {
    this.patch({ attempt: value });
    this.options.onAttemptChange(value);
  }
  private fail(error: unknown) {
    this.patch({ failure: error, comparison: null });
    if (authFailure(error)) {
      this.patch({ blocked: true, needsReview: true });
      this.options.onSessionRequired();
    }
  }
  private async run(kind: "submit" | "inspect" | "reconnect") {
    if (
      this.operation ||
      this.disposed ||
      (kind === "submit" && !this.canSubmit) ||
      (kind === "inspect" && this.state.blocked)
    )
      return;
    const controller = new AbortController();
    this.operation = controller;
    this.patch({
      busy: true,
      failure: null,
      notice: null,
      ...(kind !== "submit" ? { comparison: null, needsReview: true } : {}),
      ...(kind === "reconnect" ? { blocked: true } : {}),
    });
    let submitted: PageActionAttempt | null = null;
    try {
      if (kind === "reconnect") {
        const session = readPageSession(
          await this.api("session", { signal: controller.signal }),
        );
        if (controller.signal.aborted || this.disposed) return;
        this.session = session;
        this.options.onSessionChange(session);
        this.patch({ blocked: false, notice: "session" });
      } else if (kind === "inspect") {
        const detail = await this.api(
          `pages/${encodeURIComponent(this.state.page.id)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || this.disposed) return;
        const page = readPageSummary(detail, this.state.page);
        this.patch({
          comparison: {
            page,
            outcome: this.state.attempt
              ? classifyPageAction(this.state.attempt, page)
              : null,
          },
        });
      } else {
        submitted = createPageActionAttempt(
          { kind: this.kind, page: this.state.page },
          this.state.path,
        );
        // Parent ownership starts before dispatch, including when the component
        // unmounts or fetch is aborted before a response can be observed.
        this.attempt(submitted);
        const base = `pages/${encodeURIComponent(submitted.selection.page.id)}`;
        const response = await this.api<unknown>(
          this.kind === "delete" ? base : `${base}/${this.kind}`,
          {
            ...mutation(
              this.kind === "delete" ? "DELETE" : "POST",
              {
                expectedVersion: submitted.selection.page.version,
                ...(this.kind === "move"
                  ? { path: submitted.destination }
                  : {}),
              },
              this.session.csrfToken,
            ),
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted || this.disposed) return;
        if (
          !record(response) ||
          classifyPageAction(
            submitted,
            readPageTranslation(response.translation, submitted.selection.page),
          ) !== "desired"
        )
          throw new PageActionReadError();
        this.attempt(null);
        this.options.onDone(this.kind);
      }
    } catch (error) {
      if (this.disposed || this.operation !== controller) return;
      this.fail(error);
      if (kind === "submit" && submitted) {
        if (!uncertainPageAction(error)) this.attempt(null);
        if (
          uncertainPageAction(error) ||
          (error instanceof ApiError &&
            [401, 403, 404, 412].includes(error.status))
        )
          this.patch({ needsReview: true });
      }
    } finally {
      const active = this.operation === controller;
      if (active) this.operation = null;
      if (active && !this.disposed) {
        // Abort does not imply the server stopped. A retained attempt always
        // blocks another write, even if an adapter resolved after cancellation.
        this.patch({
          busy: false,
          ...(controller.signal.aborted
            ? {
                comparison: null,
                needsReview: true,
                failure: new Error("Inspection or request interrupted."),
              }
            : {}),
        });
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
    if (!comparison || this.state.busy || this.state.blocked || this.disposed)
      return;
    this.attempt(null);
    this.patch({
      page: comparison.page,
      needsReview: false,
      comparison: null,
      failure: null,
      notice: "adopted",
    });
    if (comparison.outcome === "desired") this.options.onDone(this.kind);
  }
  cancel() {
    this.operation?.abort();
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    this.operation?.abort();
    this.operation = null;
    this.listeners.clear();
  }
}
