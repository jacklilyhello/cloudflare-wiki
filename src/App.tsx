import { useEffect, useRef, useState } from "react";
import { publicPath } from "../shared/paths";
import type { NavigationEntry, ReaderData, WikiPage } from "../shared/reader";

type IconName =
  | "search"
  | "sun"
  | "moon"
  | "arrow"
  | "chevron"
  | "book"
  | "menu"
  | "close"
  | "clock";

function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  const paths: Record<IconName, string> = {
    search: "m21 21-4.6-4.6M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
    sun: "M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    moon: "M20.9 13a9 9 0 1 1-9.9-9.9A7 7 0 0 0 20.9 13Z",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    chevron: "m9 5 7 7-7 7",
    book: "M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1m0-15c3-2 6-2 10-1v15c-4-1-7-1-10 1V5",
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "m6 6 12 12M6 18 18 6",
    clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function Logo() {
  return (
    <svg
      className="site-mark"
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="36" height="36" rx="10" fill="currentColor" />
      <path d="M10 10h16v4H14v2h10v4H14v2h12v4H10V10Z" fill="var(--logo-ink)" />
    </svg>
  );
}

function containsPath(entry: NavigationEntry, path: string): boolean {
  return (
    (entry.kind === "page" && entry.path === path) ||
    Boolean(entry.children?.some((child) => containsPath(child, path)))
  );
}

function Navigation({
  entries,
  path,
}: {
  entries: NavigationEntry[];
  path: string;
}) {
  return (
    <ul className="navigation-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          {entry.children?.length ? (
            <details
              className="navigation-group"
              open={containsPath(entry, path)}
            >
              <summary>
                <span>{entry.title}</span>
                <Icon name="chevron" />
              </summary>
              {entry.path && (
                <a
                  className="navigation-overview"
                  href={entry.path}
                  target={entry.external ? "_blank" : undefined}
                  rel={entry.external ? "noopener noreferrer" : undefined}
                  aria-current={entry.path === path ? "page" : undefined}
                >
                  {entry.title}
                </a>
              )}
              <Navigation entries={entry.children} path={path} />
            </details>
          ) : (
            <a
              href={entry.path}
              target={entry.external ? "_blank" : undefined}
              rel={entry.external ? "noopener noreferrer" : undefined}
              aria-current={
                entry.kind === "page" && entry.path === path
                  ? "page"
                  : undefined
              }
            >
              <span className="navigation-dot" aria-hidden="true" />
              {entry.title}
              {entry.external && <span aria-hidden="true"> ↗</span>}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function flattenNavigation(entries: NavigationEntry[]): NavigationEntry[] {
  return entries.flatMap((entry) => [
    ...(entry.kind === "page" && entry.path ? [entry] : []),
    ...flattenNavigation(entry.children ?? []),
  ]);
}

function findBreadcrumb(entries: NavigationEntry[], path: string): string[] {
  for (const entry of entries) {
    if (entry.kind === "page" && entry.path === path) return [entry.title];
    const childPath = findBreadcrumb(entry.children ?? [], path);
    if (childPath.length) return [entry.title, ...childPath];
  }
  return [];
}

function formatUpdated(page: WikiPage, zh: boolean): string {
  return new Intl.DateTimeFormat(zh ? "zh-CN" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(page.updatedAt));
}

export function App({ data }: { data: ReaderData }) {
  const zh = data.language === "zh";
  const home = `/${data.language}/home`;
  const currentPath = data.page
    ? publicPath(data.page.language, data.page.path)
    : "";
  const title =
    data.mode === "search"
      ? zh
        ? "搜索文档"
        : "Search documentation"
      : (data.page?.title ??
        (zh ? "找不到这个页面" : "This page could not be found"));
  const navigationBreadcrumb = data.page
    ? findBreadcrumb(data.navigation, currentPath)
    : [title];
  const breadcrumb = navigationBreadcrumb.length
    ? navigationBreadcrumb
    : [title];
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [activeHeading, setActiveHeading] = useState(
    data.rendered?.toc[0]?.id ?? "",
  );
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const imageDialogRef = useRef<HTMLDialogElement>(null);
  const pages = flattenNavigation(data.navigation);
  const currentIndex = pages.findIndex((entry) => entry.path === currentPath);
  const previous = currentIndex > 0 ? pages[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 ? pages[currentIndex + 1] : undefined;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("wiki-theme");
    } catch {
      /* Theme still works when browser storage is unavailable. */
    }
    if (saved === "light" || saved === "dark")
      document.documentElement.dataset.theme = saved;
    const update = () =>
      setTheme(
        document.documentElement.dataset.theme === "dark" ||
          (!document.documentElement.dataset.theme && preference.matches)
          ? "dark"
          : "light",
      );
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!articleRef.current || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) setActiveHeading(entry.target.id);
      },
      { rootMargin: "-88px 0px -65% 0px", threshold: 0 },
    );
    for (const heading of articleRef.current.querySelectorAll(
      "h2[id], h3[id], h4[id]",
    ))
      observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const events = new AbortController();
    const insertedButtons: HTMLButtonElement[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const pre of article.querySelectorAll<HTMLPreElement>(
      "pre:not(.mermaid-source)",
    )) {
      const code = pre.querySelector("code");
      if (!code || !navigator.clipboard?.writeText) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = zh ? "复制" : "Copy";
      button.setAttribute("aria-label", zh ? "复制代码" : "Copy code");
      button.setAttribute("aria-live", "polite");
      button.addEventListener(
        "click",
        async () => {
          try {
            await navigator.clipboard.writeText(code.textContent ?? "");
            button.textContent = zh ? "已复制" : "Copied";
          } catch {
            button.textContent = zh ? "请手动复制" : "Select to copy";
          }
          timers.push(
            setTimeout(() => {
              button.textContent = zh ? "复制" : "Copy";
            }, 2200),
          );
        },
        { signal: events.signal },
      );
      pre.classList.add("has-copy");
      pre.appendChild(button);
      insertedButtons.push(button);
    }
    for (const img of article.querySelectorAll<HTMLImageElement>("img")) {
      if (img.closest("a")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "article-image";
      button.setAttribute(
        "aria-label",
        `${zh ? "放大图片" : "Enlarge image"}${img.alt ? `: ${img.alt}` : ""}`,
      );
      img.replaceWith(button);
      button.appendChild(img);
      button.addEventListener(
        "click",
        () =>
          setSelectedImage({ src: img.currentSrc || img.src, alt: img.alt }),
        { signal: events.signal },
      );
      insertedButtons.push(button);
    }
    return () => {
      events.abort();
      for (const timer of timers) clearTimeout(timer);
      for (const button of insertedButtons) {
        if (button.classList.contains("article-image"))
          button.replaceWith(...button.childNodes);
        else button.remove();
      }
    };
  }, [zh]);

  useEffect(() => {
    if (selectedImage && imageDialogRef.current && !imageDialogRef.current.open)
      imageDialogRef.current.showModal();
  }, [selectedImage]);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    try {
      localStorage.setItem("wiki-theme", nextTheme);
    } catch {
      /* The current theme does not require persistent storage. */
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        {zh ? "跳转到正文" : "Skip to content"}
      </a>
      <header className="site-header">
        <div className="header-inner">
          <a
            className="site-brand"
            href={home}
            aria-label={zh ? "Emby Wiki 首页" : "Emby Wiki home"}
          >
            <Logo />
            <span>
              Emby <strong>Wiki</strong>
              <small>
                {zh ? "知识，在这里连接" : "A connected knowledge base"}
              </small>
            </span>
          </a>
          <search className="header-search">
            <form action={`/${data.language}/search`} method="get">
              <label className="sr-only" htmlFor="wiki-search">
                {zh ? "搜索文档" : "Search documentation"}
              </label>
              <Icon name="search" />
              <input
                id="wiki-search"
                name="q"
                type="search"
                placeholder={
                  zh ? "搜索文档、指南与更多…" : "Search documentation…"
                }
                defaultValue={data.searchQuery}
                maxLength={200}
              />
              <button type="submit" aria-label={zh ? "搜索" : "Search"}>
                <Icon name="arrow" />
              </button>
            </form>
          </search>
          <div className="header-actions">
            <nav
              className="language-switch"
              aria-label={zh ? "页面语言" : "Page language"}
            >
              {(["zh", "en"] as const).map((language) =>
                data.translations[language] ? (
                  <a
                    key={language}
                    href={data.translations[language]}
                    lang={language}
                    hrefLang={language}
                    aria-current={
                      data.language === language ? "true" : undefined
                    }
                  >
                    {language === "zh" ? "中文" : "English"}
                  </a>
                ) : (
                  <span
                    key={language}
                    lang={language}
                    className="translation-unavailable"
                    title={zh ? "暂无此语言版本" : "Translation unavailable"}
                  >
                    {language === "zh" ? "中文" : "English"}
                    <span className="sr-only">
                      {zh ? "（暂无翻译）" : " (translation unavailable)"}
                    </span>
                  </span>
                ),
              )}
            </nav>
            <span className="header-divider" aria-hidden="true" />
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={zh ? "切换明暗主题" : "Switch color theme"}
              title={zh ? "切换明暗主题" : "Switch color theme"}
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} />
            </button>
          </div>
        </div>
      </header>
      <div className="reader-layout">
        <aside className="desktop-navigation">
          <div className="sidebar-sticky">
            <p className="sidebar-label">{zh ? "文档目录" : "DOCUMENTATION"}</p>
            <nav aria-label={zh ? "文档导航" : "Documentation navigation"}>
              <Navigation entries={data.navigation} path={currentPath} />
            </nav>
            <div className="sidebar-note">
              <span className="status-dot" aria-hidden="true" />
              <span>
                {zh ? "公开文档 · 测试环境" : "Public wiki · Test environment"}
              </span>
            </div>
          </div>
        </aside>
        <div className="reading-column">
          <details className="mobile-navigation">
            <summary>
              <Icon name="menu" />
              <span>{zh ? "浏览文档" : "Browse documentation"}</span>
              <Icon name="chevron" />
            </summary>
            <nav
              aria-label={
                zh ? "移动端文档导航" : "Mobile documentation navigation"
              }
            >
              <Navigation entries={data.navigation} path={currentPath} />
            </nav>
          </details>
          <main id="main-content" className={`article-main ${data.mode}`}>
            <nav
              className="breadcrumbs"
              aria-label={zh ? "面包屑导航" : "Breadcrumb"}
            >
              <a
                href={home}
                aria-label={zh ? "文档首页" : "Documentation home"}
              >
                <Icon name="book" />
              </a>
              {breadcrumb.map((part, index) => (
                <span
                  className="breadcrumb-part"
                  key={breadcrumb.slice(0, index + 1).join("/")}
                >
                  <Icon name="chevron" />
                  <span
                    aria-current={
                      index === breadcrumb.length - 1 ? "page" : undefined
                    }
                  >
                    {part}
                  </span>
                </span>
              ))}
            </nav>
            {data.mode === "article" && data.page && data.rendered ? (
              <article>
                <header className="article-header">
                  <p className="article-kicker">
                    {zh ? "EMBY WIKI · 文档" : "EMBY WIKI · DOCUMENTATION"}
                  </p>
                  <h1>{data.page.title}</h1>
                  <p className="article-description">{data.page.description}</p>
                  <div className="article-meta">
                    <span>
                      <Icon name="clock" />
                      {zh ? "更新于" : "Updated"}{" "}
                      <time dateTime={data.page.updatedAt}>
                        {formatUpdated(data.page, zh)}
                      </time>
                    </span>
                    <span className="meta-separator" aria-hidden="true">
                      ·
                    </span>
                    <span>{zh ? "中文" : "English"}</span>
                  </div>
                </header>
                {/* The shared server renderer sanitizes final HTML with an explicit allowlist after all Markdown transformations. */}
                <div
                  ref={articleRef}
                  className="markdown-content"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: only shared renderer sanitized HTML reaches this sink, never Markdown source.
                  dangerouslySetInnerHTML={{ __html: data.rendered.html }}
                />
                <footer className="article-footer">
                  {data.page.tags.length > 0 && (
                    <ul
                      className="article-tags"
                      aria-label={zh ? "文章标签" : "Article tags"}
                    >
                      {data.page.tags.map((tag) => (
                        <li key={tag}>{tag}</li>
                      ))}
                    </ul>
                  )}
                  <a className="back-top" href="#main-content">
                    {zh ? "返回顶部" : "Back to top"}
                    <span aria-hidden="true">↑</span>
                  </a>
                </footer>
                {(previous || next) && (
                  <nav
                    className="page-pagination"
                    aria-label={zh ? "相邻文档" : "Adjacent pages"}
                  >
                    {previous ? (
                      <a className="previous-page" href={previous.path}>
                        <small>← {zh ? "上一篇" : "Previous"}</small>
                        <span>{previous.title}</span>
                      </a>
                    ) : (
                      <span />
                    )}
                    {next && (
                      <a className="next-page" href={next.path}>
                        <small>{zh ? "下一篇" : "Next"} →</small>
                        <span>{next.title}</span>
                      </a>
                    )}
                  </nav>
                )}
              </article>
            ) : data.mode === "search" ? (
              <section className="search-page" aria-labelledby="search-title">
                <p className="article-kicker">
                  {zh ? "在知识中寻找答案" : "FIND YOUR NEXT ANSWER"}
                </p>
                <h1 id="search-title">{title}</h1>
                <p className="article-description">
                  {data.searchQuery
                    ? zh
                      ? `“${data.searchQuery}” 的搜索结果`
                      : `Results for “${data.searchQuery}”`
                    : zh
                      ? "输入关键词，搜索标题、正文、路径和标签。"
                      : "Search by title, content, path, or tag."}
                </p>
                {data.searchQuery && (
                  <p className="search-result-count">
                    {zh
                      ? `找到 ${data.searchResults.length} 篇文档`
                      : `${data.searchResults.length} ${data.searchResults.length === 1 ? "document" : "documents"} found`}
                  </p>
                )}
                <ul className="search-results">
                  {data.searchResults.map((result) => (
                    <li key={result.path}>
                      <a href={result.path}>
                        <span className="result-path">{result.path}</span>
                        <h2>
                          {result.title}
                          <Icon name="arrow" />
                        </h2>
                        <p>{result.excerpt || result.description}</p>
                        {result.tags.length > 0 && (
                          <div className="result-tags">
                            {result.tags.map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
                {data.searchQuery && data.searchResults.length === 0 && (
                  <div className="empty-search">
                    <Icon name="search" />
                    <h2>
                      {zh
                        ? "暂时没有找到匹配的文档"
                        : "No matching documents yet"}
                    </h2>
                    <p>
                      {zh
                        ? "试试更简短的关键词，或者通过左侧目录继续浏览。"
                        : "Try a shorter search term, or explore the documentation using the navigation."}
                    </p>
                    <a href={home}>
                      {zh ? "返回文档首页" : "Explore the documentation"}
                      <Icon name="arrow" />
                    </a>
                  </div>
                )}
              </section>
            ) : (
              <section
                className="not-found-page"
                aria-labelledby="not-found-title"
              >
                <span className="not-found-code">404</span>
                <p className="article-kicker">
                  {zh ? "这条路径还没有答案" : "A LITTLE OFF THE MAP"}
                </p>
                <h1 id="not-found-title">{title}</h1>
                <p className="article-description">
                  {zh
                    ? "页面可能已移动，或这个语言版本尚未发布。你可以搜索所需内容，也可以从文档首页重新开始。"
                    : "The page may have moved, or this translation is not published yet. Search for what you need, or start again from the documentation home."}
                </p>
                <a className="primary-link" href={home}>
                  {zh ? "返回文档首页" : "Back to documentation"}
                  <Icon name="arrow" />
                </a>
              </section>
            )}
            <footer className="site-footer">
              <span>Emby Wiki</span>
              <span>
                {zh
                  ? "让知识清晰，让阅读简单。"
                  : "Clear knowledge. Considered reading."}
              </span>
            </footer>
          </main>
        </div>
        <aside className="table-of-contents">
          {data.mode === "article" && Boolean(data.rendered?.toc.length) && (
            <nav
              className="toc-sticky"
              aria-label={zh ? "本页目录" : "On this page"}
            >
              <p className="sidebar-label">
                {zh ? "本页内容" : "ON THIS PAGE"}
              </p>
              <ul>
                {data.rendered?.toc.map((heading) => (
                  <li key={heading.id} data-depth={heading.depth}>
                    <a
                      href={`#${heading.id}`}
                      aria-current={
                        activeHeading === heading.id ? "location" : undefined
                      }
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
              <a className="toc-top" href="#main-content">
                {zh ? "返回顶部" : "Back to top"} ↑
              </a>
            </nav>
          )}
        </aside>
      </div>
      <dialog
        className="image-dialog"
        ref={imageDialogRef}
        onClose={() => setSelectedImage(null)}
        aria-label={zh ? "图片预览" : "Image preview"}
      >
        <form method="dialog">
          <button type="submit" aria-label={zh ? "关闭预览" : "Close preview"}>
            <Icon name="close" />
          </button>
        </form>
        {selectedImage && (
          <>
            <img src={selectedImage.src} alt={selectedImage.alt} />
            <p>{selectedImage.alt}</p>
          </>
        )}
      </dialog>
    </>
  );
}
