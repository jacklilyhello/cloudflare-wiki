import { type MouseEvent, type PointerEvent, useEffect, useState } from "react";
import type { Language } from "../shared/contracts";
import type { ReaderData } from "../shared/reader";
import { Icon } from "./components/Icon";
import { SiteLogo } from "./components/SiteLogo";
import { ThemeToggle } from "./components/ThemeToggle";

export function LandingPage({ data }: { data: ReaderData }) {
  const [language, setLanguage] = useState(data.language);
  const [tilt, setTilt] = useState("center");
  const zh = language === "zh";
  const identity = data.settings.locales[language];
  const otherLanguage = zh ? "en" : "zh";

  useEffect(() => {
    document.documentElement.lang = language;
    const title = `${identity.name} · ${language === "zh" ? "Emby 技术手册" : "The Emby Handbook"}`;
    document.title = title;
    for (const [selector, content] of [
      ['meta[name="description"]', identity.description],
      ['meta[property="og:title"]', title],
      ['meta[property="og:description"]', identity.description],
      ['meta[property="og:locale"]', zh ? "zh_CN" : "en_US"],
      ['meta[property="og:locale:alternate"]', zh ? "en_US" : "zh_CN"],
    ] as const) {
      const meta = document.querySelector<HTMLMetaElement>(selector);
      if (meta) meta.content = content;
    }
  }, [identity, language, zh]);

  function chooseLanguage(
    event: MouseEvent<HTMLAnchorElement>,
    next: Language,
  ) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    // The URL also works without JavaScript and keeps the choice on refresh.
    window.history.replaceState(null, "", `/?lang=${next}`);
    setLanguage(next);
  }

  function moveCover(event: PointerEvent<HTMLDivElement>) {
    if (
      event.pointerType !== "mouse" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width;
    setTilt(position < 0.35 ? "left" : position > 0.65 ? "right" : "center");
  }

  return (
    <div className="landing-page">
      <a className="skip-link" href="#cover-content">
        {zh ? "跳转到阅读入口" : "Skip to reading options"}
      </a>
      <header className="cover-header">
        <a className="cover-brand" href="/" aria-label={identity.name}>
          <SiteLogo logo={data.settings.logo} branding={data.branding} />
          <span>{identity.name}</span>
        </a>
        <div className="cover-header-end">
          <span className="cover-header-note" lang="en">
            THE EMBY HANDBOOK
          </span>
          <ThemeToggle settings={data.settings} language={language} />
        </div>
      </header>

      <main id="cover-content" className="cover-stage" tabIndex={-1}>
        <div className="cover-atmosphere" aria-hidden="true">
          <div className="cover-light" />
          <div className="cover-screen cover-screen-left">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="cover-screen cover-screen-right">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="cover-horizon" />
        </div>
        <div className="cover-margin cover-margin-left" aria-hidden="true">
          <span className="cover-index">01 —</span>
          <span>{zh ? "一本关于 Emby 的" : "A field guide to"}</span>
          <strong>{zh ? "现代技术手册" : "your media world."}</strong>
          <span className="cover-margin-rule" />
          <small lang="en">FEATURES / CONFIGURATION / EVERYDAY USE</small>
        </div>
        <div className="cover-margin cover-margin-right" aria-hidden="true">
          <span lang="en">YOUR MEDIA.</span>
          <span lang="en">YOUR WAY.</span>
        </div>

        <div className="cover-book-space">
          <div
            className="cover-book"
            data-tilt={tilt}
            onPointerMove={moveCover}
            onPointerLeave={() => setTilt("center")}
          >
            <div className="cover-spine" aria-hidden="true">
              <span>{identity.name}</span>
              <small lang="en">THE EMBY HANDBOOK</small>
            </div>
            <section className="cover-face" aria-labelledby="cover-title">
              <div className="cover-landscape" aria-hidden="true">
                <svg
                  viewBox="0 0 480 260"
                  fill="none"
                  focusable="false"
                  aria-hidden="true"
                >
                  <path
                    className="cover-ridge-far"
                    d="m0 166 50-36 32 14 61-65 48 36 45-23 65 64 41-47 54 26 84-73v168H0Z"
                  />
                  <path
                    className="cover-ridge-near"
                    d="m0 215 65-59 41 20 66-29 74 60 54-35 54 23 43-38 83 68v35H0Z"
                  />
                  <path
                    className="cover-water"
                    d="M0 234c100-12 173 12 265 0s139-8 215-2M0 245c108-11 156 8 249-1s164-9 231 1M0 254c155-7 292 5 480-1"
                  />
                </svg>
              </div>
              <p className="cover-edition" lang="en">
                THE EMBY HANDBOOK
              </p>
              <SiteLogo
                className="cover-logo"
                logo={data.settings.logo}
                branding={data.branding}
              />
              <h1 id="cover-title">{identity.name}</h1>
              <p className="cover-description" lang={language}>
                {identity.description}
              </p>
              <p className="cover-description-alt" lang={otherLanguage}>
                {data.settings.locales[otherLanguage].description}
              </p>
              <p className="cover-invitation">
                <span aria-hidden="true" />
                {zh
                  ? "开卷，探索你的媒体世界"
                  : "Open a new chapter in your media world"}
                <span aria-hidden="true" />
              </p>
              <div className="cover-actions">
                <a
                  className="cover-continue"
                  href={`/${language}/home`}
                  hrefLang={language}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path fill="currentColor" d="m8 5 11 7-11 7Z" />
                  </svg>
                  <span>{zh ? "继续阅读" : "Continue"}</span>
                  <Icon name="arrow" />
                </a>
                <nav
                  className="cover-languages"
                  aria-label={zh ? "阅读语言" : "Reading language"}
                >
                  {(["zh", "en"] as const).map((next) => (
                    <a
                      key={next}
                      href={`/?lang=${next}`}
                      lang={next}
                      hrefLang={next}
                      aria-current={language === next ? "true" : undefined}
                      onClick={(event) => chooseLanguage(event, next)}
                    >
                      {next === "zh" ? "中文" : "English"}
                    </a>
                  ))}
                </nav>
              </div>
            </section>
          </div>
        </div>
        <p className="cover-reading-note">
          <Icon name="book" />
          {zh ? "选择语言，继续阅读" : "Choose your language, then continue"}
        </p>
      </main>
      <footer className="cover-footer">
        <span>{data.branding?.locales[language]?.copyright}</span>
        <span lang="en">A little knowledge. A better media experience.</span>
      </footer>
    </div>
  );
}
