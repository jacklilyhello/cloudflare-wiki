import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_LIMITS,
  type AuditAction,
  type AuditCategory,
  type AuditListOptions,
  type AuditRecord,
  type AuditPage as AuditResponse,
} from "../../shared/audit";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import type { FileField } from "../../shared/files";
import type { SettingsField } from "../../shared/settings";
import { ApiError, request } from "./api";
import "./audit.css";

function pathLabel(language: Language, path: string) {
  return `/${language}/${path}`;
}

type Filters = {
  category: "" | AuditCategory;
  action: "" | AuditAction;
  language: "" | Language | "site";
  subjectId: string;
  from: string;
  to: string;
};
const EMPTY_FILTERS: Filters = {
  category: "",
  action: "",
  language: "",
  subjectId: "",
  from: "",
  to: "",
};
const ACTION_LABELS: Record<AuditAction, [string, string]> = {
  "page.create": ["创建页面", "Page created"],
  "page.save_draft": ["保存草稿", "Draft saved"],
  "page.publish": ["发布页面", "Page published"],
  "page.unpublish": ["取消发布", "Page unpublished"],
  "page.move": ["移动页面", "Page moved"],
  "page.delete": ["删除页面", "Page deleted"],
  "page.restore_revision": ["恢复历史版本", "Revision restored"],
  "page.restore_deleted": ["恢复已删除页面", "Page restored"],
  "navigation.save": ["保存导航", "Navigation saved"],
  "redirect.create": ["创建重定向", "Redirect created"],
  "redirect.update": ["更新重定向", "Redirect updated"],
  "redirect.delete": ["删除重定向", "Redirect deleted"],
  "settings.update": ["更新站点设置", "Site settings updated"],
  "file.create_folder": ["创建文件夹", "Folder created"],
  "file.prepare": ["准备文件上传", "Upload prepared"],
  "file.finalize": ["完成文件上传", "Upload completed"],
  "file.thumbnail": ["更新缩略图", "Thumbnail updated"],
  "file.rename": ["重命名文件或文件夹", "File or folder renamed"],
  "file.move": ["移动文件或文件夹", "File or folder moved"],
  "file.alt": ["更新替代文本", "Alternative text updated"],
  "file.publish": ["公开文件", "File published"],
  "file.unpublish": ["取消文件公开", "File unpublished"],
  "file.delete": ["删除文件或文件夹", "File or folder deleted"],
  "file.restore": ["恢复文件或文件夹", "File or folder restored"],
  "file.abandon": ["放弃文件上传", "Upload abandoned"],
  "administrator.initialize": ["初始化管理员", "Administrator initialized"],
  "administrator.credentials": ["更新管理员凭据", "Credentials updated"],
};
const SETTINGS_LABELS: Record<SettingsField, [string, string]> = {
  "zh.name": ["中文站点名称", "Chinese site name"],
  "zh.description": ["中文站点描述", "Chinese site description"],
  "en.name": ["英文站点名称", "English site name"],
  "en.description": ["英文站点描述", "English site description"],
  defaultLanguage: ["默认语言", "Default language"],
  theme: ["默认主题", "Default theme"],
  accent: ["强调色", "Accent color"],
  logo: ["站点标志", "Site logo"],
};
const FILE_LABELS: Record<FileField, [string, string]> = {
  name: ["名称", "Name"],
  parentId: ["所属文件夹", "Parent folder"],
  "alt.zh": ["中文替代文本", "Chinese alternative text"],
  "alt.en": ["英文替代文本", "English alternative text"],
  state: ["上传状态", "Upload state"],
  thumbnailState: ["缩略图状态", "Thumbnail state"],
  visibility: ["公开状态", "Visibility"],
  deletedAt: ["回收站状态", "Trash state"],
};
function categoryLabel(category: AuditCategory, zh: boolean) {
  return (
    {
      page: ["页面", "Pages"],
      navigation: ["导航", "Navigation"],
      redirect: ["重定向", "Redirects"],
      settings: ["站点设置", "Site settings"],
      file: ["文件", "Files"],
      administrator: ["管理员", "Administrator"],
    } as const
  )[category][zh ? 0 : 1];
}
function languageLabel(value: Language | "site" | null, zh: boolean) {
  return value === "zh"
    ? zh
      ? "中文"
      : "Chinese"
    : value === "en"
      ? zh
        ? "英文"
        : "English"
      : zh
        ? "站点级"
        : "Site-wide";
}
function dateLabel(value: string, language: Language, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: full ? "long" : "short",
      }).format(date);
}
function toIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso) ? iso : null;
}
function queryFor(filters: AuditListOptions) {
  const query = new URLSearchParams();
  for (const key of [
    "category",
    "action",
    "language",
    "subjectId",
    "from",
    "to",
  ] as const)
    if (filters[key]) query.set(key, filters[key]);
  query.set("limit", String(AUDIT_LIMITS.defaultPage));
  return query.toString();
}
function errorLabel(error: unknown, zh: boolean) {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  )
    return zh
      ? "登录状态已变化。筛选条件已保留，请在新标签页登录后重新连接。"
      : "Your session has changed. Your filters are preserved. Sign in in a new tab, then reconnect.";
  if (error instanceof ApiError && error.status === 400)
    return zh
      ? "无法读取这组筛选结果。请检查筛选条件，或刷新列表以重新开始分页。"
      : "These results could not be loaded. Check your filters, or refresh the list to restart pagination.";
  return zh
    ? "暂时无法读取审计日志。筛选条件和已读取的记录仍在，请重试。"
    : "Audit logs could not be loaded. Your filters and loaded records are still here. Please retry.";
}
function AuditIcon({ category }: { category?: AuditCategory }) {
  return (
    <svg
      className="audit-icon"
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
          category === "page"
            ? "M14 3H5v18h14V8l-5-5v5h5M9 12h6M9 16h6"
            : category === "navigation"
              ? "M10 3h4v4h-4zM3 17h4v4H3zM10 17h4v4h-4zM17 17h4v4h-4zM12 7v10M5 17v-5h14v5"
              : category === "redirect"
                ? "M4 18v-5a6 6 0 0 1 6-6h10m-5-5 5 5-5 5"
                : category === "administrator"
                  ? "M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0"
                  : category === "file"
                    ? "M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h8v2"
                    : "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0"
        }
      />
    </svg>
  );
}
function RecordDetails({
  record,
  language,
}: {
  record: AuditRecord;
  language: Language;
}) {
  const zh = language === "zh";
  const modeLabel = (mode: "automatic" | "custom") =>
    mode === "automatic"
      ? zh
        ? "自动目录"
        : "Automatic"
      : zh
        ? "自定义目录"
        : "Custom";
  return (
    <div className="audit-record-details">
      <dl className="audit-details-grid">
        <div>
          <dt>{zh ? "对象 ID" : "Object ID"}</dt>
          <dd>
            <code>{record.subjectId}</code>
          </dd>
        </div>
        <div>
          <dt>{zh ? "对象版本" : "Object version"}</dt>
          <dd>{record.subjectVersion}</dd>
        </div>
        <div>
          <dt>{zh ? "记录时间" : "Recorded at"}</dt>
          <dd>
            <time dateTime={record.createdAt}>
              {dateLabel(record.createdAt, language, true)}
            </time>
          </dd>
        </div>
        <div>
          <dt>{zh ? "记录来源" : "Record origin"}</dt>
          <dd>
            {record.origin === "legacy"
              ? zh
                ? "历史导入"
                : "Imported history"
              : zh
                ? "变更时记录"
                : "Recorded with the change"}
          </dd>
        </div>
        {record.category === "page" && (
          <>
            {record.details.fromPath && (
              <div>
                <dt>{zh ? "原路径" : "Previous path"}</dt>
                <dd>
                  <code>
                    {pathLabel(record.language, record.details.fromPath)}
                  </code>
                </dd>
              </div>
            )}
            {record.details.toPath && (
              <div>
                <dt>{zh ? "记录中的路径" : "Recorded path"}</dt>
                <dd>
                  <code>
                    {pathLabel(record.language, record.details.toPath)}
                  </code>
                </dd>
              </div>
            )}
            {record.details.revisionId && (
              <div>
                <dt>{zh ? "关联修订 ID" : "Revision ID"}</dt>
                <dd>
                  <code>{record.details.revisionId}</code>
                </dd>
              </div>
            )}
          </>
        )}
        {record.category === "redirect" && (
          <>
            {record.details.previousPath !== null && (
              <div>
                <dt>{zh ? "原重定向路径" : "Previous redirect path"}</dt>
                <dd>
                  <code>
                    {pathLabel(record.language, record.details.previousPath)}
                  </code>
                </dd>
              </div>
            )}
            {record.details.sourcePath !== null && (
              <div>
                <dt>{zh ? "重定向路径" : "Redirect path"}</dt>
                <dd>
                  <code>
                    {pathLabel(record.language, record.details.sourcePath)}
                  </code>
                </dd>
              </div>
            )}
            {record.details.previousTarget !== null && (
              <div>
                <dt>{zh ? "原目标页面 ID" : "Previous target page ID"}</dt>
                <dd>
                  <code>{record.details.previousTarget}</code>
                </dd>
              </div>
            )}
            {record.details.targetTranslationId !== null && (
              <div>
                <dt>{zh ? "目标页面 ID" : "Target page ID"}</dt>
                <dd>
                  <code>{record.details.targetTranslationId}</code>
                </dd>
              </div>
            )}
          </>
        )}
        {record.category === "navigation" && (
          <>
            <div>
              <dt>{zh ? "目录模式" : "Navigation mode"}</dt>
              <dd>
                {modeLabel(record.details.previousMode)}{" "}
                <span aria-hidden="true">→</span>{" "}
                {modeLabel(record.details.mode)}
              </dd>
            </div>
            <div>
              <dt>{zh ? "已保存的条目数" : "Saved entries"}</dt>
              <dd>{record.details.nodeCount}</dd>
            </div>
          </>
        )}
        {record.category === "settings" && (
          <div>
            <dt>{zh ? "更改的设置" : "Changed settings"}</dt>
            <dd>
              {record.details.changedFields
                .map((field) => SETTINGS_LABELS[field][zh ? 0 : 1])
                .join(zh ? "、" : ", ")}
            </dd>
          </div>
        )}
        {record.category === "file" && (
          <div>
            <dt>{zh ? "更改的文件信息" : "Changed file information"}</dt>
            <dd>
              {record.details.changedFields
                .map((field) => FILE_LABELS[field][zh ? 0 : 1])
                .join(zh ? "、" : ", ")}
            </dd>
          </div>
        )}
        {record.category === "administrator" && record.details && (
          <>
            <div>
              <dt>{zh ? "用户名" : "Username"}</dt>
              <dd>
                {record.details.usernameChanged
                  ? zh
                    ? "已更改"
                    : "Changed"
                  : zh
                    ? "未更改"
                    : "Unchanged"}
              </dd>
            </div>
            <div>
              <dt>{zh ? "密码" : "Password"}</dt>
              <dd>
                {record.details.passwordChanged
                  ? zh
                    ? "已更改"
                    : "Changed"
                  : zh
                    ? "未更改"
                    : "Unchanged"}
              </dd>
            </div>
          </>
        )}
      </dl>
      <div className="audit-record-footer">
        <p>
          {record.origin === "legacy"
            ? zh
              ? "此记录从既有历史导入，不推断当时的操作账户。"
              : "This record was imported from existing history. The acting account is not inferred."
            : record.category === "administrator"
              ? zh
                ? "记录仅说明变更类型，不包含账户值或凭据。"
                : "This record describes the change without account values or credentials."
              : record.category === "file"
                ? zh
                  ? "记录仅保留更改的字段名称，不包含文件名、替代文本或文件内容。"
                  : "This record keeps changed field names without filenames, alternative text or file contents."
                : record.category === "navigation" &&
                    record.details.mode === "automatic"
                  ? zh
                    ? "自动模式的公开目录随已发布页面生成；条目数指保留的自定义目录。"
                    : "Automatic navigation follows published pages. The entry count describes the retained custom tree."
                  : zh
                    ? "已提交的变更记录，只读保留。"
                    : "A read-only record of a committed change."}
        </p>
        {record.category === "page" && (
          <a
            className="admin-button secondary"
            href={`/admin/pages/${encodeURIComponent(record.subjectId)}/history`}
          >
            {zh ? "查看页面历史" : "View page history"}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {record.category === "navigation" && (
          <a className="admin-button secondary" href="/admin/navigation">
            {zh ? "管理导航" : "Manage navigation"}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {record.category === "redirect" && (
          <a className="admin-button secondary" href="/admin/redirects">
            {zh ? "管理重定向" : "Manage redirects"}
            <span aria-hidden="true">↗</span>
          </a>
        )}
        {record.category === "settings" && (
          <a className="admin-button secondary" href="/admin/settings">
            {zh ? "管理站点设置" : "Manage site settings"}
            <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
function AuditEntry({
  record,
  language,
}: {
  record: AuditRecord;
  language: Language;
}) {
  const zh = language === "zh";
  const title =
    record.category === "page"
      ? record.pageTitle ||
        record.details.toPath ||
        record.details.fromPath ||
        (zh ? "Wiki 页面" : "Wiki page")
      : record.category === "navigation"
        ? `${languageLabel(record.language, zh)}${zh ? "导航" : " navigation"}`
        : record.category === "redirect"
          ? `${languageLabel(record.language, zh)}${zh ? "重定向" : " redirects"}`
          : record.category === "settings"
            ? zh
              ? "站点设置与外观"
              : "Site settings and appearance"
            : record.category === "file"
              ? zh
                ? "文件与文件夹"
                : "Files and folders"
              : record.category === "administrator"
                ? zh
                  ? "管理员账户"
                  : "Administrator account"
                : zh
                  ? "其他记录"
                  : "Other activity";
  const path =
    record.category === "page"
      ? (record.details.toPath ?? record.details.fromPath)
      : record.category === "redirect"
        ? (record.details.sourcePath ?? record.details.previousPath)
        : null;
  return (
    <li className="audit-entry">
      <details>
        <summary>
          <span className={`audit-category-icon ${record.category}`}>
            <AuditIcon category={record.category} />
          </span>
          <div className="audit-entry-main">
            <div className="audit-entry-action">
              <strong>
                {ACTION_LABELS[record.action]?.[zh ? 0 : 1] ??
                  (zh ? "其他操作" : "Other activity")}
              </strong>
              <span className="audit-language-badge">
                {languageLabel(record.language, zh)}
              </span>
              {record.origin === "legacy" && (
                <span className="audit-legacy-badge">
                  {zh ? "历史导入" : "Imported"}
                </span>
              )}
            </div>
            <div className="audit-entry-target">
              <span>{title}</span>
              {path && (
                <code>{pathLabel(record.language as Language, path)}</code>
              )}
            </div>
          </div>
          <div className="audit-entry-time">
            <time dateTime={record.createdAt}>
              {dateLabel(record.createdAt, language)}
            </time>
            <small>#{record.seq}</small>
          </div>
          <span className="audit-entry-toggle" aria-hidden="true">
            ⌄
          </span>
        </summary>
        <RecordDetails record={record} language={language} />
      </details>
    </li>
  );
}

export function AuditPage({
  language,
  onSessionChange,
}: {
  language: Language;
  onSessionChange: (session: AuthSession) => void;
}) {
  const zh = language === "zh";
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [applied, setApplied] = useState<AuditListOptions>({});
  const [validation, setValidation] = useState<"dates" | "subject" | null>(
    null,
  );
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [failedMore, setFailedMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const lastQuery = useRef<string | null>(null);
  const reconnectController = useRef<AbortController | null>(null);
  const requestPending = useRef(false);
  const query = queryFor(applied);
  const needsReconnect =
    failure instanceof ApiError &&
    (failure.status === 401 || failure.status === 403);
  const actionOptions = AUDIT_ACTIONS.filter(
    (action) => !filters.category || action.startsWith(`${filters.category}.`),
  );
  const activeCount = Object.keys(applied).length;
  const advancedCount = [applied.subjectId, applied.from, applied.to].filter(
    Boolean,
  ).length;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt starts a user-requested fresh read of the same filters.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    requestPending.current = true;
    setLoading(true);
    setLoadingMore(false);
    if (lastQuery.current !== query) {
      setRecords([]);
      setCursor(null);
    }
    lastQuery.current = query;
    setFailure(null);
    setFailedMore(false);
    setReconnected(false);
    request<AuditResponse>(`audit?${query}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setRecords(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          requestPending.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [query, attempt]);
  useEffect(() => () => reconnectController.current?.abort(), []);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation(null);
    const from = filters.from ? toIso(filters.from) : undefined;
    const to = filters.to ? toIso(filters.to) : undefined;
    if (from === null || to === null || (from && to && from >= to)) {
      setValidation("dates");
      return;
    }
    const subjectId = filters.subjectId.trim();
    if (subjectId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(subjectId)) {
      setValidation("subject");
      return;
    }
    setApplied({
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.language ? { language: filters.language } : {}),
      ...(subjectId ? { subjectId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    setAttempt((value) => value + 1);
  }
  function reset() {
    setFilters({ ...EMPTY_FILTERS });
    setApplied({});
    setValidation(null);
    setAttempt((value) => value + 1);
  }
  async function more() {
    const controller = controllerRef.current;
    if (
      !cursor ||
      !controller ||
      controller.signal.aborted ||
      requestPending.current ||
      reconnecting
    )
      return;
    requestPending.current = true;
    setLoadingMore(true);
    setFailure(null);
    setFailedMore(false);
    setReconnected(false);
    try {
      const params = new URLSearchParams(query);
      params.set("cursor", cursor);
      const result = await request<AuditResponse>(`audit?${params}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setRecords((current) => {
          const seen = new Set(current.map((record) => record.seq));
          return [
            ...current,
            ...result.items.filter((record) => !seen.has(record.seq)),
          ];
        });
        setCursor(result.nextCursor);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(error);
        setFailedMore(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        requestPending.current = false;
        setLoadingMore(false);
      }
    }
  }
  async function reconnect() {
    if (reconnecting) return;
    const controller = new AbortController();
    reconnectController.current = controller;
    setReconnecting(true);
    setReconnected(false);
    try {
      const result = await request<{ session: AuthSession }>("session", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        onSessionChange(result.session);
        setFailure(null);
        setReconnected(true);
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error);
    } finally {
      if (!controller.signal.aborted) setReconnecting(false);
    }
  }
  function retry() {
    if (failedMore && cursor) void more();
    else setAttempt((value) => value + 1);
  }

  return (
    <div className="audit-workspace">
      <header className="audit-page-heading">
        <div>
          <span className="admin-eyebrow">WORKSPACE / ACTIVITY</span>
          <h1>
            {zh ? "每一次变更，都有迹可循" : "A clear record of every change"}
          </h1>
          <p>
            {zh
              ? "查看页面、文件、站点设置和管理员账户的变更，最新记录显示在前。"
              : "Review changes to pages, files, site settings and the administrator account, newest first."}
          </p>
        </div>
        <button
          className="admin-button secondary audit-refresh"
          type="button"
          disabled={loading || loadingMore || reconnecting || needsReconnect}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <AuditIcon />
          {zh ? "刷新记录" : "Refresh logs"}
        </button>
      </header>
      <form className="audit-filter-panel admin-panel" onSubmit={applyFilters}>
        <div className="audit-filter-main">
          <label>
            <span>{zh ? "类别" : "Category"}</span>
            <select
              value={filters.category}
              onChange={(event) => {
                const category = event.target.value as Filters["category"];
                setFilters((current) => ({
                  ...current,
                  category,
                  action:
                    current.action &&
                    category &&
                    !current.action.startsWith(`${category}.`)
                      ? ""
                      : current.action,
                }));
              }}
            >
              <option value="">{zh ? "全部类别" : "All categories"}</option>
              {AUDIT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(category, zh)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{zh ? "动作" : "Action"}</span>
            <select
              value={filters.action}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  action: event.target.value as Filters["action"],
                }))
              }
            >
              <option value="">{zh ? "全部动作" : "All actions"}</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action][zh ? 0 : 1]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{zh ? "语言范围" : "Language scope"}</span>
            <select
              value={filters.language}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  language: event.target.value as Filters["language"],
                }))
              }
            >
              <option value="">
                {zh ? "所有语言与站点" : "All languages and site"}
              </option>
              {(["zh", "en", "site"] as const).map((value) => (
                <option key={value} value={value}>
                  {languageLabel(value, zh)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="audit-more-filters">
          <summary>
            {zh ? "更多筛选" : "More filters"}
            {advancedCount > 0 && <span>{advancedCount}</span>}
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="audit-filter-advanced">
            <label>
              <span>{zh ? "开始时间（包含）" : "From (inclusive)"}</span>
              <input
                type="datetime-local"
                value={filters.from}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    from: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>{zh ? "结束时间（不包含）" : "Until (exclusive)"}</span>
              <input
                type="datetime-local"
                value={filters.to}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    to: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>{zh ? "对象 ID（可选）" : "Object ID (optional)"}</span>
              <input
                value={filters.subjectId}
                maxLength={AUDIT_LIMITS.subjectId}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    subjectId: event.target.value,
                  }))
                }
                placeholder={zh ? "精确匹配对象 ID" : "Exact object ID"}
              />
            </label>
            <p>
              {zh
                ? `日期与记录时间按你的时区 ${timeZone} 显示。对象 ID 可从记录详情中复制。`
                : `Dates and record times use your time zone, ${timeZone}. Copy an object ID from a record's details.`}
            </p>
          </div>
        </details>
        {validation && (
          <p className="audit-validation" role="alert">
            {validation === "dates"
              ? zh
                ? "请输入有效时间，结束时间必须晚于开始时间。"
                : "Enter valid dates. The end must be after the start."
              : zh
                ? "对象 ID 需以字母或数字开头，仅包含字母、数字、冒号、下划线或连字符。"
                : "Object IDs start with a letter or number and contain only letters, numbers, colons, underscores or hyphens."}
          </p>
        )}
        <div className="audit-filter-footer">
          <p>
            {activeCount
              ? zh
                ? `当前应用了 ${activeCount} 项筛选`
                : `${activeCount} filters applied`
              : zh
                ? "查看全部已记录的变更"
                : "Showing all recorded changes"}
          </p>
          <div>
            <button
              className="audit-reset"
              type="button"
              disabled={reconnecting}
              onClick={reset}
            >
              {zh ? "重置" : "Reset"}
            </button>
            <button
              className="admin-button"
              type="submit"
              disabled={reconnecting || needsReconnect}
            >
              {zh ? "应用筛选" : "Apply filters"}
            </button>
          </div>
        </div>
      </form>
      {failure != null && (
        <div className="admin-notice error content-session-notice" role="alert">
          <span>{errorLabel(failure, zh)}</span>
          {needsReconnect ? (
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
                disabled={reconnecting}
                onClick={() => void reconnect()}
              >
                {reconnecting
                  ? zh
                    ? "正在连接…"
                    : "Connecting…"
                  : zh
                    ? "重新连接"
                    : "Reconnect"}
              </button>
            </div>
          ) : (
            <button
              className="admin-button secondary audit-retry"
              type="button"
              disabled={loading || loadingMore}
              onClick={retry}
            >
              {zh ? "重试读取" : "Retry loading"}
            </button>
          )}
        </div>
      )}
      {reconnected && (
        <div className="admin-notice success audit-reconnected" role="status">
          <span>
            {zh
              ? "已重新连接，筛选条件未变。可继续读取记录。"
              : "Reconnected. Your filters are unchanged. You can continue loading records."}
          </span>
          <button
            className="admin-button secondary"
            type="button"
            disabled={loading || loadingMore}
            onClick={retry}
          >
            {zh ? "继续读取" : "Continue loading"}
          </button>
        </div>
      )}
      <section
        className="audit-records admin-panel"
        aria-labelledby="audit-records-title"
        aria-busy={loading || loadingMore}
      >
        <header>
          <div>
            <h2 id="audit-records-title">
              {zh ? "变更记录" : "Change history"}
            </h2>
            <span>
              {loading
                ? zh
                  ? "正在读取…"
                  : "Loading…"
                : zh
                  ? `已载入 ${records.length} 条`
                  : `${records.length} loaded`}
            </span>
          </div>
          <span className="audit-readonly">
            <span aria-hidden="true">◉</span>
            {zh ? "只读记录" : "Read-only"}
          </span>
        </header>
        {loading && records.length === 0 ? (
          <div className="audit-empty" role="status">
            <span className="admin-spinner" />
            <p>{zh ? "正在读取变更历史…" : "Loading change history…"}</p>
          </div>
        ) : records.length ? (
          <ol className="audit-list">
            {records.map((record) => (
              <AuditEntry
                key={record.seq}
                record={record}
                language={language}
              />
            ))}
          </ol>
        ) : failure == null && !reconnected ? (
          <div className="audit-empty">
            <AuditIcon />
            <h3>{zh ? "没有匹配的记录" : "No matching records"}</h3>
            <p>
              {activeCount
                ? zh
                  ? "调整筛选条件，查看其他变更。"
                  : "Adjust your filters to explore other changes."
                : zh
                  ? "已完成的内容和账户变更会在这里出现。"
                  : "Completed content and account changes will appear here."}
            </p>
          </div>
        ) : (
          <div className="audit-empty">
            <AuditIcon />
            <p>{zh ? "等待重新读取记录。" : "Ready to reload the records."}</p>
          </div>
        )}
        {records.length > 0 && (
          <footer className="audit-list-footer">
            <p>
              {cursor
                ? zh
                  ? "按记录顺序继续读取，不会重复已有记录。"
                  : "Continue through the history without repeating loaded records."
                : zh
                  ? "已显示所有匹配记录"
                  : "All matching records are shown"}
            </p>
            {cursor && (
              <button
                type="button"
                className="admin-button secondary"
                disabled={
                  loading || loadingMore || reconnecting || needsReconnect
                }
                onClick={() => void more()}
              >
                {loadingMore
                  ? zh
                    ? "正在读取…"
                    : "Loading…"
                  : zh
                    ? "加载更多"
                    : "Load more"}
              </button>
            )}
          </footer>
        )}
      </section>
      <p className="audit-privacy-note">
        {zh
          ? "历史导入记录单独标识。日志不展示正文、密码、令牌或其他凭据。"
          : "Imported history is marked separately. Logs do not show page bodies, passwords, tokens or other credentials."}
      </p>
    </div>
  );
}
