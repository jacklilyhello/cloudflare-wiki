import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import {
  type AdminTranslation,
  CONTENT_LIMITS,
  type ContentDetail,
  type DraftInput,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import { ApiError, mutation, request } from "./api";
import { type EditorHandle, MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import "./editor.css";

type Fields = {
  title: string;
  description: string;
  markdown: string;
  tags: string;
  changeNote: string;
};
const empty: Fields = {
  title: "",
  description: "",
  markdown: "",
  tags: "",
  changeNote: "",
};

export function EditorPage({
  language,
  session,
  translationId,
  onExpired,
  onSessionChange,
}: {
  language: Language;
  session: AuthSession;
  translationId?: string;
  onExpired: () => void;
  onSessionChange: (session: AuthSession) => void;
}) {
  const zh = language === "zh";
  const query = new URLSearchParams(window.location.search);
  const [contentLanguage, setContentLanguage] = useState<Language>(
    query.get("language") === "en" ? "en" : "zh",
  );
  const [translation, setTranslation] = useState<AdminTranslation | null>(null);
  const [translations, setTranslations] = useState<AdminTranslation[]>([]);
  const [fields, setFields] = useState<Fields>(empty);
  const [baseline, setBaseline] = useState(JSON.stringify(empty));
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(Boolean(translationId));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [auth, setAuth] = useState(session);
  const [authExpired, setAuthExpired] = useState(false);
  const [view, setView] = useState<"split" | "write" | "preview">("split");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const editor = useRef<EditorHandle | null>(null);
  const reconnectController = useRef<AbortController | null>(null);
  const loadedId = useRef<string | undefined>(undefined);
  const dirty =
    JSON.stringify(fields) !== baseline || (!translation && Boolean(path));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef<() => void>(() => {});
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  // Keep unsaved source only in this tab's memory. No draft or credential is
  // persisted in localStorage. Browser navigation asks before discarding edits.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const saveKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    const beforeSignout = (event: Event) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", saveKey);
    window.addEventListener("wiki:before-signout", beforeSignout);
    return () => {
      reconnectController.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", saveKey);
      window.removeEventListener("wiki:before-signout", beforeSignout);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is an explicit retry; changing interface language must not replace unsaved text.
  useEffect(() => {
    if (!translationId || loadedId.current === translationId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void request<ContentDetail>(`pages/${encodeURIComponent(translationId)}`, {
      signal: controller.signal,
    })
      .then((detail) => {
        if (controller.signal.aborted) return;
        const next = {
          title: detail.draft.title,
          description: detail.draft.description,
          markdown: detail.draft.markdown,
          tags: detail.draft.tags.join(", "),
          changeNote: "",
        };
        setFields(next);
        setBaseline(JSON.stringify(next));
        setTranslation(detail.translation);
        setTranslations(detail.translations);
        setPath(detail.translation.path);
        setContentLanguage(detail.translation.language);
        loadedId.current = detail.translation.id;
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401)
          onExpiredRef.current();
        else
          setError(
            failure instanceof ApiError && failure.status === 404
              ? "页面不存在 / Page not found"
              : "无法读取文档，请重试 / Could not load the document",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [translationId, loadAttempt]);

  function failureMessage(failure: unknown) {
    if (failure instanceof ApiError) {
      if (failure.status === 412)
        return zh
          ? "页面已在其他窗口更新。你的内容仍保留，请复制或下载后重新读取最新版本，再合并修改。"
          : "This page changed in another tab. Your text is preserved. Copy or download it before loading the latest version and merging your changes.";
      if (failure.status === 409)
        return zh
          ? "路径或语言版本发生冲突，请检查后重试。"
          : "The path or translation conflicts with an existing page. Check it and try again.";
      if (failure.status === 401 || failure.status === 403) {
        setAuthExpired(true);
        return zh
          ? "登录已过期。草稿仍保留在此页面，请在新标签页登录后重新连接。"
          : "Your session expired. This tab keeps your draft. Sign in in a new tab, then reconnect.";
      }
      if (failure.status === 400)
        return zh
          ? "请检查标题、路径、标签或 Markdown 长度与格式。正文上限为 128,000 UTF-8 字节。"
          : "Check the title, path, tags and Markdown limits. The body limit is 128,000 UTF-8 bytes.";
    }
    return zh
      ? "请求未完成，结果可能尚未确认。你的内容仍在此页；请先查看最新版本，再决定是否重试。"
      : "The request did not complete and its outcome may be unknown. Your text remains here; inspect the latest revision before retrying.";
  }

  async function save(publish = false) {
    if (busy || loading || translation?.deletedAt || authExpired) return;
    if (!fields.title.trim() || (!translation && !path.trim())) {
      setError(zh ? "请填写标题和页面路径。" : "Enter a title and page path.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const snapshot = { ...fields };
    let draftConfirmed = false;
    try {
      let current = translation;
      const input: DraftInput = {
        ...snapshot,
        tags: snapshot.tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      if (!current) {
        const parentPageId = query.get("pageId");
        const result = await request<{ translation: AdminTranslation }>(
          "pages",
          mutation(
            "POST",
            {
              ...input,
              language: contentLanguage,
              path,
              ...(parentPageId ? { pageId: parentPageId } : {}),
            },
            auth.csrfToken,
          ),
        );
        current = result.translation;
      } else if (JSON.stringify(snapshot) !== baseline) {
        const result = await request<{ translation: AdminTranslation }>(
          `pages/${encodeURIComponent(current.id)}/draft`,
          mutation(
            "PUT",
            { ...input, expectedVersion: current.version },
            auth.csrfToken,
          ),
        );
        current = result.translation;
      }
      // Keep the successful draft version even if the following publish fails.
      setTranslation(current);
      const saved = { ...snapshot, changeNote: "" };
      setFields(saved);
      setBaseline(JSON.stringify(saved));
      dirtyRef.current = false;
      draftConfirmed = true;
      if (!translationId) {
        loadedId.current = current.id;
        window.history.replaceState(
          null,
          "",
          `/admin/pages/${encodeURIComponent(current.id)}/edit`,
        );
      }
      if (publish) {
        const result = await request<{ translation: AdminTranslation }>(
          `pages/${encodeURIComponent(current.id)}/publish`,
          mutation(
            "POST",
            {
              expectedVersion: current.version,
              revisionId: current.draftRevisionId,
            },
            auth.csrfToken,
          ),
        );
        current = result.translation;
        setTranslation(current);
      }
      setNotice(
        publish
          ? zh
            ? "已发布，访客现在可以阅读这个版本。"
            : "Published. Readers can now view this version."
          : zh
            ? "草稿已保存；公开页面不会改变。"
            : "Draft saved. The published page is unchanged.",
      );
    } catch (failure) {
      const prefix =
        publish && draftConfirmed
          ? zh
            ? "草稿已保存，但发布未确认。"
            : "Draft saved, but publication was not confirmed. "
          : "";
      setError(prefix + failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = () => {
    void save();
  };

  async function unpublish() {
    if (
      !translation ||
      busy ||
      !window.confirm(
        zh
          ? "取消发布后，访客将无法阅读此页面。草稿与历史会保留。"
          : "Unpublishing hides this page from readers. Drafts and history remain. Continue?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ translation: AdminTranslation }>(
        `pages/${encodeURIComponent(translation.id)}/unpublish`,
        mutation(
          "POST",
          { expectedVersion: translation.version },
          auth.csrfToken,
        ),
      );
      setTranslation(result.translation);
      setNotice(zh ? "已取消发布。" : "Page unpublished.");
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function insert(
    before: string,
    sample: string,
    after = "",
    quoteLines = false,
  ) {
    const instance = editor.current;
    const selection = instance?.getSelection();
    if (!instance || !selection || busy || translation?.deletedAt) return;
    const text = instance.getModel()?.getValueInRange(selection) || sample;
    instance.pushUndoStop();
    instance.executeEdits("wiki-markdown-toolbar", [
      {
        range: selection,
        text: `${before}${
          quoteLines
            ? text
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")
            : text
        }${after}`,
        forceMoveMarkers: true,
      },
    ]);
    instance.pushUndoStop();
    instance.focus();
  }

  function downloadDraft() {
    // This browser-generated file contains only the owner's current draft.
    const blob = new Blob([fields.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wiki-draft.md";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function reconnect() {
    if (busy || reconnectController.current) return;
    const controller = new AbortController();
    reconnectController.current = controller;
    setBusy(true);
    try {
      const result = await request<{ session: AuthSession }>("session", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setAuth(result.session);
      onSessionChange(result.session);
      setAuthExpired(false);
      setError(null);
      setNotice(
        zh
          ? "登录已恢复，你的未保存内容保持不变。"
          : "Session restored. Your unsaved text is unchanged.",
      );
    } catch {
      if (controller.signal.aborted) return;
      setError(
        zh
          ? "请先在新标签页完成登录，再重新连接。"
          : "Sign in in a new tab before reconnecting.",
      );
    } finally {
      if (reconnectController.current === controller)
        reconnectController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const otherLanguage: Language = contentLanguage === "zh" ? "en" : "zh";
  const counterpart = translations.find(
    (item) => item.language === otherLanguage,
  );
  const readOnly = busy || Boolean(translation?.deletedAt);
  if (loading)
    return (
      <div className="admin-panel admin-loading" role="status">
        {zh ? "正在打开文档…" : "Opening document…"}
      </div>
    );
  if (translationId && !translation)
    return (
      <div className="admin-panel wiki-editor-empty">
        <h1>{zh ? "无法打开文档" : "Document unavailable"}</h1>
        <p role="alert">{error}</p>
        <button
          className="admin-button"
          type="button"
          onClick={() => setLoadAttempt((value) => value + 1)}
        >
          {zh ? "重试" : "Try again"}
        </button>
        <a href="/admin/pages">{zh ? "返回页面列表" : "Back to pages"}</a>
      </div>
    );
  return (
    <div className="wiki-editor-page">
      <div className="wiki-editor-heading">
        <div>
          <p className="admin-eyebrow">
            {zh ? "内容 / MARKDOWN" : "CONTENT / MARKDOWN"}
          </p>
          <h1>
            {translation
              ? fields.title || (zh ? "编辑文档" : "Edit document")
              : zh
                ? "新建文档"
                : "New document"}
          </h1>
          <p>
            <span className={`wiki-save-state ${dirty ? "unsaved" : ""}`}>
              {dirty
                ? zh
                  ? "有未保存的修改"
                  : "Unsaved changes"
                : zh
                  ? "已保存"
                  : "Saved"}
            </span>
            <span>
              {translation
                ? `v${translation.version}`
                : zh
                  ? "仅在发布后公开"
                  : "Private until published"}
            </span>
          </p>
        </div>
        <div className="wiki-editor-actions">
          <button
            className="admin-button secondary"
            disabled={readOnly || authExpired}
            type="button"
            onClick={() => void save()}
          >
            {busy
              ? zh
                ? "处理中…"
                : "Working…"
              : zh
                ? "保存草稿"
                : "Save draft"}
          </button>
          <button
            className="admin-button"
            disabled={readOnly || authExpired}
            type="button"
            onClick={() => void save(true)}
          >
            {zh ? "发布" : "Publish"}
          </button>
        </div>
      </div>
      {error && (
        <div className="admin-notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="admin-notice success" role="status">
          {notice}
        </div>
      )}
      {authExpired && (
        <div className="wiki-session-recovery">
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
          <button type="button" onClick={downloadDraft}>
            {zh ? "下载当前 Markdown" : "Download current Markdown"}
          </button>
        </div>
      )}
      {translation?.deletedAt && (
        <div className="admin-notice error">
          {zh
            ? "此页面已删除。请先在页面列表的回收站中恢复。"
            : "This page is deleted. Restore it from the pages trash before editing."}
        </div>
      )}
      <section className="admin-panel wiki-document-details">
        <button
          className="wiki-details-toggle"
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          <span>{zh ? "文档信息" : "Document details"}</span>
          <span>
            {contentLanguage === "zh" ? "中文" : "English"} · /{path || "…"}{" "}
            {detailsOpen ? "−" : "+"}
          </span>
        </button>
        {detailsOpen && (
          <fieldset disabled={readOnly} className="wiki-metadata-grid">
            <label className="admin-field">
              <span>{zh ? "标题" : "Title"}</span>
              <input
                required
                maxLength={CONTENT_LIMITS.title}
                value={fields.title}
                onChange={(event) =>
                  setFields({ ...fields, title: event.target.value })
                }
              />
            </label>
            <label className="admin-field">
              <span>{zh ? "语言" : "Language"}</span>
              <select
                disabled={Boolean(translation)}
                value={contentLanguage}
                onChange={(event) =>
                  setContentLanguage(event.target.value as Language)
                }
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="admin-field wiki-field-wide">
              <span>{zh ? "描述" : "Description"}</span>
              <input
                maxLength={CONTENT_LIMITS.description}
                value={fields.description}
                onChange={(event) =>
                  setFields({ ...fields, description: event.target.value })
                }
              />
            </label>
            <label className="admin-field">
              <span>{zh ? "页面路径" : "Page path"}</span>
              <input
                maxLength={CONTENT_LIMITS.path}
                value={path}
                readOnly={Boolean(translation)}
                placeholder="guide/getting-started"
                onChange={(event) => setPath(event.target.value)}
              />
              <small>
                {translation
                  ? zh
                    ? "在页面列表中移动或重命名路径。"
                    : "Move or rename paths from the pages list."
                  : zh
                    ? "使用小写字母、数字、中文、连字符；以 / 分隔目录。"
                    : "Use lowercase letters, numbers or hyphens; separate folders with /."}
              </small>
            </label>
            <label className="admin-field">
              <span>{zh ? "标签" : "Tags"}</span>
              <input
                maxLength={1100}
                value={fields.tags}
                placeholder={zh ? "教程, 入门" : "guide, getting-started"}
                onChange={(event) =>
                  setFields({ ...fields, tags: event.target.value })
                }
              />
              <small>
                {zh
                  ? "逗号分隔，最多 16 个标签"
                  : "Separate with commas, up to 16 tags"}
              </small>
            </label>
          </fieldset>
        )}
      </section>
      <section className={`admin-panel wiki-writing-panel view-${view}`}>
        <header className="wiki-writing-toolbar">
          <div className="wiki-markdown-tools">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => insert("**", zh ? "加粗文本" : "bold text", "**")}
              title={zh ? "加粗" : "Bold"}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => insert("*", zh ? "斜体文本" : "italic text", "*")}
              title={zh ? "斜体" : "Italic"}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => insert("## ", zh ? "标题" : "Heading", "\n")}
              title={zh ? "标题" : "Heading"}
            >
              H₂
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() =>
                insert(
                  "[",
                  zh ? "链接文字" : "Link text",
                  "](https://example.com)",
                )
              }
              title={zh ? "链接" : "Link"}
            >
              ↗
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => insert("\n```text\n", "code", "\n```\n")}
              title={zh ? "代码块" : "Code block"}
            >
              〈/〉
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() =>
                insert("\n", "| A | B |\n| --- | --- |\n| 1 | 2 |", "\n")
              }
              title={zh ? "表格" : "Table"}
            >
              ▦
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() =>
                insert(
                  "\n> [!NOTE]\n",
                  zh ? "提示内容" : "A helpful note",
                  "\n",
                  true,
                )
              }
              title={zh ? "提示框" : "Callout"}
            >
              ⓘ
            </button>
          </div>
          <fieldset
            className="wiki-editor-view"
            aria-label={zh ? "编辑视图" : "Editor view"}
          >
            {(["write", "split", "preview"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                {mode === "write"
                  ? zh
                    ? "编辑"
                    : "Write"
                  : mode === "split"
                    ? zh
                      ? "分栏"
                      : "Split"
                    : zh
                      ? "预览"
                      : "Preview"}
              </button>
            ))}
          </fieldset>
        </header>
        <div className="wiki-writing-grid">
          <div className="wiki-source-pane">
            <div className="wiki-pane-label">
              MARKDOWN <span>⌘ / Ctrl + S</span>
            </div>
            <MarkdownCodeEditor
              value={fields.markdown}
              onChange={(markdown) =>
                setFields((current) => ({ ...current, markdown }))
              }
              readOnly={readOnly}
              language={language}
              onReady={(instance) => {
                editor.current = instance;
              }}
            />
          </div>
          <div className="wiki-preview-pane">
            <div className="wiki-pane-label">
              {zh ? "实时预览" : "LIVE PREVIEW"}
              <span>{contentLanguage === "zh" ? "中文" : "English"}</span>
            </div>
            <MarkdownPreview
              markdown={fields.markdown}
              language={contentLanguage}
              session={auth}
              onExpired={() => setAuthExpired(true)}
            />
          </div>
        </div>
        <footer className="wiki-writing-footer">
          <span>
            {new TextEncoder().encode(fields.markdown).length.toLocaleString()}{" "}
            / 128,000 bytes
          </span>
          <a
            href={publicPath(contentLanguage, "guide/markdown")}
            target="_blank"
            rel="noopener noreferrer"
          >
            {zh ? "Markdown 格式参考 ↗" : "Markdown reference ↗"}
          </a>
        </footer>
      </section>
      <div className="wiki-editor-bottom">
        <label className="admin-field">
          <span>{zh ? "修改说明" : "Change note"}</span>
          <input
            maxLength={CONTENT_LIMITS.changeNote}
            value={fields.changeNote}
            disabled={readOnly}
            placeholder={
              zh
                ? "简要说明这次修改，便于之后查看历史"
                : "Describe this change for the revision history"
            }
            onChange={(event) =>
              setFields({ ...fields, changeNote: event.target.value })
            }
          />
        </label>
        <div className="wiki-editor-links">
          <a href="/admin/pages">{zh ? "页面列表" : "All pages"}</a>
          {translation && (
            <>
              <a
                href={`/admin/pages/${encodeURIComponent(translation.id)}/history`}
              >
                {zh ? "版本历史" : "Version history"}
              </a>
              <a
                href={
                  counterpart
                    ? `/admin/pages/${encodeURIComponent(counterpart.id)}/edit`
                    : `/admin/pages/new?language=${otherLanguage}&pageId=${encodeURIComponent(translation.pageId)}`
                }
              >
                {counterpart
                  ? zh
                    ? "编辑对应翻译"
                    : "Edit translation"
                  : zh
                    ? "添加对应翻译"
                    : "Add translation"}
              </a>
              {translation.publishedRevisionId && (
                <>
                  <a
                    href={publicPath(contentLanguage, path)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {zh ? "查看公开页面 ↗" : "Published page ↗"}
                  </a>
                  <button
                    type="button"
                    disabled={busy || authExpired}
                    onClick={() => void unpublish()}
                  >
                    {zh ? "取消发布" : "Unpublish"}
                  </button>
                </>
              )}
            </>
          )}
          <button type="button" onClick={downloadDraft}>
            {zh ? "下载 Markdown" : "Download Markdown"}
          </button>
        </div>
      </div>
    </div>
  );
}
