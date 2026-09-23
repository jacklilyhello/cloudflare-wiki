import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { isContentPath } from "../../shared/page-path";
import { ApiError } from "./api";
import {
  type PageAction,
  type PageActionAttempt,
  PageActionController,
  type PageActionSelection,
  pageActionEligible,
} from "./page-action-recovery";

export interface PageActionDialogProps {
  selection: PageActionSelection;
  language: Language;
  session: AuthSession;
  sessionBlocked: boolean;
  attempt: PageActionAttempt | null;
  onAttemptChange(attempt: PageActionAttempt | null): void;
  onSessionRequired(): void;
  onSessionChange(session: AuthSession): void;
  onBusyChange(busy: boolean): void;
  onDirtyChange(dirty: boolean): void;
  onClose(): void;
  onDone(kind: PageAction): void;
}

function failureMessage(error: unknown, zh: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return zh
        ? "会话需要重新验证，输入已保留。"
        : "Your session needs verification. Your input is preserved.";
    if (error.status === 412)
      return zh
        ? "页面版本已变化，请读取并比较最新状态。"
        : "The page version changed. Read and compare its latest state.";
    if (error.status === 409)
      return zh
        ? "目标路径已被占用，请选择其他路径。"
        : "The destination is already reserved. Choose another path.";
    if (error.status === 400)
      return zh ? "请检查路径及页面状态。" : "Check the path and page state.";
    if (error.status === 404)
      return zh
        ? "找不到这个页面，请关闭后刷新列表。"
        : "This page could not be found. Close and refresh the list.";
  }
  return zh
    ? "无法确认请求结果。输入已保留，请读取最新状态。"
    : "The request result could not be verified. Your input is preserved; read the latest state.";
}

export function PageActionDialog(props: PageActionDialogProps) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const { language, session, sessionBlocked } = props;
  const zh = language === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  const [controller] = useState(
    () =>
      new PageActionController({
        selection: props.selection,
        session: props.session,
        sessionBlocked: props.sessionBlocked,
        attempt: props.attempt,
        onAttemptChange: (attempt) =>
          callbacks.current.onAttemptChange(attempt),
        onSessionRequired: () => callbacks.current.onSessionRequired(),
        onSessionChange: (next) => callbacks.current.onSessionChange(next),
        onDone: (kind) => callbacks.current.onDone(kind),
      }),
  );
  const [state, setState] = useState(controller.state);
  const [discard, setDiscard] = useState(false);
  const kind = controller.kind;
  const dirty = kind === "move" && state.path !== state.page.path;
  const labels: Record<PageAction, string> = {
    move: zh ? "移动页面" : "Move page",
    delete: zh ? "移入回收站" : "Move to Trash",
    restore: zh ? "恢复页面" : "Restore page",
    unpublish: zh ? "取消发布" : "Unpublish page",
  };
  const descriptions: Record<PageAction, string> = {
    move: zh
      ? "修改页面路径。页面发布期间，原路径会转向新路径。"
      : "Change this page's path. While published, its previous paths redirect to its current path.",
    delete: zh
      ? "页面将立即停止公开，草稿与版本历史保留，可从回收站恢复。"
      : "The page will stop being public. Its draft and history remain available for restoration from Trash.",
    restore: zh
      ? "恢复页面及历史记录。恢复后保持未发布。"
      : "Restore this page and its history. It remains unpublished.",
    unpublish: zh
      ? "访客将无法阅读此页面，草稿与已保存版本保留。"
      : "Readers will lose access to this page. Its draft and saved revisions are retained.",
  };
  useEffect(
    () => controller.subscribe(() => setState(controller.state)),
    [controller],
  );
  useEffect(() => {
    controller.context(session, sessionBlocked);
  }, [controller, session, sessionBlocked]);
  useEffect(() => {
    callbacks.current.onBusyChange(state.busy);
  }, [state.busy]);
  useEffect(() => {
    callbacks.current.onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => {
    controller.activate();
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    return () => {
      controller.dispose();
      callbacks.current.onBusyChange(false);
      callbacks.current.onDirtyChange(false);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, [controller]);
  function close() {
    if (state.busy) return;
    if (dirty) setDiscard(true);
    else props.onClose();
  }
  const blocked = state.blocked || sessionBlocked;
  const incompatible = !pageActionEligible(kind, state.page);
  return (
    <dialog
      ref={dialog}
      className="admin-content-dialog"
      aria-labelledby="page-action-title"
      aria-describedby="page-action-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!blocked && !discard) void controller.submit();
        }}
      >
        <div className="admin-dialog-heading">
          <h2 id="page-action-title">{labels[kind]}</h2>
        </div>
        <p id="page-action-description">{descriptions[kind]}</p>
        <div className="admin-dialog-page">
          <strong>{state.page.title}</strong>
          <code>
            /{state.page.language}/{state.page.path}
          </code>
        </div>
        {kind === "move" && (
          <label className="admin-field" htmlFor="page-move-path">
            <span>{zh ? "目标路径" : "Destination path"}</span>
            <div className="admin-path-input">
              <span>/{state.page.language}/</span>
              <input
                id="page-move-path"
                value={state.path}
                disabled={state.busy}
                onChange={(event) => {
                  controller.editPath(event.target.value);
                  setDiscard(false);
                }}
                required
                maxLength={240}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <small>
              {zh
                ? "使用小写字母、数字、中文、下划线、连字符与 /。"
                : "Use lowercase letters, numbers, Unicode letters, underscores, hyphens and /."}
            </small>
            {state.path !== state.page.path && !isContentPath(state.path) && (
              <small className="admin-notice error">
                {zh
                  ? "路径格式无效或使用了保留名称。"
                  : "The path is invalid or uses a reserved name."}
              </small>
            )}
          </label>
        )}
        {state.failure !== null && (
          <p className="admin-notice error" role="alert">
            {failureMessage(state.failure, zh)}
          </p>
        )}
        {state.notice && (
          <p className="admin-notice success" role="status">
            {state.notice === "session"
              ? zh
                ? "会话已验证，请重新读取并比较页面状态。"
                : "Session verified. Read and compare the page state again."
              : zh
                ? "已采用最新页面状态，目标路径输入已保留。再次提交需明确确认。"
                : "The latest page state is now selected. Your destination input is preserved; submitting requires a new confirmation."}
          </p>
        )}
        {blocked && (
          <div className="content-session-actions">
            <a href="/admin" target="_blank" rel="noopener noreferrer">
              {zh ? "在新标签页登录" : "Sign in in a new tab"}
            </a>
            <button
              className="admin-button secondary"
              type="button"
              disabled={state.busy}
              onClick={() => void controller.reconnect()}
            >
              {zh ? "重新验证会话" : "Verify session"}
            </button>
          </div>
        )}
        {state.attempt && (
          <p className="admin-notice" role="status">
            {zh
              ? "上次提交的结果尚未确认。关闭会保留待核对操作；停止等待不会撤销服务器上的请求。"
              : "The previous submission has an unconfirmed outcome. Closing retains it for comparison; stopping the wait does not undo the server request."}
          </p>
        )}
        {state.needsReview && (
          <div>
            <p>
              {zh
                ? "读取最新状态不会提交或重试操作。"
                : "Reading the latest state does not submit or retry an action."}
            </p>
            <button
              className="admin-button secondary"
              type="button"
              disabled={state.busy || blocked}
              onClick={() => void controller.inspect()}
            >
              {zh ? "读取最新状态" : "Read latest state"}
            </button>
          </div>
        )}
        {state.comparison && (
          <section aria-label={zh ? "页面状态比较" : "Page state comparison"}>
            <h3>{zh ? "服务器上的页面" : "Page on the server"}</h3>
            <div className="admin-dialog-page">
              <strong>{state.comparison.page.title}</strong>
              <code>
                /{state.comparison.page.language}/{state.comparison.page.path}
              </code>
              <span>
                {zh ? "版本" : "Version"} {state.comparison.page.version} ·{" "}
                {state.comparison.page.deletedAt
                  ? zh
                    ? "回收站"
                    : "Trash"
                  : state.comparison.page.publishedRevisionId
                    ? zh
                      ? "已发布"
                      : "Published"
                    : zh
                      ? "未发布"
                      : "Unpublished"}
              </span>
            </div>
            <p>
              {state.comparison.outcome === "desired"
                ? zh
                  ? "这次读取的状态符合已提交操作的预期结果。"
                  : "This observation matches the submitted action's expected result."
                : state.comparison.outcome === "unchanged"
                  ? zh
                    ? "这次读取的页面状态未变。原请求仍可能稍后完成。"
                    : "The observed page state is unchanged. The original request may still finish later."
                  : zh
                    ? "请比较最新状态后明确采用。不会自动重试。"
                    : "Review the latest state before explicitly adopting it. Nothing will be retried automatically."}
            </p>
            <button
              className="admin-button secondary"
              type="button"
              disabled={state.busy || blocked}
              onClick={() => {
                controller.acknowledge();
                setDiscard(false);
              }}
            >
              {state.comparison.outcome === "desired"
                ? zh
                  ? "已核对，完成"
                  : "Reviewed; finish"
                : zh
                  ? "已核对，采用最新状态"
                  : "Reviewed; adopt latest state"}
            </button>
          </section>
        )}
        {incompatible && (
          <p className="admin-notice error" role="alert">
            {zh
              ? "当前状态不支持此操作，请关闭并刷新列表。"
              : "The current state does not support this action. Close and refresh the list."}
          </p>
        )}
        {discard && (
          <div className="admin-notice" role="alert">
            <p>
              {zh
                ? "丢弃尚未提交的路径输入并关闭？待核对的已提交操作会继续保留。"
                : "Discard the unsaved path input and close? Any submitted action awaiting comparison will be retained."}
            </p>
            <button
              className="admin-button secondary"
              type="button"
              onClick={() => setDiscard(false)}
            >
              {zh ? "继续编辑" : "Keep editing"}
            </button>
            <button
              className="admin-button secondary"
              type="button"
              onClick={props.onClose}
            >
              {zh ? "丢弃输入并关闭" : "Discard input and close"}
            </button>
          </div>
        )}
        <div className="admin-dialog-actions">
          {state.busy && (
            <button
              className="admin-button secondary"
              type="button"
              onClick={() => controller.cancel()}
            >
              {zh ? "停止等待" : "Stop waiting"}
            </button>
          )}
          <button
            className="admin-button secondary"
            type="button"
            disabled={state.busy}
            onClick={close}
          >
            {zh ? "关闭" : "Close"}
          </button>
          <button
            className={`admin-button ${kind === "delete" ? "danger" : ""}`}
            type="submit"
            disabled={!controller.canSubmit || blocked || discard}
          >
            {state.busy ? (zh ? "处理中…" : "Working…") : labels[kind]}
          </button>
        </div>
      </form>
    </dialog>
  );
}
