import {
  lazy,
  Suspense,
  useCallback,
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
import { ApiError, request } from "./api";
import { readPageSession } from "./page-action-recovery";
import { RevisionRestoreDialog } from "./RevisionRestoreDialog";
import {
  RevisionRestoreController,
  readRestoreRevision,
} from "./revision-restore-recovery";
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
  onSessionChange,
}: {
  language: Language;
  session: AuthSession;
  translationId: string;
  onSessionChange: (session: AuthSession) => void;
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
  const [restoreWork, setRestoreWork] =
    useState<RevisionRestoreController | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [discardRestore, setDiscardRestore] = useState(false);
  const [restored, setRestored] = useState<"verified" | "observed" | null>(
    null,
  );
  const [activeSession, setActiveSession] = useState(session);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [, renderRestore] = useState(0);
  const workRef = useRef(restoreWork);
  workRef.current = restoreWork;
  const sessionRef = useRef(activeSession);
  sessionRef.current = activeSession;
  const historyReads = useRef(new Set<AbortController>());
  const moreOperation = useRef<AbortController | null>(null);
  const reconnectOperation = useRef<AbortController | null>(null);
  const guarded = useRef(false);
  guarded.current = Boolean(
    restoreWork &&
      (restoreWork.state.busy ||
        restoreWork.state.attempt ||
        restoreWork.state.note),
  );
  const invalidateReads = useCallback(() => {
    for (const read of historyReads.current) read.abort();
    historyReads.current.clear();
    moreOperation.current = null;
    setMore(null);
  }, []);
  const beginRead = useCallback(() => {
    const controller = new AbortController();
    historyReads.current.add(controller);
    return controller;
  }, []);
  const endRead = useCallback((controller: AbortController) => {
    controller.abort();
    historyReads.current.delete(controller);
  }, []);
  const sessionRequired = useCallback(() => {
    setSessionBlocked(true);
    workRef.current?.context(sessionRef.current, true);
    invalidateReads();
    setLoading(false);
  }, [invalidateReads]);
  const updateSession = useCallback(
    (next: AuthSession) => {
      invalidateReads();
      sessionRef.current = next;
      setActiveSession(next);
      setSessionBlocked(false);
      onSessionChange(next);
      setRefresh((value) => value + 1);
      setPanelAttempt((value) => value + 1);
    },
    [invalidateReads, onSessionChange],
  );
  useEffect(() => {
    if (!restoreWork) return;
    restoreWork.activate();
    const unsubscribe = restoreWork.subscribe(() => {
      guarded.current = Boolean(
        restoreWork.state.busy ||
          restoreWork.state.attempt ||
          restoreWork.state.note,
      );
      renderRestore((value) => value + 1);
    });
    return () => {
      unsubscribe();
      restoreWork.dispose();
    };
  }, [restoreWork]);
  useEffect(() => {
    restoreWork?.context(activeSession, sessionBlocked);
  }, [restoreWork, activeSession, sessionBlocked]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (guarded.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const signout = (event: Event) => {
      if (guarded.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("wiki:before-signout", signout);
    return () => {
      reconnectOperation.current?.abort();
      invalidateReads();
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("wiki:before-signout", signout);
    };
  }, [invalidateReads]);
  function reload() {
    invalidateReads();
    setRefresh((value) => value + 1);
    setPanelAttempt((value) => value + 1);
  }
  async function reconnect() {
    if (restoreWork) {
      await restoreWork.reconnect();
      return;
    }
    if (reconnectOperation.current) return;
    const controller = new AbortController();
    reconnectOperation.current = controller;
    setReconnecting(true);
    setFailure(null);
    try {
      const next = readPageSession(
        await request<unknown>("session", { signal: controller.signal }),
      );
      if (
        !controller.signal.aborted &&
        reconnectOperation.current === controller
      )
        updateSession(next);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        reconnectOperation.current === controller
      )
        setFailure(error);
    } finally {
      if (reconnectOperation.current === controller) {
        reconnectOperation.current = null;
        if (!controller.signal.aborted) setReconnecting(false);
      }
    }
  }
  function startRestore() {
    if (restoreWork || sessionBlocked || !selected || !detail) return;
    try {
      const work = new RevisionRestoreController({
        source: selected,
        before: detail.translation,
        session: activeSession,
        sessionBlocked,
        onSessionRequired: sessionRequired,
        onSessionChange: updateSession,
        onDone: (outcome) => {
          setRestoreOpen(false);
          setRestoreWork(null);
          setRestored(outcome);
          invalidateReads();
          setRefresh((value) => value + 1);
          setPanelAttempt((value) => value + 1);
        },
      });
      workRef.current = work;
      setRestoreWork(work);
      setRestoreOpen(true);
      setRestored(null);
    } catch (error) {
      setPanelFailure(error);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the current publication pointer and history after restoring.
  useEffect(() => {
    if (sessionBlocked) return;
    const controller = beginRead();
    setLoading(true);
    setFailure(null);
    setMoreFailure(null);
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
        setFailure(error);
        if (error instanceof ApiError && [401, 403].includes(error.status))
          sessionRequired();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => endRead(controller);
  }, [base, refresh, sessionBlocked, beginRead, endRead, sessionRequired]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelAttempt retries a failed immutable revision read without changing the selection.
  useEffect(() => {
    if (!selectedId) return;
    if (sessionBlocked) return;
    const controller = beginRead();
    setSelected(null);
    setPanelFailure(null);
    void request<{ revision: ContentRevision }>(
      `${base}/revisions/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setSelected(
            readRestoreRevision(value.revision, translationId, selectedId),
          );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPanelFailure(error);
        if (error instanceof ApiError && [401, 403].includes(error.status))
          sessionRequired();
      });
    return () => endRead(controller);
  }, [
    base,
    selectedId,
    panelAttempt,
    sessionBlocked,
    beginRead,
    endRead,
    sessionRequired,
    translationId,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: panelAttempt retries the same explicitly selected comparison.
  useEffect(() => {
    if (mode !== "compare" || !originalId || !modifiedId) return;
    if (sessionBlocked) return;
    const controller = beginRead();
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
            original: readRestoreRevision(
              original.revision,
              translationId,
              originalId,
            ),
            modified: readRestoreRevision(
              modified.revision,
              translationId,
              modifiedId,
            ),
          });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPanelFailure(error);
        if (error instanceof ApiError && [401, 403].includes(error.status))
          sessionRequired();
      });
    return () => endRead(controller);
  }, [
    base,
    mode,
    originalId,
    modifiedId,
    panelAttempt,
    sessionBlocked,
    beginRead,
    endRead,
    sessionRequired,
    translationId,
  ]);
  async function loadMore(kind: "revisions" | "events") {
    if (moreOperation.current || sessionBlocked || loading) return;
    const controller = beginRead();
    moreOperation.current = controller;
    setMore(kind);
    setMoreFailure(null);
    try {
      if (kind === "revisions" && revisions.nextBeforeRevision !== null) {
        const page = await request<Revisions>(
          `${base}/revisions?${new URLSearchParams({ beforeRevision: String(revisions.nextBeforeRevision), limit: "20" })}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
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
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
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
      if (controller.signal.aborted) return;
      setMoreFailure(error);
      if (error instanceof ApiError && [401, 403].includes(error.status))
        sessionRequired();
    } finally {
      if (moreOperation.current === controller) {
        moreOperation.current = null;
        if (!controller.signal.aborted) setMore(null);
      }
      endRead(controller);
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
  const entryUrl = `/admin/pages/${encodeURIComponent(translationId)}`;
  return (
    <>
      {sessionBlocked && !restoreOpen && (
        <div className="admin-notice error content-session-notice" role="alert">
          <span>
            {zh
              ? "会话需要重新验证。恢复说明和待核对请求已保留。"
              : "Your session needs verification. Restore notes and unconfirmed requests are retained."}
          </span>
          <span className="content-session-actions">
            <a href="/admin" target="_blank" rel="noopener noreferrer">
              {zh ? "在新标签页登录" : "Sign in in a new tab"}
            </a>
            <button
              type="button"
              disabled={reconnecting || Boolean(restoreWork?.state.busy)}
              onClick={() => void reconnect()}
            >
              {zh ? "重新验证会话" : "Verify session"}
            </button>
          </span>
        </div>
      )}
      {restoreWork && !restoreOpen && (
        <section
          className="admin-notice history-retained-restore"
          aria-label={zh ? "保留的恢复操作" : "Retained restoration"}
        >
          <p>
            {zh
              ? `版本 ${restoreWork.state.source.revisionNo} 的恢复操作已保留在本标签页。`
              : `Restoration of revision ${restoreWork.state.source.revisionNo} is retained in this tab.`}
          </p>
          <p>
            {restoreWork.state.attempt
              ? zh
                ? "提交结果尚未确认。离开或退出会丢弃本地核对记录，但不会撤销服务器请求。"
                : "The submission is unconfirmed. Leaving or signing out discards the local comparison record, but does not undo the server request."
              : zh
                ? "恢复说明已保留。请继续或明确丢弃后再选择其他版本。"
                : "Your note is retained. Continue or explicitly discard this work before choosing another revision."}
          </p>
          <div className="content-session-actions">
            <button
              type="button"
              className="admin-button secondary"
              onClick={() => {
                setDiscardRestore(false);
                setRestoreOpen(true);
              }}
            >
              {zh ? "继续核对恢复" : "Continue restoration"}
            </button>
            {!restoreWork.state.attempt && !restoreWork.state.busy && (
              <button
                type="button"
                className="admin-button secondary"
                onClick={() => setDiscardRestore(true)}
              >
                {zh ? "丢弃恢复操作" : "Discard restoration work"}
              </button>
            )}
          </div>
          {discardRestore &&
            !restoreWork.state.attempt &&
            !restoreWork.state.busy && (
              <div role="alert">
                <p>
                  {zh
                    ? "确认丢弃此恢复说明和未提交的操作？"
                    : "Discard this note and the unsubmitted restoration?"}
                </p>
                <div className="content-session-actions">
                  <button
                    type="button"
                    className="admin-button secondary"
                    onClick={() => setDiscardRestore(false)}
                  >
                    {zh ? "保留" : "Keep it"}
                  </button>
                  <button
                    type="button"
                    className="admin-button secondary"
                    onClick={() => {
                      restoreWork.dispose();
                      workRef.current = null;
                      guarded.current = false;
                      setRestoreWork(null);
                      setDiscardRestore(false);
                    }}
                  >
                    {zh ? "确认丢弃" : "Confirm discard"}
                  </button>
                </div>
              </div>
            )}
        </section>
      )}
      {loading ? (
        <div className="admin-panel admin-loading" role="status">
          <span className="admin-spinner" />
          {zh ? "正在读取版本记录…" : "Loading revision history…"}
        </div>
      ) : failure !== null || !detail ? (
        <div className="admin-panel history-load-error">
          <div className="admin-notice error" role="alert">
            {message(failure, zh)}
          </div>
          <button
            className="admin-button secondary"
            type="button"
            disabled={sessionBlocked}
            onClick={reload}
          >
            {zh ? "重试" : "Try again"}
          </button>
          <a href="/admin/pages">{zh ? "返回页面列表" : "Back to pages"}</a>
        </div>
      ) : (
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
                {restored === "verified"
                  ? zh
                    ? "已验证新的恢复草稿，恢复操作未改变公开页面。"
                    : "The new restoration draft was verified. Restoring did not change the published page."
                  : zh
                    ? "已核对服务器上的恢复草稿。请查看最新内容。"
                    : "The restoration draft observed on the server has been reviewed. Open the latest content."}
              </span>
              <a href={`${entryUrl}/edit`}>
                {zh ? "查看草稿" : "Open draft"} →
              </a>
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
                          {revision.id ===
                            detail.translation.draftRevisionId && (
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
                  disabled={more !== null || sessionBlocked}
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
                      disabled={
                        sessionBlocked ||
                        Boolean(restoreWork) ||
                        selected.id === detail.translation.draftRevisionId
                      }
                      onClick={startRestore}
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
                        <small>
                          {zh ? "只读比较" : "Read-only comparison"}
                        </small>
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
                      panelFailure === null &&
                      !sessionBlocked && (
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
                              session={activeSession}
                              onExpired={sessionRequired}
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
                    disabled={sessionBlocked}
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
                disabled={more !== null || sessionBlocked}
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
        </>
      )}
      {restoreWork && restoreOpen && (
        <RevisionRestoreDialog
          controller={restoreWork}
          language={language}
          onClose={() => setRestoreOpen(false)}
        />
      )}
    </>
  );
}
