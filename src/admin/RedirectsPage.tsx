import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import {
  CONTENT_LIMITS,
  type ContentPage,
  type PageSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import {
  REDIRECT_LIMITS,
  type RedirectDocument,
  type RedirectEntry,
  type RedirectOrigin,
} from "../../shared/redirects";
import { ApiError, mutation, request } from "./api";
import "./redirects.css";

type Selection =
  | { kind: "create" }
  | { kind: "edit" | "delete"; entry: RedirectEntry };
type Target = Pick<
  RedirectEntry,
  "translationId" | "targetTitle" | "targetPath" | "targetStatus"
>;
type Filters = { language: Language; origin: "" | RedirectOrigin; q: string };
function pathLabel(language: Language, path: string) {
  return `/${language}/${path}`;
}
function RedirectIcon() {
  return (
    <svg
      className="redirect-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19v-7a5 5 0 0 1 5-5h10m-5-5 5 5-5 5M4 16h4" />
    </svg>
  );
}
function statusLabel(status: RedirectEntry["targetStatus"], zh: boolean) {
  return status === "published"
    ? zh
      ? "生效中"
      : "Active"
    : status === "deleted"
      ? zh
        ? "目标已删除 · 404"
        : "Target deleted · 404"
      : zh
        ? "目标未发布 · 404"
        : "Unpublished target · 404";
}
function errorLabel(error: unknown, zh: boolean) {
  if (error instanceof ApiError) {
    if ([401, 403].includes(error.status))
      return zh
        ? "登录状态已变化。输入已保留，请在新标签页登录后重新连接。"
        : "Your session has changed. Your input is preserved. Sign in in a new tab, then reconnect.";
    if (error.status === 412)
      return zh
        ? "此语言的重定向已被修改。输入已保留，请读取最新状态并核对后手动提交。"
        : "Redirects for this language changed elsewhere. Your input is preserved. Load the latest state, review it and submit manually.";
    if (error.status === 409)
      return zh
        ? "这个路径已被占用、已成为文章当前路径，或目标已删除。请检查来源路径和目标页面。"
        : "The path is occupied, is now a page's current path, or the target was deleted. Check the source and target.";
    if (error.status === 404)
      return zh
        ? "这个别名或目标已不存在，请重新读取列表。你的输入仍在。"
        : "This alias or target no longer exists. Reload the list. Your input is still here.";
    if (error.status === 400)
      return zh
        ? "请检查路径格式，并选择同语言的目标页面。"
        : "Check the path format and choose a page in the same language.";
  }
  return zh
    ? "暂时无法完成操作，请重试。"
    : "This operation could not be completed. Please retry.";
}
function isAuthFailure(error: unknown) {
  return error instanceof ApiError && [401, 403].includes(error.status);
}
function validPath(value: string) {
  return (
    value.length <= CONTENT_LIMITS.path &&
    value === value.normalize("NFKC") &&
    value === value.toLowerCase() &&
    /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value) &&
    ![
      "search",
      "admin",
      "api",
      "assets",
      "health",
      "robots.txt",
      "sitemap.xml",
    ].includes(value.split("/")[0] ?? "")
  );
}
function SessionActions({
  zh,
  busy,
  onReconnect,
}: {
  zh: boolean;
  busy: boolean;
  onReconnect: () => void;
}) {
  return (
    <div className="content-session-actions">
      <a
        href="/admin"
        target="_blank"
        rel="noopener noreferrer"
        className="admin-button secondary"
      >
        {zh ? "在新标签页登录" : "Sign in in a new tab"}
      </a>
      <button
        className="admin-button secondary"
        type="button"
        disabled={busy}
        onClick={onReconnect}
      >
        {busy
          ? zh
            ? "正在连接…"
            : "Connecting…"
          : zh
            ? "重新连接"
            : "Reconnect"}
      </button>
    </div>
  );
}
function TargetPicker({
  language,
  zh,
  disabled,
  selectedId,
  onChoose,
  onFailure,
  retryKey,
}: {
  retryKey: number;
  language: Language;
  zh: boolean;
  disabled: boolean;
  selectedId?: string;
  onChoose: (target: Target) => void;
  onFailure: (error: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PageSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit read-only retry.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    pending.current = true;
    setLoading(true);
    setFailure(null);
    setItems([]);
    setCursor(null);
    const timer = window.setTimeout(() => {
      request<ContentPage<PageSummary>>(
        `pages?${new URLSearchParams({ language, status: "active", q: query, limit: "20" })}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setItems(result.items);
            setCursor(result.nextCursor);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setFailure(error);
            if (isAuthFailure(error)) onFailureRef.current(error);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            pending.current = false;
            setLoading(false);
          }
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [language, query, attempt, retryKey]);
  async function more() {
    const controller = controllerRef.current;
    if (!cursor || !controller || controller.signal.aborted || pending.current)
      return;
    pending.current = true;
    setLoading(true);
    setFailure(null);
    try {
      const result = await request<ContentPage<PageSummary>>(
        `pages?${new URLSearchParams({ language, status: "active", q: query, limit: "20", cursor })}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setItems((current) => [...current, ...result.items]);
        setCursor(result.nextCursor);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(error);
        if (isAuthFailure(error)) onFailureRef.current(error);
      }
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setLoading(false);
      }
    }
  }
  return (
    <div className="redirect-picker">
      <label className="admin-field">
        <span>{zh ? "搜索目标页面" : "Find a target page"}</span>
        <input
          type="search"
          value={query}
          maxLength={CONTENT_LIMITS.query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder={zh ? "搜索标题或路径…" : "Search titles or paths…"}
        />
      </label>
      <ul aria-busy={loading}>
        {items.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              disabled={disabled || loading}
              aria-pressed={selectedId === page.id}
              onClick={() =>
                onChoose({
                  translationId: page.id,
                  targetTitle: page.title,
                  targetPath: page.path,
                  targetStatus: page.publishedRevisionId
                    ? "published"
                    : "draft",
                })
              }
            >
              <span>
                <strong>{page.title}</strong>
                <code>{pathLabel(language, page.path)}</code>
              </span>
              <small>
                {selectedId === page.id
                  ? zh
                    ? "已选择"
                    : "Selected"
                  : page.publishedRevisionId
                    ? zh
                      ? "已发布"
                      : "Published"
                    : zh
                      ? "草稿"
                      : "Draft"}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {failure != null ? (
        <p className="redirect-picker-message" role="alert">
          {errorLabel(failure, zh)}{" "}
          {!isAuthFailure(failure) && (
            <button
              type="button"
              disabled={disabled || loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {zh ? "重试" : "Retry"}
            </button>
          )}
        </p>
      ) : loading ? (
        <p className="redirect-picker-message" role="status">
          {zh ? "正在查找页面…" : "Finding pages…"}
        </p>
      ) : !items.length ? (
        <p className="redirect-picker-message">
          {zh ? "没有匹配的页面。" : "No matching pages."}
        </p>
      ) : null}
      {cursor && (
        <button
          className="redirect-text-button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void more()}
        >
          {zh ? "加载更多页面" : "Load more pages"}
        </button>
      )}
    </div>
  );
}

function RedirectDialog({
  selection,
  document,
  session,
  language,
  onSessionChange,
  onClose,
  onDone,
}: {
  selection: Selection;
  document: RedirectDocument;
  session: AuthSession;
  language: Language;
  onSessionChange: (session: AuthSession) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const zh = language === "zh";
  const entry = selection.kind === "create" ? null : selection.entry;
  const contentLanguage = document.language;
  const [path, setPath] = useState(entry?.path ?? "");
  const [target, setTarget] = useState<Target | null>(entry);
  const [version, setVersion] = useState(document.version);
  const [activeSession, setActiveSession] = useState(session);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [conflicted, setConflicted] = useState(false);
  const [latest, setLatest] = useState<RedirectDocument | null>(null);
  const [latestSource, setLatestSource] = useState<string | null>(null);
  const [unconfirmedSource, setUnconfirmedSource] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<"reconnected" | null>(null);
  const [picker, setPicker] = useState(!entry);
  const [pickerAttempt, setPickerAttempt] = useState(0);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [validation, setValidation] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const operation = useRef<AbortController | null>(null);
  const dirty =
    selection.kind !== "delete" &&
    (path !== (entry?.path ?? "") ||
      target?.translationId !== entry?.translationId);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const authFailure = isAuthFailure(failure);
  const latestEntry = latest?.items.find(
    (value) => value.path === latestSource,
  );
  const creationFound = selection.kind === "create" && Boolean(latestEntry);
  useEffect(() => {
    previousFocus.current =
      window.document.activeElement instanceof HTMLElement
        ? window.document.activeElement
        : null;
    dialog.current?.showModal();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const beforeSignout = (event: Event) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("wiki:before-signout", beforeSignout);
    return () => {
      operation.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("wiki:before-signout", beforeSignout);
      if (previousFocus.current?.isConnected)
        previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  function close() {
    if (busy) return;
    if (dirty) setCloseConfirm(true);
    else onClose();
  }
  async function run(kind: "save" | "reconnect" | "latest") {
    if (busy || operation.current) return;
    if (
      kind === "save" &&
      selection.kind !== "delete" &&
      (!validPath(path) || !target || target.targetStatus === "deleted")
    ) {
      setValidation(true);
      return;
    }
    if (
      kind === "save" &&
      (authFailure ||
        conflicted ||
        unconfirmedSource ||
        creationFound ||
        closeConfirm)
    )
      return;
    const sourceToCheck = entry?.path ?? unconfirmedSource ?? path;
    if (kind === "latest" && !validPath(sourceToCheck)) {
      setValidation(true);
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      if (kind === "reconnect") {
        const result = await request<{ session: AuthSession }>("session", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setActiveSession(result.session);
        onSessionChange(result.session);
        setNotice("reconnected");
        setPickerAttempt((value) => value + 1);
      } else if (kind === "latest") {
        const query = new URLSearchParams({
          limit: "1",
          sourcePath: sourceToCheck,
        });
        const result = await request<RedirectDocument>(
          `redirects/${contentLanguage}?${query}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setLatest(result);
        setLatestSource(sourceToCheck);
        setVersion(result.version);
        setUnconfirmedSource(null);
        setConflicted(
          Boolean(
            entry && !result.items.some((item) => item.path === entry.path),
          ),
        );
      } else {
        const body =
          selection.kind === "delete"
            ? { expectedVersion: version, sourcePath: entry?.path }
            : {
                expectedVersion: version,
                path,
                translationId: target?.translationId,
                ...(selection.kind === "edit"
                  ? { sourcePath: entry?.path }
                  : {}),
              };
        await request(`redirects/${contentLanguage}`, {
          ...mutation(
            selection.kind === "create"
              ? "POST"
              : selection.kind === "edit"
                ? "PUT"
                : "DELETE",
            body,
            activeSession.csrfToken,
          ),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) onDone();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (
          kind === "save" &&
          (!(error instanceof ApiError) || error.status >= 500)
        ) {
          setUnconfirmedSource(entry?.path ?? path);
          setLatest(null);
          setLatestSource(null);
        } else setFailure(error);
        if (error instanceof ApiError && error.status === 412)
          setConflicted(true);
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="redirect-dialog"
      aria-labelledby="redirect-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("save");
        }}
      >
        <div className="redirect-dialog-heading">
          <span
            className={`redirect-dialog-symbol ${selection.kind === "delete" ? "danger" : ""}`}
          >
            <RedirectIcon />
          </span>
          <div>
            <span className="admin-eyebrow">
              {contentLanguage === "zh"
                ? "中文 / REDIRECT"
                : "ENGLISH / REDIRECT"}
            </span>
            <h2 id="redirect-dialog-title">
              {selection.kind === "create"
                ? zh
                  ? "创建重定向"
                  : "Create a redirect"
                : selection.kind === "edit"
                  ? zh
                    ? "编辑重定向"
                    : "Edit redirect"
                  : zh
                    ? "删除这个别名？"
                    : "Delete this alias?"}
            </h2>
          </div>
        </div>
        <p className="redirect-dialog-description">
          {selection.kind === "delete"
            ? zh
              ? "删除后，原地址将无法访问。目标文章及其当前路径不会被删除。"
              : "The old address will stop working. The article and its current path are not deleted."
            : zh
              ? "将一个旧地址直接指向同语言文章。文章移动后，重定向会继续跟随它的当前路径。"
              : "Send an old address directly to a page in the same language. Redirects follow the page's current path when it moves."}
        </p>
        {entry && (
          <div className="redirect-original">
            <span>
              {zh ? "打开表单时的别名" : "Alias when this form was opened"}
            </span>
            <code>{pathLabel(contentLanguage, entry.path)}</code>
            <span aria-hidden="true">→</span>
            <code>{pathLabel(contentLanguage, entry.targetPath)}</code>
            <small>
              {entry.origin === "automatic"
                ? zh
                  ? "由页面移动自动创建"
                  : "Created automatically by a page move"
                : zh
                  ? "手动创建"
                  : "Created manually"}
            </small>
          </div>
        )}
        {(failure != null || conflicted || unconfirmedSource) && (
          <div
            className="admin-notice error content-session-notice"
            role="alert"
          >
            {unconfirmedSource && (
              <span>
                {zh
                  ? "操作结果尚无法确认，可能已经完成。输入已保留，再次提交已暂停；请先读取最新状态并核对。"
                  : "The outcome is unconfirmed and the operation may have completed. Your input is preserved and submission is paused. Load the latest state to check it first."}
              </span>
            )}
            {(failure != null || conflicted) && (
              <span>{errorLabel(failure ?? new ApiError(412), zh)}</span>
            )}
            {authFailure && (
              <SessionActions
                zh={zh}
                busy={busy}
                onReconnect={() => void run("reconnect")}
              />
            )}
            {(conflicted || unconfirmedSource) && (
              <button
                type="button"
                className="admin-button secondary"
                disabled={busy || authFailure}
                onClick={() => void run("latest")}
              >
                {zh ? "读取最新状态" : "Load latest state"}
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="admin-notice success" role="status">
            {zh
              ? "已重新连接，输入和版本条件未变。核对后再手动提交。"
              : "Reconnected. Your input and version condition are unchanged. Review them before submitting."}
          </div>
        )}
        {latest && (
          <div className="redirect-latest" role="status">
            <strong>
              {zh
                ? "已读取最新目录版本，请重新确认"
                : "Latest registry version loaded. Review before submitting."}
            </strong>
            <p>
              {zh
                ? "输入仍保留。请与当前记录核对，系统不会自动重新提交。"
                : "Your input is preserved. Compare it with the current record; nothing is automatically resubmitted."}
            </p>
            {latestEntry ? (
              <>
                <code>
                  {pathLabel(contentLanguage, latestEntry.path)} →{" "}
                  {pathLabel(contentLanguage, latestEntry.targetPath)}
                </code>
                <p>
                  {latestEntry.targetTitle} ·{" "}
                  {statusLabel(latestEntry.targetStatus, zh)}
                </p>
                <p>
                  {latestEntry.origin === "automatic"
                    ? zh
                      ? "自动创建"
                      : "Created automatically"
                    : zh
                      ? "手动创建"
                      : "Created manually"}{" "}
                  ·{" "}
                  <time dateTime={latestEntry.createdAt}>
                    {new Date(latestEntry.createdAt).toLocaleString(
                      language === "zh" ? "zh-CN" : "en-GB",
                    )}
                  </time>
                </p>
                {creationFound && (
                  <p>
                    {zh
                      ? "此来源已存在别名，不能再次创建。请关闭并刷新列表，核对结果；如需更改，请打开该别名的编辑操作。"
                      : "An alias already exists at this source. Creating it again is blocked. Close and refresh the list to review it, then use Edit if changes are needed."}
                  </p>
                )}
              </>
            ) : (
              <p>
                {entry
                  ? zh
                    ? "原别名已被移除或成为文章当前路径，不能在此继续提交。请关闭并刷新列表；如需新别名，请使用新建操作。"
                    : "The original alias was removed or became a current page path. This form cannot submit it. Close and refresh the list; use New redirect if you need a new alias."
                  : zh
                    ? `未找到来源 ${pathLabel(contentLanguage, latestSource ?? path)} 的别名。请核对输入后手动提交；文章当前路径仍受保护。`
                    : `No alias was found at ${pathLabel(contentLanguage, latestSource ?? path)}. Review your input before submitting manually; current page paths remain protected.`}
              </p>
            )}
          </div>
        )}
        {selection.kind !== "delete" && (
          <fieldset disabled={busy} className="redirect-form-fields">
            <label className="admin-field">
              <span>{zh ? "来源路径" : "Source path"}</span>
              <div className="redirect-path-input">
                <span>/{contentLanguage}/</span>
                <input
                  value={path}
                  required
                  maxLength={CONTENT_LIMITS.path}
                  onChange={(event) => setPath(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={zh ? "guides/旧地址" : "guides/old-address"}
                />
              </div>
              <small>
                {zh
                  ? "使用小写字母、数字、中文、下划线、连字符和 /。不要填写域名、语言前缀、查询参数或 #。"
                  : "Use lowercase letters, numbers, Unicode letters, underscores, hyphens and /. Omit the domain, language prefix, query and #."}
              </small>
            </label>
            {entry && path !== entry.path && (
              <p className="redirect-change-warning">
                {zh
                  ? "更改来源会替换原别名，不会额外保留原地址。"
                  : "Changing the source replaces this alias. The previous address is not retained."}
              </p>
            )}
            <div className="redirect-target-heading">
              <span>{zh ? "目标页面" : "Target page"}</span>
              {target && (
                <button
                  className="redirect-text-button"
                  type="button"
                  onClick={() => setPicker((value) => !value)}
                >
                  {picker
                    ? zh
                      ? "收起选择器"
                      : "Hide picker"
                    : zh
                      ? "更换目标"
                      : "Change target"}
                </button>
              )}
            </div>
            {target && (
              <div className="redirect-target-card">
                <strong>{target.targetTitle}</strong>
                <code>{pathLabel(contentLanguage, target.targetPath)}</code>
                <span className={`redirect-status ${target.targetStatus}`}>
                  {statusLabel(target.targetStatus, zh)}
                </span>
              </div>
            )}
            {picker && (
              <TargetPicker
                retryKey={pickerAttempt}
                language={contentLanguage}
                zh={zh}
                disabled={busy}
                selectedId={target?.translationId}
                onChoose={(next) => {
                  setTarget(next);
                  setPicker(false);
                }}
                onFailure={setFailure}
              />
            )}
            {target && target.targetStatus !== "published" && (
              <p className="redirect-change-warning">
                {target.targetStatus === "deleted"
                  ? zh
                    ? "目标已删除，请选择另一个页面。你也可以删除此别名。"
                    : "This target was deleted. Choose another page or delete the alias."
                  : zh
                    ? "目标尚未发布。可以保存别名，但访问它会返回 404，直到目标发布。"
                    : "The target is unpublished. You can save this alias, but it returns 404 until the target is published."}
              </p>
            )}
            {validation && (
              <div className="admin-notice error" role="alert">
                {zh
                  ? "请填写有效的来源路径，并选择一个未删除的同语言页面。"
                  : "Enter a valid source path and choose a non-deleted page in this language."}
              </div>
            )}
          </fieldset>
        )}
        {closeConfirm ? (
          <div className="redirect-close-confirm" role="alert">
            <p>{zh ? "丢弃尚未提交的输入？" : "Discard your unsaved input?"}</p>
            <div>
              <button
                className="admin-button secondary"
                type="button"
                onClick={() => setCloseConfirm(false)}
              >
                {zh ? "继续编辑" : "Keep editing"}
              </button>
              <button
                className="admin-button danger"
                type="button"
                onClick={onClose}
              >
                {zh ? "丢弃并关闭" : "Discard and close"}
              </button>
            </div>
          </div>
        ) : (
          <fieldset className="redirect-dialog-actions" disabled={busy}>
            <button
              className="admin-button secondary"
              type="button"
              onClick={close}
            >
              {zh ? "取消" : "Cancel"}
            </button>
            <button
              className={`admin-button ${selection.kind === "delete" ? "danger" : ""}`}
              type="submit"
              disabled={
                conflicted ||
                authFailure ||
                unconfirmedSource !== null ||
                creationFound ||
                (selection.kind !== "delete" &&
                  target?.targetStatus === "deleted")
              }
            >
              {busy
                ? zh
                  ? "正在处理…"
                  : "Working…"
                : selection.kind === "delete"
                  ? zh
                    ? "删除别名"
                    : "Delete alias"
                  : zh
                    ? "保存重定向"
                    : "Save redirect"}
            </button>
          </fieldset>
        )}
        <p className="redirect-dialog-footnote">
          {zh
            ? "成功保存后立即生效。当前文章路径受保护，只能在页面管理中移动。"
            : "Saved changes apply immediately. Current page paths are protected; move a page from Pages instead."}
        </p>
      </form>
    </dialog>
  );
}

export function RedirectsPage({
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
    origin: "",
    q: "",
  });
  const [search, setSearch] = useState("");
  const [document, setDocument] = useState<RedirectDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [failedMore, setFailedMore] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<"saved" | "reconnected" | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const reconnectRef = useRef<AbortController | null>(null);
  const requestPending = useRef(false);
  const lastQuery = useRef<string | null>(null);
  const params = new URLSearchParams({
    limit: String(REDIRECT_LIMITS.defaultPage),
    ...(filters.origin ? { origin: filters.origin } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  });
  const query = `redirects/${filters.language}?${params}`;
  const authFailure = isAuthFailure(failure);
  const listStale = failure instanceof ApiError && failure.status === 412;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit refresh or a completed mutation.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    requestPending.current = true;
    if (lastQuery.current !== query) setDocument(null);
    lastQuery.current = query;
    setLoading(true);
    setLoadingMore(false);
    setFailure(null);
    setFailedMore(false);
    request<RedirectDocument>(query, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setDocument(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          requestPending.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [query, attempt]);
  useEffect(() => () => reconnectRef.current?.abort(), []);
  async function more() {
    const controller = controllerRef.current;
    if (
      !document?.nextCursor ||
      !controller ||
      controller.signal.aborted ||
      requestPending.current
    )
      return;
    requestPending.current = true;
    setLoadingMore(true);
    setFailure(null);
    setFailedMore(false);
    try {
      const result = await request<RedirectDocument>(
        `${query}&cursor=${encodeURIComponent(document.nextCursor)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        if (result.version !== document.version) {
          setFailure(new ApiError(412));
          return;
        }
        setDocument((current) =>
          current
            ? {
                ...result,
                items: [
                  ...current.items,
                  ...result.items.filter(
                    (item) =>
                      !current.items.some(
                        (previous) => previous.path === item.path,
                      ),
                  ),
                ],
              }
            : result,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(error);
        setFailedMore(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        requestPending.current = false;
        setLoadingMore(false);
      }
    }
  }
  async function reconnect() {
    if (busy || reconnectRef.current) return;
    const controller = new AbortController();
    reconnectRef.current = controller;
    setBusy(true);
    try {
      const result = await request<{ session: AuthSession }>("session", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        onSessionChange(result.session);
        setFailure(null);
        setNotice("reconnected");
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      if (reconnectRef.current === controller) reconnectRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function filter(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }));
    setNotice(null);
  }
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    filter({ q: search.trim() });
    setAttempt((value) => value + 1);
  }
  const retry = () =>
    failedMore ? void more() : setAttempt((value) => value + 1);
  return (
    <div className="redirect-workspace">
      <header className="redirect-page-heading">
        <div>
          <span className="admin-eyebrow">MANAGEMENT / REDIRECTS</span>
          <h1>
            {zh ? "让旧链接，找到新方向" : "Give old links a new direction"}
          </h1>
          <p>
            {zh
              ? "管理文章别名，让已有链接继续到达正确的内容。"
              : "Manage page aliases so existing links keep reaching the right content."}
          </p>
        </div>
        <button
          className="admin-button"
          type="button"
          disabled={
            loading ||
            loadingMore ||
            !document ||
            document.language !== filters.language ||
            authFailure ||
            listStale
          }
          onClick={() => setSelection({ kind: "create" })}
        >
          <span aria-hidden="true">＋</span>
          {zh ? "新建重定向" : "New redirect"}
        </button>
      </header>
      <section
        className="redirect-list-panel admin-panel"
        aria-label={zh ? "重定向列表" : "Redirect list"}
      >
        <div className="redirect-toolbar">
          <form className="redirect-search" onSubmit={submitSearch}>
            <label>
              <span className="redirect-sr-only">
                {zh ? "搜索来源路径" : "Search source paths"}
              </span>
              <input
                type="search"
                value={search}
                maxLength={REDIRECT_LIMITS.query}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={zh ? "搜索来源路径…" : "Search source paths…"}
              />
            </label>
            <button type="submit">{zh ? "搜索" : "Search"}</button>
          </form>
          <label className="redirect-language">
            <span>{zh ? "内容语言" : "Content language"}</span>
            <select
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
        <div className="redirect-filterbar">
          <fieldset aria-label={zh ? "创建来源" : "Creation origin"}>
            {(["", "automatic", "manual"] as const).map((origin) => (
              <button
                key={origin}
                type="button"
                aria-pressed={filters.origin === origin}
                onClick={() => filter({ origin })}
              >
                {origin === ""
                  ? zh
                    ? "全部别名"
                    : "All aliases"
                  : origin === "automatic"
                    ? zh
                      ? "自动创建"
                      : "Automatic"
                    : zh
                      ? "手动创建"
                      : "Manual"}
              </button>
            ))}
          </fieldset>
          <button
            className="redirect-text-button"
            type="button"
            disabled={loading || loadingMore || busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {zh ? "刷新" : "Refresh"}
          </button>
        </div>
        {failure != null && (
          <div
            className="redirect-list-notice admin-notice error content-session-notice"
            role="alert"
          >
            <span>{errorLabel(failure, zh)}</span>
            {authFailure ? (
              <SessionActions
                zh={zh}
                busy={busy}
                onReconnect={() => void reconnect()}
              />
            ) : (
              <button
                type="button"
                className="admin-button secondary"
                disabled={loading || loadingMore}
                onClick={
                  failure instanceof ApiError && failure.status === 412
                    ? () => setAttempt((value) => value + 1)
                    : retry
                }
              >
                {zh ? "重新读取" : "Reload"}
              </button>
            )}
          </div>
        )}
        {notice && (
          <div
            className="redirect-list-notice admin-notice success"
            role="status"
          >
            {notice === "saved" ? (
              zh ? (
                "重定向已更新。"
              ) : (
                "Redirects updated."
              )
            ) : (
              <>
                <span>
                  {zh
                    ? "已重新连接，筛选条件已保留。"
                    : "Reconnected. Your filters are preserved."}
                </span>
                <button
                  className="redirect-text-button"
                  type="button"
                  onClick={retry}
                >
                  {zh ? "继续读取" : "Continue loading"}
                </button>
              </>
            )}
          </div>
        )}
        <div aria-busy={loading || loadingMore}>
          {loading && !document ? (
            <div className="redirect-empty" role="status">
              <span className="admin-spinner" />
              <p>{zh ? "正在读取重定向…" : "Loading redirects…"}</p>
            </div>
          ) : document?.items.length ? (
            <ul className="redirect-list">
              {document.items.map((entry) => (
                <li key={entry.path}>
                  <div className="redirect-entry-icon">
                    <RedirectIcon />
                  </div>
                  <div className="redirect-entry-main">
                    <div className="redirect-entry-source">
                      <code>{pathLabel(document.language, entry.path)}</code>
                      <span className="redirect-origin">
                        {entry.origin === "automatic"
                          ? zh
                            ? "自动"
                            : "Automatic"
                          : zh
                            ? "手动"
                            : "Manual"}
                      </span>
                    </div>
                    <div className="redirect-entry-target">
                      <span aria-hidden="true">↳</span>
                      <div>
                        <strong>{entry.targetTitle}</strong>
                        <code>
                          {pathLabel(document.language, entry.targetPath)}
                        </code>
                      </div>
                    </div>
                    <span className={`redirect-status ${entry.targetStatus}`}>
                      {statusLabel(entry.targetStatus, zh)}
                    </span>
                  </div>
                  <div className="redirect-entry-actions">
                    {entry.targetStatus === "published" && (
                      <a
                        className="redirect-test-link"
                        href={publicPath(document.language, entry.path)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {zh ? "检查链接 ↗" : "Check link ↗"}
                      </a>
                    )}
                    <button
                      type="button"
                      disabled={
                        loading ||
                        loadingMore ||
                        authFailure ||
                        listStale ||
                        document.language !== filters.language
                      }
                      onClick={() => setSelection({ kind: "edit", entry })}
                    >
                      {zh ? "编辑" : "Edit"}
                    </button>
                    <button
                      className="danger"
                      type="button"
                      disabled={
                        loading ||
                        loadingMore ||
                        authFailure ||
                        listStale ||
                        document.language !== filters.language
                      }
                      onClick={() => setSelection({ kind: "delete", entry })}
                    >
                      {zh ? "删除" : "Delete"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="redirect-empty">
              <RedirectIcon />
              <h2>
                {failure
                  ? zh
                    ? "列表暂不可用"
                    : "The list is unavailable"
                  : zh
                    ? "没有匹配的别名"
                    : "No matching aliases"}
              </h2>
              <p>
                {zh
                  ? "页面移动时会自动保留旧地址，你也可以手动创建别名。"
                  : "Moving a page preserves its old address. You can also create aliases manually."}
              </p>
            </div>
          )}
        </div>
        {document && (
          <footer className="redirect-list-footer">
            <span>
              {zh
                ? `已载入 ${document.items.length} 个别名`
                : `${document.items.length} aliases loaded`}
            </span>
            {document.nextCursor && (
              <button
                className="admin-button secondary"
                type="button"
                disabled={
                  loading ||
                  loadingMore ||
                  authFailure ||
                  listStale ||
                  document.language !== filters.language
                }
                onClick={() => void more()}
              >
                {loadingMore
                  ? zh
                    ? "正在读取…"
                    : "Loading…"
                  : zh
                    ? "加载更多"
                    : "Load more"}
              </button>
            )}
          </footer>
        )}
      </section>
      <p className="redirect-note">
        {zh
          ? "这里只列出别名，不包含文章的当前路径。自动与手动表示创建来源，两种别名都可以编辑或删除。目标未发布或已删除时，别名返回 404。"
          : "This list contains aliases, not current page paths. Automatic and Manual describe how an alias was created; both can be edited or deleted. Aliases return 404 while their target is unpublished or deleted."}
      </p>
      {selection && document && (
        <RedirectDialog
          key={`${filters.language}:${selection.kind}:${selection.kind === "create" ? "new" : selection.entry.path}`}
          selection={selection}
          document={document}
          session={session}
          language={language}
          onSessionChange={onSessionChange}
          onClose={() => setSelection(null)}
          onDone={() => {
            setSelection(null);
            setDocument(null);
            setNotice("saved");
            setAttempt((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
