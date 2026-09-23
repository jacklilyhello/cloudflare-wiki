import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import type { FileEntry } from "../../shared/files";
import { request } from "./api";
import { type Action, FileActionDialog } from "./FileActionDialog";
import { FilesBrowser } from "./FilesBrowser";
import { FileUploadDialog } from "./FileUploadDialog";
import { failureText } from "./file-errors";
import type { FolderCreateAttempt } from "./folder-create-recovery";
import "./files.css";

function bytes(value: number) {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MiB`
    : value >= 1024
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${value} B`;
}
function date(value: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function FileMark({ folder = false }: { folder?: boolean }) {
  return (
    <svg
      className="files-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d={
          folder
            ? "M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h8v2"
            : "M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h5"
        }
      />
    </svg>
  );
}
function previewUrl(entry: FileEntry) {
  return `/api/admin/files/${entry.id}/${entry.thumbnailState === "ready" ? "thumbnail" : "image"}`;
}
function FilePreview({ entry, zh }: { entry: FileEntry; zh: boolean }) {
  const [failed, setFailed] = useState(false);
  const image =
    entry.kind === "file" &&
    entry.state === "ready" &&
    !entry.deletedAt &&
    entry.source?.mime !== "application/octet-stream";
  return (
    <div className="files-preview">
      {image && !failed ? (
        <img
          src={previewUrl(entry)}
          alt={entry.alt?.[zh ? "zh" : "en"] || entry.name}
          onError={() => setFailed(true)}
        />
      ) : (
        <>
          <FileMark folder={entry.kind === "folder"} />
          <span>
            {entry.deletedAt
              ? zh
                ? "回收站中的项目"
                : "Item in Trash"
              : failed
                ? zh
                  ? "预览暂不可用"
                  : "Preview unavailable"
                : entry.kind === "folder"
                  ? zh
                    ? "文件夹"
                    : "Folder"
                  : entry.source?.mime === "application/octet-stream"
                    ? zh
                      ? "附件"
                      : "Attachment"
                    : zh
                      ? "等待上传"
                      : "Awaiting upload"}
          </span>
        </>
      )}
    </div>
  );
}
export function FilesPage({
  language,
  session,
  onSessionChange,
}: {
  language: Language;
  session: AuthSession;
  onSessionChange(session: AuthSession): void;
}) {
  const zh = language === "zh";
  const [parentId, setParentId] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeSession, setActiveSession] = useState(session);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [uploading, setUploading] = useState(false);
  const [folderRecovery, setFolderRecovery] =
    useState<FolderCreateAttempt | null>(null);
  const pendingFolder = useRef(false);
  pendingFolder.current = folderRecovery !== null;
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (pendingFolder.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const signout = (event: Event) => {
      if (pendingFolder.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("wiki:before-signout", signout);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("wiki:before-signout", signout);
    };
  }, []);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  function refresh() {
    setRefreshKey((value) => value + 1);
  }
  function updateSession(next: AuthSession) {
    setActiveSession(next);
    onSessionChange(next);
    setBlocked(false);
    refresh();
  }
  async function reconnect() {
    if (busy || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      const result = await request<{ session: AuthSession }>("session", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        updateSession(result.session);
        setSelected(null);
        setNotice(
          zh
            ? "会话已恢复，请重新选择文件后操作。"
            : "Session restored. Select the file again before making changes.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const publicUrl =
    selected?.kind === "file" &&
    selected.state === "ready" &&
    selected.publishedAt &&
    !selected.deletedAt
      ? `/files/${selected.id}/${selected.source?.mime === "application/octet-stream" ? "download" : "image"}`
      : null;
  async function copyUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(
        new URL(publicUrl, location.origin).href,
      );
      setNotice(zh ? "公开链接已复制。" : "Public URL copied.");
    } catch {
      setNotice(
        zh
          ? "无法自动复制。请选中下面的公开链接并复制。"
          : "Automatic copy is unavailable. Select and copy the public URL below.",
      );
    }
  }
  function changeFolder(id: string | null) {
    setParentId(id);
    setSelected(null);
    setNotice(null);
  }
  const editable = Boolean(
    selected && selected.state === "ready" && !selected.deletedAt,
  );
  return (
    <div className="files-workspace">
      <header className="files-page-heading">
        <div>
          <span className="admin-eyebrow">
            {zh ? "内容 · 文件资料库" : "CONTENT · FILE LIBRARY"}
          </span>
          <h1>{zh ? "文件与图片" : "Files & images"}</h1>
          <p>
            {zh
              ? "整理教程截图与附件，为文档选择恰当的素材。"
              : "Organize screenshots and attachments for your documentation."}
          </p>
        </div>
        <div className="files-heading-actions">
          <button
            className="admin-button secondary"
            type="button"
            disabled={blocked || trash}
            onClick={() => setAction("folder")}
          >
            {folderRecovery
              ? zh
                ? "检查新建结果"
                : "Review folder creation"
              : zh
                ? "新建文件夹"
                : "New folder"}
          </button>
          <button
            className="admin-button"
            type="button"
            disabled={blocked || trash}
            onClick={() => setUploading(true)}
          >
            {zh ? "上传文件" : "Upload file"}
          </button>
        </div>
      </header>
      {notice && (
        <p className="admin-notice success" role="status">
          {notice}
        </p>
      )}
      {blocked && (
        <section className="admin-notice error">
          <p>
            {zh
              ? "会话需要重新验证。文件操作已暂停。"
              : "Verify your session to continue making file changes."}
          </p>
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
              className="admin-button secondary"
              type="button"
              disabled={busy}
              onClick={() => void reconnect()}
            >
              {zh ? "重新验证会话" : "Check session"}
            </button>
          </div>
          {Boolean(failure) && <p role="alert">{failureText(failure, zh)}</p>}
        </section>
      )}
      <div className="files-layout">
        <section
          className="admin-panel files-library-panel"
          aria-label={zh ? "文件浏览器" : "File browser"}
        >
          <div className="files-library-tabs">
            <fieldset aria-label={zh ? "文件范围" : "File scope"}>
              <button
                type="button"
                aria-pressed={!trash}
                onClick={() => {
                  setTrash(false);
                  setSelected(null);
                }}
              >
                {zh ? "资料库" : "Library"}
              </button>
              <button
                type="button"
                aria-pressed={trash}
                onClick={() => {
                  setTrash(true);
                  setSelected(null);
                }}
              >
                {zh ? "回收站" : "Trash"}
              </button>
            </fieldset>
          </div>
          <FilesBrowser
            language={language}
            parentId={parentId}
            onParentChange={changeFolder}
            selectedId={selected?.id}
            onSelect={setSelected}
            trash={trash}
            refreshKey={refreshKey}
            onSessionRequired={() => setBlocked(true)}
          />
        </section>
        <aside
          className="admin-panel files-properties"
          aria-label={zh ? "文件属性" : "File properties"}
        >
          {selected ? (
            <>
              <FilePreview
                key={`${selected.id}-${selected.version}`}
                entry={selected}
                zh={zh}
              />
              <div className="files-properties-body">
                <div className="files-properties-heading">
                  <h2>{selected.name}</h2>
                  <span
                    className={`files-status ${selected.publishedAt ? "public" : ""}`}
                  >
                    {selected.deletedAt
                      ? zh
                        ? "回收站"
                        : "Trash"
                      : selected.state === "pending"
                        ? zh
                          ? "上传未完成"
                          : "Upload pending"
                        : selected.kind === "folder"
                          ? zh
                            ? "文件夹"
                            : "Folder"
                          : selected.publishedAt
                            ? zh
                              ? "公开"
                              : "Public"
                            : zh
                              ? "私有"
                              : "Private"}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>{zh ? "类型" : "Type"}</dt>
                    <dd>
                      {selected.kind === "folder"
                        ? zh
                          ? "文件夹"
                          : "Folder"
                        : (selected.source?.mime ?? "—")}
                    </dd>
                  </div>
                  {selected.source && (
                    <div>
                      <dt>{zh ? "大小" : "Size"}</dt>
                      <dd>{bytes(selected.source.bytes)}</dd>
                    </div>
                  )}
                  {selected.source?.width && (
                    <div>
                      <dt>{zh ? "尺寸" : "Dimensions"}</dt>
                      <dd>
                        {selected.source.width} × {selected.source.height}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{zh ? "更新于" : "Updated"}</dt>
                    <dd>{date(selected.updatedAt, zh)}</dd>
                  </div>
                  {selected.kind === "file" && (
                    <div>
                      <dt>{zh ? "缩略图" : "Thumbnail"}</dt>
                      <dd>
                        {
                          {
                            none: zh ? "未提供" : "Not supplied",
                            pending: zh ? "尚未完成" : "Pending",
                            ready: zh ? "可用" : "Ready",
                            abandoned: zh ? "已放弃" : "Abandoned",
                          }[selected.thumbnailState]
                        }
                      </dd>
                    </div>
                  )}
                </dl>
                {selected.alt && (
                  <div className="files-alt-summary">
                    <strong>{zh ? "替代文本" : "Alternative text"}</strong>
                    <p>
                      <span>中文</span>
                      {selected.alt.zh || (zh ? "未填写" : "Not set")}
                    </p>
                    <p>
                      <span>English</span>
                      {selected.alt.en || (zh ? "未填写" : "Not set")}
                    </p>
                  </div>
                )}
                {publicUrl && (
                  <label className="admin-field files-public-url">
                    <span>{zh ? "公开链接" : "Public URL"}</span>
                    <input
                      readOnly
                      value={new URL(publicUrl, location.origin).href}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      className="admin-button secondary"
                      type="button"
                      onClick={() => void copyUrl()}
                    >
                      {zh ? "复制链接" : "Copy URL"}
                    </button>
                  </label>
                )}
                {selected.kind === "file" &&
                  !selected.publishedAt &&
                  !selected.deletedAt &&
                  selected.state === "ready" && (
                    <p className="files-help">
                      {zh
                        ? "此文件目前仅管理员可见。公开后才能在页面编辑器中插入。"
                        : "Only the administrator can access this file. Publish it before inserting it in an article."}
                    </p>
                  )}
                <div className="files-item-actions">
                  {selected.kind === "folder" && !selected.deletedAt && (
                    <button
                      className="admin-button secondary"
                      type="button"
                      onClick={() => changeFolder(selected.id)}
                    >
                      {zh ? "打开文件夹" : "Open folder"}
                    </button>
                  )}
                  {selected.kind === "file" && editable && (
                    <a
                      className="admin-button secondary"
                      href={`/api/admin/files/${selected.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {zh ? "下载" : "Download"}
                    </a>
                  )}
                  {editable && (
                    <>
                      <button
                        type="button"
                        className="admin-button secondary"
                        disabled={blocked}
                        onClick={() => setAction("rename")}
                      >
                        {zh ? "重命名" : "Rename"}
                      </button>
                      <button
                        type="button"
                        className="admin-button secondary"
                        disabled={blocked}
                        onClick={() => setAction("move")}
                      >
                        {zh ? "移动" : "Move"}
                      </button>
                      {selected.kind === "file" && (
                        <>
                          <button
                            type="button"
                            className="admin-button secondary"
                            disabled={blocked}
                            onClick={() => setAction("alt")}
                          >
                            {zh ? "替代文本" : "Alternative text"}
                          </button>
                          <button
                            type="button"
                            className="admin-button secondary"
                            disabled={blocked}
                            onClick={() =>
                              setAction(
                                selected.publishedAt ? "unpublish" : "publish",
                              )
                            }
                          >
                            {selected.publishedAt
                              ? zh
                                ? "取消公开"
                                : "Unpublish"
                              : zh
                                ? "公开文件"
                                : "Publish file"}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="admin-button secondary files-danger"
                        disabled={blocked}
                        onClick={() => setAction("delete")}
                      >
                        {zh ? "移入回收站" : "Move to Trash"}
                      </button>
                    </>
                  )}
                  {selected.deletedAt && (
                    <button
                      type="button"
                      className="admin-button"
                      disabled={blocked}
                      onClick={() => setAction("restore")}
                    >
                      {zh ? "恢复" : "Restore"}
                    </button>
                  )}
                  {!selected.deletedAt &&
                    !selected.publishedAt &&
                    (selected.state === "pending" ||
                      selected.thumbnailState === "pending") && (
                      <button
                        type="button"
                        className="admin-button secondary files-danger"
                        disabled={blocked}
                        onClick={() => setAction("abandon")}
                      >
                        {zh ? "放弃未完成上传" : "Abandon unfinished upload"}
                      </button>
                    )}
                </div>
                {selected.state === "pending" && (
                  <p className="files-help">
                    {zh
                      ? "使用原上传对话框核对存储结果。若已关闭，可放弃此项后重新上传。"
                      : "Use the original upload dialog to check the stored result. If it is closed, abandon this item and start a new upload."}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="files-properties-empty">
              <FileMark />
              <h2>{zh ? "文件详情" : "File details"}</h2>
              <p>
                {zh
                  ? "选择文件或文件夹，查看预览、信息和可用操作。"
                  : "Select a file or folder to preview it and see its information and actions."}
              </p>
              <div className="files-storage-note">
                <span>
                  {zh
                    ? "私有上传 · 明确公开"
                    : "Private uploads · Explicit publication"}
                </span>
                <p>
                  {zh
                    ? "文件只有在你公开之后才会对访客可见。"
                    : "Files become visible to readers only after you publish them."}
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>
      {action && (
        <FileActionDialog
          action={action}
          entry={action === "folder" ? null : selected}
          parentId={parentId}
          language={language}
          session={activeSession}
          onSessionChange={updateSession}
          onSessionRequired={() => setBlocked(true)}
          folderRecovery={action === "folder" ? folderRecovery : null}
          onFolderRecovery={setFolderRecovery}
          onClose={() => {
            setAction(null);
            refresh();
          }}
          onDone={(entry) => {
            if (action === "folder") setFolderRecovery(null);
            setSelected(entry);
            setAction(null);
            setNotice(zh ? "文件资料库已更新。" : "File library updated.");
            refresh();
          }}
        />
      )}
      {uploading && (
        <FileUploadDialog
          language={language}
          parentId={parentId}
          session={activeSession}
          onSessionChange={updateSession}
          onClose={() => {
            setUploading(false);
            refresh();
          }}
          onChanged={refresh}
          onSessionRequired={() => setBlocked(true)}
        />
      )}
    </div>
  );
}
