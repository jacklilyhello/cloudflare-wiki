import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import {
  parseSiteSettingsValues,
  SETTINGS_LIMITS,
  SITE_ACCENTS,
  SITE_LOGOS,
  SITE_THEMES,
  type SiteSettings,
  type SiteSettingsValues,
} from "../../shared/settings";
import { SiteLogo } from "../components/SiteLogo";
import { ApiError, mutation, request } from "./api";
import "./settings.css";

function valuesOf(settings: SiteSettingsValues): SiteSettingsValues {
  return {
    locales: {
      zh: { ...settings.locales.zh },
      en: { ...settings.locales.en },
    },
    defaultLanguage: settings.defaultLanguage,
    theme: settings.theme,
    accent: settings.accent,
    logo: settings.logo,
  };
}
function equalValues(a: SiteSettingsValues, b: SiteSettingsValues) {
  return JSON.stringify(valuesOf(a)) === JSON.stringify(valuesOf(b));
}
function authError(error: unknown) {
  return error instanceof ApiError && [401, 403].includes(error.status);
}
function errorText(error: unknown, zh: boolean) {
  if (authError(error))
    return zh
      ? "登录状态已变化，输入仍保留。请在新标签页登录后重新连接。"
      : "Your session has changed. Your input is preserved. Sign in in a new tab, then reconnect.";
  if (error instanceof ApiError && error.status === 400)
    return zh
      ? "请检查两个语言的名称和描述，以及所选外观。"
      : "Check the names and descriptions in both languages and the selected appearance.";
  return zh
    ? "暂时无法完成请求，输入仍保留。"
    : "The request could not be completed. Your input is preserved.";
}
function choiceLabel(value: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    system: ["跟随系统", "System"],
    light: ["浅色", "Light"],
    dark: ["深色", "Dark"],
    forest: ["森林绿", "Forest"],
    ocean: ["海洋蓝", "Ocean"],
    plum: ["梅紫", "Plum"],
    emby: ["E 字标", "E monogram"],
    book: ["书本", "Book"],
    none: ["仅文字", "Text only"],
    zh: ["中文", "中文"],
    en: ["English", "English"],
  };
  return labels[value]?.[zh ? 0 : 1] ?? value;
}
function comparisonRows(settings: SiteSettingsValues, zh: boolean) {
  return [
    [zh ? "中文名称" : "Chinese name", settings.locales.zh.name],
    [zh ? "中文描述" : "Chinese description", settings.locales.zh.description],
    [zh ? "英文名称" : "English name", settings.locales.en.name],
    [zh ? "英文描述" : "English description", settings.locales.en.description],
    [
      zh ? "默认语言" : "Default language",
      choiceLabel(settings.defaultLanguage, zh),
    ],
    [zh ? "默认主题" : "Default theme", choiceLabel(settings.theme, zh)],
    [zh ? "强调色" : "Accent", choiceLabel(settings.accent, zh)],
    [zh ? "标志" : "Logo", choiceLabel(settings.logo, zh)],
  ];
}
function ConfirmReset({
  zh,
  onClose,
  onConfirm,
}: {
  zh: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      className="settings-dialog"
      ref={dialog}
      aria-labelledby="settings-reset-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <h2 id="settings-reset-title">
        {zh ? "丢弃未保存的修改？" : "Discard unsaved changes?"}
      </h2>
      <p>
        {zh
          ? "表单将恢复为上次载入的设置。"
          : "The form will return to the settings you last loaded."}
      </p>
      <div>
        <button
          className="admin-button secondary"
          type="button"
          onClick={onClose}
        >
          {zh ? "继续编辑" : "Keep editing"}
        </button>
        <button className="admin-button" type="button" onClick={onConfirm}>
          {zh ? "重置表单" : "Reset form"}
        </button>
      </div>
    </dialog>
  );
}

export function SettingsPage({
  language,
  session,
  onSessionChange,
  onSaved,
}: {
  language: Language;
  session: AuthSession;
  onSessionChange: (session: AuthSession) => void;
  onSaved: (settings: SiteSettingsValues) => void;
}) {
  const zh = language === "zh";
  const [baseline, setBaseline] = useState<SiteSettings | null>(null);
  const [draft, setDraft] = useState<SiteSettingsValues | null>(null);
  const [contentLanguage, setContentLanguage] = useState<Language>(language);
  const [activeSession, setActiveSession] = useState(session);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [recovery, setRecovery] = useState<"conflict" | "unknown" | null>(null);
  const [latest, setLatest] = useState<SiteSettings | null>(null);
  const [notice, setNotice] = useState<
    "saved" | "reconnected" | "reviewed" | null
  >(null);
  const [validation, setValidation] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const dirty = Boolean(draft && baseline && !equalValues(draft, baseline));
  const guarded = useRef(false);
  guarded.current = dirty || recovery !== null || busy;
  const sessionExpired = sessionBlocked || authError(failure);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry of the initial read; later reads must preserve the draft.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void request<SiteSettings>("settings", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setBaseline(result);
          setDraft(valuesOf(result));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFailure(error);
          if (authError(error)) setSessionBlocked(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (guarded.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const beforeSignout = (event: Event) => {
      if (guarded.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("wiki:before-signout", beforeSignout);
    return () => {
      operation.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("wiki:before-signout", beforeSignout);
    };
  }, []);
  function update(values: Partial<SiteSettingsValues>) {
    setDraft((current) => (current ? { ...current, ...values } : current));
    setNotice(null);
    setValidation(false);
  }
  function updateIdentity(field: "name" | "description", value: string) {
    if (!draft) return;
    update({
      locales: {
        ...draft.locales,
        [contentLanguage]: {
          ...draft.locales[contentLanguage],
          [field]: value,
        },
      },
    });
  }
  async function run(kind: "save" | "latest" | "reconnect") {
    if (busy || loading || operation.current) return;
    if (
      kind === "save" &&
      (!draft ||
        !baseline ||
        !dirty ||
        recovery ||
        latest ||
        sessionExpired ||
        resetConfirm)
    )
      return;
    let submitted: SiteSettingsValues | null = null;
    if (kind === "save" && draft) {
      try {
        submitted = parseSiteSettingsValues(draft);
      } catch {
        setValidation(true);
        return;
      }
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    if (kind === "latest") setLatest(null);
    try {
      if (kind === "reconnect") {
        const result = await request<{ session: AuthSession }>("session", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setActiveSession(result.session);
        setSessionBlocked(false);
        onSessionChange(result.session);
        setNotice("reconnected");
      } else if (kind === "latest") {
        const result = await request<SiteSettings>("settings", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setLatest(result);
      } else if (submitted && baseline) {
        const result = await request<SiteSettings>("settings", {
          ...mutation(
            "PUT",
            { ...submitted, expectedVersion: baseline.version },
            activeSession.csrfToken,
          ),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setBaseline(result);
        setDraft(valuesOf(result));
        setLatest(null);
        setRecovery(null);
        setNotice("saved");
        onSaved(valuesOf(result));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (authError(error)) setSessionBlocked(true);
        if (
          kind === "save" &&
          (!(error instanceof ApiError) || error.status >= 500)
        ) {
          setRecovery("unknown");
          setLatest(null);
        } else if (
          kind === "save" &&
          error instanceof ApiError &&
          error.status === 412
        ) {
          setRecovery("conflict");
          setLatest(null);
        } else setFailure(error);
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function acceptLatest(keepInput: boolean) {
    if (!latest || busy || sessionExpired) return;
    setBaseline(latest);
    onSaved(valuesOf(latest));
    if (!keepInput) setDraft(valuesOf(latest));
    setLatest(null);
    setRecovery(null);
    setFailure(null);
    setValidation(false);
    setNotice("reviewed");
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("save");
  }
  const draftRows = draft ? comparisonRows(draft, zh) : [];
  return (
    <div className="settings-workspace">
      <header className="settings-heading">
        <div>
          <p className="admin-eyebrow">WORKSPACE / SETTINGS</p>
          <h1>{zh ? "让站点，成为你的样子" : "Make this space your own"}</h1>
          <p>
            {zh
              ? "为两种语言定义清晰的身份，选择适合阅读的外观。"
              : "A clear identity in both languages. An appearance made for reading."}
          </p>
        </div>
        <span className={`settings-save-state${dirty ? " is-dirty" : ""}`}>
          {dirty
            ? zh
              ? "有未保存的修改"
              : "Unsaved changes"
            : zh
              ? "站点设置"
              : "Site settings"}
        </span>
      </header>
      {failure != null && (
        <div className="admin-notice error settings-notice" role="alert">
          <span>{errorText(failure, zh)}</span>
          {sessionExpired ? (
            <div className="settings-inline-actions">
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
                disabled={busy || loading}
                onClick={() => void run("reconnect")}
              >
                {zh ? "重新连接" : "Reconnect"}
              </button>
            </div>
          ) : (
            !baseline && (
              <button
                type="button"
                className="admin-button secondary"
                disabled={loading}
                onClick={() => setAttempt((value) => value + 1)}
              >
                {zh ? "重试读取" : "Retry loading"}
              </button>
            )
          )}
        </div>
      )}
      {recovery && (
        <div className="admin-notice error settings-notice" role="alert">
          <span>
            {recovery === "unknown"
              ? zh
                ? "保存结果尚无法确认，可能已经完成。输入已保留；请读取最新设置并比较后再操作。"
                : "The save outcome is unconfirmed and may have completed. Your input is preserved. Load the latest settings and compare before continuing."
              : zh
                ? "设置已在其他位置更新。输入已保留；请读取最新设置并比较，系统不会自动覆盖。"
                : "Settings changed elsewhere. Your input is preserved. Load the latest settings and compare; nothing is overwritten automatically."}
          </span>
          <button
            className="admin-button secondary"
            type="button"
            disabled={busy || sessionExpired}
            onClick={() => void run("latest")}
          >
            {busy
              ? zh
                ? "正在读取…"
                : "Loading…"
              : zh
                ? "读取最新设置"
                : "Load latest settings"}
          </button>
        </div>
      )}
      {notice && (
        <div className="admin-notice success settings-notice" role="status">
          {notice === "saved"
            ? zh
              ? "设置已保存，站点外观已更新。"
              : "Settings saved. The site appearance is updated."
            : notice === "reconnected"
              ? zh
                ? "已重新连接。输入与版本条件仍保留，请核对后手动继续。"
                : "Reconnected. Your input and version condition are preserved. Review before continuing manually."
              : zh
                ? "已采用读取的版本条件。请检查表单；如需更改站点，仍须手动保存。"
                : "The loaded version is now your baseline. Review the form; changing the site still requires Save."}
          {notice === "reconnected" && !baseline && (
            <button
              className="admin-button secondary"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {zh ? "继续读取" : "Continue loading"}
            </button>
          )}
        </div>
      )}
      {latest && draft && (
        <section
          className="settings-comparison admin-panel"
          aria-labelledby="settings-compare-title"
        >
          <header>
            <p className="admin-eyebrow">REVIEW CHANGES</p>
            <h2 id="settings-compare-title">
              {zh ? "比较后，再决定" : "Compare before continuing"}
            </h2>
            <p>
              {zh
                ? "左侧是刚读取的已保存设置，右侧是当前输入。读取不会修改表单或自动保存。"
                : "The left column contains the saved settings just loaded; the right contains your input. Loading does not replace the form or save it."}
            </p>
          </header>
          <div className="settings-comparison-scroll">
            <table>
              <thead>
                <tr>
                  <th>{zh ? "项目" : "Setting"}</th>
                  <th>{zh ? "最新已保存" : "Latest saved"}</th>
                  <th>{zh ? "你的输入" : "Your input"}</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows(latest, zh).map(([label, value], index) => (
                  <tr
                    key={label}
                    className={
                      value !== draftRows[index]?.[1] ? "is-changed" : undefined
                    }
                  >
                    <th scope="row">{label}</th>
                    <td>{value || "—"}</td>
                    <td>{draftRows[index]?.[1] || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="settings-compare-actions">
            <button
              type="button"
              className="admin-button secondary"
              disabled={busy || sessionExpired}
              onClick={() => acceptLatest(false)}
            >
              {zh
                ? "采用最新值，替换输入"
                : "Replace my input with latest values"}
            </button>
            <button
              type="button"
              className="admin-button"
              disabled={busy || sessionExpired}
              onClick={() => acceptLatest(true)}
            >
              {zh
                ? "保留输入，采用此版本条件"
                : "Keep my input with this version"}
            </button>
          </div>
        </section>
      )}
      {loading ? (
        <div className="admin-panel admin-loading" role="status">
          <span className="admin-spinner" />
          {zh ? "正在读取站点设置…" : "Loading site settings…"}
        </div>
      ) : draft && baseline ? (
        <form onSubmit={submit}>
          <div className="settings-layout">
            <div className="settings-sections">
              <section
                className="settings-card admin-panel"
                aria-labelledby="settings-identity-title"
              >
                <header>
                  <span className="settings-step">01</span>
                  <div>
                    <h2 id="settings-identity-title">
                      {zh ? "站点身份" : "Site identity"}
                    </h2>
                    <p>
                      {zh
                        ? "名称与描述随访客正在阅读的语言展示。"
                        : "The name and description follow the reader’s current language."}
                    </p>
                  </div>
                </header>
                <fieldset
                  className="settings-language-tabs"
                  aria-label={zh ? "编辑语言" : "Editing language"}
                >
                  {(["zh", "en"] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      lang={value}
                      aria-pressed={contentLanguage === value}
                      onClick={() => setContentLanguage(value)}
                    >
                      {value === "zh" ? "中文" : "English"}
                      <span>{value === "zh" ? "ZH" : "EN"}</span>
                    </button>
                  ))}
                </fieldset>
                <fieldset disabled={busy} className="settings-fields">
                  <label className="admin-field" htmlFor="settings-name">
                    <span>
                      {zh ? "站点名称" : "Site name"}
                      <small>
                        {draft.locales[contentLanguage].name.length} /{" "}
                        {SETTINGS_LIMITS.name}
                      </small>
                    </span>
                    <input
                      id="settings-name"
                      value={draft.locales[contentLanguage].name}
                      maxLength={SETTINGS_LIMITS.name}
                      required
                      onChange={(event) =>
                        updateIdentity("name", event.target.value)
                      }
                      autoComplete="off"
                    />
                  </label>
                  <label className="admin-field" htmlFor="settings-description">
                    <span>
                      {zh ? "简短描述" : "Short description"}
                      <small>
                        {draft.locales[contentLanguage].description.length} /{" "}
                        {SETTINGS_LIMITS.description}
                      </small>
                    </span>
                    <textarea
                      id="settings-description"
                      value={draft.locales[contentLanguage].description}
                      maxLength={SETTINGS_LIMITS.description}
                      rows={3}
                      onChange={(event) =>
                        updateIdentity("description", event.target.value)
                      }
                    />
                    <small>
                      {zh
                        ? "公开显示的单段简介，用于站点介绍与页面分享信息。留空可省略。"
                        : "A public, single-paragraph introduction used in site and sharing information. Leave blank to omit it."}
                    </small>
                  </label>
                  <label
                    className="admin-field settings-default-language"
                    htmlFor="settings-default-language"
                  >
                    <span>{zh ? "默认语言" : "Default language"}</span>
                    <select
                      id="settings-default-language"
                      value={draft.defaultLanguage}
                      onChange={(event) =>
                        update({
                          defaultLanguage: event.target.value as Language,
                        })
                      }
                    >
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </select>
                    <small>
                      {zh
                        ? "访问站点首页时使用；已选择的阅读语言不变。"
                        : "Used when opening the site root; an explicitly selected reading language stays unchanged."}
                    </small>
                  </label>
                </fieldset>
              </section>
              <section
                className="settings-card admin-panel"
                aria-labelledby="settings-appearance-title"
              >
                <header>
                  <span className="settings-step">02</span>
                  <div>
                    <h2 id="settings-appearance-title">
                      {zh ? "阅读外观" : "Reading appearance"}
                    </h2>
                    <p>
                      {zh
                        ? "简洁的选择，让内容始终成为重点。"
                        : "A few considered choices, with your content at the center."}
                    </p>
                  </div>
                </header>
                <fieldset disabled={busy} className="settings-option-group">
                  <legend>{zh ? "默认主题" : "Default theme"}</legend>
                  <div className="settings-options">
                    {SITE_THEMES.map((value) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={draft.theme === value}
                        onClick={() => update({ theme: value })}
                      >
                        <span
                          className={`settings-theme-sample theme-${value}`}
                          aria-hidden="true"
                        >
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>{choiceLabel(value, zh)}</span>
                      </button>
                    ))}
                  </div>
                  <p>
                    {zh
                      ? "访客自己选择的浅色或深色模式优先于站点默认值。"
                      : "A visitor’s own light or dark preference takes priority over the site default."}
                  </p>
                </fieldset>
                <fieldset disabled={busy} className="settings-option-group">
                  <legend>{zh ? "强调色" : "Accent color"}</legend>
                  <div className="settings-options settings-color-options">
                    {SITE_ACCENTS.map((value) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={draft.accent === value}
                        onClick={() => update({ accent: value })}
                      >
                        <span
                          className={`settings-color-sample accent-${value}`}
                          aria-hidden="true"
                        />
                        <span>{choiceLabel(value, zh)}</span>
                        <span
                          className="settings-choice-check"
                          aria-hidden="true"
                        >
                          {draft.accent === value ? "✓" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset disabled={busy} className="settings-option-group">
                  <legend>{zh ? "站点标志" : "Site logo"}</legend>
                  <div className="settings-options settings-logo-options">
                    {SITE_LOGOS.map((value) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={draft.logo === value}
                        onClick={() => update({ logo: value })}
                      >
                        <span
                          className="settings-logo-sample"
                          aria-hidden="true"
                        >
                          {value === "none" ? "Aa" : <SiteLogo logo={value} />}
                        </span>
                        <span>{choiceLabel(value, zh)}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              </section>
            </div>
            <aside className="settings-preview-column">
              <section className="settings-preview-card">
                <header>
                  <p className="admin-eyebrow">LIVE PREVIEW</p>
                  <h2>{zh ? "看看它的样子" : "A look at your space"}</h2>
                  <span>
                    {zh
                      ? "预览 · 保存后应用"
                      : "Preview · applies after saving"}
                  </span>
                </header>
                <div
                  className={`settings-preview preview-${draft.theme} accent-${draft.accent}`}
                >
                  <div className="settings-preview-browser" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <span>your wiki</span>
                  </div>
                  <div className="settings-preview-brand">
                    {draft.logo !== "none" && (
                      <span>
                        <SiteLogo logo={draft.logo} />
                      </span>
                    )}
                    <strong>
                      {draft.locales[contentLanguage].name ||
                        (zh ? "站点名称" : "Site name")}
                    </strong>
                    <small>{contentLanguage === "zh" ? "中文" : "EN"}</small>
                  </div>
                  <div className="settings-preview-body">
                    <div className="settings-preview-nav" aria-hidden="true">
                      <span>⌂</span>
                      <i />
                      <i />
                      <i />
                    </div>
                    <article>
                      <p className="settings-preview-kicker">
                        {contentLanguage === "zh"
                          ? "欢迎来到知识空间"
                          : "WELCOME TO YOUR WIKI"}
                      </p>
                      <h3>
                        {contentLanguage === "zh"
                          ? "每一份知识，都值得被分享。"
                          : "Good knowledge deserves a home."}
                      </h3>
                      {draft.locales[contentLanguage].description && (
                        <p>{draft.locales[contentLanguage].description}</p>
                      )}
                      <div className="settings-preview-callout">
                        {contentLanguage === "zh"
                          ? "从一篇清晰的文档开始。"
                          : "Start with one clear page."}
                      </div>
                      <span className="settings-preview-link">
                        {contentLanguage === "zh"
                          ? "开始阅读 →"
                          : "Start reading →"}
                      </span>
                    </article>
                  </div>
                </div>
                <p className="settings-preview-note">
                  {zh
                    ? "预览仅使用当前输入，不会改变已保存的站点。跟随系统模式按当前设备外观显示。"
                    : "This preview uses your input and leaves the saved site unchanged. System mode follows this device’s appearance."}
                </p>
              </section>
              <div className="settings-tip">
                <span aria-hidden="true">↗</span>
                <p>
                  {zh
                    ? "设置保存后会应用到站点。内容、文章路径和导航结构不会被改动。"
                    : "Saved settings apply across the site. Your articles, paths and navigation stay in place."}
                </p>
              </div>
            </aside>
          </div>
          {validation && (
            <div className="admin-notice error" role="alert">
              {zh
                ? "请检查中英文名称（必填，最多 80 字符）及描述（最多 300 字符）。请使用单行文字，不含控制字符。"
                : "Check both names (required, up to 80 characters) and descriptions (up to 300 characters). Use single-line text without control characters."}
            </div>
          )}
          <footer className="settings-savebar">
            <div>
              <strong>
                {dirty
                  ? zh
                    ? "修改尚未保存"
                    : "Your changes are not saved"
                  : zh
                    ? "已与载入的设置一致"
                    : "Your form matches the loaded settings"}
              </strong>
              <small>
                {zh
                  ? "预览满意后，保存即可应用到站点。"
                  : "Save when you’re ready to apply these settings to the site."}
              </small>
            </div>
            <div>
              <button
                className="admin-button secondary"
                type="button"
                disabled={
                  busy || !dirty || recovery !== null || latest !== null
                }
                onClick={() => setResetConfirm(true)}
              >
                {zh ? "重置表单" : "Reset form"}
              </button>
              <button
                className="admin-button"
                type="submit"
                disabled={
                  busy ||
                  !dirty ||
                  recovery !== null ||
                  latest !== null ||
                  sessionExpired ||
                  resetConfirm
                }
              >
                {busy
                  ? zh
                    ? "正在处理…"
                    : "Working…"
                  : zh
                    ? "保存设置"
                    : "Save settings"}
              </button>
            </div>
          </footer>
        </form>
      ) : null}
      {resetConfirm && (
        <ConfirmReset
          zh={zh}
          onClose={() => setResetConfirm(false)}
          onConfirm={() => {
            if (baseline) setDraft(valuesOf(baseline));
            setResetConfirm(false);
            setValidation(false);
            setNotice(null);
          }}
        />
      )}
    </div>
  );
}
