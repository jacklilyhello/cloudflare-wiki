import { useCallback, useEffect, useRef, useState } from "react";
import type { PageSummary } from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import { ApiError, request } from "./api";
import type { PageAction } from "./page-action-recovery";
import {
  adjacentDirectoryRead,
  type DirectoryRead,
  type DirectoryView,
  directoryBreadcrumbs,
  directoryQuery,
  firstDirectoryRead,
  PageDirectoryChanged,
  readDirectoryPage,
} from "./page-directory-model";
import "./page-directory.css";

export interface PageDirectoryBrowserProps {
  language: Language;
  contentLanguage: Language;
  path: string;
  onPathChange(path: string): void;
  refreshKey: number;
  actionsDisabled: boolean;
  onSessionRequired(): void;
  onPageAction(action: PageAction, page: PageSummary): void;
  onMoveDirectory(path: string): void;
}
type ReadError = "changed" | "session" | "missing" | "read";
type Loaded = { scope: string; view: DirectoryView };

function DirectoryIcon({ page = false }: { page?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          page
            ? "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"
            : "M3 7h7l2 2h9v11H3V5h7l2 2h7v2"
        }
      />
    </svg>
  );
}

function PageState({ page, zh }: { page: PageSummary; zh: boolean }) {
  return (
    <span className="page-directory-states">
      {page.publishedRevisionId && (
        <span className="page-directory-badge">
          {zh ? "已发布" : "Published"}
        </span>
      )}
      {page.draftRevisionId !== page.publishedRevisionId && (
        <span className="page-directory-badge draft">
          {page.publishedRevisionId
            ? zh
              ? "有新草稿"
              : "Draft changes"
            : zh
              ? "草稿"
              : "Draft"}
        </span>
      )}
    </span>
  );
}

function PageLinks({
  page,
  zh,
  disabled,
  onAction,
}: {
  page: PageSummary;
  zh: boolean;
  disabled: boolean;
  onAction(action: PageAction, page: PageSummary): void;
}) {
  const route = `/admin/pages/${encodeURIComponent(page.id)}`;
  return (
    <div className="page-directory-page-actions">
      <a href={`${route}/edit`}>{zh ? "编辑页面" : "Edit page"}</a>
      <a href={`${route}/history`}>{zh ? "版本历史" : "History"}</a>
      {page.publishedRevisionId && (
        <a href={publicPath(page.language, page.path)}>
          {zh ? "查看公开页面" : "View published"}
        </a>
      )}
      <select
        aria-label={`${zh ? "页面操作：" : "Page actions: "}${page.title}`}
        value=""
        disabled={disabled}
        onChange={(event) => {
          const action = event.currentTarget.value;
          if (
            !disabled &&
            (action === "move" || action === "delete" || action === "unpublish")
          )
            onAction(action, page);
        }}
      >
        <option value="" disabled>
          {zh ? "页面操作" : "Page actions"}
        </option>
        <option value="move">
          {zh ? "仅移动 / 重命名此页面" : "Move / rename this page only"}
        </option>
        {page.publishedRevisionId && (
          <option value="unpublish">
            {zh ? "取消发布此页面" : "Unpublish this page"}
          </option>
        )}
        <option value="delete">{zh ? "删除此页面" : "Delete this page"}</option>
      </select>
    </div>
  );
}

function errorText(error: ReadError, zh: boolean) {
  if (error === "changed")
    return zh
      ? "目录已发生变化，之前的分页已清除。请刷新后继续浏览。"
      : "The directory changed, so its previous pages were cleared. Refresh to continue.";
  if (error === "session")
    return zh
      ? "会话需要重新连接。请使用上方的重新连接按钮；当前目录已保留。"
      : "Reconnect your session using the controls above. Your directory is preserved.";
  if (error === "missing")
    return zh
      ? "此路径下已没有活动页面。你可以重试，或返回上级目录。"
      : "This path no longer contains active pages. Retry or return to its parent.";
  return zh
    ? "暂时无法读取目录。请重试；这不会更改页面。"
    : "The directory could not be read. Retry when ready; this does not change pages.";
}

export function PageDirectoryBrowser({
  language,
  contentLanguage,
  path,
  onPathChange,
  refreshKey,
  actionsDisabled,
  onSessionRequired,
  onPageAction,
  onMoveDirectory,
}: PageDirectoryBrowserProps) {
  const zh = language === "zh";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ReadError | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const sessionBlocked = useRef(false);
  const previousRefresh = useRef(refreshKey);
  const scopeKey = JSON.stringify([contentLanguage, path, refreshKey]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const sessionCallback = useRef(onSessionRequired);
  sessionCallback.current = onSessionRequired;
  const view = loaded?.scope === scopeKey ? loaded.view : null;
  let trail: ReturnType<typeof directoryBreadcrumbs> = [];
  try {
    trail = directoryBreadcrumbs(path);
  } catch {
    /* A failed read shows the invalid location without using it in links. */
  }

  const load = useCallback(
    async (read: DirectoryRead, explicit = false) => {
      active.current?.abort();
      const turn = ++generation.current;
      setLoaded(null);
      if (sessionBlocked.current && !explicit) {
        setBusy(false);
        setError("session");
        return;
      }
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError(null);
      const current = () =>
        !controller.signal.aborted &&
        generation.current === turn &&
        currentScope.current === scopeKey;
      try {
        const scope = { language: contentLanguage, path };
        const result = await request<unknown>(directoryQuery(scope, read), {
          signal: controller.signal,
        });
        if (!current()) return;
        const next = readDirectoryPage(result, scope, read);
        sessionBlocked.current = false;
        setLoaded({ scope: scopeKey, view: next });
      } catch (failure) {
        if (!current()) return;
        if (
          failure instanceof ApiError &&
          (failure.status === 401 || failure.status === 403)
        ) {
          sessionBlocked.current = true;
          setError("session");
          sessionCallback.current();
        } else if (
          failure instanceof PageDirectoryChanged ||
          (failure instanceof ApiError && failure.status === 412)
        )
          setError("changed");
        else if (failure instanceof ApiError && failure.status === 404)
          setError("missing");
        else setError("read");
      } finally {
        if (current()) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [contentLanguage, path, scopeKey],
  );

  useEffect(() => {
    const explicit = previousRefresh.current !== refreshKey;
    previousRefresh.current = refreshKey;
    void load(firstDirectoryRead(), explicit);
    return () => {
      active.current?.abort();
      generation.current++;
    };
  }, [load, refreshKey]);

  function navigate(next: string) {
    if (next === path) return;
    active.current?.abort();
    generation.current++;
    setLoaded(null);
    onPathChange(next);
  }
  function paginate(direction: "next" | "previous") {
    if (!view || busy) return;
    const next = adjacentDirectoryRead(view, direction);
    if (next) void load(next);
  }
  const page = view?.page;
  const mutationBlocked = actionsDisabled || busy || Boolean(error) || !page;
  const parent = trail.length > 1 ? (trail.at(-2)?.path ?? "") : "";
  return (
    <section
      className="page-directory"
      aria-label={zh ? "页面目录浏览器" : "Page directory browser"}
    >
      <div className="page-directory-toolbar">
        <nav
          className="page-directory-breadcrumbs"
          aria-label={zh ? "页面目录路径" : "Page directory path"}
        >
          <ol>
            <li>
              <button
                type="button"
                aria-current={path === "" ? "location" : undefined}
                onClick={() => navigate("")}
              >
                {zh ? "根目录" : "Root"}
              </button>
            </li>
            {trail.map((crumb) => (
              <li key={crumb.path}>
                <span aria-hidden="true">/</span>
                <button
                  type="button"
                  title={crumb.segment}
                  aria-current={crumb.path === path ? "location" : undefined}
                  onClick={() => navigate(crumb.path)}
                >
                  {crumb.segment}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <button
          type="button"
          className="page-directory-button"
          disabled={busy}
          onClick={() => void load(firstDirectoryRead(), true)}
        >
          {zh ? "刷新目录" : "Refresh"}
        </button>
      </div>
      <div className="page-directory-location">
        <div>
          <code>
            /{contentLanguage}
            {path ? `/${path}` : "/"}
          </code>
          <p>
            {zh
              ? "打开任一路径，即可在其中新建子页面。"
              : "Open any path to create child pages inside it."}
          </p>
        </div>
        {path && page && (
          <button
            type="button"
            className="page-directory-button"
            disabled={mutationBlocked}
            onClick={() => onMoveDirectory(path)}
          >
            {zh ? "移动整个目录" : "Move entire directory"}
          </button>
        )}
      </div>
      {error && (
        <div className="page-directory-error" role="alert">
          <p>{errorText(error, zh)}</p>
          <div>
            <button
              type="button"
              className="page-directory-button"
              disabled={busy}
              onClick={() => void load(firstDirectoryRead(), true)}
            >
              {error === "changed"
                ? zh
                  ? "刷新目录"
                  : "Refresh directory"
                : zh
                  ? "重试读取"
                  : "Retry read"}
            </button>
            {path && (
              <button
                type="button"
                className="page-directory-button"
                onClick={() => navigate(parent)}
              >
                {zh ? "返回上级" : "Go to parent"}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="page-directory-content" aria-busy={busy}>
        <p className="page-directory-count" role="status">
          {busy
            ? zh
              ? "正在读取目录…"
              : "Reading directory…"
            : page
              ? zh
                ? `第 ${(view?.read.previous.length ?? 0) + 1} 页 · ${page.items.length} 个项目`
                : `Page ${(view?.read.previous.length ?? 0) + 1} · ${page.items.length} items`
              : ""}
        </p>
        {page?.page && (
          <article className="page-directory-landing">
            <span className="page-directory-icon">
              <DirectoryIcon page />
            </span>
            <div className="page-directory-landing-body">
              <p className="page-directory-eyebrow">
                {zh ? "当前目录的页面" : "PAGE AT THIS PATH"}
              </p>
              <h2>{page.page.title}</h2>
              {page.page.description && (
                <p className="page-directory-description">
                  {page.page.description}
                </p>
              )}
              <PageState page={page.page} zh={zh} />
              <PageLinks
                page={page.page}
                zh={zh}
                disabled={mutationBlocked}
                onAction={onPageAction}
              />
            </div>
          </article>
        )}
        {page && !page.items.length && (
          <div className="page-directory-empty">
            <DirectoryIcon />
            <h3>{zh ? "还没有子页面" : "No child pages yet"}</h3>
            <p>
              {zh
                ? "使用上方的“新建页面”，开始在此目录中编写文档。"
                : "Use New page above to start a document in this directory."}
            </p>
          </div>
        )}
        {page && page.items.length > 0 && (
          <ul className="page-directory-list">
            {page.items.map((item) => (
              <li className="page-directory-row" key={item.path}>
                <div className="page-directory-node">
                  <span
                    className={`page-directory-icon${item.hasChildren ? " folder" : ""}`}
                  >
                    <DirectoryIcon page={!item.hasChildren} />
                  </span>
                  <div className="page-directory-node-copy">
                    <button
                      type="button"
                      className="page-directory-name"
                      onClick={() => navigate(item.path)}
                      title={item.segment}
                    >
                      {item.segment}
                    </button>
                    <p className="page-directory-kind">
                      {item.hasChildren
                        ? item.page
                          ? zh
                            ? "目录与页面"
                            : "Directory with page"
                          : zh
                            ? "目录"
                            : "Directory"
                        : zh
                          ? "页面 · 可添加子页面"
                          : "Page · can contain child pages"}
                    </p>
                    {item.page && (
                      <p className="page-directory-title">{item.page.title}</p>
                    )}
                    {item.page && <PageState page={item.page} zh={zh} />}
                  </div>
                  <button
                    type="button"
                    className="page-directory-open"
                    onClick={() => navigate(item.path)}
                    aria-label={`${zh ? "打开路径：" : "Open path: "}/${contentLanguage}/${item.path}`}
                  >
                    {zh ? "打开" : "Open"}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
                <div className="page-directory-row-actions">
                  {item.page && (
                    <PageLinks
                      page={item.page}
                      zh={zh}
                      disabled={mutationBlocked}
                      onAction={onPageAction}
                    />
                  )}
                  {item.hasChildren && (
                    <button
                      type="button"
                      className="page-directory-move"
                      disabled={mutationBlocked}
                      onClick={() => onMoveDirectory(item.path)}
                    >
                      {zh ? "移动整个目录" : "Move entire directory"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view && !error && (
        <footer className="page-directory-pagination">
          <span>
            {zh
              ? "目录与页面按路径排序"
              : "Directories and pages, ordered by path"}
          </span>
          <div>
            <button
              type="button"
              className="page-directory-button"
              disabled={busy || !view.read.previous.length}
              onClick={() => paginate("previous")}
            >
              {zh ? "上一页" : "Previous"}
            </button>
            <button
              type="button"
              className="page-directory-button"
              disabled={busy || !view.page.nextCursor}
              onClick={() => paginate("next")}
            >
              {zh ? "下一页" : "Next"}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}
