import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { FileImageError } from "../../shared/file-image";
import { FILE_LIMITS } from "../../shared/files";
import { ApiError } from "./api";
import {
  FileUploadController,
  type FileUploadState,
  type UploadPhase,
  uploadHasUnsavedWork,
  uploadNeedsReviewBeforeClose,
  uploadRole,
} from "./file-upload";
import "./file-upload.css";

function phaseLabel(phase: UploadPhase, zh: boolean) {
  const labels: Record<UploadPhase, [string, string]> = {
    select: ["选择文件", "Choose a file"],
    checking: ["检查文件格式…", "Checking file headers…"],
    hashing: ["计算文件校验值…", "Calculating file checksum…"],
    thumbnail: ["生成缩略图…", "Generating thumbnail…"],
    preparing: ["准备上传…", "Preparing upload…"],
    source: ["正在上传原文件…", "Uploading source…"],
    "upload-thumbnail": ["正在上传缩略图…", "Uploading thumbnail…"],
    refreshing: ["读取最新状态…", "Reading current state…"],
    reconciling: ["检查已存储的上传…", "Checking stored upload…"],
    abandoning: ["取消待完成上传…", "Abandoning pending upload…"],
    reconnecting: ["重新连接…", "Reconnecting…"],
    ready: ["原文件已保存", "Source saved"],
    complete: ["文件已保存", "File saved"],
    recovery: ["需要检查上传结果", "Review the upload outcome"],
    abandoned: ["待完成上传已取消", "Pending upload abandoned"],
  };
  return labels[phase][zh ? 0 : 1];
}
function errorLabel(error: unknown, zh: boolean) {
  if (error instanceof FileImageError)
    return error.status === 413
      ? zh
        ? "文件或图片尺寸超出限制。"
        : "The file or image dimensions exceed the limit."
      : zh
        ? "图片头信息无效或与格式不匹配。"
        : "The image headers are invalid or do not match the format.";
  if (error instanceof ApiError) {
    if ([401, 403].includes(error.status))
      return zh
        ? "登录状态已变化，请重新连接。"
        : "Your session changed. Reconnect before continuing.";
    if (error.status === 412)
      return zh
        ? "文件或文件库已变化。读取最新状态并检查后再操作。"
        : "The file or library changed. Read the latest state before continuing.";
    if (error.status === 409)
      return zh
        ? "操作与当前状态冲突，或上传已过期。请检查当前状态；无法恢复的待完成上传可以取消。"
        : "The operation conflicts with the current state, or the upload expired. Review the current state; abandon a pending upload that cannot be recovered.";
    if (error.status === 400 || error.status === 413 || error.status === 415)
      return zh
        ? "请检查文件名、文件大小和格式。"
        : "Check the name, file size and format.";
  }
  if (error instanceof DOMException && error.name === "AbortError")
    return zh
      ? "已停止等待。已提交的操作仍可能完成，请检查其结果。"
      : "Stopped waiting. A submitted operation may still complete; check its outcome.";
  return zh
    ? "请求未能完成，所选文件仍保留在当前标签页。"
    : "The request did not complete. Your selected file remains in this tab.";
}

export function FileUploadDialog({
  language,
  parentId,
  session,
  onSessionChange,
  onClose,
  onChanged,
  onSessionRequired,
}: {
  language: Language;
  parentId: string | null;
  session: AuthSession;
  onSessionChange(session: AuthSession): void;
  onClose(): void;
  onChanged(): void;
  onSessionRequired?(): void;
}) {
  const zh = language === "zh";
  const [initial] = useState(() => ({ parentId, session }));
  const [state, setState] = useState<FileUploadState | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const keepOpen = useRef<HTMLButtonElement>(null);
  const keepUpload = useRef<HTMLButtonElement>(null);
  const controller = useRef<FileUploadController | null>(null);
  const callbacks = useRef({
    onSessionChange,
    onClose,
    onChanged,
    onSessionRequired,
  });
  callbacks.current = {
    onSessionChange,
    onClose,
    onChanged,
    onSessionRequired,
  };
  useEffect(() => {
    if (!previousFocus.current && document.activeElement instanceof HTMLElement)
      previousFocus.current = document.activeElement;
    const upload = new FileUploadController({
      ...initial,
      onChanged: () => callbacks.current.onChanged(),
      onSessionChange: (current) => callbacks.current.onSessionChange(current),
      onSessionRequired: () => callbacks.current.onSessionRequired?.(),
    });
    controller.current = upload;
    const unsubscribe = upload.subscribe(setState);
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!uploadHasUnsavedWork(upload.state)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeSignout = (event: Event) => {
      if (uploadHasUnsavedWork(upload.state)) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("wiki:before-signout", beforeSignout);
    return () => {
      unsubscribe();
      upload.dispose();
      controller.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("wiki:before-signout", beforeSignout);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [initial]);
  useEffect(() => {
    if (confirmClose) keepOpen.current?.focus();
  }, [confirmClose]);
  useEffect(() => {
    if (confirmAbandon) keepUpload.current?.focus();
  }, [confirmAbandon]);
  function close() {
    if (state && uploadHasUnsavedWork(state)) setConfirmClose(true);
    else onClose();
  }
  const locked =
    !state || state.busy || Boolean(state.entry) || state.recovery !== null;
  const role = state?.entry ? uploadRole(state.entry) : null;
  const needsReview = Boolean(state && uploadNeedsReviewBeforeClose(state));
  return (
    <dialog
      ref={dialog}
      className="file-upload-dialog"
      aria-labelledby="file-upload-title"
      aria-describedby="file-upload-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={close}
    >
      <header className="file-upload-heading">
        <div>
          <p className="admin-eyebrow">{zh ? "文件库" : "FILE LIBRARY"}</p>
          <h2 id="file-upload-title">{zh ? "上传文件" : "Upload a file"}</h2>
        </div>
        <button
          type="button"
          className="file-upload-close"
          aria-label={zh ? "关闭上传窗口" : "Close upload window"}
          onClick={close}
        >
          ×
        </button>
      </header>
      <p id="file-upload-description" className="file-upload-description">
        {zh
          ? "文件先保存为私有。请在文件库中确认并发布后，再插入公开页面。"
          : "Files are saved privately. Review and publish them in the library before inserting them into public pages."}
      </p>
      {state && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void controller.current?.start();
            }}
          >
            <fieldset disabled={locked} className="file-upload-fields">
              <label className="file-upload-picker" htmlFor="file-upload-file">
                <span className="file-upload-glyph" aria-hidden="true">
                  ↑
                </span>
                <strong>
                  {state.file?.name ??
                    (zh ? "选择一个文件" : "Choose one file")}
                </strong>
                <span>
                  {state.file
                    ? `${state.file.size.toLocaleString()} ${zh ? "字节" : "bytes"}`
                    : zh
                      ? "任意附件最多 20 MiB；PNG、JPEG、WebP 最多 10 MiB / 2500 万像素"
                      : "Attachments up to 20 MiB; PNG, JPEG, WebP up to 10 MiB / 25 MP"}
                </span>
                <input
                  id="file-upload-file"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file)
                      controller.current?.edit({ file, name: file.name });
                  }}
                />
              </label>
              <label className="admin-field" htmlFor="file-upload-name">
                <span>{zh ? "文件名" : "File name"}</span>
                <input
                  id="file-upload-name"
                  value={state.name}
                  required
                  maxLength={FILE_LIMITS.name * 2}
                  autoComplete="off"
                  onChange={(event) =>
                    controller.current?.edit({
                      name: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="file-upload-checkbox">
                <input
                  type="checkbox"
                  checked={state.wantThumbnail}
                  onChange={(event) =>
                    controller.current?.edit({
                      wantThumbnail: event.currentTarget.checked,
                    })
                  }
                />
                <span>
                  {zh
                    ? "为支持的图片生成缩略图"
                    : "Generate a thumbnail for supported images"}
                  <small>
                    {zh
                      ? "最大 320 像素 / 256 KiB。浏览器无法生成时继续上传原文件。"
                      : "Up to 320px / 256 KiB. If generation is unavailable, upload the source alone."}
                  </small>
                </span>
              </label>
            </fieldset>
            {!state.entry && !state.recovery && (
              <div className="file-upload-start">
                <button
                  type="submit"
                  className="admin-button"
                  disabled={
                    state.busy ||
                    state.blocked ||
                    !state.file ||
                    !state.name.trim()
                  }
                >
                  {zh ? "保存为私有文件" : "Save as private file"}
                </button>
              </div>
            )}
          </form>
          <div
            className={`file-upload-status${state.busy ? " is-busy" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span className="file-upload-status-dot" aria-hidden="true" />
            <strong>{phaseLabel(state.phase, zh)}</strong>
            {state.busy && (
              <button
                type="button"
                className="file-upload-text"
                onClick={() => controller.current?.cancel()}
              >
                {zh ? "停止等待" : "Stop waiting"}
              </button>
            )}
          </div>
          {state.thumbnailOmitted && (
            <p className="file-upload-note">
              {zh
                ? "浏览器未能生成符合限制的缩略图；原文件仍可保存。"
                : "The browser could not generate a thumbnail within the limits. The source can still be saved."}
            </p>
          )}
          {state.failure !== null && (
            <div className="admin-notice error" role="alert">
              {errorLabel(state.failure, zh)}
            </div>
          )}
          {state.blocked && (
            <section className="file-upload-recovery">
              <p>
                {zh
                  ? "输入与文件保留在此标签页。请在新标签页登录，再回来重新连接；重新连接不会自动重试上传。"
                  : "Your input and file remain in this tab. Sign in in a new tab, then reconnect here. Reconnecting does not retry the upload."}
              </p>
              <div className="file-upload-actions">
                <a
                  className="admin-button secondary"
                  href="/admin"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {zh ? "在新标签页登录" : "Sign in in a new tab"}
                </a>
                <button
                  type="button"
                  className="admin-button"
                  disabled={state.busy}
                  onClick={() => void controller.current?.reconnect()}
                >
                  {zh ? "重新连接" : "Reconnect"}
                </button>
              </div>
            </section>
          )}
          {state.credentialsChanged && role && (
            <p className="file-upload-note">
              {zh
                ? "此上传属于之前的账户凭证版本。请取消待完成上传，再明确开始一次新上传。"
                : "This upload belongs to an earlier credential version. Abandon the pending upload before starting a new one."}
            </p>
          )}
          {state.recovery === "mutation" && (
            <p className="file-upload-note">
              {zh
                ? "取消操作的结果尚未确认。请先读取最新状态，再决定下一步。"
                : "The abandonment outcome is unconfirmed. Read the current state before choosing another action."}
            </p>
          )}
          {state.entry && (
            <section className="file-upload-entry">
              <strong>{state.entry.name}</strong>
              <small>
                {zh ? "当前版本" : "Current version"} {state.entry.version}
              </small>
              {state.entry.uploadExpiresAt && role && (
                <p>
                  {zh ? "待完成上传期限" : "Pending upload deadline"}:{" "}
                  {new Date(state.entry.uploadExpiresAt).toLocaleString(
                    zh ? "zh-CN" : "en-GB",
                  )}
                </p>
              )}
              {role && (
                <>
                  <p>
                    {zh
                      ? "若提交后未收到确认，请读取最新状态，并明确检查已存储的上传。取消仅结束待完成状态，不会删除存储对象。"
                      : "If submission was not confirmed, read the current state and explicitly check the stored upload. Abandoning ends the pending state; it does not delete stored objects."}
                  </p>
                  <div className="file-upload-actions">
                    <button
                      type="button"
                      className="admin-button secondary"
                      disabled={state.busy || state.blocked}
                      onClick={() => void controller.current?.refresh()}
                    >
                      {zh ? "读取最新状态" : "Read current state"}
                    </button>
                    <button
                      type="button"
                      className="admin-button secondary"
                      disabled={
                        state.busy ||
                        state.blocked ||
                        state.credentialsChanged ||
                        state.recovery === "mutation"
                      }
                      onClick={() => void controller.current?.reconcile()}
                    >
                      {zh ? "检查已存储的上传" : "Check stored upload"}
                    </button>
                    {controller.current?.canUploadThumbnail && (
                      <button
                        type="button"
                        className="admin-button"
                        disabled={state.busy || state.blocked}
                        onClick={() =>
                          void controller.current?.uploadThumbnail()
                        }
                      >
                        {zh
                          ? "上传已生成的缩略图"
                          : "Upload prepared thumbnail"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="file-upload-text danger"
                      disabled={
                        state.busy ||
                        state.blocked ||
                        state.recovery === "mutation"
                      }
                      onClick={() => setConfirmAbandon(true)}
                    >
                      {role === "source"
                        ? zh
                          ? "取消待完成上传"
                          : "Abandon pending upload"
                        : zh
                          ? "放弃待完成缩略图"
                          : "Abandon pending thumbnail"}
                    </button>
                  </div>
                </>
              )}
              {state.entry.state === "abandoned" && (
                <button
                  type="button"
                  className="admin-button secondary"
                  disabled={state.busy || state.blocked}
                  onClick={() => controller.current?.restart()}
                >
                  {zh ? "准备一次新上传" : "Prepare a new upload"}
                </button>
              )}
              {!role && state.entry.state === "ready" && (
                <p>
                  {state.entry.publishedAt
                    ? zh
                      ? "该文件已在其他操作中发布。"
                      : "This file was published by another operation."
                    : zh
                      ? "文件已保存为私有。关闭窗口后可在文件库中管理发布状态。"
                      : "The file is saved privately. Close this dialog to manage publication in the library."}
                </p>
              )}
            </section>
          )}
          {state.recovery === "prepare" && !state.entry && (
            <section className="file-upload-recovery">
              <h3>
                {zh
                  ? "未收到上传准备结果"
                  : "Upload preparation was not confirmed"}
              </h3>
              <p>
                {zh
                  ? "准备请求可能已经创建条目。先检查当前文件夹中的所有条目；本窗口不会自动认领同名文件。检查并确认后可关闭窗口，在文件库中处理已有的待完成条目。"
                  : "Preparation may have created an entry. Inspect every entry in this folder first; this dialog will not adopt a matching file. After inspection and acknowledgment, close it to handle an existing pending entry in the library."}
              </p>
              <button
                type="button"
                className="admin-button secondary"
                disabled={state.busy || state.blocked}
                onClick={() => void controller.current?.inspectFolder()}
              >
                {zh ? "检查当前文件夹" : "Inspect current folder"}
              </button>
              {state.folderReview && (
                <ul className="file-upload-review">
                  {state.folderReview.items.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.kind === "folder"
                          ? zh
                            ? "文件夹"
                            : "Folder"
                          : entry.state === "pending"
                            ? zh
                              ? "待完成"
                              : "Pending"
                            : zh
                              ? "已保存"
                              : "Saved"}{" "}
                        · {entry.id}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {state.folderReview?.nextCursor && (
                <button
                  type="button"
                  className="admin-button secondary"
                  disabled={state.busy || state.blocked}
                  onClick={() => void controller.current?.inspectFolder(true)}
                >
                  {zh ? "继续检查下一页" : "Inspect next page"}
                </button>
              )}
              {state.folderReviewed && (
                <>
                  <p>
                    {zh
                      ? "已读取当前文件夹的全部条目。若发现此前创建的条目，请先在文件库处理它；如仍需另一次上传，可明确返回准备步骤。"
                      : "All entries in this folder have been read. Handle any previously created entry in the library first. If you still need another upload, explicitly return to preparation."}
                  </p>
                  <button
                    type="button"
                    className="admin-button secondary"
                    disabled={state.busy || state.blocked}
                    onClick={() => controller.current?.acknowledgeFolder()}
                  >
                    {zh
                      ? "已检查，返回准备步骤"
                      : "Reviewed; return to preparation"}
                  </button>
                </>
              )}
            </section>
          )}
          {confirmAbandon && (
            <section className="file-upload-confirm" role="alert">
              <h3>
                {zh ? "确认取消待完成上传？" : "Abandon the pending upload?"}
              </h3>
              <p>
                {role === "thumbnail"
                  ? zh
                    ? "原文件会保留，缩略图不可在此上传中重新添加。"
                    : "The source remains. A thumbnail cannot be added again to this upload."
                  : zh
                    ? "此待完成条目将永久结束。存储对象不会被删除；可另行开始新上传。"
                    : "This pending entry becomes terminal. Stored objects are retained; you can start a separate upload."}
              </p>
              <div className="file-upload-actions">
                <button
                  type="button"
                  className="admin-button secondary"
                  ref={keepUpload}
                  onClick={() => setConfirmAbandon(false)}
                >
                  {zh ? "保留" : "Keep it"}
                </button>
                <button
                  type="button"
                  className="admin-button"
                  disabled={state.busy || state.blocked}
                  onClick={() => {
                    setConfirmAbandon(false);
                    void controller.current?.abandon();
                  }}
                >
                  {zh ? "确认取消" : "Confirm abandon"}
                </button>
              </div>
            </section>
          )}
          {confirmClose && (
            <section className="file-upload-confirm" role="alert">
              <h3>{zh ? "关闭上传窗口？" : "Close the upload dialog?"}</h3>
              <p>
                {needsReview
                  ? zh
                    ? "请先检查或取消待完成上传，再关闭此窗口。停止等待不会撤回已提交的操作，也不会删除存储对象。若准备结果未知，请完整检查文件夹并明确确认。"
                    : "Review or abandon the pending upload before closing. Stopping your wait does not undo a submitted operation or delete stored objects. If preparation is uncertain, inspect the complete folder and acknowledge the result."
                  : zh
                    ? "关闭会丢弃当前标签页保留的文件选择和未提交输入。"
                    : "Closing discards this tab’s file selection and unsubmitted input."}
              </p>
              <div className="file-upload-actions">
                <button
                  type="button"
                  className="admin-button secondary"
                  ref={keepOpen}
                  onClick={() => setConfirmClose(false)}
                >
                  {zh ? "留在此处" : "Stay here"}
                </button>
                {!needsReview && (
                  <button
                    type="button"
                    className="admin-button"
                    onClick={() => {
                      onClose();
                    }}
                  >
                    {zh ? "丢弃输入并关闭" : "Discard input and close"}
                  </button>
                )}
                {state.busy && (
                  <button
                    type="button"
                    className="admin-button"
                    onClick={() => {
                      controller.current?.cancel();
                      setConfirmClose(false);
                    }}
                  >
                    {zh ? "停止等待并检查" : "Stop waiting and review"}
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}
      <footer className="file-upload-footer">
        <small>
          {zh
            ? "仅当前标签页保留文件。上传准备 15 分钟后到期。"
            : "File selection stays in this tab only. Prepared uploads expire after 15 minutes."}
        </small>
        <button
          type="button"
          className="admin-button secondary"
          onClick={close}
        >
          {zh ? "关闭" : "Close"}
        </button>
      </footer>
    </dialog>
  );
}
