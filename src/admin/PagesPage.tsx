import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { ContentPage, PageSummary } from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { isContentPath } from "../../shared/page-path";
import { publicPath } from "../../shared/paths";
import { ApiError, request } from "./api";
import { DirectoryMoveDialog } from "./DirectoryMoveDialog";
import type { DirectoryMoveAttempt } from "./directory-move-recovery";
import { PageActionDialog } from "./PageActionDialog";
import { PageDirectoryBrowser } from "./PageDirectoryBrowser";
import {
  type PageAction,
  type PageActionAttempt,
  type PageActionSelection,
  readPageSession,
} from "./page-action-recovery";
import "./pages.css";

type PageNotice =
  | { type: PageAction }
  | { type: "directory"; count: number }
  | { type: "review" };

type PageStatus = "active" | "draft" | "published" | "deleted";
type Filters = {
  language: Language;
  status: PageStatus;
  query: string;
  cursor: string | null;
};

function failureMessage(failure: unknown, zh: boolean): string {
  if (failure instanceof ApiError) {
    if (failure.status === 412)
      return zh
        ? "页面已在其他位置更新。请读取最新状态，再确认本次操作。"
        : "This page has changed elsewhere. Load its latest state before confirming this action.";
    if (failure.status === 409)
      return zh
        ? "目标路径已被占用，请选择另一个路径。"
        : "That path is already in use. Choose another path.";
    if (failure.status === 400)
      return zh
        ? "请检查页面路径和输入内容。"
        : "Check the page path and the details you entered.";
    if (failure.status === 403)
      return zh
        ? "当前请求未获授权，请刷新后重试。"
        : "This request was not authorized. Reload and try again.";
    if (failure.status === 404)
      return zh
        ? "找不到这个页面，请刷新列表。"
        : "This page could not be found. Refresh the list.";
  }
  return zh
    ? "暂时无法完成操作。你的输入已保留，请稍后重试。"
    : "The request could not be completed. Your input is preserved; please try again.";
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

function FileIcon() {
  return (
    <svg
      className="admin-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H5v20h14V7l-5-5v5h5M8 12h8M8 16h6" />
    </svg>
  );
}

export function PagesPage({
  language,
  session,
  onSessionChange,
}: {
  language: Language;
  session: AuthSession;
  onSessionChange: (session: AuthSession) => void;
}) {
  const zh = language === "zh";
  const [filters, setFilters] = useState<Filters>({
    language,
    status: "active",
    query: "",
    cursor: null,
  });
  const [search, setSearch] = useState("");
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [result, setResult] = useState<ContentPage<PageSummary> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<PageActionSelection | null>(null);
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const [view, setView] = useState<"directories" | "list">("directories");
  const [paths, setPaths] = useState<Record<Language, string>>({
    zh: "",
    en: "",
  });
  const [activeSession, setActiveSession] = useState(session);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [directory, setDirectory] = useState<{
    language: Language;
    path: string;
  } | null>(null);
  const [directoryAttempt, setDirectoryAttempt] =
    useState<DirectoryMoveAttempt | null>(null);
  const [actionAttempt, setActionAttempt] = useState<PageActionAttempt | null>(
    null,
  );
  const pending = Boolean(directoryAttempt || actionAttempt);
  const guarded = useRef(false);
  guarded.current = pending || busy || dirty;
  const reconnectOperation = useRef<AbortController | null>(null);
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
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("wiki:before-signout", signout);
    };
  }, []);
  const sessionRequired = useCallback(() => setSessionBlocked(true), []);
  function refreshBoth() {
    setPrevious([]);
    setFilters((value) => ({ ...value, cursor: null }));
    setRefresh((value) => value + 1);
  }
  function updateSession(next: AuthSession) {
    setActiveSession(next);
    onSessionChange(next);
    setSessionBlocked(false);
    refreshBoth();
  }
  async function reconnect() {
    if (reconnectOperation.current) return;
    const controller = new AbortController();
    reconnectOperation.current = controller;
    setReconnecting(true);
    setFailure(null);
    try {
      const value = readPageSession(
        await request<unknown>("session", {
          signal: controller.signal,
        }),
      );
      if (!controller.signal.aborted) updateSession(value);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      if (reconnectOperation.current === controller)
        reconnectOperation.current = null;
      if (!controller.signal.aborted) setReconnecting(false);
    }
  }
  function pageAction(kind: PageAction, page: PageSummary) {
    if (pending || busy || sessionBlocked) return;
    setSelection({ kind, page });
  }
  function closeDialogs() {
    setSelection(null);
    setDirectory(null);
    setDirty(false);
  }
  const path = paths[filters.language];
  const childAllowed = !path || isContentPath(`${path}/a`);
  const newPageQuery = new URLSearchParams({ language: filters.language });
  if (view === "directories" && path) newPageQuery.set("prefix", path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the authoritative list after a mutation or manual retry.
  useEffect(() => {
    if (view !== "list") {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setResult(null);
    setFailure(null);
    const query = new URLSearchParams({
      language: filters.language,
      status: filters.status,
      q: filters.query,
      limit: "20",
    });
    if (filters.cursor) query.set("cursor", filters.cursor);
    void request<ContentPage<PageSummary>>(`pages?${query}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403].includes(error.status))
          sessionRequired();
        setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, refresh, view, sessionRequired]);
  function filter(next: Partial<Filters>, flat = true) {
    if (flat) setView("list");
    setPrevious([]);
    setResult(null);
    setFilters((value) => ({ ...value, ...next, cursor: null }));
  }
  const statuses: { id: PageStatus; label: string }[] = [
    { id: "active", label: zh ? "所有页面" : "All pages" },
    { id: "draft", label: zh ? "草稿" : "Drafts" },
    { id: "published", label: zh ? "已发布" : "Published" },
    { id: "deleted", label: zh ? "已删除" : "Deleted" },
  ];
  const notices: Record<PageAction, string> = {
    move: zh ? "页面路径已更新。" : "Page path updated.",
    delete: zh
      ? "页面已删除，版本历史已保留。"
      : "Page deleted; revision history retained.",
    restore: zh
      ? "页面已恢复为未发布状态。"
      : "Page restored and left unpublished.",
    unpublish: zh ? "页面已取消发布。" : "Page unpublished.",
  };
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">
            {zh ? "内容工作空间" : "CONTENT WORKSPACE"}
          </p>
          <h1>{zh ? "页面" : "Pages"}</h1>
          <p>
            {zh
              ? "组织双语文档，照料从草稿到发布的每一步。"
              : "Organize bilingual documentation, from the first draft to publication."}
          </p>
        </div>
        {!pending &&
        !busy &&
        !sessionBlocked &&
        (view !== "directories" || childAllowed) ? (
          <a
            className="admin-button pages-new-button"
            href={`/admin/pages/new?${newPageQuery}`}
          >
            <span aria-hidden="true">＋</span>
            {view === "directories" && path
              ? zh
                ? "在此目录新建页面"
                : "New page here"
              : zh
                ? "新建页面"
                : "New page"}
          </a>
        ) : (
          <button
            className="admin-button pages-new-button"
            type="button"
            disabled
          >
            {zh ? "新建页面" : "New page"}
          </button>
        )}
      </div>
      {notice && (
        <div className="admin-notice success" role="status">
          <span>
            {notice.type === "directory"
              ? zh
                ? `已整体移动 ${notice.count} 个页面。`
                : `${notice.count} pages moved together.`
              : notice.type === "review"
                ? zh
                  ? "已结束本次状态核对。新的移动仍需重新预览并确认。"
                  : "State review finished. Another move still requires a new preview and confirmation."
                : notices[notice.type]}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={zh ? "关闭提示" : "Dismiss notification"}
          >
            ×
          </button>
        </div>
      )}
      {sessionBlocked && !selection && !directory && (
        <div className="admin-notice error content-session-notice" role="alert">
          <span>
            {zh
              ? "登录状态已变化。请在新窗口登录，然后重新连接；待确认的操作会保留。"
              : "Your session changed. Sign in in a new tab, then reconnect. Pending actions are retained."}
          </span>
          <a href="/admin" target="_blank" rel="noopener noreferrer">
            {zh ? "新窗口登录" : "Sign in in new tab"}
          </a>
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void reconnect()}
          >
            {zh ? "重新连接" : "Reconnect"}
          </button>
        </div>
      )}
      {pending && !selection && !directory && (
        <div className="admin-notice warning pages-pending" role="status">
          <span>
            {zh
              ? "上次操作的结果尚未确认。核对前暂不能提交其他页面操作。"
              : "The previous action is unconfirmed. Review it before submitting other page changes."}
          </span>
          <button
            className="admin-button secondary"
            type="button"
            onClick={() => {
              if (directoryAttempt)
                setDirectory({
                  language: directoryAttempt.preview.language,
                  path: directoryAttempt.preview.fromPath,
                });
              else if (actionAttempt) setSelection(actionAttempt.selection);
            }}
          >
            {zh ? "核对待确认操作" : "Review pending action"}
          </button>
        </div>
      )}
      <section className="admin-panel admin-page-library">
        <div className="pages-toolbar">
          <search className="pages-search-region">
            <form
              className="pages-search"
              onSubmit={(event) => {
                event.preventDefault();
                filter({ query: search.trim() });
              }}
            >
              <label className="sr-only" htmlFor="pages-search">
                {zh ? "搜索页面标题与路径" : "Search page titles and paths"}
              </label>
              <svg
                viewBox="0 0 24 24"
                className="admin-icon"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
              <input
                id="pages-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={200}
                type="search"
                placeholder={zh ? "搜索标题或路径…" : "Find a title or path…"}
              />
              <button type="submit" disabled={loading}>
                {zh ? "搜索" : "Search"}
              </button>
            </form>
          </search>
          <label className="pages-language" htmlFor="content-language">
            <span>{zh ? "内容语言" : "Content language"}</span>
            <select
              id="content-language"
              value={filters.language}
              onChange={(event) =>
                filter({ language: event.target.value as Language }, false)
              }
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <div className="pages-filter-bar">
          <fieldset
            className="pages-status-filters"
            aria-label={zh ? "页面状态" : "Page status"}
          >
            <button
              type="button"
              aria-pressed={view === "directories"}
              onClick={() => {
                setView("directories");
                setFailure(null);
              }}
            >
              {zh ? "目录" : "Directories"}
            </button>
            {statuses.map((status) => (
              <button
                type="button"
                key={status.id}
                aria-pressed={view === "list" && filters.status === status.id}
                onClick={() => filter({ status: status.id })}
              >
                {status.label}
              </button>
            ))}
          </fieldset>
          {view === "list" && (
            <button
              className="pages-refresh"
              type="button"
              disabled={loading}
              onClick={refreshBoth}
            >
              {loading
                ? zh
                  ? "读取中…"
                  : "Loading…"
                : zh
                  ? "刷新"
                  : "Refresh"}
            </button>
          )}
        </div>
        {view === "directories" ? (
          <PageDirectoryBrowser
            language={language}
            contentLanguage={filters.language}
            path={path}
            onPathChange={(next) =>
              setPaths((value) => ({ ...value, [filters.language]: next }))
            }
            refreshKey={refresh}
            actionsDisabled={pending || busy || sessionBlocked}
            onSessionRequired={sessionRequired}
            onPageAction={pageAction}
            onMoveDirectory={(source) => {
              if (!pending && !busy && !sessionBlocked)
                setDirectory({ language: filters.language, path: source });
            }}
          />
        ) : (
          <>
            {failure !== null ? (
              <div className="pages-list-message">
                <div className="admin-notice error" role="alert">
                  {failureMessage(failure, zh)}
                </div>
                <button
                  type="button"
                  className="admin-button secondary"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  {zh ? "重试" : "Try again"}
                </button>
              </div>
            ) : loading ? (
              <div className="admin-loading" role="status">
                <span className="admin-spinner" />
                {zh ? "正在读取页面…" : "Loading pages…"}
              </div>
            ) : result?.items.length ? (
              <div className="admin-table-wrap">
                <table className="pages-list-table">
                  <thead>
                    <tr>
                      <th scope="col">{zh ? "页面与路径" : "Page and path"}</th>
                      <th scope="col">{zh ? "状态" : "Status"}</th>
                      <th scope="col">{zh ? "更新时间" : "Updated"}</th>
                      <th scope="col">
                        <span className="sr-only">
                          {zh ? "操作" : "Actions"}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((page) => {
                      const route = `/admin/pages/${encodeURIComponent(page.id)}`;
                      const hasDraft =
                        page.draftRevisionId !== page.publishedRevisionId;
                      return (
                        <tr key={page.id}>
                          <td>
                            <div className="pages-file-cell">
                              <span className="pages-file-icon">
                                <FileIcon />
                              </span>
                              <div>
                                <a
                                  href={`${route}/${page.deletedAt ? "history" : "edit"}`}
                                  className="pages-file-title"
                                >
                                  {page.title}
                                </a>
                                <code>
                                  /{page.language}/{page.path}
                                </code>
                                {page.description && <p>{page.description}</p>}
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="pages-state-stack">
                              {page.deletedAt ? (
                                <span className="pages-badge deleted">
                                  {zh ? "已删除" : "Deleted"}
                                </span>
                              ) : (
                                <>
                                  {page.publishedRevisionId && (
                                    <span className="pages-badge published">
                                      {zh ? "已发布" : "Published"}
                                    </span>
                                  )}
                                  {hasDraft && (
                                    <span className="pages-badge draft">
                                      {page.publishedRevisionId
                                        ? zh
                                          ? "有新草稿"
                                          : "Draft changes"
                                        : zh
                                          ? "草稿"
                                          : "Draft"}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                          <td className="admin-date">
                            <time dateTime={page.updatedAt}>
                              {dateLabel(page.updatedAt, language)}
                            </time>
                          </td>
                          <td>
                            <div className="pages-row-actions">
                              {!page.deletedAt && (
                                <a href={`${route}/edit`}>
                                  {zh ? "编辑" : "Edit"}
                                </a>
                              )}
                              <a href={`${route}/history`}>
                                {zh ? "版本" : "History"}
                              </a>
                              <select
                                className="pages-action-select"
                                disabled={pending || busy || sessionBlocked}
                                aria-label={`${zh ? "更多操作：" : "More actions: "}${page.title}`}
                                defaultValue=""
                                onChange={(event) => {
                                  const action = event.currentTarget.value;
                                  event.currentTarget.value = "";
                                  if (action === "view")
                                    window.location.assign(
                                      publicPath(page.language, page.path),
                                    );
                                  else if (
                                    [
                                      "move",
                                      "delete",
                                      "restore",
                                      "unpublish",
                                    ].includes(action)
                                  )
                                    pageAction(action as PageAction, page);
                                }}
                              >
                                <option value="" disabled>
                                  {zh ? "操作" : "Actions"}
                                </option>
                                {page.deletedAt ? (
                                  <option value="restore">
                                    {zh ? "恢复页面" : "Restore page"}
                                  </option>
                                ) : (
                                  <>
                                    {page.publishedRevisionId && (
                                      <option value="view">
                                        {zh
                                          ? "查看公开页面"
                                          : "View published page"}
                                      </option>
                                    )}
                                    <option value="move">
                                      {zh
                                        ? "移动 / 重命名路径"
                                        : "Move / rename path"}
                                    </option>
                                    {page.publishedRevisionId && (
                                      <option value="unpublish">
                                        {zh ? "取消发布" : "Unpublish"}
                                      </option>
                                    )}
                                    <option value="delete">
                                      {zh ? "删除页面" : "Delete page"}
                                    </option>
                                  </>
                                )}
                              </select>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-empty">
                <FileIcon />
                <h3>
                  {filters.query
                    ? zh
                      ? "没有匹配的页面"
                      : "No matching pages"
                    : zh
                      ? "这里还没有页面"
                      : "No pages here yet"}
                </h3>
                <p>
                  {filters.query
                    ? zh
                      ? "换一个标题、路径或状态试试。"
                      : "Try another title, path or status."
                    : filters.status === "deleted"
                      ? zh
                        ? "删除的页面会保留在这里，随时可以恢复。"
                        : "Deleted pages appear here and can be restored."
                      : zh
                        ? "创建一篇文档，开始记录你的知识。"
                        : "Create a document to start sharing your knowledge."}
                </p>
              </div>
            )}
            {!failure && result && (
              <footer className="pages-pagination">
                <span>
                  {zh
                    ? `第 ${previous.length + 1} 页 · ${result.items.length} 个页面`
                    : `Page ${previous.length + 1} · ${result.items.length} pages`}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={loading || previous.length === 0}
                    onClick={() => {
                      const stack = [...previous];
                      const cursor = stack.pop() ?? null;
                      setPrevious(stack);
                      setFilters((value) => ({ ...value, cursor }));
                    }}
                  >
                    {zh ? "上一页" : "Previous"}
                  </button>
                  <button
                    type="button"
                    disabled={loading || !result.nextCursor}
                    onClick={() => {
                      if (!result.nextCursor) return;
                      setPrevious((value) => [...value, filters.cursor]);
                      setFilters((value) => ({
                        ...value,
                        cursor: result.nextCursor,
                      }));
                    }}
                  >
                    {zh ? "下一页" : "Next"}
                  </button>
                </div>
              </footer>
            )}
          </>
        )}
      </section>
      {selection && (
        <PageActionDialog
          key={`${selection.page.id}-${selection.kind}`}
          selection={selection}
          session={activeSession}
          language={language}
          sessionBlocked={sessionBlocked}
          onSessionRequired={sessionRequired}
          onSessionChange={updateSession}
          attempt={actionAttempt}
          onAttemptChange={setActionAttempt}
          onBusyChange={setBusy}
          onDirtyChange={setDirty}
          onClose={closeDialogs}
          onDone={(kind) => {
            closeDialogs();
            setNotice({ type: kind });
            refreshBoth();
          }}
        />
      )}
      {directory && (
        <DirectoryMoveDialog
          key={`${directory.language}:${directory.path}`}
          language={language}
          contentLanguage={directory.language}
          fromPath={directory.path}
          session={activeSession}
          sessionBlocked={sessionBlocked}
          onSessionRequired={sessionRequired}
          onSessionChange={updateSession}
          attempt={directoryAttempt}
          onAttemptChange={setDirectoryAttempt}
          onBusyChange={setBusy}
          onDirtyChange={setDirty}
          onClose={closeDialogs}
          onDone={(value) => {
            closeDialogs();
            setPaths((previousPaths) => ({
              ...previousPaths,
              [value.language]: value.toPath,
            }));
            setFilters((previousFilters) => ({
              ...previousFilters,
              language: value.language,
              cursor: null,
            }));
            setView("directories");
            setNotice({ type: "directory", count: value.items.length });
            refreshBoth();
          }}
          onReviewed={(confirmedPath) => {
            if (confirmedPath) {
              setPaths((previousPaths) => ({
                ...previousPaths,
                [directory.language]: confirmedPath,
              }));
              setFilters((previousFilters) => ({
                ...previousFilters,
                language: directory.language,
                cursor: null,
              }));
              setView("directories");
            }
            closeDialogs();
            refreshBoth();
            setNotice({ type: "review" });
          }}
        />
      )}
    </>
  );
}
