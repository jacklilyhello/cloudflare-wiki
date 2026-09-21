import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type {
  ContentDetail,
  ContentPage,
  PageSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import { ApiError, mutation, request } from "./api";
import "./pages.css";

type PageStatus = "active" | "draft" | "published" | "deleted";
type PageAction = "move" | "delete" | "restore" | "unpublish";
type Selection = { kind: PageAction; page: PageSummary };
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

function PageDialog({
  selection,
  session,
  language,
  onClose,
  onDone,
}: {
  selection: Selection;
  session: AuthSession;
  language: Language;
  onClose: () => void;
  onDone: (kind: PageAction) => void;
}) {
  const zh = language === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(selection.page);
  const [activeSession, setActiveSession] = useState(session);
  const [path, setPath] = useState(page.path);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const labels: Record<PageAction, string> = {
    move: zh ? "移动页面" : "Move page",
    delete: zh ? "删除页面" : "Delete page",
    restore: zh ? "恢复页面" : "Restore page",
    unpublish: zh ? "取消发布" : "Unpublish page",
  };
  const descriptions: Record<PageAction, string> = {
    move: zh
      ? "修改页面的路径。页面发布期间，原路径会直接转向新路径。"
      : "Change the page path. While the page is published, its previous paths redirect to the current path.",
    delete: zh
      ? "页面将立即从公开站点移除，草稿与版本历史会保留。你可以在“已删除”中恢复。"
      : "The page will disappear from the public wiki. Its draft and revision history are retained, and it can be restored from Deleted.",
    restore: zh
      ? "恢复此页面及其历史记录。恢复后保持未发布，检查内容后再发布。"
      : "Restore this page and its history. It remains unpublished until you review and publish it.",
    unpublish: zh
      ? "访客将无法阅读此页面。当前草稿与已保存的版本都会保留。"
      : "Readers will no longer be able to access this page. Its draft and saved revisions are retained.",
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const base = `pages/${encodeURIComponent(page.id)}`;
      await request(
        selection.kind === "delete" ? base : `${base}/${selection.kind}`,
        mutation(
          selection.kind === "delete" ? "DELETE" : "POST",
          {
            expectedVersion: page.version,
            ...(selection.kind === "move" ? { path } : {}),
          },
          activeSession.csrfToken,
        ),
      );
      onDone(selection.kind);
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
      const detail = await request<ContentDetail>(
        `pages/${encodeURIComponent(page.id)}`,
      );
      setPage({
        ...detail.translation,
        title: detail.draft.title,
        description: detail.draft.description,
        tags: detail.draft.tags,
      });
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
  const incompatible =
    selection.kind === "restore" ? !page.deletedAt : Boolean(page.deletedAt);
  return (
    <dialog
      ref={dialog}
      className="admin-content-dialog"
      aria-labelledby="page-action-title"
      aria-describedby="page-action-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="admin-dialog-heading">
          <span
            className={`admin-dialog-icon ${selection.kind === "delete" ? "danger" : ""}`}
          >
            <FileIcon />
          </span>
          <h2 id="page-action-title">{labels[selection.kind]}</h2>
        </div>
        <p id="page-action-description">{descriptions[selection.kind]}</p>
        <div className="admin-dialog-page">
          <strong>{page.title}</strong>
          <code>
            /{page.language}/{page.path}
          </code>
        </div>
        {refreshed && (
          <p className="admin-notice success" role="status">
            {zh
              ? "已读取最新状态，请重新确认页面与操作。"
              : "Latest state loaded. Review the page and confirm the action."}
          </p>
        )}
        {reconnected && (
          <p className="admin-notice success" role="status">
            {zh
              ? "已重新连接。输入已保留，请确认后再次提交。"
              : "Reconnected. Your input is preserved; review it and submit again."}
          </p>
        )}
        {failure !== null && (
          <div
            className={`admin-notice error${needsReconnect ? " content-session-notice" : ""}`}
            role="alert"
          >
            <span>
              {needsReconnect
                ? zh
                  ? "登录状态已变化。请在新窗口登录，再重新连接；本次输入已保留。"
                  : "Your session has changed. Sign in in a new tab, then reconnect. Your input is preserved."
                : failureMessage(failure, zh)}
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
                onClick={() => void latest()}
                disabled={busy}
              >
                {zh ? "读取最新状态" : "Load latest"}
              </button>
            )}
          </div>
        )}
        {incompatible && (
          <p className="admin-notice error" role="alert">
            {zh
              ? "当前页面状态不支持此操作，请关闭并刷新列表。"
              : "The page no longer supports this action. Close this dialog and refresh the list."}
          </p>
        )}
        <fieldset disabled={busy || incompatible}>
          {selection.kind === "move" && (
            <label className="admin-field" htmlFor="move-path">
              <span>{zh ? "新路径" : "New path"}</span>
              <div className="admin-path-input">
                <span>/{page.language}/</span>
                <input
                  id="move-path"
                  type="text"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  required
                  maxLength={240}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <small>
                {zh
                  ? "例如 guides/开始使用。使用小写字母、数字、中文、下划线、连字符与 /。"
                  : "For example guides/getting-started. Use lowercase letters, numbers, underscores, hyphens and /; Unicode letters are supported."}
              </small>
            </label>
          )}
          <div className="admin-dialog-actions">
            <button
              className="admin-button secondary"
              type="button"
              onClick={onClose}
            >
              {zh ? "取消" : "Cancel"}
            </button>
            <button
              className={`admin-button ${selection.kind === "delete" ? "danger" : ""}`}
              type="submit"
            >
              {busy ? (zh ? "处理中…" : "Working…") : labels[selection.kind]}
            </button>
          </div>
        </fieldset>
        {incompatible && (
          <button
            className="admin-button secondary"
            type="button"
            onClick={onClose}
          >
            {zh ? "关闭" : "Close"}
          </button>
        )}
      </form>
    </dialog>
  );
}

export function PagesPage({
  language,
  session,
  onExpired,
}: {
  language: Language;
  session: AuthSession;
  onExpired: () => void;
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<PageAction | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the authoritative list after a mutation or manual retry.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
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
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, refresh, onExpired]);
  function filter(next: Partial<Filters>) {
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
        <a
          className="admin-button pages-new-button"
          href={`/admin/pages/new?language=${filters.language}`}
        >
          <span aria-hidden="true">＋</span>
          {zh ? "新建页面" : "New page"}
        </a>
      </div>
      {notice && (
        <div className="admin-notice success" role="status">
          <span>{notices[notice]}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={zh ? "关闭提示" : "Dismiss notification"}
          >
            ×
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
                filter({ language: event.target.value as Language })
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
            {statuses.map((status) => (
              <button
                type="button"
                key={status.id}
                aria-pressed={filters.status === status.id}
                onClick={() => filter({ status: status.id })}
              >
                {status.label}
              </button>
            ))}
          </fieldset>
          <button
            className="pages-refresh"
            type="button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? (zh ? "读取中…" : "Loading…") : zh ? "刷新" : "Refresh"}
          </button>
        </div>
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
                    <span className="sr-only">{zh ? "操作" : "Actions"}</span>
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
                            <a href={`${route}/edit`}>{zh ? "编辑" : "Edit"}</a>
                          )}
                          <a href={`${route}/history`}>
                            {zh ? "版本" : "History"}
                          </a>
                          <select
                            className="pages-action-select"
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
                                setSelection({
                                  kind: action as PageAction,
                                  page,
                                });
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
      </section>
      {selection && (
        <PageDialog
          key={`${selection.page.id}-${selection.kind}`}
          selection={selection}
          session={session}
          language={language}
          onClose={() => setSelection(null)}
          onDone={(kind) => {
            setSelection(null);
            setNotice(kind);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
