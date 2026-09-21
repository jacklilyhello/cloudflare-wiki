export function App() {
  return (
    <main>
      <p className="eyebrow">EMBY WIKI / TEST ENVIRONMENT</p>
      <h1>Cloudflare Wiki</h1>
      <p className="intro">工程基础已就绪。</p>
      <p lang="en">A small beginning for a better documentation experience.</p>
      <section aria-label="测试环境说明">
        <span className="badge">测试环境 · Test only</span>
        <h2>cf.emby.wiki</h2>
        <p>
          这是全新项目的初始化页面。Wiki 阅读、Markdown
          编辑与后台管理将在后续开发。
        </p>
        <p lang="en">
          The public wiki and single-administrator CMS are planned for a later
          phase.
        </p>
        <a href="/health">
          查看健康检查 / Health check <span aria-hidden="true">↗</span>
        </a>
      </section>
      <footer>中文 + English · Cloudflare Native</footer>
    </main>
  );
}
