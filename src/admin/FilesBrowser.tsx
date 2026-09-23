import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Language } from "../../shared/contracts";
import { FILE_LIMITS, type FileEntry, type FilePage } from "../../shared/files";
import { ApiError, request } from "./api";
import {
  FileBrowserChanged,
  FolderPathUnavailable,
  fileBrowserQuery,
  fileThumbnailPath,
  mergeFilePages,
  resolveFolderTrail,
} from "./files-browser-model";
import "./files-browser.css";

export interface FilesBrowserProps {
  language: Language;
  parentId: string | null;
  onParentChange: (id: string | null) => void;
  selectedId?: string | null;
  onSelect: (entry: FileEntry) => void;
  trash?: boolean;
  refreshKey?: number;
  onSessionRequired: () => void;
  foldersOnly?: boolean;
  onLoaded?: (page: FilePage) => void;
}
type ReadError = "read" | "changed" | "session" | "folder";

function FileIcon({ folder = false }: { folder?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d={
          folder
            ? "M3 7h7l2 2h9v11H3V5h7l2 2h7v2"
            : "M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h4"
        }
      />
    </svg>
  );
}

function EntryImage({ entry }: { entry: FileEntry }) {
  const path = fileThumbnailPath(entry);
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`files-browser-visual${entry.kind === "folder" ? " folder" : ""}`}
    >
      {path && !failed ? (
        <img
          src={path}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <FileIcon folder={entry.kind === "folder"} />
      )}
    </span>
  );
}

function size(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function entryDescription(entry: FileEntry, zh: boolean) {
  if (entry.kind === "folder") return zh ? "文件夹" : "Folder";
  if (entry.state === "pending") return zh ? "等待完成上传" : "Upload pending";
  const source = entry.source;
  if (!source) return zh ? "文件" : "File";
  const kind =
    source.mime === "application/octet-stream"
      ? zh
        ? "附件"
        : "Attachment"
      : source.mime.slice(6).toUpperCase();
  return `${kind} · ${size(source.bytes)}`;
}

function errorText(error: ReadError, zh: boolean) {
  if (error === "session")
    return zh
      ? "请在上方重新连接管理员会话，然后重试读取。当前文件夹和搜索条件已保留。"
      : "Reconnect the administrator session above, then retry reading. Your folder and search are preserved.";
  if (error === "changed")
    return zh
      ? "文件库已更改，之前的分页已清除。请刷新以查看最新内容。"
      : "The library changed, so the previous pages were cleared. Refresh to view the latest contents.";
  if (error === "folder")
    return zh
      ? "当前文件夹路径不可用。请重试，或返回文件库根目录。"
      : "This folder path is unavailable. Retry or return to the library root.";
  return zh
    ? "暂时无法读取文件。请重试；这不会更改任何文件。"
    : "Files could not be read. Retry when ready; this does not change any files.";
}

export function FilesBrowser({
  language,
  parentId,
  onParentChange,
  selectedId,
  onSelect,
  trash = false,
  refreshKey = 0,
  onSessionRequired,
  foldersOnly = false,
  onLoaded,
}: FilesBrowserProps) {
  const zh = language === "zh";
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<FilePage | null>(null);
  const [trail, setTrail] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReadError | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentPage = useRef<FilePage | null>(null);
  const sessionBlocked = useRef(false);
  const previousRefresh = useRef(refreshKey);
  const callbacks = useRef({ onLoaded, onSessionRequired });
  callbacks.current = { onLoaded, onSessionRequired };

  const load = useCallback(
    async (append = false, explicit = false) => {
      if (sessionBlocked.current && !explicit) return;
      const previous = append ? currentPage.current : null;
      if (append && !previous?.nextCursor) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const current = ++generation.current;
      setBusy(true);
      setError(null);
      if (!append) {
        currentPage.current = null;
        setPage(null);
        setTrail([]);
      }
      try {
        const [result, folders] = await Promise.all([
          request<FilePage>(
            fileBrowserQuery({
              parentId,
              trash,
              query,
              cursor: previous?.nextCursor ?? undefined,
            }),
            { signal: controller.signal },
          ),
          append || trash
            ? Promise.resolve(null)
            : resolveFolderTrail(parentId, (id) =>
                request<FileEntry>(`files/${id}`, {
                  signal: controller.signal,
                }),
              ),
        ]);
        if (controller.signal.aborted || current !== generation.current) return;
        const merged = mergeFilePages(previous, result);
        currentPage.current = merged;
        setPage(merged);
        if (folders) setTrail(folders);
        sessionBlocked.current = false;
        callbacks.current.onLoaded?.(merged);
      } catch (cause) {
        if (controller.signal.aborted || current !== generation.current) return;
        controller.abort();
        const status = cause instanceof ApiError ? cause.status : null;
        if (status === 401 || status === 403) {
          sessionBlocked.current = true;
          currentPage.current = null;
          setPage(null);
          setError("session");
          callbacks.current.onSessionRequired();
        } else if (status === 412 || cause instanceof FileBrowserChanged) {
          currentPage.current = null;
          setPage(null);
          setError("changed");
        } else {
          setError(
            status === 404 || cause instanceof FolderPathUnavailable
              ? "folder"
              : "read",
          );
        }
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [parentId, query, trash],
  );

  useEffect(() => {
    const refreshed = previousRefresh.current !== refreshKey;
    previousRefresh.current = refreshKey;
    // A parent refresh after verified reconnect is explicit; navigation alone
    // cannot silently clear the authentication block.
    if (sessionBlocked.current && !refreshed) {
      currentPage.current = null;
      setPage(null);
      setTrail([]);
      setBusy(false);
      setError("session");
    } else {
      void load(false, refreshed);
    }
    return () => {
      active.current?.abort();
      generation.current++;
    };
  }, [load, refreshKey]);

  function navigate(id: string | null) {
    setSearch("");
    setQuery("");
    onParentChange(id);
  }

  function searchFolder() {
    if (busy) return;
    if (query === search.trim()) void load(false, true);
    else setQuery(search.trim());
  }

  const visible =
    page?.items.filter((entry) => !foldersOnly || entry.kind === "folder") ??
    [];
  return (
    <section
      className="files-browser"
      aria-label={zh ? "文件库浏览器" : "File library browser"}
    >
      <div className="files-browser-toolbar">
        {trash ? (
          <p className="files-browser-location">
            {zh ? "回收站 · 所有文件夹" : "Trash · All folders"}
          </p>
        ) : (
          <nav
            className="files-browser-breadcrumbs"
            aria-label={zh ? "文件夹路径" : "Folder path"}
          >
            <ol>
              <li>
                <button
                  type="button"
                  aria-current={parentId === null ? "location" : undefined}
                  onClick={() => navigate(null)}
                >
                  {zh ? "文件库" : "Library"}
                </button>
              </li>
              {trail.map((folder) => (
                <li key={folder.id}>
                  <span aria-hidden="true">/</span>
                  <button
                    type="button"
                    title={folder.name}
                    aria-current={
                      folder.id === parentId ? "location" : undefined
                    }
                    onClick={() => navigate(folder.id)}
                  >
                    {folder.name}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <button
          className="files-browser-refresh"
          type="button"
          disabled={busy}
          onClick={() => void load(false, true)}
        >
          {zh ? "刷新" : "Refresh"}
        </button>
      </div>
      <search
        className="files-browser-search"
        aria-label={
          trash
            ? zh
              ? "搜索回收站"
              : "Search Trash"
            : zh
              ? "搜索当前文件夹"
              : "Search this folder"
        }
      >
        <label htmlFor={searchId}>
          {trash
            ? zh
              ? "搜索整个回收站"
              : "Search all Trash"
            : zh
              ? "仅搜索当前文件夹"
              : "Search this folder only"}
        </label>
        <div>
          <input
            id={searchId}
            type="search"
            maxLength={FILE_LIMITS.query}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              event.stopPropagation();
              searchFolder();
            }}
            placeholder={zh ? "按名称搜索…" : "Search by name…"}
          />
          <button type="button" disabled={busy} onClick={searchFolder}>
            {zh ? "搜索" : "Search"}
          </button>
        </div>
      </search>
      {error && (
        <div className="files-browser-notice" role="alert">
          <p>{errorText(error, zh)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(false, true)}
          >
            {error === "changed"
              ? zh
                ? "刷新文件库"
                : "Refresh library"
              : zh
                ? "重试读取"
                : "Retry read"}
          </button>
        </div>
      )}
      <div className="files-browser-results" aria-busy={busy}>
        <p className="files-browser-count" role="status">
          {busy
            ? zh
              ? "正在读取…"
              : "Reading…"
            : page
              ? zh
                ? `已显示 ${visible.length} 个${foldersOnly ? "文件夹" : "项目"}`
                : `${visible.length} ${foldersOnly ? "folders" : "items"} shown`
              : ""}
        </p>
        {page && visible.length === 0 && (
          <div className="files-browser-empty">
            <FileIcon folder />
            <p>
              {query
                ? zh
                  ? "当前范围内没有匹配项目。"
                  : "No matching items in this location."
                : foldersOnly
                  ? zh
                    ? "这里还没有显示的文件夹。"
                    : "No folders shown here yet."
                  : zh
                    ? "此处暂无文件或文件夹。"
                    : "No files or folders here yet."}
            </p>
            {page.nextCursor && (
              <p>
                {zh
                  ? "还有未读取的项目，可继续加载。"
                  : "More items are available. Continue loading below."}
              </p>
            )}
          </div>
        )}
        <ul className="files-browser-list">
          {visible.map((entry) => (
            <li
              className="files-browser-card"
              key={entry.id}
              data-selected={entry.id === selectedId}
            >
              <button
                type="button"
                className="files-browser-select"
                aria-pressed={entry.id === selectedId}
                onClick={() => onSelect(entry)}
                disabled={busy || error !== null}
              >
                <EntryImage
                  key={`${entry.id}-${entry.version}`}
                  entry={entry}
                />
                <span className="files-browser-entry-text">
                  <strong title={entry.name}>{entry.name}</strong>
                  <span>{entryDescription(entry, zh)}</span>
                </span>
              </button>
              <div className="files-browser-card-footer">
                <span className="files-browser-state">
                  {entry.deletedAt
                    ? zh
                      ? "已删除"
                      : "Deleted"
                    : entry.kind === "folder"
                      ? zh
                        ? "目录"
                        : "Directory"
                      : entry.publishedAt
                        ? zh
                          ? "公开"
                          : "Public"
                        : zh
                          ? "私有"
                          : "Private"}
                </span>
                {entry.kind === "folder" && !trash && (
                  <button
                    type="button"
                    disabled={busy || error !== null}
                    onClick={() => navigate(entry.id)}
                    aria-label={`${zh ? "打开文件夹" : "Open folder"}: ${entry.name}`}
                  >
                    {zh ? "打开" : "Open"}
                    <span aria-hidden="true"> →</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {page?.nextCursor && (
          <button
            type="button"
            className="files-browser-more"
            disabled={busy || error !== null}
            onClick={() => void load(true)}
          >
            {busy
              ? zh
                ? "正在读取…"
                : "Reading…"
              : zh
                ? "加载更多"
                : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}

export function FolderPicker({
  language,
  value,
  onChange,
  onSessionRequired,
  excludeId,
}: {
  language: Language;
  value: string | null;
  onChange: (id: string | null) => void;
  onSessionRequired: () => void;
  excludeId?: string;
}) {
  const zh = language === "zh";
  const [parentId, setParentId] = useState(value);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const candidate = selected?.id ?? parentId;
  return (
    <div className="files-folder-picker">
      <FilesBrowser
        language={language}
        parentId={parentId}
        onParentChange={(id) => {
          setParentId(id);
          setSelected(null);
          setLoaded(false);
        }}
        selectedId={selected?.id}
        onSelect={setSelected}
        foldersOnly
        onLoaded={() => setLoaded(true)}
        onSessionRequired={() => {
          setLoaded(false);
          onSessionRequired();
        }}
      />
      <div className="files-folder-picker-choice">
        <p>
          {selected
            ? `${zh ? "已选择" : "Selected"}: ${selected.name}`
            : zh
              ? "打开文件夹后使用当前目录，或选择列表中的文件夹。"
              : "Open a folder to use that location, or select a folder from the list."}
        </p>
        {candidate === excludeId && (
          <p role="status">
            {zh
              ? "文件夹不能作为自身的父目录。"
              : "A folder cannot be its own parent."}
          </p>
        )}
        <div>
          <button type="button" onClick={() => onChange(null)}>
            {zh ? "使用根目录" : "Use library root"}
          </button>
          <button
            type="button"
            disabled={!loaded || candidate === excludeId}
            onClick={() => onChange(candidate)}
          >
            {selected
              ? zh
                ? "使用所选文件夹"
                : "Use selected folder"
              : zh
                ? "使用当前文件夹"
                : "Use this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
