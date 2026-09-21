import {
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AuthSession } from "../../shared/auth";
import type {
  ContentDetail,
  ContentEvent,
  ContentEventType,
  ContentPage,
  ContentRevision,
  RevisionSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { ApiError, mutation, request } from "./api";
import "./versions.css";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({
    default: module.MarkdownPreview,
  })),
);
const MarkdownDiff = lazy(() =>
  import("./MarkdownDiff").then((module) => ({ default: module.MarkdownDiff })),
);
type Revisions = {
  revisions: RevisionSummary[];
  nextBeforeRevision: number | null;
};
type Mode = "preview" | "source" | "compare";

function message(error: unknown, zh: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 412)
      return zh
        ? "页面已更新。请读取最新状态，确认后再恢复版本。"
        : "The page has changed. Load its latest state, then review and confirm the restore.";
    if (error.status === 404)
      return zh
        ? "找不到这个页面或版本。"
        : "This page or revision could not be found.";
    if (error.status === 403)
      return zh
        ? "请求未获授权，请刷新后重试。"
        : "This request was not authorized. Reload and try again.";
    if (error.status === 400)
      return zh
        ? "当前页面状态不支持此操作，请检查页面和输入内容。"
        : "Check the page state and the details you entered before trying again.";
  }
  return zh
    ? "暂时无法读取或保存，请重试。你的输入已保留。"
    : "This request could not be completed. Your input is preserved; please try again.";
}

function dateLabel(value: string, language: Language) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function RestoreDialog({
  revision,
  detail,
  language,
  session,
  onClose,
  onDone,
}: {
  revision: ContentRevision;
  detail: ContentDetail;
  language: Language;
  session: AuthSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const zh = language === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(detail.translation);
  const [activeSession, setActiveSession] = useState(session);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await request(
        `pages/${encodeURIComponent(current.id)}/revisions/${encodeURIComponent(revision.id)}/restore`,
        mutation(
          "POST",
          { expectedVersion: current.version, changeNote: note },
          activeSession.csrfToken,
        ),
      );
      onDone();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function latest() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await request<ContentDetail>(
        `pages/${encodeURIComponent(current.id)}`,
      );
      setCurrent(result.translation);
      setRefreshed(true);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function reconnect() {
    setBusy(true);
    setReconnected(false);
    try {
      const result = await request<{ session: AuthSession }>("session");
      setActiveSession(result.session);
      setFailure(null);
      setReconnected(true);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const needsReconnect =
    failure instanceof ApiError &&
    (failure.status === 401 || failure.status === 403);
  return (
    <dialog
      ref={dialog}
      className="history-restore-dialog"
      aria-labelledby="restore-title"
      aria-describedby="restore-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className="admin-eyebrow">
          {zh ? "安全恢复" : "RESTORE A SNAPSHOT"}
        </p>
        <h2 id="restore-title">
          {zh
            ? `将版本 ${revision.revisionNo} 恢复为新草稿`
            : `Restore revision ${revision.revisionNo} as a new draft`}
        </h2>
        <p id="restore-description">
          {zh
            ? "标题、描述、标签和 Markdown 会复制到一个新版本。当前公开页面不会变化，旧版本与现有草稿也会保留在历史中。页面路径和语言关系不会改变。"
            : "The title, description, tags and Markdown are copied into a new revision. The published page stays unchanged, and earlier drafts remain in history. The page path and translation links do not change."}
        </p>
        {reconnected && (
          <div className="admin-notice success" role="status">
            {zh
              ? "已重新连接。恢复说明已保留，请确认后再次提交。"
              : "Reconnected. Your change note is preserved; review it and submit again."}
          </div>
        )}
        {failure !== null && (
          <div
            className={`admin-notice error${needsReconnect ? " content-session-notice" : ""}`}
            role="alert"
          >
            <span>
              {needsReconnect
                ? zh
                  ? "登录状态已变化。请在新窗口登录，再重新连接；恢复说明已保留。"
                  : "Your session has changed. Sign in in a new tab, then reconnect. Your change note is preserved."
                : message(failure, zh)}
            </span>
            {needsReconnect && (
              <span className="content-session-actions">
                <a href="/admin" target="_blank" rel="noopener noreferrer">
                  {zh ? "新窗口登录" : "Sign in in new tab"}
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reconnect()}
                >
                  {zh ? "重新连接" : "Reconnect"}
                </button>
              </span>
            )}
            {failure instanceof ApiError && failure.status === 412 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void latest()}
              >
                {zh ? "读取最新状态" : "Load latest"}
              </button>
            )}
          </div>
        )}
        {refreshed && (
          <div className="admin-notice success" role="status">
            {zh
              ? "已读取最新状态。请确认仍要从此历史版本创建新草稿。"
              : "Latest state loaded. Confirm that you still want a new draft from this revision."}
          </div>
        )}
        {current.deletedAt && (
          <div className="admin-notice error" role="alert">
            {zh
              ? "页面已删除，请先在页面列表中恢复页面。"
              : "This page is deleted. Restore it from the page list first."}
          </div>
        )}
        <fieldset disabled={busy}>
          <label className="admin-field" htmlFor="restore-note">
            <span>{zh ? "变更说明（可选）" : "Change note (optional)"}</span>
            <textarea
              id="restore-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder={
                zh
                  ? "记录这次恢复的原因…"
                  : "Why are you restoring this revision?"
              }
            />
          </label>
          <div className="history-dialog-actions">
            <button
              className="admin-button secondary"
              type="button"
              onClick={onClose}
            >
              {zh ? "取消" : "Cancel"}
            </button>
            <button
              className="admin-button"
              type="submit"
              disabled={Boolean(current.deletedAt)}
            >
              {busy
                ? zh
                  ? "正在恢复…"
                  : "Restoring…"
                : zh
                  ? "恢复为新草稿"
                  : "Restore as draft"}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

function MetadataDiff({
  original,
  modified,
  zh,
}: {
  original: ContentRevision;
  modified: ContentRevision;
  zh: boolean;
}) {
  const fields = [
    {
      label: zh ? "标题" : "Title",
      before: original.title,
      after: modified.title,
    },
    {
      label: zh ? "描述" : "Description",
      before: original.description,
      after: modified.description,
    },
    {
      label: zh ? "标签" : "Tags",
      before: original.tags.join(", "),
      after: modified.tags.join(", "),
    },
  ].filter((field) => field.before !== field.after);
  return (
    <section className="history-metadata-diff">
      <h3>{zh ? "页面信息变化" : "Metadata changes"}</h3>
      {fields.length ? (
        <dl>
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>
                <del>{field.before || (zh ? "（空）" : "(empty)")}</del>
                <ins>{field.after || (zh ? "（空）" : "(empty)")}</ins>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>
          {zh
            ? "标题、描述与标签没有变化。"
            : "The title, description and tags are unchanged."}
        </p>
      )}
    </section>
  );
}

export function VersionsPage({
  language,
  session,
  translationId,
  onExpired,
}: {
  language: Language;
  session: AuthSession;
  translationId: string;
  onExpired: () => void;
}) {
  const zh = language === "zh";
  const base = `pages/${encodeURIComponent(translationId)}`;
  const [detail, setDetail] = useState<ContentDetail | null>(null);
  const [revisions, setRevisions] = useState<Revisions>({
    revisions: [],
    nextBeforeRevision: null,
  });
  const [events, setEvents] = useState<ContentPage<ContentEvent>>({
    items: [],
    nextCursor: null,
  });
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<ContentRevision | null>(null);
  const [mode, setMode] = useState<Mode>("preview");
  const [originalId, setOriginalId] = useState("");
  const [modifiedId, setModifiedId] = useState("");
  const [comparison, setComparison] = useState<{
    original: ContentRevision;
    modified: ContentRevision;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState<"revisions" | "events" | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [panelFailure, setPanelFailure] = useState<unknown>(null);
  const [moreFailure, setMoreFailure] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [panelAttempt, setPanelAttempt] = useState(0);
  const [restore, setRestore] = useState(false);
  const [restored, setRestored] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the current publication pointer and history after restoring.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void Promise.all([
      request<ContentDetail>(base, { signal: controller.signal }),
      request<Revisions>(`${base}/revisions?limit=20`, {
        signal: controller.signal,
      }),
      request<ContentPage<ContentEvent>>(`${base}/events?limit=20`, {
        signal: controller.signal,
      }),
    ])
      .then(([page, versions, activity]) => {
        if (controller.signal.aborted) return;
        setDetail(page);
        setRevisions(versions);
        setEvents(activity);
        setSelectedId(
          page.translation.draftRevisionId ?? versions.revisions[0]?.id ?? "",
        );
        setOriginalId(
          versions.revisions[1]?.id ?? versions.revisions[0]?.id ?? "",
        );
        setModifiedId(versions.revisions[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, refresh, onExpired]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelAttempt retries a failed immutable revision read without changing the selection.
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setSelected(null);
    setPanelFailure(null);
    void request<{ revision: ContentRevision }>(
      `${base}/revisions/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setSelected(value.revision);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setPanelFailure(error);
      });
    return () => controller.abort();
  }, [base, selectedId, panelAttempt, onExpired]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelAttempt retries the same explicitly selected comparison.
  useEffect(() => {
    if (mode !== "compare" || !originalId || !modifiedId) return;
    const controller = new AbortController();
    setComparison(null);
    setPanelFailure(null);
    void Promise.all([
      request<{ revision: ContentRevision }>(
        `${base}/revisions/${encodeURIComponent(originalId)}`,
        { signal: controller.signal },
      ),
      request<{ revision: ContentRevision }>(
        `${base}/revisions/${encodeURIComponent(modifiedId)}`,
        { signal: controller.signal },
      ),
    ])
      .then(([original, modified]) => {
        if (!controller.signal.aborted)
          setComparison({
            original: original.revision,
            modified: modified.revision,
          });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setPanelFailure(error);
      });
    return () => controller.abort();
  }, [base, mode, originalId, modifiedId, panelAttempt, onExpired]);
  async function loadMore(kind: "revisions" | "events") {
    if (more) return;
    setMore(kind);
    setMoreFailure(null);
    try {
      if (kind === "revisions" && revisions.nextBeforeRevision !== null) {
        const page = await request<Revisions>(
          `${base}/revisions?${new URLSearchParams({ beforeRevision: String(revisions.nextBeforeRevision), limit: "20" })}`,
        );
        setRevisions((value) => ({
          revisions: [
            ...value.revisions,
            ...page.revisions.filter(
              (item) => !value.revisions.some((old) => old.id === item.id),
            ),
          ],
          nextBeforeRevision: page.nextBeforeRevision,
        }));
      } else if (kind === "events" && events.nextCursor) {
        const page = await request<ContentPage<ContentEvent>>(
          `${base}/events?${new URLSearchParams({ cursor: events.nextCursor, limit: "20" })}`,
        );
        setEvents((value) => ({
          items: [
            ...value.items,
            ...page.items.filter(
              (item) => !value.items.some((old) => old.id === item.id),
            ),
          ],
          nextCursor: page.nextCursor,
        }));
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired();
      else setMoreFailure(error);
    } finally {
      setMore(null);
    }
  }
  const eventLabels: Record<ContentEventType, string> = {
    create: zh ? "创建页面" : "Page created",
    save_draft: zh ? "保存草稿" : "Draft saved",
    publish: zh ? "发布页面" : "Page published",
    unpublish: zh ? "取消发布" : "Page unpublished",
    move: zh ? "移动页面" : "Page moved",
    delete: zh ? "删除页面" : "Page deleted",
    restore_revision: zh ? "恢复历史版本为草稿" : "Revision restored as draft",
    restore_deleted: zh ? "恢复已删除页面" : "Deleted page restored",
  };
  if (loading)
    return (
      <div className="admin-panel admin-loading" role="status">
        <span className="admin-spinner" />
        {zh ? "正在读取版本记录…" : "Loading revision history…"}
      </div>
    );
  if (failure !== null || !detail)
    return (
      <div className="admin-panel history-load-error">
        <div className="admin-notice error" role="alert">
          {message(failure, zh)}
        </div>
        <button
          className="admin-button secondary"
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          {zh ? "重试" : "Try again"}
        </button>
        <a href="/admin/pages">{zh ? "返回页面列表" : "Back to pages"}</a>
      </div>
    );
  const entryUrl = `/admin/pages/${encodeURIComponent(translationId)}`;
  return (
    <>
      <a className="history-back" href="/admin/pages">
        ← {zh ? "所有页面" : "All pages"}
      </a>
      <div className="admin-page-heading history-heading">
        <div>
          <p className="admin-eyebrow">
            {zh ? "版本与变更记录" : "VERSIONS & ACTIVITY"}
          </p>
          <h1>{detail.draft.title}</h1>
          <p>
            <code>
              /{detail.translation.language}/{detail.translation.path}
            </code>
            <span className="history-heading-separator">·</span>
            {zh
              ? `${detail.translation.revisionSeq} 个版本`
              : `${detail.translation.revisionSeq} revisions`}
          </p>
        </div>
        {!detail.translation.deletedAt && (
          <a
            className="admin-button secondary history-edit-button"
            href={`${entryUrl}/edit`}
          >
            {zh ? "返回编辑" : "Back to editor"}{" "}
            <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {restored && (
        <div className="admin-notice success" role="status">
          <span>
            {zh
              ? "已创建新的恢复草稿，公开页面保持不变。"
              : "A new draft was created. The published page is unchanged."}
          </span>
          <a href={`${entryUrl}/edit`}>{zh ? "查看草稿" : "Open draft"} →</a>
        </div>
      )}
      {detail.translation.deletedAt && (
        <div className="history-deleted-notice">
          {zh
            ? "此页面已删除，历史记录仍然保留。请先从页面列表恢复页面，再恢复历史内容。"
            : "This page is deleted; its history is retained. Restore the page from the page list before restoring content."}
        </div>
      )}
      <div className="history-workspace">
        <aside className="admin-panel history-revisions">
          <header>
            <h2>{zh ? "历史版本" : "Revisions"}</h2>
            <span>{detail.translation.revisionSeq}</span>
          </header>
          <ol>
            {revisions.revisions.map((revision) => (
              <li key={revision.id}>
                <button
                  type="button"
                  className={selectedId === revision.id ? "selected" : ""}
                  aria-pressed={selectedId === revision.id}
                  onClick={() => {
                    setSelectedId(revision.id);
                    setMode("preview");
                  }}
                >
                  <span className="history-revision-title">
                    <strong>
                      {zh ? "版本" : "Revision"} {revision.revisionNo}
                    </strong>
                    <span className="history-revision-flags">
                      {revision.id ===
                        detail.translation.publishedRevisionId && (
                        <span>{zh ? "已发布" : "Published"}</span>
                      )}
                      {revision.id === detail.translation.draftRevisionId && (
                        <span>{zh ? "当前草稿" : "Current draft"}</span>
                      )}
                    </span>
                  </span>
                  <time dateTime={revision.createdAt}>
                    {dateLabel(revision.createdAt, language)}
                  </time>
                  <p>
                    {revision.changeNote ||
                      (revision.restoredFromRevisionId
                        ? zh
                          ? "从历史版本恢复"
                          : "Restored from history"
                        : zh
                          ? "未填写变更说明"
                          : "No change note")}
                  </p>
                </button>
              </li>
            ))}
          </ol>
          {revisions.nextBeforeRevision !== null && (
            <button
              className="history-load-more"
              type="button"
              disabled={more !== null}
              onClick={() => void loadMore("revisions")}
            >
              {more === "revisions"
                ? zh
                  ? "读取中…"
                  : "Loading…"
                : zh
                  ? "更早的版本"
                  : "Older revisions"}
            </button>
          )}
        </aside>
        <section className="admin-panel history-viewer">
          <div className="history-viewer-toolbar">
            <div className="history-view-tabs">
              {(
                [
                  { mode: "preview", label: zh ? "预览" : "Preview" },
                  { mode: "source", label: "Markdown" },
                  { mode: "compare", label: zh ? "比较版本" : "Compare" },
                ] as const
              ).map((tab) => (
                <button
                  type="button"
                  key={tab.mode}
                  aria-pressed={mode === tab.mode}
                  onClick={() => {
                    setMode(tab.mode);
                    setPanelFailure(null);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {selected &&
              mode !== "compare" &&
              !detail.translation.deletedAt && (
                <button
                  className="history-restore-button"
                  type="button"
                  disabled={selected.id === detail.translation.draftRevisionId}
                  onClick={() => setRestore(true)}
                >
                  {selected.id === detail.translation.draftRevisionId
                    ? zh
                      ? "当前草稿"
                      : "Current draft"
                    : zh
                      ? `恢复版本 ${selected.revisionNo}`
                      : `Restore revision ${selected.revisionNo}`}
                </button>
              )}
          </div>
          {mode === "compare" ? (
            <div className="history-comparison">
              <div className="history-compare-pickers">
                <label htmlFor="original-revision">
                  <span>{zh ? "原版本" : "Original"}</span>
                  <select
                    id="original-revision"
                    value={originalId}
                    onChange={(event) => setOriginalId(event.target.value)}
                  >
                    {revisions.revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {zh ? "版本" : "Revision"} {revision.revisionNo} ·{" "}
                        {revision.title}
                      </option>
                    ))}
                  </select>
                </label>
                <span aria-hidden="true">→</span>
                <label htmlFor="modified-revision">
                  <span>{zh ? "目标版本" : "Modified"}</span>
                  <select
                    id="modified-revision"
                    value={modifiedId}
                    onChange={(event) => setModifiedId(event.target.value)}
                  >
                    {revisions.revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {zh ? "版本" : "Revision"} {revision.revisionNo} ·{" "}
                        {revision.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {comparison && panelFailure === null && (
                <>
                  <MetadataDiff
                    original={comparison.original}
                    modified={comparison.modified}
                    zh={zh}
                  />
                  <div className="history-diff-legend">
                    <span>{zh ? "删除" : "Removed"}</span>
                    <span>{zh ? "新增" : "Added"}</span>
                    <small>{zh ? "只读比较" : "Read-only comparison"}</small>
                  </div>
                  <Suspense
                    fallback={
                      <div className="admin-loading" role="status">
                        {zh ? "正在加载差异视图…" : "Loading comparison…"}
                      </div>
                    }
                  >
                    <MarkdownDiff
                      original={comparison.original.markdown}
                      modified={comparison.modified.markdown}
                      language={language}
                    />
                  </Suspense>
                </>
              )}
            </div>
          ) : (
            selected && (
              <>
                <div className="history-snapshot-metadata">
                  <div>
                    <p className="admin-eyebrow">
                      {zh ? "版本" : "REVISION"} {selected.revisionNo}
                    </p>
                    <h2>{selected.title}</h2>
                    <p>
                      {selected.description ||
                        (zh ? "没有页面描述。" : "No description.")}
                    </p>
                  </div>
                  <div className="history-snapshot-meta">
                    <time dateTime={selected.createdAt}>
                      {dateLabel(selected.createdAt, language)}
                    </time>
                    {selected.tags.length > 0 && (
                      <div>
                        {selected.tags.map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {selected.changeNote && (
                    <blockquote>{selected.changeNote}</blockquote>
                  )}
                </div>
                {mode === "source" ? (
                  <pre className="history-markdown-source">
                    <code>{selected.markdown}</code>
                  </pre>
                ) : (
                  panelFailure === null && (
                    <div className="history-preview">
                      <Suspense
                        fallback={
                          <div className="admin-loading" role="status">
                            {zh ? "正在加载预览…" : "Loading preview…"}
                          </div>
                        }
                      >
                        <MarkdownPreview
                          markdown={selected.markdown}
                          language={detail.translation.language}
                          session={session}
                          onExpired={onExpired}
                        />
                      </Suspense>
                    </div>
                  )
                )}
              </>
            )
          )}
          {panelFailure !== null ? (
            <div className="history-panel-error">
              <div className="admin-notice error" role="alert">
                {message(panelFailure, zh)}
              </div>
              <button
                type="button"
                className="admin-button secondary"
                onClick={() => setPanelAttempt((value) => value + 1)}
              >
                {zh ? "重试" : "Try again"}
              </button>
            </div>
          ) : (
            ((mode === "compare" && !comparison) ||
              (mode !== "compare" && !selected)) && (
              <div className="admin-loading" role="status">
                <span className="admin-spinner" />
                {zh ? "正在读取版本内容…" : "Loading revision content…"}
              </div>
            )
          )}
        </section>
      </div>
      {moreFailure !== null && (
        <div className="admin-notice error" role="alert">
          {message(moreFailure, zh)}
        </div>
      )}
      <section className="admin-panel history-events">
        <header className="admin-panel-heading">
          <div>
            <h2>{zh ? "页面活动" : "Page activity"}</h2>
            <p>
              {zh
                ? "保存、发布、移动与恢复的完整轨迹。"
                : "A record of saves, publication, moves and restores."}
            </p>
          </div>
        </header>
        <ol>
          {events.items.map((event) => (
            <li key={event.id}>
              <span
                className={`history-event-dot ${event.type}`}
                aria-hidden="true"
              />
              <div>
                <div className="history-event-heading">
                  <strong>{eventLabels[event.type]}</strong>
                  <time dateTime={event.createdAt}>
                    {dateLabel(event.createdAt, language)}
                  </time>
                </div>
                {event.type === "move" && (
                  <p className="history-event-path">
                    <code>{event.fromPath}</code>
                    <span aria-hidden="true">→</span>
                    <code>{event.toPath}</code>
                  </p>
                )}
                {event.changeNote && <p>{event.changeNote}</p>}
                {event.revisionId && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(event.revisionId ?? "");
                      setMode("preview");
                      document
                        .querySelector(".history-viewer")
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                    }}
                  >
                    {zh ? "查看关联版本" : "View revision"} ↗
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {events.nextCursor && (
          <button
            className="history-load-more"
            type="button"
            disabled={more !== null}
            onClick={() => void loadMore("events")}
          >
            {more === "events"
              ? zh
                ? "读取中…"
                : "Loading…"
              : zh
                ? "更早的活动"
                : "Earlier activity"}
          </button>
        )}
      </section>
      {restore && selected && (
        <RestoreDialog
          revision={selected}
          detail={detail}
          language={language}
          session={session}
          onClose={() => setRestore(false)}
          onDone={() => {
            setRestore(false);
            setRestored(true);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
