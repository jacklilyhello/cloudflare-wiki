import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import {
  defaultFileLabel,
  type FileInsertionKind,
  fileMarkdown,
  isFileImage,
  isInsertableFile,
} from "../../shared/file-markdown";
import { FILE_LIMITS, type FileEntry } from "../../shared/files";
import { ApiError, request } from "./api";
import { FilesBrowser } from "./FilesBrowser";
import "./file-picker.css";

export function FilePicker({
  language,
  contentLanguage,
  blocked,
  onSessionRequired,
  onSessionChange,
  onInsert,
  onClose,
}: {
  language: Language;
  contentLanguage: Language;
  blocked: boolean;
  onSessionRequired: () => void;
  onSessionChange: (session: AuthSession) => void;
  onInsert: (markdown: string) => (() => void) | null;
  onClose: () => void;
}) {
  const zh = language === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const focusAfterInsert = useRef<(() => void) | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [latest, setLatest] = useState<FileEntry | null>(null);
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [kind, setKind] = useState<FileInsertionKind>("image");
  const [busy, setBusy] = useState(false);
  const [sessionBlocked, setSessionBlocked] = useState(blocked);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const blockedNow = blocked || sessionBlocked;

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    closeButton.current?.focus();
    return () => {
      controller.current?.abort();
      const restoreEditorFocus = focusAfterInsert.current;
      focusAfterInsert.current = null;
      // Run after the dialog leaves the DOM. Successful insertion owns this
      // restoration; cancel returns to the control that opened the picker.
      if (restoreEditorFocus) restoreEditorFocus();
      else if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
      )
        previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!blocked) return;
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setSessionBlocked(true);
  }, [blocked]);

  function requireSession() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setSessionBlocked(true);
    onSessionRequired();
  }

  function select(entry: FileEntry) {
    if (blockedNow || reloadRequired || busy) return;
    if (entry.kind === "folder") {
      setParentId(entry.id);
      return;
    }
    setSelected(entry);
    setLatest(null);
    setLabel(defaultFileLabel(entry, contentLanguage));
    setLabelEdited(false);
    setKind(isFileImage(entry) ? "image" : "download");
    setError(null);
  }

  async function reconnect() {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ session: AuthSession }>("session", {
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      onSessionChange(result.session);
      setSessionBlocked(false);
      setReloadRequired(true);
    } catch {
      if (!pending.signal.aborted)
        setError(
          zh
            ? "请先在新标签页登录，再重新连接。"
            : "Sign in in a new tab, then reconnect.",
        );
    } finally {
      if (controller.current === pending) controller.current = null;
      if (!pending.signal.aborted) setBusy(false);
    }
  }

  async function reload() {
    if (blockedNow || controller.current) return;
    setRefreshKey((value) => value + 1);
    setReloadRequired(false);
    setError(null);
    if (!selected) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    try {
      const current = await request<FileEntry>(`files/${selected.id}`, {
        signal: pending.signal,
      });
      if (pending.signal.aborted || controller.current !== pending) return;
      if (current.id !== selected.id) throw new Error("Invalid file response.");
      if (current.version !== selected.version) setLatest(current);
      else {
        setSelected(current);
        setLatest(null);
      }
    } catch (failure) {
      if (pending.signal.aborted) return;
      if (
        failure instanceof ApiError &&
        (failure.status === 401 || failure.status === 403)
      ) {
        requireSession();
        return;
      }
      setError(
        zh
          ? "无法重新读取所选文件，请重试或选择其他文件。"
          : "Could not reload the selected file. Retry or select another file.",
      );
    } finally {
      if (controller.current === pending) controller.current = null;
      if (!pending.signal.aborted) setBusy(false);
    }
  }

  function reviewLatest() {
    if (!latest || blockedNow || busy) return;
    setSelected(latest);
    if (!labelEdited) setLabel(defaultFileLabel(latest, contentLanguage));
    if (!isFileImage(latest)) setKind("download");
    setLatest(null);
    setError(null);
  }

  async function insert() {
    if (
      !selected ||
      !isInsertableFile(selected) ||
      blockedNow ||
      reloadRequired ||
      latest ||
      controller.current
    )
      return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError(null);
    try {
      const current = await request<FileEntry>(`files/${selected.id}`, {
        signal: pending.signal,
      });
      if (pending.signal.aborted || controller.current !== pending) return;
      if (current.id !== selected.id) throw new Error("Invalid file response.");
      if (current.version !== selected.version) {
        setLatest(current);
        setError(
          zh
            ? "文件已更新。请核对下方的最新信息，再确认使用此版本。"
            : "This file changed. Review the latest details below before choosing this version.",
        );
        return;
      }
      if (!isInsertableFile(current)) {
        setLatest(current);
        setError(
          zh
            ? "文件现在无法公开访问。请在文件管理器中检查。"
            : "This file is no longer public. Check it in the File Manager.",
        );
        return;
      }
      const markdown = fileMarkdown(current, label, kind);
      const restoreEditorFocus = onInsert(markdown);
      if (restoreEditorFocus) {
        focusAfterInsert.current = restoreEditorFocus;
        onClose();
      } else
        setError(
          zh
            ? "文稿或选区已变化，尚未插入。请关闭选择器，重新选择插入位置。"
            : "The document or selection changed. Nothing was inserted. Close the picker and choose the insertion point again.",
        );
    } catch (failure) {
      if (pending.signal.aborted) return;
      if (
        failure instanceof ApiError &&
        (failure.status === 401 || failure.status === 403)
      ) {
        requireSession();
        return;
      }
      setError(
        failure instanceof ApiError && failure.status === 404
          ? zh
            ? "文件已不可用。请重新加载文件列表。"
            : "This file is unavailable. Reload the file list."
          : zh
            ? "无法插入。请检查标签，并重新读取文件后再试。"
            : "Could not insert the file. Check its label and reload before trying again.",
      );
    } finally {
      if (controller.current === pending) controller.current = null;
      if (!pending.signal.aborted) setBusy(false);
    }
  }

  const displayed = latest ?? selected;
  return (
    <dialog
      ref={dialog}
      className="file-picker-dialog"
      aria-labelledby="file-picker-title"
      aria-describedby="file-picker-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="file-picker-heading">
        <div>
          <h2 id="file-picker-title">{zh ? "插入文件" : "Insert a file"}</h2>
          <p id="file-picker-description">
            {zh
              ? "浏览文件，选择已公开的图片或附件插入 Markdown。"
              : "Browse files and insert a published image or attachment into Markdown."}
          </p>
        </div>
        <button ref={closeButton} type="button" onClick={onClose}>
          {zh ? "关闭" : "Close"}
        </button>
      </header>
      <div className="file-picker-links">
        <a href="/admin/files" target="_blank" rel="noopener noreferrer">
          {zh ? "打开文件管理器 ↗" : "Open File Manager ↗"}
        </a>
        <button
          type="button"
          disabled={busy || blockedNow}
          onClick={() => void reload()}
        >
          {zh ? "重新加载文件" : "Reload files"}
        </button>
      </div>
      {error && (
        <p className="file-picker-error" role="alert">
          {error}
        </p>
      )}
      {blockedNow ? (
        <div className="file-picker-recovery" role="status">
          <p>
            {zh
              ? "登录已过期。草稿、选区和文件选择仍保留；重新连接后请重新加载文件。"
              : "Your session expired. Your draft, insertion point and file selection are preserved. Reconnect, then reload files."}
          </p>
          <a href="/admin" target="_blank" rel="noopener noreferrer">
            {zh ? "在新标签页登录" : "Sign in in a new tab"}
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconnect()}
          >
            {zh ? "重新连接" : "Reconnect"}
          </button>
        </div>
      ) : reloadRequired ? (
        <p className="file-picker-recovery" role="status">
          {zh
            ? "登录已恢复。点击“重新加载文件”后继续。"
            : "Session restored. Choose Reload files to continue."}
        </p>
      ) : (
        <fieldset disabled={busy} className="file-picker-browser">
          <FilesBrowser
            language={language}
            parentId={parentId}
            onParentChange={setParentId}
            selectedId={selected?.id}
            onSelect={select}
            refreshKey={refreshKey}
            onSessionRequired={requireSession}
          />
        </fieldset>
      )}
      {displayed && (
        <section
          className="file-picker-selection"
          aria-label={zh ? "已选文件" : "Selected file"}
        >
          <p className="file-picker-name">
            {displayed.name} <small>v{displayed.version}</small>
          </p>
          <p>
            {isInsertableFile(displayed)
              ? zh
                ? "已公开，可插入"
                : "Published and available for insertion"
              : zh
                ? "只有已就绪、已公开且未删除的文件可以插入。请在文件管理器中处理后重新加载。"
                : "Only ready, published files outside the trash can be inserted. Update the file in File Manager, then reload."}
          </p>
          {latest && (
            <>
              <p>
                {zh
                  ? "文件已更新，请核对这些信息后确认使用此版本。"
                  : "This file changed. Review these details before choosing this version."}
              </p>
              <p>
                {zh ? "最新替代文本：" : "Latest alt text: "}
                {latest.alt?.[contentLanguage] || "—"}
              </p>
              <button
                type="button"
                disabled={busy || blockedNow || reloadRequired}
                onClick={reviewLatest}
              >
                {zh ? "确认使用此版本" : "Use this version"}
              </button>
            </>
          )}
          <fieldset
            disabled={busy || blockedNow || reloadRequired || Boolean(latest)}
            className="file-picker-options"
          >
            <label>
              <span>
                {zh ? "替代文本 / 链接文字" : "Alt text / link label"}
              </span>
              <input
                maxLength={FILE_LIMITS.alt}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setLabelEdited(true);
                }}
              />
            </label>
            <label>
              <span>{zh ? "插入方式" : "Insert as"}</span>
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as FileInsertionKind)
                }
              >
                {isFileImage(displayed) && (
                  <option value="image">{zh ? "图片" : "Image"}</option>
                )}
                <option value="download">
                  {zh ? "下载链接" : "Download link"}
                </option>
              </select>
            </label>
          </fieldset>
        </section>
      )}
      <footer className="file-picker-actions">
        <button type="button" onClick={onClose}>
          {zh ? "取消" : "Cancel"}
        </button>
        <button
          className="admin-button"
          type="button"
          disabled={
            busy ||
            blockedNow ||
            reloadRequired ||
            Boolean(latest) ||
            !selected ||
            !isInsertableFile(selected) ||
            !label.trim()
          }
          onClick={() => void insert()}
        >
          {busy
            ? zh
              ? "正在核对…"
              : "Checking…"
            : zh
              ? "插入 Markdown"
              : "Insert Markdown"}
        </button>
      </footer>
    </dialog>
  );
}
