import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { FILE_LIMITS, type FileEntry, type FilePage } from "../../shared/files";
import { ApiError, mutation, request } from "./api";
import { FolderPicker } from "./FilesBrowser";
import { authentication, failureText } from "./file-errors";
import {
  type FolderCreateAttempt,
  type FolderCreateInspection,
  folderInspectionQuery,
  mergeFolderInspection,
} from "./folder-create-recovery";

export type Action =
  | "folder"
  | "rename"
  | "move"
  | "alt"
  | "publish"
  | "unpublish"
  | "delete"
  | "restore"
  | "abandon";
export function FileActionDialog({
  action,
  entry,
  parentId,
  language,
  session,
  onSessionChange,
  onSessionRequired,
  folderRecovery,
  onFolderRecovery,
  onClose,
  onDone,
}: {
  action: Action;
  entry: FileEntry | null;
  parentId: string | null;
  language: Language;
  session: AuthSession;
  onSessionChange(session: AuthSession): void;
  onSessionRequired(): void;
  folderRecovery: FolderCreateAttempt | null;
  onFolderRecovery(value: FolderCreateAttempt | null): void;
  onClose(): void;
  onDone(entry: FileEntry): void;
}) {
  const zh = language === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [current, setCurrent] = useState(entry);
  const [activeSession, setActiveSession] = useState(session);
  const [name, setName] = useState(
    action === "folder" ? (folderRecovery?.name ?? "") : (entry?.name ?? ""),
  );
  const [destination, setDestination] = useState(
    action === "folder"
      ? folderRecovery
        ? folderRecovery.parentId
        : parentId
      : (entry?.parentId ?? null),
  );
  const [alt, setAlt] = useState(entry?.alt ?? { zh: "", en: "" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [blocked, setBlocked] = useState(false);
  const [recovery, setRecovery] = useState(Boolean(folderRecovery));
  const [inspection, setInspection] = useState<FolderCreateInspection | null>(
    null,
  );
  const [latest, setLatest] = useState<FileEntry | null>(null);
  const [compared, setCompared] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty =
    action === "folder"
      ? Boolean(name)
      : action === "rename"
        ? name !== current?.name
        : action === "move" || action === "restore"
          ? destination !== current?.parentId
          : action === "alt"
            ? JSON.stringify(alt) !== JSON.stringify(current?.alt)
            : false;
  const guarded = useRef(false);
  guarded.current = dirty || recovery || busy;
  const titles: Record<Action, string> = {
    folder: zh ? "新建文件夹" : "New folder",
    rename: zh ? "重命名" : "Rename",
    move: zh ? "移动" : "Move",
    alt: zh ? "图片替代文本" : "Alternative text",
    publish: zh ? "公开文件" : "Publish file",
    unpublish: zh ? "取消公开" : "Unpublish file",
    delete: zh ? "移入回收站" : "Move to Trash",
    restore: zh ? "恢复文件" : "Restore item",
    abandon: zh ? "放弃未完成上传" : "Abandon unfinished upload",
  };
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
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
      operation.current?.abort();
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("wiki:before-signout", signout);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  function close() {
    if (busy) return;
    if (dirty || recovery) setDiscard(true);
    else onClose();
  }
  async function run(kind: "submit" | "latest" | "reconnect" | "inspect") {
    if (
      busy ||
      operation.current ||
      (kind === "submit" && (blocked || recovery))
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    if (kind === "latest" || kind === "reconnect") {
      setLatest(null);
      setCompared(false);
      if (kind === "reconnect") setInspection(null);
    }
    let submitted = false;
    try {
      if (kind === "reconnect") {
        const result = await request<{ session: AuthSession }>("session", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setActiveSession(result.session);
        onSessionChange(result.session);
        setBlocked(false);
        setNotice(
          zh
            ? "会话已恢复。请比较最新状态后继续。"
            : "Session restored. Compare the latest state before continuing.",
        );
      } else if (kind === "inspect" && folderRecovery) {
        const page = await request<FilePage>(
          folderInspectionQuery(folderRecovery, inspection),
          { signal: controller.signal },
        );
        if (!controller.signal.aborted)
          setInspection(
            mergeFolderInspection(folderRecovery, inspection, page),
          );
      } else if (kind === "latest" && current) {
        const result = await request<FileEntry>(`files/${current.id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setLatest(result);
        setCompared(false);
      } else if (kind === "submit" && action === "folder") {
        const query = new URLSearchParams({ parentId: destination ?? "" });
        const library = await request<FilePage>(`files?${query}`, {
          signal: controller.signal,
        });
        submitted = true;
        const created = await request<FileEntry>("files/folders", {
          ...mutation(
            "POST",
            {
              expectedLibraryVersion: library.libraryVersion,
              parentId: destination,
              name,
            },
            activeSession.csrfToken,
          ),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) onDone(created);
      } else if (kind === "submit" && current) {
        const fields =
          action === "rename"
            ? { name }
            : action === "move" || action === "restore"
              ? { parentId: destination }
              : action === "alt"
                ? { alt }
                : {};
        submitted = true;
        const result = await request<FileEntry>(
          `files/${current.id}/${action}`,
          {
            ...mutation(
              "POST",
              { expectedVersion: current.version, ...fields },
              activeSession.csrfToken,
            ),
            signal: controller.signal,
          },
        );
        if (!controller.signal.aborted) onDone(result);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setFailure(error);
      if (authentication(error)) {
        setLatest(null);
        setInspection(null);
        setBlocked(true);
        onSessionRequired();
        if (current) setRecovery(true);
      }
      if (kind === "inspect") setInspection(null);
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      if (kind === "submit" && submitted && uncertain && action === "folder") {
        onFolderRecovery({ name, parentId: destination });
        setRecovery(true);
        setInspection(null);
      } else if (
        kind === "submit" &&
        current &&
        (uncertain ||
          (error instanceof ApiError && [404, 412].includes(error.status)))
      ) {
        setRecovery(true);
        setLatest(null);
        setCompared(false);
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function useLatest() {
    if (!latest || blocked || busy) return;
    setCurrent(latest);
    setRecovery(false);
    setCompared(true);
    setLatest(null);
    setFailure(null);
    setNotice(
      zh
        ? "已采用最新版本作为本次操作的依据，你输入的内容未改变。请再次确认。"
        : "The latest version is now the basis for this action. Your input is unchanged; confirm again.",
    );
  }
  const incompatible =
    (current && action !== "restore" && current.deletedAt) ||
    (current && action === "restore" && !current.deletedAt);
  return (
    <dialog
      ref={dialog}
      className="file-action-dialog"
      aria-labelledby="file-action-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run("submit");
        }}
      >
        <header>
          <span className="admin-eyebrow">
            {zh ? "文件资料库" : "FILE LIBRARY"}
          </span>
          <h2 id="file-action-title">{titles[action]}</h2>
          {current && <p className="files-dialog-name">{current.name}</p>}
        </header>
        <div className="files-dialog-body">
          {action === "publish" && (
            <p>
              {zh
                ? "公开后，任何拥有链接的人都能查看或下载此文件。尚未完成的缩略图会被放弃；页面编辑器可以插入公开文件。"
                : "Anyone with the link can view or download a published file. Any unfinished thumbnail will be abandoned. Published files can be inserted in the page editor."}
            </p>
          )}
          {action === "unpublish" && (
            <p>
              {zh
                ? "公开链接将停止提供此文件。引用它的页面会出现无法加载的图片或下载链接。"
                : "Public links will stop serving this file. Pages that reference it will have unavailable images or downloads."}
            </p>
          )}
          {action === "delete" && (
            <p>
              {zh
                ? "文件会立即停止公开并移入回收站，存储内容保留。文件夹必须没有活动子项。"
                : "The item will be unpublished and moved to Trash; stored content is retained. Folders must have no active children."}
            </p>
          )}
          {action === "restore" && (
            <p>
              {zh
                ? "选择恢复位置。恢复后的文件保持私有，检查后再公开。"
                : "Choose a restore location. Restored files remain private until you publish them again."}
            </p>
          )}
          {action === "abandon" && (
            <p>
              {current?.state === "pending"
                ? zh
                  ? "结束这个未完成的上传。它无法恢复；已经传入的私有存储内容不会被删除。"
                  : "End this unfinished upload permanently. Any private bytes already stored are retained."
                : zh
                  ? "放弃尚未完成的缩略图，已完成的原始文件继续保留。"
                  : "Abandon the unfinished thumbnail and keep the completed source file."}
            </p>
          )}
          <fieldset disabled={busy}>
            {(action === "folder" || action === "rename") && (
              <label className="admin-field">
                <span>{zh ? "名称" : "Name"}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={FILE_LIMITS.name}
                  required
                  autoComplete="off"
                />
              </label>
            )}
            {(action === "move" || action === "restore") && (
              <FolderPicker
                key={activeSession.csrfToken}
                language={language}
                value={destination}
                onChange={setDestination}
                onSessionRequired={() => {
                  setBlocked(true);
                  setRecovery(true);
                  onSessionRequired();
                }}
                excludeId={current?.kind === "folder" ? current.id : undefined}
              />
            )}
            {action === "alt" && (
              <>
                {(["zh", "en"] as const).map((locale) => (
                  <label className="admin-field" key={locale}>
                    <span>
                      {locale === "zh"
                        ? "中文替代文本"
                        : "English alternative text"}
                    </span>
                    <textarea
                      value={alt[locale]}
                      onChange={(event) =>
                        setAlt((value) => ({
                          ...value,
                          [locale]: event.target.value,
                        }))
                      }
                      maxLength={FILE_LIMITS.alt}
                      rows={3}
                    />
                  </label>
                ))}
                <p className="files-help">
                  {zh
                    ? "描述图片传达的信息。插入 Markdown 时默认使用正文语言对应的文本。"
                    : "Describe what the image conveys. Insertion uses the text for the article's language."}
                </p>
              </>
            )}
          </fieldset>
          {Boolean(failure) && (
            <p className="admin-notice error" role="alert">
              {failureText(failure, zh)}
            </p>
          )}
          {notice && (
            <p className="admin-notice success" role="status">
              {notice}
            </p>
          )}
          {blocked && (
            <div className="files-recovery">
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
                className="admin-button secondary"
                disabled={busy}
                onClick={() => void run("reconnect")}
              >
                {zh ? "重新验证会话" : "Check session"}
              </button>
            </div>
          )}
          {recovery && current && (
            <div className="files-recovery">
              <p>
                {zh
                  ? "先读取最新信息。此操作不会覆盖你的输入，也不会重试提交。"
                  : "Load the latest information first. This preserves your input and does not retry the action."}
              </p>
              <button
                type="button"
                className="admin-button secondary"
                disabled={busy || blocked}
                onClick={() => void run("latest")}
              >
                {zh ? "读取最新状态" : "Load latest state"}
              </button>
            </div>
          )}
          {recovery && folderRecovery && (
            <div className="files-recovery">
              <p>
                {zh
                  ? `需要核对“${folderRecovery.name}”在原文件夹中的创建结果。检查期间保留你的输入；不会重复提交。`
                  : `Check whether “${folderRecovery.name}” was created in its original folder. Your input is preserved; nothing is resubmitted.`}
              </p>
              {(!inspection || inspection.nextCursor) && (
                <button
                  type="button"
                  className="admin-button secondary"
                  disabled={busy || blocked}
                  onClick={() => void run("inspect")}
                >
                  {inspection
                    ? zh
                      ? "继续检查下一页"
                      : "Inspect next page"
                    : zh
                      ? "检查创建结果"
                      : "Inspect create outcome"}
                </button>
              )}
              {inspection && (
                <p>
                  {zh
                    ? `已检查 ${inspection.readCount} 个条目。`
                    : `Inspected ${inspection.readCount} items.`}
                </p>
              )}
              {inspection && !inspection.nextCursor && (
                <>
                  <p>
                    {inspection.match
                      ? zh
                        ? `发现同名${inspection.match.kind === "folder" ? "文件夹" : "文件"}：${inspection.match.name}。`
                        : `Found an item with this name: ${inspection.match.name}.`
                      : zh
                        ? "这次完整检查未发现同名条目。原请求仍可能稍后完成，再次提交时仍会检查重名。"
                        : "This complete inspection found no item with that name. The original request may still finish later; another submission still checks for collisions."}
                  </p>
                  {inspection.match?.kind === "folder" && (
                    <button
                      type="button"
                      className="admin-button secondary"
                      disabled={busy || blocked}
                      onClick={() => {
                        if (inspection.match) onDone(inspection.match);
                      }}
                    >
                      {zh ? "选择已存在的文件夹" : "Select the existing folder"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="admin-button secondary"
                    disabled={busy || blocked}
                    onClick={() => {
                      setRecovery(false);
                      onFolderRecovery(null);
                      setInspection(null);
                      setFailure(null);
                      setCompared(true);
                    }}
                  >
                    {zh
                      ? "已核对，继续编辑名称"
                      : "Reviewed; continue editing the name"}
                  </button>
                </>
              )}
            </div>
          )}
          {latest && (
            <section className="files-comparison">
              <h3>{zh ? "服务器上的最新信息" : "Latest server information"}</h3>
              <dl>
                <div>
                  <dt>{zh ? "名称" : "Name"}</dt>
                  <dd>{latest.name}</dd>
                </div>
                <div>
                  <dt>{zh ? "状态" : "State"}</dt>
                  <dd>
                    {latest.deletedAt
                      ? zh
                        ? "回收站"
                        : "Trash"
                      : latest.publishedAt
                        ? zh
                          ? "公开"
                          : "Public"
                        : zh
                          ? "私有"
                          : "Private"}{" "}
                    · {latest.state}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? "位置" : "Location"}</dt>
                  <dd>
                    {latest.parentId === current?.parentId
                      ? zh
                        ? "原文件夹"
                        : "Unchanged folder"
                      : zh
                        ? "已移动，请核对目标位置"
                        : "Moved; review the destination"}
                  </dd>
                </div>
                {latest.alt && (
                  <>
                    <div>
                      <dt>中文</dt>
                      <dd>{latest.alt.zh || "—"}</dd>
                    </div>
                    <div>
                      <dt>English</dt>
                      <dd>{latest.alt.en || "—"}</dd>
                    </div>
                  </>
                )}
              </dl>
              <button
                type="button"
                className="admin-button secondary"
                disabled={busy || blocked}
                onClick={useLatest}
              >
                {zh
                  ? "已比较，保留输入并继续"
                  : "Reviewed; keep input and continue"}
              </button>
            </section>
          )}
          {incompatible && (
            <p className="admin-notice error">
              {zh
                ? "最新状态不再支持此操作。请返回文件列表选择合适的操作。"
                : "The latest state no longer supports this action. Return to the file list."}
            </p>
          )}
          {discard && (
            <div className="files-recovery" role="alert">
              <p>
                {recovery
                  ? zh
                    ? "关闭后请先检查列表中的实际状态。尚未确认的请求可能已经成功，关闭不会撤销它。"
                    : "Inspect the actual list state after closing. An unconfirmed request may have succeeded; closing does not undo it."
                  : zh
                    ? "丢弃此对话框中尚未提交的输入？"
                    : "Discard the unsaved input in this dialog?"}
              </p>
              <button
                className="admin-button secondary"
                type="button"
                onClick={() => setDiscard(false)}
              >
                {zh ? "继续查看" : "Keep reviewing"}
              </button>
              <button
                className="admin-button secondary"
                type="button"
                onClick={onClose}
              >
                {zh ? "关闭并刷新列表" : "Close and refresh list"}
              </button>
            </div>
          )}
        </div>
        <footer>
          <button
            className="admin-button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="admin-button"
            type="submit"
            disabled={
              busy || blocked || recovery || Boolean(incompatible) || discard
            }
          >
            {busy
              ? zh
                ? "处理中…"
                : "Working…"
              : compared
                ? zh
                  ? "确认本次操作"
                  : "Confirm this action"
                : titles[action]}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
