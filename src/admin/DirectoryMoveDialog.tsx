import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { ContentDetail } from "../../shared/content";
import type { Language } from "../../shared/contracts";
import type {
  DirectoryMovePreview,
  DirectoryMoveResult,
  PageDirectory,
} from "../../shared/directories";
import { isContentPath } from "../../shared/page-path";
import { ApiError, mutation, request } from "./api";
import {
  type DirectoryInspection,
  type DirectoryMoveAttempt,
  directoryCommit,
  inspectDirectoryMove,
  verifyDirectoryMoveResult,
} from "./directory-move-recovery";
import { readPageSession } from "./page-action-recovery";

export function DirectoryMoveDialog({
  language,
  contentLanguage,
  fromPath,
  session,
  sessionBlocked,
  attempt,
  onAttemptChange,
  onSessionRequired,
  onSessionChange,
  onBusyChange,
  onDirtyChange,
  onDone,
  onReviewed,
  onClose,
}: {
  language: Language;
  contentLanguage: Language;
  fromPath: string;
  session: AuthSession;
  sessionBlocked: boolean;
  attempt: DirectoryMoveAttempt | null;
  onAttemptChange(attempt: DirectoryMoveAttempt | null): void;
  onSessionRequired(): void;
  onSessionChange(session: AuthSession): void;
  onBusyChange(busy: boolean): void;
  onDirtyChange(dirty: boolean): void;
  onDone(result: DirectoryMoveResult): void;
  onReviewed(path: string): void;
  onClose(): void;
}) {
  const zh = language === "zh";
  const [destination, setDestination] = useState(
    attempt?.preview.toPath ?? fromPath,
  );
  const [preview, setPreview] = useState<DirectoryMovePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [inspection, setInspection] = useState<DirectoryInspection | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const running = useRef(false);
  const authBlocked = useRef(sessionBlocked);
  authBlocked.current = sessionBlocked;
  const dirty = destination !== fromPath || preview !== null;
  const callbacks = useRef({ onBusyChange, onDirtyChange });
  callbacks.current = { onBusyChange, onDirtyChange };
  useEffect(() => {
    const focused = document.activeElement;
    dialog.current?.showModal();
    return () => {
      operation.current?.abort();
      callbacks.current.onBusyChange(false);
      callbacks.current.onDirtyChange(false);
      if (focused instanceof HTMLElement && focused.isConnected)
        focused.focus();
    };
  }, []);
  useEffect(() => {
    callbacks.current.onDirtyChange(dirty);
  }, [dirty]);
  function begin() {
    if (running.current) return null;
    const controller = new AbortController();
    operation.current = controller;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setFailure(null);
    setInspection(null);
    return controller;
  }
  function end(controller: AbortController) {
    if (operation.current !== controller || controller.signal.aborted) return;
    operation.current = null;
    running.current = false;
    setBusy(false);
    onBusyChange(false);
  }
  function failed(error: unknown) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      authBlocked.current = true;
      onSessionRequired();
    }
    setFailure(error);
  }
  async function loadPreview(event: FormEvent) {
    event.preventDefault();
    if (attempt || authBlocked.current) return;
    const controller = begin();
    if (!controller) return;
    setPreview(null);
    setConfirmed(false);
    try {
      const value = await request<DirectoryMovePreview>(
        `directories/${contentLanguage}/preview`,
        {
          ...mutation(
            "POST",
            { fromPath, toPath: destination },
            session.csrfToken,
          ),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      directoryCommit(value);
      if (
        value.language !== contentLanguage ||
        value.fromPath !== fromPath ||
        value.toPath !== destination
      )
        throw new Error("Directory preview changed.");
      setPreview(value);
    } catch (error) {
      if (!controller.signal.aborted) failed(error);
    } finally {
      end(controller);
    }
  }
  async function commit() {
    if (!preview || !confirmed || attempt || authBlocked.current) return;
    const controller = begin();
    if (!controller) return;
    const retained = { preview: structuredClone(preview) };
    onAttemptChange(retained);
    setConfirmed(false);
    try {
      const result = await request<DirectoryMoveResult>(
        `directories/${contentLanguage}/move`,
        {
          ...mutation(
            "POST",
            directoryCommit(retained.preview),
            session.csrfToken,
          ),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      verifyDirectoryMoveResult(retained.preview, result);
      onAttemptChange(null);
      onDone(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      // A rejected request has a known outcome. A lost/invalid success response
      // or server failure remains pending until the administrator reviews it.
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      )
        onAttemptChange(null);
      setPreview(null);
      failed(error);
    } finally {
      end(controller);
    }
  }
  async function inspect() {
    if (!attempt || authBlocked.current) return;
    const controller = begin();
    if (!controller) return;
    try {
      const value = await inspectDirectoryMove(
        attempt,
        {
          registry: (locale, signal) =>
            request<PageDirectory>(`directories/${locale}?limit=1`, { signal }),
          page: async (id, signal) => {
            try {
              return (
                await request<ContentDetail>(
                  `pages/${encodeURIComponent(id)}`,
                  { signal },
                )
              ).translation;
            } catch (error) {
              if (error instanceof ApiError && error.status === 404)
                return null;
              throw error;
            }
          },
        },
        controller.signal,
      );
      if (!controller.signal.aborted) setInspection(value);
    } catch (error) {
      if (!controller.signal.aborted) failed(error);
    } finally {
      end(controller);
    }
  }
  async function reconnect() {
    const controller = begin();
    if (!controller) return;
    setPreview(null);
    setConfirmed(false);
    try {
      const value = readPageSession(
        await request<unknown>("session", {
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      onSessionChange(value);
    } catch (error) {
      if (!controller.signal.aborted) failed(error);
    } finally {
      end(controller);
    }
  }
  function close() {
    if (running.current) return;
    if (!attempt && dirty && !discard) setDiscard(true);
    else onClose();
  }
  function stopWaiting() {
    operation.current?.abort();
    operation.current = null;
    running.current = false;
    setBusy(false);
    onBusyChange(false);
    setPreview(null);
    setConfirmed(false);
    setInspection(null);
    setFailure(new Error("Request interrupted."));
    // The parent still owns any dispatched attempt. Aborting fetch cannot
    // establish that the server stopped, so another write remains blocked.
  }
  const errorText =
    failure instanceof ApiError
      ? failure.status === 412
        ? zh
          ? "目录或页面已变化。请重新预览全部页面，再确认移动。"
          : "The directory or its pages changed. Preview all pages again before confirming."
        : failure.status === 409
          ? zh
            ? "目标路径或其子路径已被页面、回收站或旧别名占用，或者源目录超过 25 页。请选择其他目标或更小的目录。"
            : "The destination is reserved by pages, Trash or aliases, or the source exceeds 25 pages. Choose another destination or a smaller directory."
          : failure.status === 404
            ? zh
              ? "源目录已不存在。请关闭并刷新目录。"
              : "The source directory no longer exists. Close and refresh the directory."
            : failure.status === 400
              ? zh
                ? "请检查路径；目标不能与源目录相同、嵌套或重叠。"
                : "Check the path. Source and destination must be separate, non-overlapping directories."
              : zh
                ? "暂时无法完成请求。输入已保留。"
                : "The request could not be completed. Your input is preserved."
      : zh
        ? "暂时无法核实请求结果。输入已保留。"
        : "The request result could not be verified. Your input is preserved.";
  return (
    <dialog
      ref={dialog}
      className="admin-content-dialog directory-move-dialog"
      aria-labelledby="directory-move-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={onClose}
    >
      <h2 id="directory-move-title">
        {zh ? "移动 / 重命名目录" : "Move / rename directory"}
      </h2>
      <p>
        {zh
          ? "包括目录首页和所有有效子页面，最多 25 页，一次整体移动。"
          : "Move the landing page and all active descendants together, up to 25 pages."}
      </p>
      <div className="admin-dialog-page">
        <code>
          /{contentLanguage}/{fromPath}
        </code>
      </div>
      <p className="directory-move-explanation">
        {zh
          ? "原路径会保留为旧别名；回收站中的页面保持原位。正文不会改写，普通相对链接可能改变含义。已被别名占用的旧目录不能直接移回。"
          : "Previous paths remain aliases; pages in Trash stay in place. Markdown is unchanged, so ordinary relative links may resolve differently. An old directory reserved by aliases cannot be reused directly."}
      </p>
      {sessionBlocked && (
        <div className="admin-notice error content-session-notice" role="alert">
          <span>
            {zh
              ? "登录状态已变化。请在新窗口登录，再重新连接。"
              : "Your session changed. Sign in in a new tab, then reconnect."}
          </span>
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
        </div>
      )}
      {failure !== null && !sessionBlocked && (
        <p className="admin-notice error" role="alert">
          {errorText}
        </p>
      )}
      {attempt ? (
        <section
          className="directory-recovery"
          aria-label={zh ? "核对待确认的移动" : "Review pending move"}
        >
          <p className="admin-notice warning" role="status">
            {zh
              ? "上次移动结果尚未确认。读取原页面的最新状态并核对后，才能开始另一次移动。关闭窗口仍会保留本次待确认记录。"
              : "The previous move is unconfirmed. Read and review the original pages before starting another move. Closing this dialog keeps the pending record."}
          </p>
          <p>
            <code>
              /{contentLanguage}/{attempt.preview.toPath}
            </code>
          </p>
          <button
            className="admin-button secondary"
            type="button"
            disabled={busy || sessionBlocked}
            onClick={() => void inspect()}
          >
            {busy
              ? zh
                ? "核对中…"
                : "Checking…"
              : zh
                ? "读取并核对最新状态"
                : "Read and compare latest state"}
          </button>
          {inspection && (
            <>
              <p role="status">
                {!inspection.stable
                  ? zh
                    ? "核对期间状态发生变化，请再次读取。"
                    : "State changed during inspection. Read again."
                  : inspection.kind === "moved"
                    ? zh
                      ? "当前页面状态与移动后的结果一致。"
                      : "Current pages match the moved state."
                    : inspection.kind === "unchanged"
                      ? zh
                        ? "未观察到这次移动产生的变化。"
                        : "No change from this move was observed."
                      : zh
                        ? "页面与原状态或预期移动结果不同，请核对下面的路径。"
                        : "Pages differ from the original and expected states. Review the paths below."}
              </p>
              <ul className="directory-inspection-list">
                {attempt.preview.members.map((member, index) => (
                  <li key={member.id}>
                    <strong>{member.title}</strong>
                    <code>
                      {inspection.pages[index]
                        ? `/${contentLanguage}/${inspection.pages[index]?.path} · v${inspection.pages[index]?.version}${inspection.pages[index]?.deletedAt ? (zh ? " · 已删除" : " · Deleted") : ""}`
                        : zh
                          ? "页面不存在"
                          : "Page missing"}
                    </code>
                  </li>
                ))}
              </ul>
              <p>
                {zh
                  ? "这只说明当前观察到的状态，不会自动重试。任何下一次移动都需要新的预览与确认。"
                  : "This describes the observed state and never retries the move. Another move requires a fresh preview and confirmation."}
              </p>
              <button
                className="admin-button secondary"
                type="button"
                disabled={busy || sessionBlocked || !inspection.stable}
                onClick={() => {
                  onAttemptChange(null);
                  setInspection(null);
                  setPreview(null);
                  setConfirmed(false);
                  onReviewed(
                    inspection.kind === "moved" ? attempt.preview.toPath : "",
                  );
                }}
              >
                {zh
                  ? "已核对，结束待确认状态"
                  : "Reviewed — finish pending review"}
              </button>
            </>
          )}
        </section>
      ) : (
        <form onSubmit={(event) => void loadPreview(event)}>
          <fieldset disabled={busy || sessionBlocked}>
            <label className="admin-field" htmlFor="directory-destination">
              <span>{zh ? "目标目录路径" : "Destination directory path"}</span>
              <div className="admin-path-input">
                <span>/{contentLanguage}/</span>
                <input
                  id="directory-destination"
                  value={destination}
                  maxLength={240}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    setPreview(null);
                    setConfirmed(false);
                    setDiscard(false);
                  }}
                />
              </div>
              <small>
                {zh
                  ? "输入完整目标路径，例如 guides/安装。可同时移动目录并修改名称。"
                  : "Enter the full destination, such as guides/setup. You can change its parent and name together."}
              </small>
            </label>
            <button
              type="submit"
              className="admin-button secondary"
              disabled={!isContentPath(destination) || destination === fromPath}
            >
              {busy
                ? zh
                  ? "读取中…"
                  : "Loading…"
                : zh
                  ? "预览全部移动内容"
                  : "Preview every moved page"}
            </button>
          </fieldset>
          {preview && (
            <section
              className="directory-preview"
              aria-label={zh ? "移动预览" : "Move preview"}
            >
              <p>
                <strong>
                  {zh
                    ? `${preview.members.length} 个页面，其中 ${preview.publishedCount} 个已发布`
                    : `${preview.members.length} pages, ${preview.publishedCount} published`}
                </strong>
              </p>
              <ol className="directory-inspection-list">
                {preview.members.map((member) => (
                  <li key={member.id}>
                    <strong>{member.title}</strong>
                    <code>
                      /{contentLanguage}/{member.fromPath}
                    </code>
                    <span aria-hidden="true">↓</span>
                    <code>
                      /{contentLanguage}/{member.toPath}
                    </code>
                  </li>
                ))}
              </ol>
              <label className="directory-move-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || sessionBlocked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  {zh
                    ? "我已核对所有页面、目标路径与相对链接影响。"
                    : "I reviewed all pages, destination paths and the effect on relative links."}
                </span>
              </label>
              <button
                className="admin-button"
                type="button"
                disabled={busy || sessionBlocked || !confirmed}
                onClick={() => void commit()}
              >
                {busy
                  ? zh
                    ? "移动中…"
                    : "Moving…"
                  : zh
                    ? "确认整体移动"
                    : "Confirm complete move"}
              </button>
            </section>
          )}
        </form>
      )}
      {discard && !attempt && (
        <p className="admin-notice warning" role="status">
          {zh
            ? "关闭会放弃尚未提交的目标路径与预览。"
            : "Closing discards the unsaved destination and preview."}
        </p>
      )}
      <div className="admin-dialog-actions">
        {busy && (
          <button
            type="button"
            className="admin-button secondary"
            onClick={stopWaiting}
          >
            {zh ? "停止等待" : "Stop waiting"}
          </button>
        )}
        {discard && !attempt && (
          <button
            type="button"
            className="admin-button secondary"
            onClick={() => setDiscard(false)}
          >
            {zh ? "继续编辑" : "Keep editing"}
          </button>
        )}
        <button
          type="button"
          className="admin-button secondary"
          disabled={busy}
          onClick={close}
        >
          {discard && !attempt
            ? zh
              ? "放弃并关闭"
              : "Discard and close"
            : zh
              ? "关闭"
              : "Close"}
        </button>
      </div>
    </dialog>
  );
}
