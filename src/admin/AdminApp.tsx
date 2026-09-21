import {
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  normalizeAdminReturnTo,
  parseAdminRoute,
} from "../../shared/admin-routes";
import {
  AUTH_LIMITS,
  type AuthSession,
  type BootstrapStatus,
} from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import { ApiError, mutation, request } from "./api";
import "./admin.css";

const PagesPage = lazy(() =>
  import("./PagesPage").then((module) => ({ default: module.PagesPage })),
);
const VersionsPage = lazy(() =>
  import("./VersionsPage").then((module) => ({ default: module.VersionsPage })),
);
const EditorPage = lazy(() =>
  import("./EditorPage").then((module) => ({ default: module.EditorPage })),
);
const NavigationPage = lazy(() =>
  import("./NavigationPage").then((module) => ({
    default: module.NavigationPage,
  })),
);

const AuditPage = lazy(() =>
  import("./AuditPage").then((module) => ({ default: module.AuditPage })),
);

type Overview = {
  pages: { total: number; drafts: number; published: number; deleted: number };
  revisions: number;
  recent: {
    id: string;
    language: Language;
    path: string;
    title: string;
    updatedAt: string;
    published: boolean;
  }[];
};
type IconName =
  | "book"
  | "grid"
  | "user"
  | "arrow"
  | "lock"
  | "logout"
  | "page"
  | "check"
  | "clock";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    book: "M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1m0-15c3-2 6-2 10-1v15c-4-1-7-1-10 1V5",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    user: "M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
    logout: "M9 4H4v16h5m4-12 4 4-4 4M9 12h12",
    page: "M14 2H5v20h14V7l-5-5v5h5M8 12h8M8 16h8",
    check: "m5 12 4 4L19 6",
    clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  };
  return (
    <svg
      className="admin-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function Brand({ zh }: { zh: boolean }) {
  return (
    <a className="admin-brand" href="/admin">
      <span className="admin-mark" aria-hidden="true">
        E
      </span>
      <span>
        Emby <strong>Wiki</strong>
        <small>{zh ? "管理工作空间" : "ADMIN WORKSPACE"}</small>
      </span>
    </a>
  );
}

function errorMessage(
  error: unknown,
  zh: boolean,
  context: "auth" | "setup" | "session" = "session",
) {
  if (error instanceof ApiError) {
    if (error.status === 429)
      return zh
        ? "尝试过于频繁，请稍后重试。"
        : "Too many attempts. Please try again later.";
    if (error.status === 401 && context === "auth")
      return zh
        ? "用户名或密码不正确，请重试。"
        : "The username or password is incorrect. Please try again.";
    if ((error.status === 401 || error.status === 403) && context === "setup")
      return zh
        ? "初始化凭证无效或已过期，请检查后重试。"
        : "The setup token is invalid or expired. Please check it and try again.";
    if (error.status === 403)
      return zh
        ? "当前请求未获授权，请刷新页面后重试。"
        : "This request was not authorized. Reload the page and try again.";
    if (error.status === 409 || error.status === 412)
      return zh
        ? "账户状态已变化，请刷新页面后重试。"
        : "The account has changed. Reload the page and try again.";
    if (error.status === 400 || error.status === 422)
      return zh
        ? "请检查填写内容。密码须为 12–128 个字符。"
        : "Please check your details. Passwords must contain 12–128 characters.";
  }
  return zh
    ? "暂时无法完成请求，请稍后重试。"
    : "We could not complete the request. Please try again.";
}

function validNewPassword(value: string): boolean {
  const characters = [...value].length;
  return (
    characters >= AUTH_LIMITS.passwordMin &&
    characters <= AUTH_LIMITS.passwordMax &&
    new TextEncoder().encode(value).byteLength <= AUTH_LIMITS.passwordBytes
  );
}

function PasswordInput({
  id,
  label,
  zh,
  current = false,
  setup = false,
}: {
  id: string;
  label: string;
  zh: boolean;
  current?: boolean;
  setup?: boolean;
}) {
  return (
    <label className="admin-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        name={id}
        type="password"
        autoComplete={
          setup ? "off" : current ? "current-password" : "new-password"
        }
        required
        minLength={AUTH_LIMITS.passwordMin}
        maxLength={AUTH_LIMITS.passwordMax * 2}
        aria-describedby={current ? undefined : `${id}-hint`}
      />
      {!current && (
        <small id={`${id}-hint`}>
          {zh
            ? "12–128 个字符，建议使用独特的长密码。"
            : "12–128 characters. Use a long, unique password."}
        </small>
      )}
    </label>
  );
}

function formatDate(value: string | number, zh: boolean) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(zh ? "zh-CN" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function Dashboard({
  session,
  zh,
  onExpired,
}: {
  session: AuthSession;
  zh: boolean;
  onExpired: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt deliberately restarts this read when the user retries.
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void request<Overview>("overview", { signal: controller.signal })
      .then(setOverview)
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setError(failure);
      });
    return () => controller.abort();
  }, [attempt, onExpired]);
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">
            {zh ? "你的知识空间" : "YOUR KNOWLEDGE SPACE"}
          </p>
          <h1>
            {zh ? "欢迎回来，" : "Welcome back, "}
            {session.user.username}
            <span className="admin-heading-dot">.</span>
          </h1>
          <p>
            {zh
              ? "让知识清晰可见，让每一份文档持续生长。"
              : "A clear view of your documentation and the knowledge it holds."}
          </p>
        </div>
        <a
          className="admin-button secondary"
          href={publicPath(zh ? "zh" : "en", "home")}
        >
          {zh ? "浏览 Wiki" : "Open wiki"}
          <Icon name="arrow" />
        </a>
      </div>
      {error ? (
        <div className="admin-notice error" role="alert">
          <span>{errorMessage(error, zh)}</span>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {zh ? "重试" : "Try again"}
          </button>
        </div>
      ) : !overview ? (
        <div className="admin-panel admin-loading" role="status">
          <span className="admin-spinner" />
          {zh ? "正在读取工作空间…" : "Loading your workspace…"}
        </div>
      ) : (
        <>
          <div className="admin-stats">
            {(
              [
                {
                  name: zh ? "全部页面" : "Total pages",
                  value: overview.pages.total,
                  icon: "book",
                  detail: zh ? "所有语言版本" : "Across both languages",
                },
                {
                  name: zh ? "已发布" : "Published",
                  value: overview.pages.published,
                  icon: "check",
                  detail: zh ? "访客可阅读" : "Available to readers",
                },
                {
                  name: zh ? "草稿" : "Drafts",
                  value: overview.pages.drafts,
                  icon: "page",
                  detail: zh ? "等待下一次发布" : "Ready for your next update",
                },
                {
                  name: zh ? "已删除" : "Deleted",
                  value: overview.pages.deleted,
                  icon: "clock",
                  detail: zh ? "保留在版本记录中" : "Retained in your history",
                },
              ] as const
            ).map((stat) => (
              <section className="admin-stat" key={stat.icon}>
                <div>
                  <p>{stat.name}</p>
                  <span className="admin-stat-icon">
                    <Icon name={stat.icon} />
                  </span>
                </div>
                <strong>
                  {stat.value.toLocaleString(zh ? "zh-CN" : "en-GB")}
                </strong>
                <small>{stat.detail}</small>
              </section>
            ))}
          </div>
          <section className="admin-panel">
            <header className="admin-panel-heading">
              <div>
                <h2>{zh ? "最近更新" : "Recently updated"}</h2>
                <p>
                  {zh
                    ? "文档的最新变化，尽在这里。"
                    : "The latest activity across your documentation."}
                </p>
              </div>
              <span className="admin-pill">
                {overview.revisions.toLocaleString()}{" "}
                {zh ? "个历史版本" : "revisions"}
              </span>
            </header>
            {overview.recent.length ? (
              <div className="admin-table-wrap">
                <table className="admin-pages-table">
                  <thead>
                    <tr>
                      <th scope="col">{zh ? "页面" : "Page"}</th>
                      <th scope="col">{zh ? "语言" : "Language"}</th>
                      <th scope="col">{zh ? "状态" : "Status"}</th>
                      <th scope="col">{zh ? "更新时间" : "Updated"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recent.map((page) => (
                      <tr key={`${page.id}-${page.language}`}>
                        <td>
                          <div className="admin-page-cell">
                            <span className="admin-document-icon">
                              <Icon name="page" />
                            </span>
                            <div>
                              {page.published ? (
                                <a href={publicPath(page.language, page.path)}>
                                  {page.title}
                                  <Icon name="arrow" />
                                </a>
                              ) : (
                                <strong>{page.title}</strong>
                              )}
                              <small>
                                /{page.language}/{page.path}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="admin-language-tag">
                            {page.language === "zh" ? "中文" : "EN"}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`admin-status ${page.published ? "published" : "draft"}`}
                          >
                            <span />
                            {page.published
                              ? zh
                                ? "已发布"
                                : "Published"
                              : zh
                                ? "草稿"
                                : "Draft"}
                          </span>
                        </td>
                        <td className="admin-date">
                          <time dateTime={page.updatedAt}>
                            {formatDate(page.updatedAt, zh)}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-empty">
                <Icon name="book" />
                <h3>{zh ? "这里还没有文档" : "No documents yet"}</h3>
                <p>
                  {zh
                    ? "文档更新后，会在这里显示。"
                    : "Your documents will appear here as they are updated."}
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Account({
  session,
  zh,
  busy,
  onSave,
}: {
  session: AuthSession;
  zh: boolean;
  busy: boolean;
  onSave: (
    event: FormEvent<HTMLFormElement>,
    type: "profile" | "password",
  ) => Promise<void>;
}) {
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">
            {zh ? "账户与安全" : "ACCOUNT & SECURITY"}
          </p>
          <h1>{zh ? "管理员账户" : "Administrator"}</h1>
          <p>
            {zh
              ? "管理登录信息，保护你的知识空间。"
              : "Manage your sign-in details and keep your workspace secure."}
          </p>
        </div>
      </div>
      <div className="admin-account-grid">
        <aside className="admin-panel admin-account-summary">
          <div className="admin-avatar large">
            {session.user.username.slice(0, 1).toUpperCase()}
          </div>
          <h2>{session.user.username}</h2>
          <span className="admin-pill">
            {zh ? "站点管理员" : "Site administrator"}
          </span>
          <p>
            {zh
              ? "这是本站唯一的管理员账户，拥有文档和站点的管理权限。"
              : "The sole administrator account for this wiki, with access to site and document management."}
          </p>
          <dl>
            <div>
              <dt>{zh ? "本次登录" : "Signed in"}</dt>
              <dd>{formatDate(session.createdAt, zh)}</dd>
            </div>
            <div>
              <dt>{zh ? "会话最晚到期" : "Session expires"}</dt>
              <dd>{formatDate(session.expiresAt, zh)}</dd>
            </div>
          </dl>
          <div className="admin-security-note">
            <Icon name="lock" />
            <span>
              {zh
                ? "更改用户名或密码后，所有已登录的会话都会退出。"
                : "Changing your username or password signs out all active sessions."}
            </span>
          </div>
        </aside>
        <div className="admin-account-forms">
          <section className="admin-panel">
            <header className="admin-panel-heading">
              <div>
                <h2>{zh ? "登录信息" : "Sign-in details"}</h2>
                <p>
                  {zh
                    ? "修改用户名需要验证当前密码。"
                    : "Confirm your current password to change your username."}
                </p>
              </div>
              <Icon name="user" />
            </header>
            <form
              className="admin-settings-form"
              onSubmit={(event) => void onSave(event, "profile")}
            >
              <fieldset disabled={busy}>
                <label className="admin-field" htmlFor="profile-username">
                  <span>{zh ? "用户名" : "Username"}</span>
                  <input
                    id="profile-username"
                    name="username"
                    type="text"
                    defaultValue={session.user.username}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,31}"
                    aria-describedby="profile-username-hint"
                  />
                  <small id="profile-username-hint">
                    {zh
                      ? "3–32 位英文字母、数字、下划线或连字符，以字母或数字开头。"
                      : "3–32 letters, numbers, underscores or hyphens; start with a letter or number."}
                  </small>
                </label>
                <PasswordInput
                  id="profile-password"
                  label={zh ? "当前密码" : "Current password"}
                  zh={zh}
                  current
                />
                <div className="admin-form-footer">
                  <small>
                    {zh
                      ? "保存后所有会话都会退出，需重新登录。"
                      : "Saving signs out all sessions. Sign in again to continue."}
                  </small>
                  <button className="admin-button" type="submit">
                    {busy
                      ? zh
                        ? "正在保存…"
                        : "Saving…"
                      : zh
                        ? "保存用户名"
                        : "Save username"}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
          <section className="admin-panel">
            <header className="admin-panel-heading">
              <div>
                <h2>{zh ? "更改密码" : "Change password"}</h2>
                <p>
                  {zh
                    ? "使用不在其他网站重复使用的长密码。"
                    : "Choose a long password you do not use elsewhere."}
                </p>
              </div>
              <Icon name="lock" />
            </header>
            <form
              className="admin-settings-form"
              onSubmit={(event) => void onSave(event, "password")}
            >
              <fieldset disabled={busy}>
                <PasswordInput
                  id="current-password"
                  label={zh ? "当前密码" : "Current password"}
                  zh={zh}
                  current
                />
                <div className="admin-form-columns">
                  <PasswordInput
                    id="new-password"
                    label={zh ? "新密码" : "New password"}
                    zh={zh}
                  />
                  <PasswordInput
                    id="confirm-password"
                    label={zh ? "再次输入新密码" : "Confirm new password"}
                    zh={zh}
                  />
                </div>
                <div className="admin-form-footer">
                  <small>
                    {zh
                      ? "更改后所有会话都会退出，需重新登录。"
                      : "Changing your password signs out all sessions. Sign in again to continue."}
                  </small>
                  <button className="admin-button" type="submit">
                    {busy
                      ? zh
                        ? "正在保存…"
                        : "Saving…"
                      : zh
                        ? "更新密码"
                        : "Update password"}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}

function SignOutDialog({
  zh,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  zh: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!previousFocus.current && document.activeElement instanceof HTMLElement)
      previousFocus.current = document.activeElement;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    cancel.current?.focus();
    return () => {
      if (previousFocus.current?.isConnected)
        previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="admin-signout-dialog"
      aria-labelledby="signout-title"
      aria-describedby="signout-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onCancel();
      }}
      onClose={onCancel}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <span className="admin-signout-icon">
          <Icon name="logout" />
        </span>
        <h2 id="signout-title">
          {zh
            ? "丢弃未保存的修改并退出？"
            : "Discard unsaved changes and sign out?"}
        </h2>
        <p id="signout-description">
          {zh
            ? "当前工作区有尚未保存的修改。退出会丢弃这些修改；取消可继续编辑并保存。"
            : "This workspace contains unsaved changes. Signing out discards them. Cancel to keep editing and save your work."}
        </p>
        {error && (
          <div className="admin-notice error" role="alert">
            {error}
          </div>
        )}
        <fieldset disabled={busy} className="admin-signout-actions">
          <button
            ref={cancel}
            className="admin-button secondary"
            type="button"
            onClick={onCancel}
          >
            {zh ? "取消，继续编辑" : "Cancel, keep editing"}
          </button>
          <button className="admin-button admin-signout-confirm" type="submit">
            {busy
              ? zh
                ? "正在退出…"
                : "Signing out…"
              : zh
                ? "丢弃并退出"
                : "Discard and sign out"}
          </button>
        </fieldset>
      </form>
    </dialog>
  );
}

export function AdminApp() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem("wiki-admin-language");
      if (saved === "zh" || saved === "en") return saved;
    } catch {
      /* The interface remains usable when browser storage is unavailable. */
    }
    return "zh";
  });
  const zh = language === "zh";
  const [session, setSession] = useState<AuthSession | null>(null);
  const [setup, setSetup] = useState<BootstrapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialError, setInitialError] = useState<unknown>(null);
  const [notice, setNotice] = useState<
    "expired" | "password" | "profile" | "logout" | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  const route = parseAdminRoute(window.location.pathname);
  const account = route.page === "account";
  const contentRoute = ["pages", "editor", "history"].includes(route.page);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = `${zh ? "管理工作空间" : "Admin workspace"} · Emby Wiki`;
    try {
      localStorage.setItem("wiki-admin-language", language);
    } catch {
      /* This page still uses the selected language without persistence. */
    }
  }, [language, zh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt deliberately repeats session discovery after a manual retry.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setInitialError(null);
    async function load() {
      try {
        const result = await request<{
          authenticated: true;
          session: AuthSession;
        }>("session", { signal: controller.signal });
        if (!controller.signal.aborted) setSession(result.session);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (!(failure instanceof ApiError) || failure.status !== 401)
          throw failure;
        const state = await request<BootstrapStatus>("setup", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSetup(state);
      }
    }
    void load()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setInitialError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  function signedOut(reason: typeof notice) {
    setConfirmSignOut(false);
    setSession(null);
    setSetup({ initialized: true, setupAvailable: false });
    setNotice(reason);
    setError(null);
  }

  const [onExpired] = useState(() => () => {
    setConfirmSignOut(false);
    setSession(null);
    setSetup({ initialized: true, setupAvailable: false });
    setNotice("expired");
    setError(null);
  });

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !setup) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const initializing = !setup.initialized;
    const password = String(values.get("password") ?? "");
    setError(null);
    if (initializing && !validNewPassword(password)) {
      setError(errorMessage(new ApiError(400), zh));
      return;
    }
    if (initializing && password !== values.get("confirm-password")) {
      setError(zh ? "两次输入的密码不一致。" : "The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ session: AuthSession }>(
        initializing ? "setup" : "login",
        mutation("POST", {
          username: String(values.get("username") ?? ""),
          password,
          ...(initializing ? { token: String(values.get("token") ?? "") } : {}),
        }),
      );
      form.reset();
      const returnTargets = new URLSearchParams(window.location.search).getAll(
        "returnTo",
      );
      const returnTo =
        returnTargets.length === 1
          ? normalizeAdminReturnTo(returnTargets[0])
          : null;
      if (returnTo) {
        window.location.assign(returnTo);
        return;
      }
      if (route.page === "editor" || route.page === "history") {
        window.location.reload();
        return;
      }
      setSession(result.session);
      setNotice(null);
    } catch (failure) {
      for (const input of form.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ))
        input.value = "";
      setError(errorMessage(failure, zh, initializing ? "setup" : "auth"));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount(
    event: FormEvent<HTMLFormElement>,
    type: "profile" | "password",
  ) {
    event.preventDefault();
    if (busy || !session) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setError(null);
    if (
      type === "password" &&
      !validNewPassword(String(values.get("new-password") ?? ""))
    ) {
      setError(errorMessage(new ApiError(400), zh));
      return;
    }
    if (
      type === "password" &&
      values.get("new-password") !== values.get("confirm-password")
    ) {
      setError(
        zh ? "两次输入的新密码不一致。" : "The new passwords do not match.",
      );
      return;
    }
    setBusy(true);
    try {
      await request<void>(
        type,
        mutation(
          "PUT",
          {
            expectedVersion: session.user.version,
            ...(type === "profile"
              ? {
                  username: String(values.get("username") ?? ""),
                  currentPassword: String(values.get("profile-password") ?? ""),
                }
              : {
                  currentPassword: String(values.get("current-password") ?? ""),
                  newPassword: String(values.get("new-password") ?? ""),
                }),
          },
          session.csrfToken,
        ),
      );
      form.reset();
      signedOut(type);
    } catch (failure) {
      for (const input of form.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ))
        input.value = "";
      if (failure instanceof ApiError && failure.status === 401) {
        try {
          const result = await request<{
            authenticated: true;
            session: AuthSession;
          }>("session");
          setSession(result.session);
          setError(
            zh
              ? "当前密码不正确，请重试。"
              : "The current password is incorrect. Please try again.",
          );
        } catch (sessionFailure) {
          if (
            sessionFailure instanceof ApiError &&
            sessionFailure.status === 401
          )
            signedOut("expired");
          else
            setError(
              zh
                ? "暂时无法核实登录状态，请稍后重试。"
                : "We could not verify your session. Please try again.",
            );
        }
      } else setError(errorMessage(failure, zh));
    } finally {
      setBusy(false);
    }
  }

  async function logout(force = false) {
    if (busy || !session) return;
    if (
      !force &&
      !window.dispatchEvent(
        new Event("wiki:before-signout", { cancelable: true }),
      )
    ) {
      setError(null);
      setConfirmSignOut(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request<void>("logout", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrfToken },
      });
      signedOut("logout");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401)
        signedOut("expired");
      else setError(errorMessage(failure, zh));
    } finally {
      setBusy(false);
    }
  }

  const languageSwitch = (
    <fieldset
      className="admin-language-switch"
      aria-label={zh ? "界面语言" : "Interface language"}
    >
      {(["zh", "en"] as const).map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          aria-pressed={language === value}
          onClick={() => {
            setLanguage(value);
            setError(null);
          }}
          disabled={busy}
        >
          {value === "zh" ? "中文" : "English"}
        </button>
      ))}
    </fieldset>
  );
  const notices = {
    expired: zh
      ? "会话已结束，请重新登录。"
      : "Your session has ended. Please sign in again.",
    password: zh
      ? "密码已更新，所有会话已退出。请使用新密码登录。"
      : "Password updated. All sessions are signed out. Sign in with your new password.",
    profile: zh
      ? "用户名已更新，所有会话已退出。请使用新用户名登录。"
      : "Username updated. All sessions are signed out. Sign in with your new username.",
    logout: zh ? "已安全退出登录。" : "You have been signed out.",
  };

  if (!session) {
    const initializing = setup && !setup.initialized;
    return (
      <div className="admin-root admin-auth">
        <header className="admin-auth-header">
          <Brand zh={zh} />
          <div>
            {languageSwitch}
            <a className="admin-text-link" href={publicPath(language, "home")}>
              {zh ? "返回 Wiki" : "Back to wiki"}
              <Icon name="arrow" />
            </a>
          </div>
        </header>
        <main className="admin-auth-main">
          <section className="admin-auth-intro">
            <span className="admin-eyebrow">EMBY WIKI / WORKSPACE</span>
            <h1>
              {zh ? (
                <>
                  让知识，
                  <br />
                  井然有序<span>.</span>
                </>
              ) : (
                <>
                  A place for
                  <br />
                  clear thinking<span>.</span>
                </>
              )}
            </h1>
            <p>
              {zh
                ? "把经验写成文档，把探索汇成指南。\n在这里，照料你的每一份知识。"
                : "Turn experience into documentation, and exploration into guides. Give your knowledge a place to grow."}
            </p>
            <div className="admin-auth-detail">
              <span>
                <Icon name="book" />
                {zh ? "专注于文档" : "Made for documentation"}
              </span>
              <span className="admin-intro-rule" />
              <span>中文 / English</span>
            </div>
            <div className="admin-auth-signature">
              <span className="admin-status-dot" />
              {zh ? "一个 Wiki，无限知识。" : "One wiki. A world of knowledge."}
            </div>
          </section>
          <section
            className="admin-auth-card"
            aria-labelledby="admin-auth-title"
          >
            <span className="admin-auth-lock">
              <Icon name="lock" />
            </span>
            <p className="admin-eyebrow">
              {zh ? "管理员专属" : "ADMINISTRATOR ACCESS"}
            </p>
            <h2 id="admin-auth-title">
              {initializing
                ? zh
                  ? "建立你的工作空间"
                  : "Set up your workspace"
                : zh
                  ? "欢迎回来"
                  : "Welcome back"}
            </h2>
            <p className="admin-auth-description">
              {initializing
                ? zh
                  ? "创建本站唯一的管理员账户。"
                  : "Create the administrator account for this wiki."
                : zh
                  ? "登录，继续管理你的 Emby Wiki。"
                  : "Sign in to your Emby Wiki workspace."}
            </p>
            {notice && (
              <div className="admin-notice success" role="status">
                {notices[notice]}
              </div>
            )}
            {(error || initialError !== null) && (
              <div className="admin-notice error" role="alert">
                {error ?? errorMessage(initialError, zh)}
              </div>
            )}
            {loading ? (
              <div className="admin-loading" role="status">
                <span className="admin-spinner" />
                {zh ? "正在检查登录状态…" : "Checking your session…"}
              </div>
            ) : !setup ? (
              <button
                className="admin-button full"
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {zh ? "重新连接" : "Try again"}
              </button>
            ) : initializing && !setup.setupAvailable ? (
              <div className="admin-setup-unavailable">
                <h3>{zh ? "初始化尚未开放" : "Setup is not available yet"}</h3>
                <p>
                  {zh
                    ? "请联系站点所有者完成配置，再回来创建管理员账户。"
                    : "Ask the site owner to complete the setup configuration before creating the administrator account."}
                </p>
                <button
                  className="admin-button secondary full"
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {zh ? "重新检查" : "Check again"}
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => void authenticate(event)}
                autoComplete={initializing ? "off" : "on"}
              >
                <fieldset disabled={busy}>
                  {initializing && (
                    <label className="admin-field" htmlFor="setup-token">
                      <span>{zh ? "初始化凭证" : "Setup token"}</span>
                      <input
                        id="setup-token"
                        name="token"
                        type="password"
                        autoComplete="off"
                        required
                        maxLength={256}
                      />
                      <small>
                        {zh
                          ? "使用站点所有者提供的一次性初始化凭证。"
                          : "Use the one-time setup token supplied by the site owner."}
                      </small>
                    </label>
                  )}
                  <label className="admin-field" htmlFor="auth-username">
                    <span>{zh ? "用户名" : "Username"}</span>
                    <input
                      id="auth-username"
                      name="username"
                      type="text"
                      autoComplete={initializing ? "off" : "username"}
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      minLength={3}
                      maxLength={32}
                      pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,31}"
                      aria-describedby={
                        initializing ? "auth-username-hint" : undefined
                      }
                    />
                    {initializing && (
                      <small id="auth-username-hint">
                        {zh
                          ? "3–32 位英文字母、数字、下划线或连字符，以字母或数字开头。"
                          : "3–32 letters, numbers, underscores or hyphens; start with a letter or number."}
                      </small>
                    )}
                  </label>
                  <PasswordInput
                    id="password"
                    label={zh ? "密码" : "Password"}
                    zh={zh}
                    current={!initializing}
                    setup={Boolean(initializing)}
                  />
                  {initializing && (
                    <PasswordInput
                      id="confirm-password"
                      label={zh ? "再次输入密码" : "Confirm password"}
                      zh={zh}
                      setup
                    />
                  )}
                  <button className="admin-button full" type="submit">
                    {busy
                      ? zh
                        ? "请稍候…"
                        : "Please wait…"
                      : initializing
                        ? zh
                          ? "创建管理员账户"
                          : "Create administrator"
                        : zh
                          ? "登录工作空间"
                          : "Sign in"}
                    {busy ? (
                      <span className="admin-spinner" />
                    ) : (
                      <Icon name="arrow" />
                    )}
                  </button>
                </fieldset>
              </form>
            )}
            <p className="admin-auth-footnote">
              <Icon name="lock" />
              {zh
                ? "仅供站点管理员使用"
                : "Reserved for the site administrator"}
            </p>
          </section>
        </main>
        <footer className="admin-auth-footer">
          <span>Emby Wiki</span>
          <span>
            {zh ? "知识，在这里连接。" : "A connected knowledge base."}
          </span>
        </footer>
      </div>
    );
  }

  return (
    <div className="admin-root admin-workspace">
      <a className="admin-skip-link" href="#admin-content">
        {zh ? "跳转到主要内容" : "Skip to content"}
      </a>
      <aside className="admin-sidebar">
        <Brand zh={zh} />
        <p className="admin-nav-label">{zh ? "工作空间" : "WORKSPACE"}</p>
        <nav aria-label={zh ? "管理导航" : "Administration"}>
          <a
            href="/admin"
            aria-current={route.page === "dashboard" ? "page" : undefined}
          >
            <Icon name="grid" />
            <span>{zh ? "概览" : "Dashboard"}</span>
          </a>
          <a
            href="/admin/pages"
            aria-current={contentRoute ? "page" : undefined}
          >
            <Icon name="book" />
            <span>{zh ? "页面" : "Pages"}</span>
          </a>
          <a
            href="/admin/navigation"
            aria-current={route.page === "navigation" ? "page" : undefined}
          >
            <Icon name="page" />
            <span>{zh ? "导航" : "Navigation"}</span>
          </a>
          <a
            href="/admin/audit"
            aria-current={route.page === "audit" ? "page" : undefined}
          >
            <Icon name="clock" />
            <span>{zh ? "审计日志" : "Audit logs"}</span>
          </a>
          <a href="/admin/account" aria-current={account ? "page" : undefined}>
            <Icon name="user" />
            <span>{zh ? "管理员" : "Administrator"}</span>
          </a>
        </nav>
        <div className="admin-sidebar-bottom">
          <div className="admin-sidebar-note">
            <span className="admin-status-dot" />
            {zh ? "测试工作空间" : "Test workspace"}
          </div>
          <div className="admin-sidebar-user">
            <span className="admin-avatar">
              {session.user.username.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{session.user.username}</strong>
              <small>{zh ? "管理员" : "Administrator"}</small>
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busy}
              aria-label={zh ? "退出登录" : "Sign out"}
              title={zh ? "退出登录" : "Sign out"}
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      <div className="admin-workspace-main">
        <header className="admin-toolbar">
          <div className="admin-breadcrumb">
            <span>Emby Wiki</span>
            <span aria-hidden="true">/</span>
            <strong>
              {
                {
                  dashboard: zh ? "概览" : "Dashboard",
                  account: zh ? "管理员" : "Administrator",
                  pages: zh ? "页面" : "Pages",
                  navigation: zh ? "导航" : "Navigation",
                  audit: zh ? "审计日志" : "Audit logs",
                  editor: zh ? "编辑页面" : "Page editor",
                  history: zh ? "版本历史" : "Revision history",
                  "not-found": zh ? "找不到页面" : "Page not found",
                }[route.page]
              }
            </strong>
          </div>
          <div>
            {languageSwitch}
            <a className="admin-text-link" href={publicPath(language, "home")}>
              {zh ? "查看站点" : "View site"}
              <Icon name="arrow" />
            </a>
          </div>
        </header>
        <main
          id="admin-content"
          className={`admin-content${route.page === "editor" ? " admin-editor-content" : ""}`}
        >
          {error && (
            <div className="admin-notice error" role="alert">
              {error}
            </div>
          )}
          <Suspense
            fallback={
              <div className="admin-panel admin-loading" role="status">
                <span className="admin-spinner" />
                {zh ? "正在加载工作空间…" : "Loading workspace…"}
              </div>
            }
          >
            {route.page === "account" ? (
              <Account
                session={session}
                zh={zh}
                busy={busy}
                onSave={saveAccount}
              />
            ) : route.page === "pages" ? (
              <PagesPage
                language={language}
                session={session}
                onExpired={onExpired}
                onSessionChange={setSession}
              />
            ) : route.page === "navigation" ? (
              <NavigationPage
                language={language}
                session={session}
                onSessionChange={setSession}
              />
            ) : route.page === "audit" ? (
              <AuditPage language={language} onSessionChange={setSession} />
            ) : route.page === "editor" ? (
              <EditorPage
                language={language}
                session={session}
                translationId={route.translationId}
                onExpired={onExpired}
                onSessionChange={setSession}
              />
            ) : route.page === "history" ? (
              <VersionsPage
                language={language}
                session={session}
                translationId={route.translationId}
                onExpired={onExpired}
                onSessionChange={setSession}
              />
            ) : route.page === "dashboard" ? (
              <Dashboard session={session} zh={zh} onExpired={onExpired} />
            ) : (
              <section className="admin-panel admin-empty">
                <h1>
                  {zh
                    ? "找不到这个管理页面"
                    : "This admin page could not be found"}
                </h1>
                <p>
                  {zh
                    ? "请通过侧栏访问工作空间。"
                    : "Use the sidebar to return to your workspace."}
                </p>
                <a className="admin-button secondary" href="/admin/pages">
                  {zh ? "查看所有页面" : "Browse pages"}
                </a>
              </section>
            )}
          </Suspense>
          <footer className="admin-content-footer">
            <span>Emby Wiki</span>
            <span>
              {zh ? "让知识不断生长。" : "Keep your knowledge growing."}
            </span>
          </footer>
        </main>
      </div>
      {confirmSignOut && (
        <SignOutDialog
          zh={zh}
          busy={busy}
          error={error}
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => void logout(true)}
        />
      )}
    </div>
  );
}
