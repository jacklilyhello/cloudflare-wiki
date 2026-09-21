import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type {
  ContentDetail,
  ContentPage,
  PageSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import {
  NAVIGATION_LIMITS,
  type NavigationDocument,
  type NavigationNode,
  type NavigationTarget,
  normalizeNavigationUrl,
} from "../../shared/navigation";
import { publicPath } from "../../shared/paths";
import { ApiError, mutation, request } from "./api";
import {
  canMove,
  move,
  nodeDepth,
  normalize,
  removeNode,
  siblings,
} from "./navigation-tree";
import "./navigation.css";

type Draft = Pick<NavigationDocument, "mode" | "nodes">;
type Pending =
  | { kind: "language"; language: Language }
  | { kind: "reload" }
  | { kind: "seed" }
  | { kind: "delete"; id: string };
const MAX_NODES = NAVIGATION_LIMITS.nodes;
const MAX_DEPTH = NAVIGATION_LIMITS.depth;

function invalidNode(nodes: NavigationNode[]): NavigationNode | undefined {
  const references = new Set<string>();
  return nodes.find((node) => {
    if (nodeDepth(nodes, node) > MAX_DEPTH) return true;
    if (
      node.label !== null &&
      (!node.label.trim() || node.label.length > NAVIGATION_LIMITS.label)
    )
      return true;
    if (node.kind !== "page" && !node.label?.trim()) return true;
    if (
      node.kind === "link" &&
      (!node.externalUrl ||
        node.externalUrl.length > NAVIGATION_LIMITS.url ||
        !normalizeNavigationUrl(node.externalUrl))
    )
      return true;
    if (node.kind === "page") {
      if (!node.translationId || references.has(node.translationId))
        return true;
      references.add(node.translationId);
    }
    return false;
  });
}
function message(error: unknown, zh: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return zh
        ? "登录状态已变化。你的修改仍在此页，请重新连接后手动保存。"
        : "Your session has changed. Your edits are still here. Reconnect, then save when ready.";
    if (error.status === 412)
      return zh
        ? "导航已在别处更新。当前修改已保留，请读取最新版本后重新编辑；不会覆盖其他修改。"
        : "Navigation was updated elsewhere. Your edits are preserved. Load the latest version before editing again; other changes have not been overwritten.";
    if (error.status === 400 || error.status === 409)
      return zh
        ? "无法保存。请检查节点名称、链接、文章引用及目录层级。"
        : "Could not save. Check labels, links, page references and nesting.";
  }
  return zh
    ? "暂时无法完成操作。你的修改已保留，请稍后重试。"
    : "This operation could not be completed. Your edits are preserved. Please try again.";
}
function NavIcon({ kind }: { kind: NavigationNode["kind"] }) {
  return (
    <svg
      className={`navigation-icon ${kind}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          kind === "group"
            ? "M3 7h7l2 2h9v11H3zM3 7V4h7l2 3h9v2"
            : kind === "page"
              ? "M14 3H5v18h14V8l-5-5v5h5M9 12h6M9 16h6"
              : "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"
        }
      />
    </svg>
  );
}
function Modal({
  title,
  children,
  busy,
  onClose,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.showModal();
    return () => {
      if (previousFocus.current?.isConnected)
        previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="navigation-dialog"
      aria-labelledby="navigation-dialog-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <h2 id="navigation-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
function PagePicker({
  language,
  zh,
  existing,
  onChoose,
  onClose,
}: {
  language: Language;
  zh: boolean;
  existing: Set<string>;
  onChoose: (page: PageSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit read-only retry control.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setPages([]);
    setCursor(null);
    setLoading(true);
    setFailure(null);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        language,
        status: "active",
        limit: "30",
        q: query,
      });
      request<ContentPage<PageSummary>>(`pages?${params}`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) {
            setPages(result.items);
            setCursor(result.nextCursor);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setFailure(error);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [language, query, attempt]);
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailure(null);
    const controller = controllerRef.current;
    try {
      const result = await request<ContentPage<PageSummary>>(
        `pages?${new URLSearchParams({ language, status: "active", q: query, cursor, limit: "30" })}`,
        { signal: controller?.signal },
      );
      if (!controller?.signal.aborted) {
        setPages((current) => [...current, ...result.items]);
        setCursor(result.nextCursor);
      }
    } catch (error) {
      if (!controller?.signal.aborted) setFailure(error);
    } finally {
      if (!controller?.signal.aborted) setLoading(false);
    }
  }
  return (
    <Modal
      title={zh ? "选择 Wiki 页面" : "Choose a wiki page"}
      busy={false}
      onClose={onClose}
    >
      <p>
        {zh
          ? "选择当前语言的文章。尚未发布的文章会保留在目录中，发布后才对访客显示。"
          : "Choose a page in this language. Unpublished pages stay in your tree and appear to visitors after publication."}
      </p>
      <label className="admin-field navigation-picker-search">
        <span>{zh ? "搜索标题或路径" : "Search titles or paths"}</span>
        <input
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={zh ? "查找文章…" : "Find a page…"}
        />
      </label>
      {failure != null && (
        <div className="admin-notice error" role="alert">
          {message(failure, zh)}{" "}
          <button
            type="button"
            className="navigation-text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {zh ? "重试" : "Retry"}
          </button>
        </div>
      )}
      <ul className="navigation-picker-list" aria-busy={loading}>
        {pages.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              disabled={loading || existing.has(page.id)}
              onClick={() => onChoose(page)}
            >
              <NavIcon kind="page" />
              <span>
                <strong>{page.title}</strong>
                <small>{publicPath(page.language, page.path)}</small>
              </span>
              <span className="navigation-badge">
                {existing.has(page.id)
                  ? zh
                    ? "已在目录中"
                    : "Already added"
                  : page.publishedRevisionId
                    ? zh
                      ? "已发布"
                      : "Published"
                    : zh
                      ? "草稿"
                      : "Draft"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loading ? (
        <p role="status">{zh ? "正在查找页面…" : "Finding pages…"}</p>
      ) : !pages.length && !failure ? (
        <p>{zh ? "没有找到匹配页面。" : "No matching pages."}</p>
      ) : null}
      <div className="navigation-dialog-actions">
        {cursor && (
          <button
            className="admin-button secondary"
            type="button"
            disabled={loading}
            onClick={() => void more()}
          >
            {zh ? "加载更多" : "Load more"}
          </button>
        )}
        <button
          type="button"
          className="admin-button secondary"
          onClick={onClose}
        >
          {zh ? "取消" : "Cancel"}
        </button>
      </div>
    </Modal>
  );
}

export function NavigationPage({
  language,
  session,
  onSessionChange,
}: {
  language: Language;
  session: AuthSession;
  onSessionChange: (session: AuthSession) => void;
}) {
  const zh = language === "zh";
  const [contentLanguage, setContentLanguage] = useState<Language>(language);
  const [document, setDocument] = useState<NavigationDocument | null>(null);
  const [draft, setDraft] = useState<Draft>({ mode: "automatic", nodes: [] });
  const [targets, setTargets] = useState<Record<string, NavigationTarget>>({});
  const [activeSession, setActiveSession] = useState(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [picker, setPicker] = useState<"new" | string | null>(null);
  const [preview, setPreview] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const detailRequests = useRef(new Set<AbortController>());
  const [conflicted, setConflicted] = useState(false);
  const dirty =
    !!document &&
    JSON.stringify(draft) !==
      JSON.stringify({ mode: document.mode, nodes: document.nodes });
  const nodes = draft.nodes;
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedTarget = selected?.translationId
    ? targets[selected.translationId]
    : null;
  const invalid = useMemo(() => invalidNode(nodes), [nodes]);
  const reconnectNeeded =
    failure instanceof ApiError &&
    (failure.status === 401 || failure.status === 403);
  const custom = draft.mode === "custom";

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit read-only retry control.
  useEffect(() => {
    const controller = new AbortController();
    for (const pendingRequest of detailRequests.current) pendingRequest.abort();
    detailRequests.current.clear();
    setDocument(null);
    setDraft({ mode: "automatic", nodes: [] });
    setTargets({});
    setSelectedId(null);
    setConflicted(false);
    setLoading(true);
    setFailure(null);
    setNotice(null);
    request<NavigationDocument>(`navigation/${contentLanguage}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDocument(result);
        setDraft({ mode: result.mode, nodes: result.nodes });
        setTargets(
          Object.fromEntries(
            result.targets.map((target) => [target.id, target]),
          ),
        );
        setSelectedId(null);
        setCollapsed(new Set());
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      for (const pendingRequest of detailRequests.current)
        pendingRequest.abort();
      detailRequests.current.clear();
    };
  }, [contentLanguage, attempt]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeSignout = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("wiki:before-signout", beforeSignout);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("wiki:before-signout", beforeSignout);
    };
  }, [dirty]);

  function updateNodes(next: NavigationNode[]) {
    setDraft((current) => ({ ...current, nodes: next }));
    setNotice(null);
  }
  function updateSelected(value: Partial<NavigationNode>) {
    if (!selected) return;
    updateNodes(
      nodes.map((node) =>
        node.id === selected.id ? { ...node, ...value } : node,
      ),
    );
  }
  function label(node: NavigationNode, published = false) {
    return (
      node.label ||
      (node.translationId
        ? published
          ? targets[node.translationId]?.publishedTitle
          : targets[node.translationId]?.draftTitle
        : null) ||
      (zh ? "未选择文章" : "Choose a page")
    );
  }
  function status(node: NavigationNode) {
    if (node.kind !== "page") return null;
    const target = node.translationId ? targets[node.translationId] : null;
    return !target || target.deleted
      ? zh
        ? "引用不可用"
        : "Unavailable"
      : !target.publishedTitle
        ? zh
          ? "未发布"
          : "Unpublished"
        : null;
  }
  function add(kind: NavigationNode["kind"], page?: PageSummary) {
    if (nodes.length >= MAX_NODES) return;
    let parentId =
      selected?.kind === "group" ? selected.id : (selected?.parentId ?? null);
    if (
      parentId &&
      nodeDepth(
        nodes,
        nodes.find((node) => node.id === parentId) as NavigationNode,
      ) >= MAX_DEPTH
    )
      parentId = null;
    const id = crypto.randomUUID();
    updateNodes(
      normalize([
        ...nodes,
        {
          id,
          parentId,
          position: siblings(nodes, parentId).length,
          kind,
          label:
            kind === "page"
              ? null
              : kind === "group"
                ? zh
                  ? "新分组"
                  : "New group"
                : zh
                  ? "新链接"
                  : "New link",
          translationId: page?.id ?? null,
          externalUrl: kind === "link" ? "" : null,
        },
      ]),
    );
    setSelectedId(id);
    setCollapsed((current) => {
      const next = new Set(current);
      if (parentId) next.delete(parentId);
      return next;
    });
  }
  async function choosePage(page: PageSummary) {
    if (picker === "new") add("page", page);
    else if (picker)
      updateNodes(
        nodes.map((node) =>
          node.id === picker ? { ...node, translationId: page.id } : node,
        ),
      );
    setTargets((current) => ({
      ...current,
      [page.id]: {
        id: page.id,
        language: page.language,
        path: page.path,
        draftTitle: page.title,
        publishedTitle: null,
        deleted: !!page.deletedAt,
      },
    }));
    setPicker(null);
    const controller = new AbortController();
    detailRequests.current.add(controller);
    try {
      const detail = await request<ContentDetail>(
        `pages/${encodeURIComponent(page.id)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setTargets((current) => ({
        ...current,
        [page.id]: {
          id: page.id,
          language: page.language,
          path: detail.translation.path,
          draftTitle: detail.draft.title,
          publishedTitle: detail.published?.title ?? null,
          deleted: !!detail.translation.deletedAt,
        },
      }));
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      detailRequests.current.delete(controller);
    }
  }
  async function save() {
    if (
      !document ||
      document.language !== contentLanguage ||
      busy ||
      loading ||
      conflicted ||
      reconnectNeeded
    )
      return false;
    if (invalid) {
      setSelectedId(invalid.id);
      setFailure(new ApiError(400));
      return false;
    }
    for (const pendingRequest of detailRequests.current) pendingRequest.abort();
    detailRequests.current.clear();
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await request<NavigationDocument>(
        `navigation/${contentLanguage}`,
        mutation(
          "PUT",
          {
            expectedVersion: document.version,
            mode: draft.mode,
            nodes: normalize(nodes),
          },
          activeSession.csrfToken,
        ),
      );
      setDocument(result);
      setDraft({ mode: result.mode, nodes: result.nodes });
      setTargets(
        Object.fromEntries(result.targets.map((target) => [target.id, target])),
      );
      setNotice(
        zh
          ? "导航已保存，公开侧栏已更新。"
          : "Navigation saved. The public sidebar is updated.",
      );
      return true;
    } catch (error) {
      setFailure(error);
      if (error instanceof ApiError && error.status === 412)
        setConflicted(true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function reconnect() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await request<{
        authenticated: true;
        session: AuthSession;
      }>("session");
      setActiveSession(result.session);
      onSessionChange(result.session);
      setFailure(null);
      setNotice(
        zh
          ? "已重新连接。你的修改尚未保存，请核对后手动保存。"
          : "Reconnected. Your edits are not saved yet. Review them, then save.",
      );
      if (!document) setAttempt((value) => value + 1);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  function changeLanguage(next: Language) {
    if (next === contentLanguage || busy || loading) return;
    if (dirty) setPending({ kind: "language", language: next });
    else setContentLanguage(next);
  }
  function seed() {
    if (!document?.automaticNodes) return;
    setDraft({
      mode: "custom",
      nodes: document.automaticNodes.map((node) => ({ ...node })),
    });
    setSelectedId(null);
    setCollapsed(new Set());
    setNotice(null);
    setPending(null);
  }
  function remove(id: string, promote: boolean) {
    updateNodes(removeNode(nodes, id, promote));
    setSelectedId(null);
    setPending(null);
  }
  function moveSelected(parentId: string | null, index: number) {
    if (!selected || !canMove(nodes, selected.id, parentId)) return;
    updateNodes(move(nodes, selected.id, parentId, index));
    setCollapsed((current) => {
      const next = new Set(current);
      if (parentId) next.delete(parentId);
      return next;
    });
    setNotice(
      zh
        ? "目录顺序已调整，保存后生效。"
        : "Tree order updated. Save to apply this change.",
    );
  }
  function tree(parentId: string | null): ReactNode {
    return (
      <ul className="navigation-tree-level">
        {siblings(nodes, parentId).map((node) => (
          <li key={node.id}>
            <div
              className={`navigation-node ${selectedId === node.id ? "selected" : ""}`}
            >
              {node.kind === "group" ? (
                <button
                  type="button"
                  className="navigation-expand"
                  aria-label={`${collapsed.has(node.id) ? (zh ? "展开" : "Expand") : zh ? "折叠" : "Collapse"} ${label(node)}`}
                  aria-expanded={!collapsed.has(node.id)}
                  disabled={busy}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(node.id) ? "›" : "⌄"}
                </button>
              ) : (
                <span className="navigation-expand-spacer" />
              )}
              <button
                type="button"
                className="navigation-node-select"
                aria-pressed={selectedId === node.id}
                disabled={busy}
                onClick={() => setSelectedId(node.id)}
              >
                <NavIcon kind={node.kind} />
                <span>{label(node)}</span>
                {status(node) && (
                  <small className="navigation-badge warning">
                    {status(node)}
                  </small>
                )}
              </button>
            </div>
            {node.kind === "group" && !collapsed.has(node.id) && tree(node.id)}
          </li>
        ))}
      </ul>
    );
  }
  function previewTree(
    all: NavigationNode[],
    parentId: string | null,
  ): ReactNode[] {
    return siblings(all, parentId).flatMap((node): ReactNode[] => {
      if (node.kind === "group") {
        const children = previewTree(all, node.id);
        return children.length
          ? [
              <li key={node.id}>
                <strong>{node.label}</strong>
                <ul>{children}</ul>
              </li>,
            ]
          : [];
      }
      if (node.kind === "link")
        return node.externalUrl && normalizeNavigationUrl(node.externalUrl)
          ? [
              <li key={node.id}>
                <a
                  href={node.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {node.label}
                  <span aria-hidden="true"> ↗</span>
                </a>
              </li>,
            ]
          : [];
      const target = node.translationId ? targets[node.translationId] : null;
      return target?.publishedTitle && !target.deleted
        ? [
            <li key={node.id}>
              <a
                href={publicPath(target.language, target.path)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {node.label || target.publishedTitle}
              </a>
            </li>,
          ]
        : [];
    });
  }
  const peers = selected ? siblings(nodes, selected.parentId) : [];
  const selectedIndex = selected
    ? peers.findIndex((node) => node.id === selected.id)
    : -1;
  const previousGroup =
    selectedIndex > 0 && peers[selectedIndex - 1]?.kind === "group"
      ? peers[selectedIndex - 1]
      : null;
  const selectedParent = selected?.parentId
    ? nodes.find((node) => node.id === selected.parentId)
    : null;
  const previewNodes = custom ? nodes : (document?.automaticNodes ?? []);
  const previewEntries = previewTree(previewNodes, null);

  return (
    <div className="navigation-workspace">
      <div className="admin-page-heading">
        <div>
          <span className="admin-eyebrow">ORGANIZE / NAVIGATION</span>
          <h1>{zh ? "让每一页，都有方向" : "Give every page a place"}</h1>
          <p>
            {zh
              ? "编排读者看到的目录，让知识更容易被发现。"
              : "Arrange the sidebar your readers use to explore the wiki."}
          </p>
        </div>
        <button
          type="button"
          className="admin-button"
          disabled={
            busy ||
            loading ||
            !document ||
            !dirty ||
            reconnectNeeded ||
            conflicted
          }
          onClick={() => void save()}
        >
          {busy
            ? zh
              ? "正在处理…"
              : "Working…"
            : zh
              ? "保存导航"
              : "Save navigation"}
        </button>
      </div>
      <div className="navigation-topbar admin-panel">
        <label className="navigation-content-language">
          <span>{zh ? "目录语言" : "Navigation language"}</span>
          <select
            value={contentLanguage}
            disabled={busy || loading}
            onChange={(event) => changeLanguage(event.target.value as Language)}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <div className="navigation-save-state">
          <span
            className={`admin-status-dot ${dirty ? "navigation-dirty-dot" : ""}`}
          />
          {dirty
            ? zh
              ? "有未保存的修改"
              : "Unsaved changes"
            : !document
              ? zh
                ? "尚未读取目录"
                : "Navigation not loaded"
              : zh
                ? "所有修改已保存"
                : "All changes saved"}
          <small>
            {zh ? "保存后立即对访客生效" : "Saving applies changes immediately"}
          </small>
        </div>
        <button
          className="navigation-text-button"
          type="button"
          disabled={busy || loading}
          onClick={() =>
            dirty
              ? setPending({ kind: "reload" })
              : setAttempt((value) => value + 1)
          }
        >
          {zh ? "重新读取" : "Reload"}
        </button>
      </div>
      {(failure != null || conflicted) && (
        <div className="admin-notice error content-session-notice" role="alert">
          <span>{message(failure ?? new ApiError(412), zh)}</span>
          {reconnectNeeded && (
            <div className="content-session-actions">
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
                {zh ? "重新连接" : "Reconnect"}
              </button>
            </div>
          )}
          {conflicted && (
            <button
              className="admin-button secondary"
              type="button"
              onClick={() => setPending({ kind: "reload" })}
            >
              {zh ? "读取最新版本…" : "Load latest version…"}
            </button>
          )}
          {!document && !reconnectNeeded && (
            <button
              type="button"
              className="navigation-text-button"
              disabled={loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {zh ? "重试" : "Retry"}
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="admin-notice success" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <div className="admin-panel admin-loading" role="status">
          <span className="admin-spinner" />
          {zh ? "正在读取目录…" : "Loading navigation…"}
        </div>
      ) : (
        document && (
          <>
            <section
              className="navigation-mode admin-panel"
              aria-labelledby="navigation-mode-title"
            >
              <div>
                <h2 id="navigation-mode-title">
                  {zh ? "目录编排方式" : "Navigation mode"}
                </h2>
                <p>
                  {custom
                    ? zh
                      ? "自由组合分组、Wiki 页面和外部链接。"
                      : "Combine groups, wiki pages and external links."
                    : zh
                      ? "按已发布文章的路径自动生成目录，新发布的文章会自动出现。"
                      : "Build the sidebar from published page paths. Newly published pages appear automatically."}
                </p>
              </div>
              <fieldset
                className="navigation-mode-switch"
                disabled={busy}
                aria-label={zh ? "目录编排方式" : "Navigation mode"}
              >
                {(["automatic", "custom"] as const).map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    aria-pressed={draft.mode === mode}
                    onClick={() => {
                      setDraft((current) => ({ ...current, mode }));
                      setNotice(null);
                    }}
                  >
                    {mode === "automatic"
                      ? zh
                        ? "自动目录"
                        : "Automatic"
                      : zh
                        ? "自定义目录"
                        : "Custom"}
                  </button>
                ))}
              </fieldset>
            </section>
            {!custom && (
              <section className="navigation-automatic admin-panel">
                <div className="navigation-automatic-illustration">
                  <NavIcon kind="group" />
                  <span />
                  <NavIcon kind="page" />
                  <NavIcon kind="page" />
                </div>
                <h2>
                  {zh
                    ? "跟随文章，自然生长"
                    : "A sidebar that grows with your pages"}
                </h2>
                <p>
                  {zh
                    ? "自动目录适合按路径组织的文档。需要专属分组或外部链接时，可以从当前目录开始编排。已有自定义目录会保留。"
                    : "Automatic navigation follows your document paths. Start with the current tree when you need your own groups or links. Your existing custom tree is retained."}
                </p>
                <button
                  className="admin-button secondary"
                  type="button"
                  disabled={busy || !document.automaticNodes}
                  onClick={() =>
                    nodes.length ? setPending({ kind: "seed" }) : seed()
                  }
                >
                  {zh ? "从当前目录开始" : "Start from the current tree"}
                </button>
                {!document.automaticNodes && (
                  <p className="navigation-limit-note">
                    {zh
                      ? "自动目录超过 300 个条目或 8 层，无法整体复制。可切换自定义模式，从空目录开始。"
                      : "This automatic tree exceeds 300 entries or 8 levels and cannot be copied. Switch to Custom to build a smaller tree."}
                  </p>
                )}
              </section>
            )}
            {custom && (
              <div className="navigation-editor-grid">
                <section
                  className="navigation-tree-panel admin-panel"
                  aria-labelledby="navigation-tree-title"
                >
                  <header>
                    <div>
                      <h2 id="navigation-tree-title">
                        {zh ? "目录结构" : "Navigation tree"}
                      </h2>
                      <small>
                        {nodes.length} / 300 ·{" "}
                        {zh ? "最多 8 层" : "Up to 8 levels"}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="navigation-text-button"
                      disabled={busy || !document.automaticNodes}
                      onClick={() =>
                        nodes.length ? setPending({ kind: "seed" }) : seed()
                      }
                    >
                      {zh ? "从当前目录开始" : "Use current tree"}
                    </button>
                  </header>
                  <fieldset
                    className="navigation-add-actions"
                    disabled={busy || nodes.length >= MAX_NODES}
                  >
                    <button type="button" onClick={() => add("group")}>
                      <NavIcon kind="group" />
                      {zh ? "分组" : "Group"}
                      <span>+</span>
                    </button>
                    <button type="button" onClick={() => setPicker("new")}>
                      <NavIcon kind="page" />
                      {zh ? "页面" : "Page"}
                      <span>+</span>
                    </button>
                    <button type="button" onClick={() => add("link")}>
                      <NavIcon kind="link" />
                      {zh ? "链接" : "Link"}
                      <span>+</span>
                    </button>
                  </fieldset>
                  <p className="navigation-tree-hint">
                    {zh
                      ? "选择条目编辑属性，使用右侧按钮调整顺序与层级。"
                      : "Select an entry to edit it. Use the controls to reorder or move it."}
                  </p>
                  <div className="navigation-tree-scroll">
                    {nodes.length ? (
                      tree(null)
                    ) : (
                      <div className="navigation-empty">
                        <NavIcon kind="group" />
                        <h3>{zh ? "从一个分组开始" : "Start with a group"}</h3>
                        <p>
                          {zh
                            ? "添加分组、页面或链接，组成你的第一份目录。空的自定义目录不会向访客显示条目。"
                            : "Add a group, page or link to build your navigation. An empty custom tree shows no entries to visitors."}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
                <section
                  className="navigation-properties admin-panel"
                  aria-labelledby="navigation-properties-title"
                >
                  <header>
                    <h2 id="navigation-properties-title">
                      {zh ? "条目属性" : "Entry details"}
                    </h2>
                    <small>
                      {selected
                        ? selected.kind === "group"
                          ? zh
                            ? "分组"
                            : "Group"
                          : selected.kind === "page"
                            ? zh
                              ? "Wiki 页面"
                              : "Wiki page"
                            : zh
                              ? "外部链接"
                              : "External link"
                        : zh
                          ? "选择一个条目"
                          : "Select an entry"}
                    </small>
                  </header>
                  {selected ? (
                    <fieldset
                      disabled={busy}
                      className="navigation-properties-form"
                    >
                      <label className="admin-field">
                        <span>
                          {zh ? "显示名称" : "Display label"}
                          {selected.kind === "page" && (
                            <small> {zh ? "（可选）" : "(optional)"}</small>
                          )}
                        </span>
                        <input
                          value={selected.label ?? ""}
                          maxLength={200}
                          onChange={(event) =>
                            updateSelected({
                              label: event.target.value || null,
                            })
                          }
                          placeholder={
                            selected.kind === "page"
                              ? zh
                                ? "跟随已发布的文章标题"
                                : "Use the published page title"
                              : zh
                                ? "填写名称"
                                : "Enter a label"
                          }
                        />
                        <small>
                          {selected.kind === "page"
                            ? zh
                              ? "留空时使用文章的已发布标题，文章移动后链接会自动跟随。"
                              : "Leave blank to use the published title. Links follow the page when it moves."
                            : zh
                              ? "这个名称会出现在公开目录中。"
                              : "This label appears in the public sidebar."}
                        </small>
                      </label>
                      {selected.kind === "page" && (
                        <div className="navigation-reference">
                          <span>{zh ? "关联文章" : "Linked page"}</span>
                          <strong>
                            {(selected.translationId &&
                              targets[selected.translationId]?.draftTitle) ||
                              (zh
                                ? "文章引用不可用"
                                : "Page reference unavailable")}
                          </strong>
                          {selectedTarget && (
                            <code>
                              {publicPath(contentLanguage, selectedTarget.path)}
                            </code>
                          )}
                          {status(selected) && (
                            <span className="navigation-badge warning">
                              {status(selected)} ·{" "}
                              {zh ? "公开目录中隐藏" : "Hidden from visitors"}
                            </span>
                          )}
                          <button
                            className="admin-button secondary"
                            type="button"
                            onClick={() => setPicker(selected.id)}
                          >
                            {zh ? "更换文章" : "Choose another page"}
                          </button>
                        </div>
                      )}
                      {selected.kind === "link" && (
                        <label className="admin-field">
                          <span>{zh ? "链接地址" : "Link URL"}</span>
                          <input
                            type="url"
                            inputMode="url"
                            value={selected.externalUrl ?? ""}
                            maxLength={2048}
                            placeholder="https://example.com"
                            onChange={(event) =>
                              updateSelected({
                                externalUrl: event.target.value,
                              })
                            }
                          />
                          <small>
                            {zh
                              ? "仅支持 http:// 和 https:// 地址，不接受含用户名或密码的地址。"
                              : "Use an http:// or https:// URL without a username or password."}
                          </small>
                        </label>
                      )}
                      <label className="admin-field">
                        <span>{zh ? "所属分组" : "Parent group"}</span>
                        <select
                          value={selected.parentId ?? ""}
                          onChange={(event) =>
                            moveSelected(
                              event.target.value || null,
                              siblings(
                                nodes,
                                event.target.value || null,
                              ).filter((node) => node.id !== selected.id)
                                .length,
                            )
                          }
                        >
                          <option value="">
                            {zh ? "目录顶层" : "Top level"}
                          </option>
                          {nodes
                            .filter(
                              (node) =>
                                node.kind === "group" &&
                                canMove(nodes, selected.id, node.id),
                            )
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {"— ".repeat(nodeDepth(nodes, node) - 1)}
                                {label(node)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div className="navigation-order-controls">
                        <span>{zh ? "顺序与层级" : "Order and nesting"}</span>
                        <div>
                          <button
                            type="button"
                            disabled={selectedIndex <= 0}
                            onClick={() =>
                              moveSelected(selected.parentId, selectedIndex - 1)
                            }
                          >
                            ↑ {zh ? "上移" : "Move up"}
                          </button>
                          <button
                            type="button"
                            disabled={selectedIndex >= peers.length - 1}
                            onClick={() =>
                              moveSelected(selected.parentId, selectedIndex + 1)
                            }
                          >
                            ↓ {zh ? "下移" : "Move down"}
                          </button>
                          <button
                            type="button"
                            disabled={!selectedParent}
                            onClick={() =>
                              selectedParent &&
                              moveSelected(
                                selectedParent.parentId,
                                siblings(
                                  nodes,
                                  selectedParent.parentId,
                                ).findIndex(
                                  (node) => node.id === selectedParent.id,
                                ) + 1,
                              )
                            }
                          >
                            ← {zh ? "提升一级" : "Outdent"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !previousGroup ||
                              !canMove(nodes, selected.id, previousGroup.id)
                            }
                            onClick={() =>
                              previousGroup &&
                              moveSelected(
                                previousGroup.id,
                                siblings(nodes, previousGroup.id).length,
                              )
                            }
                          >
                            → {zh ? "移入前一组" : "Indent"}
                          </button>
                        </div>
                        <small>
                          {zh
                            ? "分组可以包含条目；页面和链接不可包含子项。"
                            : "Only groups can contain other entries."}
                        </small>
                      </div>
                      {invalid?.id === selected.id && (
                        <div className="admin-notice error">
                          {zh
                            ? "请完善名称或链接，并确保文章未重复、层级不超过 8 层。"
                            : "Check the label or URL, avoid duplicate pages and keep nesting within 8 levels."}
                        </div>
                      )}
                      <button
                        className="navigation-delete-button"
                        type="button"
                        onClick={() =>
                          setPending({ kind: "delete", id: selected.id })
                        }
                      >
                        {zh ? "从目录中移除…" : "Remove from navigation…"}
                      </button>
                      <small className="navigation-delete-note">
                        {zh
                          ? "移除目录条目不会删除文章。"
                          : "Removing an entry never deletes the article."}
                      </small>
                    </fieldset>
                  ) : (
                    <div className="navigation-empty">
                      <NavIcon kind="page" />
                      <p>
                        {zh
                          ? "在左侧选择一个条目，在这里调整它的名称、位置和关联内容。"
                          : "Select an entry to edit its label, location and linked content."}
                      </p>
                    </div>
                  )}
                </section>
              </div>
            )}
            <section className="navigation-preview admin-panel">
              <header>
                <div>
                  <h2>
                    {custom
                      ? zh
                        ? "公开目录预览"
                        : "Public navigation preview"
                      : zh
                        ? "自定义起点预览"
                        : "Custom starting tree preview"}
                  </h2>
                  <p>
                    {custom
                      ? zh
                        ? "预览当前修改；未发布、已删除的文章和空分组会隐藏。保存后生效。"
                        : "Preview your edits. Unpublished or deleted pages and empty groups are hidden. Save to apply."
                      : zh
                        ? "这是自动目录转换为自定义目录后的结构。实际自动目录请在公开站点查看。"
                        : "This shows the automatic tree after conversion to a custom starting tree. View the actual automatic navigation on the public site."}
                  </p>
                </div>
                <button
                  type="button"
                  className="admin-button secondary"
                  aria-expanded={preview}
                  onClick={() => setPreview((value) => !value)}
                >
                  {preview
                    ? zh
                      ? "收起预览"
                      : "Hide preview"
                    : zh
                      ? "预览目录"
                      : "Preview tree"}
                </button>
              </header>
              {preview && (
                <div className="navigation-preview-body">
                  <div className="navigation-preview-sidebar">
                    <div className="navigation-preview-brand">
                      Emby <strong>Wiki</strong>
                      <small>
                        {contentLanguage === "zh"
                          ? "中文目录"
                          : "ENGLISH NAVIGATION"}
                      </small>
                    </div>
                    {!custom && !document.automaticNodes ? (
                      <p>
                        {zh
                          ? "此自动目录较大，请在公开站点查看。"
                          : "This automatic tree is large. View it on the public site."}
                      </p>
                    ) : previewEntries.length ? (
                      <ul>{previewEntries}</ul>
                    ) : (
                      <p>
                        {zh
                          ? "当前没有对访客可见的目录条目。"
                          : "There are no visible navigation entries."}
                      </p>
                    )}
                  </div>
                  <div className="navigation-preview-note">
                    <span className="admin-eyebrow">READER EXPERIENCE</span>
                    <h3>
                      {zh
                        ? "读者看到的，清晰有序。"
                        : "A clear path for your readers."}
                    </h3>
                    <p>
                      {custom
                        ? zh
                          ? "文章使用当前已发布标题与路径。链接会在新标签页打开，方便检查；未保存的目录仅在此预览。"
                          : "Pages use their currently published title and path. Preview links open in a new tab for checking. Unsaved navigation exists only in this preview."
                        : zh
                          ? "转换为自定义目录时，带子页面的文章会拆为分组与页面条目。你可以从这个结构开始编辑；当前公开站点仍使用已保存的目录模式。"
                          : "When converted, pages with children become a group and a page entry. Use this structure as a starting point. The public site continues to use the saved navigation mode."}
                    </p>
                    <a
                      className="admin-text-link"
                      href={publicPath(contentLanguage, "home")}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {zh
                        ? "查看当前公开站点 ↗"
                        : "View the current public site ↗"}
                    </a>
                  </div>
                </div>
              )}
            </section>
          </>
        )
      )}
      {picker && (
        <PagePicker
          key={`${contentLanguage}:${picker}`}
          language={contentLanguage}
          zh={zh}
          existing={
            new Set(
              nodes
                .filter((node) => node.kind === "page" && node.id !== picker)
                .map((node) => node.translationId ?? ""),
            )
          }
          onChoose={(page) => void choosePage(page)}
          onClose={() => setPicker(null)}
        />
      )}
      {pending && (
        <Modal
          title={
            pending.kind === "language"
              ? zh
                ? "切换前保存修改？"
                : "Save before switching?"
              : pending.kind === "reload"
                ? zh
                  ? "读取最新目录？"
                  : "Load the latest navigation?"
                : pending.kind === "seed"
                  ? zh
                    ? "使用当前自动目录？"
                    : "Use the current automatic tree?"
                  : zh
                    ? "移除目录条目？"
                    : "Remove this navigation entry?"
          }
          busy={busy}
          onClose={() => setPending(null)}
        >
          <p>
            {pending.kind === "language"
              ? zh
                ? "两个语言的目录独立管理。保存当前修改、丢弃修改，或取消并继续编辑。"
                : "Each language has its own navigation. Save your current changes, discard them, or cancel to keep editing."
              : pending.kind === "reload"
                ? zh
                  ? "这会丢弃此页尚未保存的修改，并读取服务器上的最新版本。"
                  : "This discards unsaved edits on this page and loads the latest version from the server."
                : pending.kind === "seed"
                  ? zh
                    ? "这会替换当前自定义目录。复制后仍需保存，才会影响公开目录。"
                    : "This replaces your custom tree. Save afterwards to apply it to the public sidebar."
                  : zh
                    ? "只移除导航条目，不会删除任何文章。分组可连同子项移除，或只移除分组并将子项提升一级。"
                    : "Only navigation entries are removed; articles are not deleted. Remove a group with its entries, or keep its entries one level higher."}
          </p>
          {(failure != null || conflicted) && pending.kind === "language" && (
            <div className="admin-notice error" role="alert">
              {message(failure ?? new ApiError(412), zh)}
            </div>
          )}
          <fieldset disabled={busy} className="navigation-dialog-actions">
            <button
              type="button"
              className="admin-button secondary"
              onClick={() => setPending(null)}
            >
              {zh ? "取消" : "Cancel"}
            </button>
            {pending.kind === "language" ? (
              <>
                <button
                  type="button"
                  className="admin-button secondary"
                  onClick={() => {
                    setContentLanguage(pending.language);
                    setPending(null);
                  }}
                >
                  {zh ? "丢弃并切换" : "Discard and switch"}
                </button>
                <button
                  type="button"
                  className="admin-button"
                  disabled={reconnectNeeded || conflicted}
                  onClick={() => {
                    const next = pending.language;
                    void save().then((saved) => {
                      if (saved) {
                        setPending(null);
                        setContentLanguage(next);
                      }
                    });
                  }}
                >
                  {zh ? "保存并切换" : "Save and switch"}
                </button>
              </>
            ) : pending.kind === "reload" ? (
              <button
                type="button"
                className="admin-button navigation-danger"
                onClick={() => {
                  setPending(null);
                  setAttempt((value) => value + 1);
                }}
              >
                {zh ? "丢弃修改并读取" : "Discard edits and reload"}
              </button>
            ) : pending.kind === "seed" ? (
              <button type="button" className="admin-button" onClick={seed}>
                {zh ? "替换自定义目录" : "Replace custom tree"}
              </button>
            ) : (
              <>
                {nodes.find((node) => node.id === pending.id)?.kind ===
                  "group" &&
                  siblings(nodes, pending.id).length > 0 && (
                    <button
                      type="button"
                      className="admin-button secondary"
                      onClick={() => remove(pending.id, true)}
                    >
                      {zh
                        ? "只移除分组，保留子项"
                        : "Remove group, keep entries"}
                    </button>
                  )}
                <button
                  type="button"
                  className="admin-button navigation-danger"
                  onClick={() => remove(pending.id, false)}
                >
                  {nodes.find((node) => node.id === pending.id)?.kind ===
                    "group" && siblings(nodes, pending.id).length
                    ? zh
                      ? "移除整组及子项"
                      : "Remove group and entries"
                    : zh
                      ? "移除条目"
                      : "Remove entry"}
                </button>
              </>
            )}
          </fieldset>
        </Modal>
      )}
    </div>
  );
}
