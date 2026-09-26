import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type AdminTranslation,
  CONTENT_LIMITS,
  type ContentRevision,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { ApiError } from "./api";
import type { RevisionRestoreController } from "./revision-restore-recovery";

function failureMessage(error: unknown, zh: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return zh
        ? "会话需要重新验证。所选版本、恢复说明和待核对操作已保留。"
        : "Your session needs verification. The selected revision, change note and pending operation are preserved.";
    if (error.status === 412)
      return zh
        ? "页面版本已变化。请读取并比较最新状态，明确采用后再决定是否恢复。"
        : "The page version changed. Read and compare its latest state, then explicitly adopt it before deciding whether to restore.";
    if (error.status === 404)
      return zh
        ? "找不到这个页面或版本。输入已保留，请重新读取状态。"
        : "This page or revision could not be found. Your input is preserved; read the state again.";
    if (error.status === 400 || error.status === 409)
      return zh
        ? "当前页面状态或恢复说明不支持此操作。请核对输入与最新状态。"
        : "The page state or change note does not allow this operation. Check your input and the latest state.";
  }
  return zh
    ? "无法验证请求结果。输入与待核对操作已保留；请读取最新状态后继续。"
    : "The request result could not be verified. Your input and pending operation are preserved; read the latest state before continuing.";
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

function PageState({
  page,
  title,
  language,
}: {
  page: AdminTranslation;
  title: string;
  language: Language;
}) {
  const zh = language === "zh";
  return (
    <section className="history-restore-state" aria-label={title}>
      <h4>{title}</h4>
      <code>
        /{page.language}/{page.path}
      </code>
      <dl>
        <div>
          <dt>{zh ? "页面写入版本" : "Page write version"}</dt>
          <dd>{page.version}</dd>
        </div>
        <div>
          <dt>{zh ? "状态" : "State"}</dt>
          <dd>
            {page.deletedAt
              ? zh
                ? "回收站"
                : "Trash"
              : page.publishedRevisionId
                ? zh
                  ? "已发布"
                  : "Published"
                : zh
                  ? "未发布"
                  : "Unpublished"}
          </dd>
        </div>
        <div>
          <dt>{zh ? "草稿版本 ID" : "Draft revision ID"}</dt>
          <dd>
            <code>{page.draftRevisionId ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>{zh ? "公开版本 ID" : "Published revision ID"}</dt>
          <dd>
            <code>{page.publishedRevisionId ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>{zh ? "更新时间" : "Updated"}</dt>
          <dd>{dateLabel(page.updatedAt, language)}</dd>
        </div>
      </dl>
    </section>
  );
}

function RevisionState({
  revision,
  title,
  language,
}: {
  revision: ContentRevision;
  title: string;
  language: Language;
}) {
  const zh = language === "zh";
  return (
    <section className="history-restore-state" aria-label={title}>
      <h4>
        {title} · {zh ? "版本" : "Revision"} {revision.revisionNo}
      </h4>
      <strong>{revision.title}</strong>
      <dl>
        <div>
          <dt>{zh ? "描述" : "Description"}</dt>
          <dd>{revision.description || "—"}</dd>
        </div>
        <div>
          <dt>{zh ? "标签" : "Tags"}</dt>
          <dd>{revision.tags.length ? revision.tags.join(" · ") : "—"}</dd>
        </div>
        <div>
          <dt>{zh ? "创建时间" : "Created"}</dt>
          <dd>{dateLabel(revision.createdAt, language)}</dd>
        </div>
        <div>
          <dt>{zh ? "版本说明" : "Revision note"}</dt>
          <dd>{revision.changeNote || "—"}</dd>
        </div>
      </dl>
      <details className="history-restore-source">
        <summary>{zh ? "查看 Markdown 源文" : "View Markdown source"}</summary>
        <pre>{revision.markdown || (zh ? "（空正文）" : "(Empty body)")}</pre>
      </details>
    </section>
  );
}

export function RevisionRestoreDialog({
  controller,
  language,
  onClose,
}: {
  controller: RevisionRestoreController;
  language: Language;
  onClose: () => void;
}) {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const snapshot = useCallback(() => controller.state, [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const noteHelpId = useId();
  const zh = language === "zh";
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      // The history page owns the controller. Closing this element only hides
      // its view, including during StrictMode's setup/cleanup verification.
      if (element?.open) element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  const baseline = state.attempt?.before ?? state.before;
  return (
    <dialog
      ref={dialog}
      className="history-restore-dialog history-restore-recovery"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!controller.state.busy) onClose();
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (controller.canSubmit) void controller.submit();
        }}
      >
        <p className="admin-eyebrow">
          {zh ? "恢复历史版本" : "RESTORE A REVISION"}
        </p>
        <h2 id={titleId}>
          {zh
            ? `将版本 ${state.source.revisionNo} 恢复为新草稿`
            : `Restore revision ${state.source.revisionNo} as a new draft`}
        </h2>
        <p id={descriptionId}>
          {zh
            ? "标题、描述、标签和 Markdown 会复制到一个新版本。当前公开版本保持不变，现有草稿仍保留在历史中。页面路径和语言关系不会改变。"
            : "The title, description, tags and Markdown are copied into a new revision. The published revision stays unchanged, and the existing draft remains in history. The page path and translation links do not change."}
        </p>
        <div className="history-restore-grid">
          <RevisionState
            revision={state.source}
            title={zh ? "恢复来源" : "Restore source"}
            language={language}
          />
          <PageState
            page={baseline}
            title={zh ? "提交依据" : "Submission baseline"}
            language={language}
          />
        </div>
        <label className="admin-field history-restore-note" htmlFor={noteId}>
          <span>{zh ? "恢复说明（可选）" : "Change note (optional)"}</span>
          <textarea
            id={noteId}
            value={state.note}
            rows={3}
            maxLength={CONTENT_LIMITS.changeNote}
            disabled={state.busy}
            aria-describedby={noteHelpId}
            onChange={(event) => controller.editNote(event.target.value)}
          />
          <small id={noteHelpId}>
            {zh
              ? "关闭会在当前历史页面保留说明与待核对操作。修改说明不会更改已经提交的请求。"
              : "Closing preserves this note and pending operation on the history page. Editing the note does not change a request already submitted."}
          </small>
        </label>
        {state.attempt && state.attempt.note !== state.note && (
          <div className="history-restore-submitted-note">
            <strong>
              {zh
                ? "上次请求已提交的说明"
                : "Note sent with the previous request"}
            </strong>
            <p>{state.attempt.note || (zh ? "（空说明）" : "(No note)")}</p>
          </div>
        )}
        {state.failure !== null && (
          <div className="admin-notice error" role="alert">
            {failureMessage(state.failure, zh)}
          </div>
        )}
        {state.notice && (
          <div className="admin-notice success" role="status">
            {state.notice === "session"
              ? zh
                ? "会话已验证。请重新读取并比较页面状态；不会自动提交恢复。"
                : "Session verified. Read and compare the page state again; restoration is not submitted automatically."
              : zh
                ? "已采用最新页面状态。所选历史版本与编辑中的说明已保留；恢复仍需再次明确提交。"
                : "The latest page state is now selected. Your source revision and edited note are preserved; restoring still requires a new explicit submission."}
          </div>
        )}
        {state.blocked && (
          <div className="history-restore-session">
            <p>
              {zh
                ? "请在新标签页登录，然后回到这里验证会话。"
                : "Sign in in a new tab, then return here to verify your session."}
            </p>
            <div className="history-restore-controls">
              <a
                className="admin-button secondary"
                href="/admin"
                target="_blank"
                rel="noopener noreferrer"
              >
                {zh ? "在新标签页登录" : "Sign in in a new tab"}
              </a>
              <button
                className="admin-button secondary"
                type="button"
                disabled={state.busy}
                onClick={() => void controller.reconnect()}
              >
                {zh ? "验证会话" : "Verify session"}
              </button>
            </div>
          </div>
        )}
        {state.attempt && (
          <div className="admin-notice" role="status">
            {zh
              ? "上次恢复请求的结果尚未确认。停止等待不会撤销服务器上的操作，关闭窗口会保留待核对记录。不会自动重试恢复。"
              : "The previous restore request has an unconfirmed outcome. Stopping the wait does not undo the server operation; closing retains the pending record. Restoration will not be retried automatically."}
          </div>
        )}
        {state.needsReview && (
          <section
            className="history-restore-review"
            aria-label={zh ? "读取最新状态" : "Read latest state"}
          >
            <p>
              {zh
                ? "此操作只读取两次页面与草稿，确认观察结果稳定后供你比较，不会提交恢复。"
                : "This reads the page and draft twice to obtain a stable observation for comparison. It does not submit a restore."}
            </p>
            <button
              className="admin-button secondary"
              type="button"
              disabled={state.busy || state.blocked}
              onClick={() => void controller.inspect()}
            >
              {zh ? "读取并比较最新状态" : "Read and compare latest state"}
            </button>
          </section>
        )}
        {state.comparison && (
          <section
            className="history-restore-comparison"
            aria-label={zh ? "最新状态比较" : "Latest state comparison"}
          >
            <h3>{zh ? "最新读取的状态" : "Latest observed state"}</h3>
            <div className="history-restore-grid">
              <PageState
                page={state.comparison.page}
                title={zh ? "当前页面" : "Current page"}
                language={language}
              />
              <RevisionState
                revision={state.comparison.draft}
                title={zh ? "当前草稿" : "Current draft"}
                language={language}
              />
            </div>
            <p>
              {state.comparison.outcome === "desired"
                ? zh
                  ? "观察到的草稿符合上次提交的恢复结果，包括来源版本与已提交说明。这只能说明当前状态，不能证明是哪一次请求完成了写入。"
                  : "The observed draft matches the previous restore submission, including its source revision and submitted note. This establishes the current state, not which request performed the write."
                : state.comparison.outcome === "unchanged"
                  ? zh
                    ? "两次读取的页面状态与提交前相同。原请求仍可能稍后完成；采用此状态不会撤销原请求，也不会自动重试。"
                    : "Both reads show the same page state as before submission. The original request may still finish later; adopting this state does not undo it or retry it automatically."
                  : state.comparison.outcome === "changed"
                    ? zh
                      ? "页面或草稿已经变化，且不符合上次提交的完整预期。请比较路径、公开版本与草稿内容，再明确采用最新状态。"
                      : "The page or draft changed and does not match the full expected result of the previous submission. Compare the path, published revision and draft content before adopting the latest state."
                    : zh
                      ? "请比较当前页面和草稿后，明确采用最新状态。所选历史版本与恢复说明会保留。"
                      : "Review the current page and draft before explicitly adopting the latest state. Your source revision and change note will be preserved."}
            </p>
            <button
              className="admin-button secondary"
              type="button"
              disabled={state.busy || state.blocked}
              onClick={() => controller.acknowledge()}
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
        {state.before.deletedAt && (
          <div className="admin-notice error" role="alert">
            {zh
              ? "页面在回收站中，暂不能恢复历史版本。"
              : "This page is in Trash and cannot restore a historical revision."}
          </div>
        )}
        <div className="history-dialog-actions">
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
            onClick={() => {
              if (!controller.state.busy) onClose();
            }}
          >
            {zh ? "关闭并保留" : "Close and keep"}
          </button>
          <button
            className="admin-button"
            type="submit"
            disabled={!controller.canSubmit}
          >
            {state.busy
              ? zh
                ? "等待请求…"
                : "Waiting…"
              : zh
                ? "恢复为新草稿"
                : "Restore as new draft"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
