-- Original project documentation, published once on initial database creation.
-- Later edits belong to immutable revisions; this migration is never regenerated.

INSERT INTO pages (id,created_at) VALUES ('starter-home','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-home-zh','starter-home','zh','home','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-home-zh-r1','starter-home-zh',1,'Emby 技术文档','从清晰的文档开始，构建自己的媒体体验。','## 从这里开始

欢迎来到 Emby Wiki。这里用清晰的技术文档，记录媒体库的整理方法、服务配置和日常使用经验。

一篇好的文档应该让下一步变得简单：先说明目标，再列出条件，最后给出可以核对的结果。你可以通过左侧目录浏览，也可以直接搜索关键词。

> [!NOTE]
> 这是新站的测试环境。文档内容正在建设中，正式站点仍在 [emby.wiki](https://emby.wiki)。

## 找到需要的内容

| 想要做什么 | 从哪里开始 |
| --- | --- |
| 熟悉目录、搜索和语言切换 | [[guide/reading\|阅读指南]] |
| 查看代码、表格与技术文档格式 | [[guide/markdown\|Markdown 格式参考]] |
| 精确定位一段说明 | 使用本页右侧的内容目录 |

### 按目录浏览

左侧目录按主题组织。当前页面会高亮显示，所属目录会自动展开。窄屏上可以通过顶部的目录按钮打开导航。

### 按关键词查找

搜索覆盖标题、描述、正文、标签和路径。中文和英文分别显示当前语言的结果，便于在同一套文档中查找。

## 用你习惯的方式阅读

- **中文 / English**：同一篇文章的语言版本可以直接切换。
- **明暗主题**：跟随系统，也可以用右上角按钮切换。
- **代码复制**：代码块提供复制操作，保留原始换行。
- **标题链接**：每个章节都有稳定的链接，方便引用和分享。

## 文档约定

文档优先使用 Markdown，并将配置示例与说明放在一起。执行任何示例前，请先确认它适合你的环境；示例里的路径和名称需要按实际情况填写。

> [!TIP]
> 遇到较长的教程时，先浏览内容目录，再阅读每一步的前置条件和验证方法。
','["Emby","入门"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('zh','home','starter-home-zh','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-home-zh','zh','starter-home-zh-r1','Emby 技术文档','从清晰的文档开始，构建自己的媒体体验。','home','["Emby","入门"]','从这里开始 欢迎来到 Emby Wiki。这里用清晰的技术文档，记录媒体库的整理方法、服务配置和日常使用经验。 一篇好的文档应该让下一步变得简单：先说明目标，再列出条件，最后给出可以核对的结果。你可以通过左侧目录浏览，也可以直接搜索关键词。 [!NOTE] 这是新站的测试环境。文档内容正在建设中，正式站点仍在 emby.wiki 。 找到需要的内容 想要做什么 从哪里开始 熟悉目录、搜索和语言切换 阅读指南 查看代码、表格与技术文档格式 Markdown 格式参考 精确定位一段说明 使用本页右侧的内容目录 按目录浏览 左侧目录按主题组织。当前页面会高亮显示，所属目录会自动展开。窄屏上可以通过顶部的目录按钮打开导航。 按关键词查找 搜索覆盖标题、描述、正文、标签和路径。中文和英文分别显示当前语言的结果，便于在同一套文档中查找。 用你习惯的方式阅读 中文 / English ：同一篇文章的语言版本可以直接切换。 明暗主题 ：跟随系统，也可以用右上角按钮切换。 代码复制 ：代码块提供复制操作，保留原始换行。 标题链接 ：每个章节都有稳定的链接，方便引用和分享。 文档约定 文档优先使用 Markdown，并将配置示例与说明放在一起。执行任何示例前，请先确认它适合你的环境；示例里的路径和名称需要按实际情况填写。 [!TIP] 遇到较长的教程时，先浏览内容目录，再阅读每一步的前置条件和验证方法。');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'emby 技 术 文 档','emby 入 门','从 清 晰 的 文 档 开 始 , 构 建 自 己 的 媒 体 体 验 。','home','从 这 里 开 始 欢 迎 来 到 emby wiki。 这 里 用 清 晰 的 技 术 文 档 , 记 录 媒 体 库 的 整 理 方 法 、 服 务 配 置 和 日 常 使 用 经 验 。 一 篇 好 的 文 档 应 该 让 下 一 步 变 得 简 单 : 先 说 明 目 标 , 再 列 出 条 件 , 最 后 给 出 可 以 核 对 的 结 果 。 你 可 以 通 过 左 侧 目 录 浏 览 , 也 可 以 直 接 搜 索 关 键 词 。 [!note] 这 是 新 站 的 测 试 环 境 。 文 档 内 容 正 在 建 设 中 , 正 式 站 点 仍 在 emby.wiki 。 找 到 需 要 的 内 容 想 要 做 什 么 从 哪 里 开 始 熟 悉 目 录 、 搜 索 和 语 言 切 换 阅 读 指 南 查 看 代 码 、 表 格 与 技 术 文 档 格 式 markdown 格 式 参 考 精 确 定 位 一 段 说 明 使 用 本 页 右 侧 的 内 容 目 录 按 目 录 浏 览 左 侧 目 录 按 主 题 组 织 。 当 前 页 面 会 高 亮 显 示 , 所 属 目 录 会 自 动 展 开 。 窄 屏 上 可 以 通 过 顶 部 的 目 录 按 钮 打 开 导 航 。 按 关 键 词 查 找 搜 索 覆 盖 标 题 、 描 述 、 正 文 、 标 签 和 路 径 。 中 文 和 英 文 分 别 显 示 当 前 语 言 的 结 果 , 便 于 在 同 一 套 文 档 中 查 找 。 用 你 习 惯 的 方 式 阅 读 中 文 / english : 同 一 篇 文 章 的 语 言 版 本 可 以 直 接 切 换 。 明 暗 主 题 : 跟 随 系 统 , 也 可 以 用 右 上 角 按 钮 切 换 。 代 码 复 制 : 代 码 块 提 供 复 制 操 作 , 保 留 原 始 换 行 。 标 题 链 接 : 每 个 章 节 都 有 稳 定 的 链 接 , 方 便 引 用 和 分 享 。 文 档 约 定 文 档 优 先 使 用 markdown, 并 将 配 置 示 例 与 说 明 放 在 一 起 。 执 行 任 何 示 例 前 , 请 先 确 认 它 适 合 你 的 环 境 ; 示 例 里 的 路 径 和 名 称 需 要 按 实 际 情 况 填 写 。 [!tip] 遇 到 较 长 的 教 程 时 , 先 浏 览 内 容 目 录 , 再 阅 读 每 一 步 的 前 置 条 件 和 验 证 方 法 。' FROM published_search WHERE translation_id='starter-home-zh';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-home-zh-r1',published_revision_id='starter-home-zh-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-home-zh';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-home-zh-initial-publication','starter-home-zh','publish',1,'starter-home-zh-r1','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-home-en','starter-home','en','home','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-home-en-r1','starter-home-en',1,'Emby documentation','Clear documentation for your media experience.','## Start here

Welcome to Emby Wiki. This documentation space brings together clear notes about organizing a media library, configuring services, and everyday use.

A useful guide makes the next step clear: explain the goal, list the prerequisites, and show how to check the result. Browse the navigation or search for a keyword to get started.

> [!NOTE]
> This is the new site''s test environment. Documentation is being built; the existing public site remains at [emby.wiki](https://emby.wiki).

## Find what you need

| Your goal | Start with |
| --- | --- |
| Learn navigation, search, and language switching | [[guide/reading\|Reading guide]] |
| Explore code blocks, tables, and document formats | [[guide/markdown\|Markdown reference]] |
| Jump to a specific section | Use the contents on the right |

### Browse by topic

The left navigation groups documents by topic. Your current page is highlighted and its folder opens automatically. On smaller screens, use the navigation button in the header.

### Search by keyword

Search covers titles, descriptions, body text, tags, and paths. Results stay in the selected language so that Chinese and English documentation remain easy to navigate.

## Make yourself at home

- **中文 / English** switches between translations of the same article.
- **Light and dark themes** follow your system until you choose a preference.
- **Copy code** preserves the original lines in a code block.
- **Heading links** let you share a specific section.

## Documentation conventions

Articles use Markdown and keep configuration examples beside their explanations. Check that an example fits your environment before running it; replace example paths and names with your own values.

> [!TIP]
> For a long guide, scan the contents first, then read each step''s prerequisites and verification instructions.
','["Emby","getting started"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('en','home','starter-home-en','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-home-en','en','starter-home-en-r1','Emby documentation','Clear documentation for your media experience.','home','["Emby","getting started"]','Start here Welcome to Emby Wiki. This documentation space brings together clear notes about organizing a media library, configuring services, and everyday use. A useful guide makes the next step clear: explain the goal, list the prerequisites, and show how to check the result. Browse the navigation or search for a keyword to get started. [!NOTE] This is the new site''s test environment. Documentation is being built; the existing public site remains at emby.wiki . Find what you need Your goal Start with Learn navigation, search, and language switching Reading guide Explore code blocks, tables, and document formats Markdown reference Jump to a specific section Use the contents on the right Browse by topic The left navigation groups documents by topic. Your current page is highlighted and its folder opens automatically. On smaller screens, use the navigation button in the header. Search by keyword Search covers titles, descriptions, body text, tags, and paths. Results stay in the selected language so that Chinese and English documentation remain easy to navigate. Make yourself at home 中文 / English switches between translations of the same article. Light and dark themes follow your system until you choose a preference. Copy code preserves the original lines in a code block. Heading links let you share a specific section. Documentation conventions Articles use Markdown and keep configuration examples beside their explanations. Check that an example fits your environment before running it; replace example paths and names with your own values. [!TIP] For a long guide, scan the contents first, then read each step''s prerequisites and verification instructions.');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'emby documentation','emby getting started','clear documentation for your media experience.','home','start here welcome to emby wiki. this documentation space brings together clear notes about organizing a media library, configuring services, and everyday use. a useful guide makes the next step clear: explain the goal, list the prerequisites, and show how to check the result. browse the navigation or search for a keyword to get started. [!note] this is the new site''s test environment. documentation is being built; the existing public site remains at emby.wiki . find what you need your goal start with learn navigation, search, and language switching reading guide explore code blocks, tables, and document formats markdown reference jump to a specific section use the contents on the right browse by topic the left navigation groups documents by topic. your current page is highlighted and its folder opens automatically. on smaller screens, use the navigation button in the header. search by keyword search covers titles, descriptions, body text, tags, and paths. results stay in the selected language so that chinese and english documentation remain easy to navigate. make yourself at home 中 文 / english switches between translations of the same article. light and dark themes follow your system until you choose a preference. copy code preserves the original lines in a code block. heading links let you share a specific section. documentation conventions articles use markdown and keep configuration examples beside their explanations. check that an example fits your environment before running it; replace example paths and names with your own values. [!tip] for a long guide, scan the contents first, then read each step''s prerequisites and verification instructions.' FROM published_search WHERE translation_id='starter-home-en';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-home-en-r1',published_revision_id='starter-home-en-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-home-en';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-home-en-initial-publication','starter-home-en','publish',1,'starter-home-en-r1','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO pages (id,created_at) VALUES ('starter-reading','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-reading-zh','starter-reading','zh','guide/reading','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-reading-zh-r1','starter-reading-zh',1,'阅读指南','快速找到内容，用你习惯的方式阅读。','## 浏览目录

文档地址由语言和路径组成，例如 `/zh/guide/reading`。左侧目录展示当前语言的文档。点击目录标题可以展开或收起一组文章。

当前页面的上方有面包屑导航，右侧有由文章标题生成的内容目录。移动端会将主要阅读区域留给正文。

## 搜索文档

在顶部输入关键词，按 Enter 查看结果。结果会显示页面标题、描述和命中的正文片段。

可以试试 `Markdown`、`代码` 或 `guide`。标题和标签匹配的结果会优先显示，正文也可被搜索。

## 切换语言

右上角的 **中文 / English** 对应同一篇文章的翻译。如果文章没有另一种语言的版本，界面会明确提示该版本不可用。

## 复制与分享

将鼠标移到代码块上，使用复制按钮复制纯文本。复制失败时仍可直接选中文本。

```json
{
  "example": "replace-with-your-value",
  "enabled": true
}
```

文章标题旁的链接可以直接跳到某一节。图片可以打开大图查看；公开附件的下载链接会保留在正文中。

## 无障碍阅读

使用 Tab 可以依次访问搜索、语言切换、导航和正文链接。页面顶部的跳转链接可以直接进入正文。主题按钮会记住你的选择。

> [!TIP]
> 阅读时不需要注册或登录。
','["指南","导航","搜索"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('zh','guide/reading','starter-reading-zh','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-reading-zh','zh','starter-reading-zh-r1','阅读指南','快速找到内容，用你习惯的方式阅读。','guide/reading','["指南","导航","搜索"]','浏览目录 文档地址由语言和路径组成，例如 /zh/guide/reading 。左侧目录展示当前语言的文档。点击目录标题可以展开或收起一组文章。 当前页面的上方有面包屑导航，右侧有由文章标题生成的内容目录。移动端会将主要阅读区域留给正文。 搜索文档 在顶部输入关键词，按 Enter 查看结果。结果会显示页面标题、描述和命中的正文片段。 可以试试 Markdown 、 代码 或 guide 。标题和标签匹配的结果会优先显示，正文也可被搜索。 切换语言 右上角的 中文 / English 对应同一篇文章的翻译。如果文章没有另一种语言的版本，界面会明确提示该版本不可用。 复制与分享 将鼠标移到代码块上，使用复制按钮复制纯文本。复制失败时仍可直接选中文本。 { "example": "replace-with-your-value", "enabled": true } 文章标题旁的链接可以直接跳到某一节。图片可以打开大图查看；公开附件的下载链接会保留在正文中。 无障碍阅读 使用 Tab 可以依次访问搜索、语言切换、导航和正文链接。页面顶部的跳转链接可以直接进入正文。主题按钮会记住你的选择。 [!TIP] 阅读时不需要注册或登录。');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'阅 读 指 南','指 南 导 航 搜 索','快 速 找 到 内 容 , 用 你 习 惯 的 方 式 阅 读 。','guide/reading','浏 览 目 录 文 档 地 址 由 语 言 和 路 径 组 成 , 例 如 /zh/guide/reading 。 左 侧 目 录 展 示 当 前 语 言 的 文 档 。 点 击 目 录 标 题 可 以 展 开 或 收 起 一 组 文 章 。 当 前 页 面 的 上 方 有 面 包 屑 导 航 , 右 侧 有 由 文 章 标 题 生 成 的 内 容 目 录 。 移 动 端 会 将 主 要 阅 读 区 域 留 给 正 文 。 搜 索 文 档 在 顶 部 输 入 关 键 词 , 按 enter 查 看 结 果 。 结 果 会 显 示 页 面 标 题 、 描 述 和 命 中 的 正 文 片 段 。 可 以 试 试 markdown 、 代 码 或 guide 。 标 题 和 标 签 匹 配 的 结 果 会 优 先 显 示 , 正 文 也 可 被 搜 索 。 切 换 语 言 右 上 角 的 中 文 / english 对 应 同 一 篇 文 章 的 翻 译 。 如 果 文 章 没 有 另 一 种 语 言 的 版 本 , 界 面 会 明 确 提 示 该 版 本 不 可 用 。 复 制 与 分 享 将 鼠 标 移 到 代 码 块 上 , 使 用 复 制 按 钮 复 制 纯 文 本 。 复 制 失 败 时 仍 可 直 接 选 中 文 本 。 { "example": "replace-with-your-value", "enabled": true } 文 章 标 题 旁 的 链 接 可 以 直 接 跳 到 某 一 节 。 图 片 可 以 打 开 大 图 查 看 ; 公 开 附 件 的 下 载 链 接 会 保 留 在 正 文 中 。 无 障 碍 阅 读 使 用 tab 可 以 依 次 访 问 搜 索 、 语 言 切 换 、 导 航 和 正 文 链 接 。 页 面 顶 部 的 跳 转 链 接 可 以 直 接 进 入 正 文 。 主 题 按 钮 会 记 住 你 的 选 择 。 [!tip] 阅 读 时 不 需 要 注 册 或 登 录 。' FROM published_search WHERE translation_id='starter-reading-zh';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-reading-zh-r1',published_revision_id='starter-reading-zh-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-reading-zh';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-reading-zh-initial-publication','starter-reading-zh','publish',1,'starter-reading-zh-r1','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-reading-en','starter-reading','en','guide/reading','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-reading-en-r1','starter-reading-en',1,'Reading guide','Find what you need and read your way.','## Browse the navigation

Document addresses contain a language and a path, such as `/en/guide/reading`. The navigation lists documents in your selected language. Select a folder heading to expand or collapse it.

Breadcrumbs appear above the article. The contents on the right come from the article headings. Small screens give the main reading area more space.

## Search the documentation

Enter keywords in the header and press Enter. Results show the title, description, and a matching excerpt.

Try `Markdown`, `code`, or `guide`. Matches in titles and tags rank above matches in the article body.

## Switch languages

Use **中文 / English** in the header to open a translation of the same article. If a translation is unavailable, the interface tells you explicitly.

## Copy and share

Use the copy button on a code block to copy its plain text. If clipboard access fails, you can still select the text yourself.

```json
{
  "example": "replace-with-your-value",
  "enabled": true
}
```

Heading links open a specific section. Images can be opened at a larger size, and public attachment links stay inside the article.

## Accessible reading

Use Tab to reach search, language controls, navigation, and article links. The skip link at the top goes directly to the content. The theme button remembers your choice.

> [!TIP]
> Reading never requires registration or login.
','["guide","navigation","search"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('en','guide/reading','starter-reading-en','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-reading-en','en','starter-reading-en-r1','Reading guide','Find what you need and read your way.','guide/reading','["guide","navigation","search"]','Browse the navigation Document addresses contain a language and a path, such as /en/guide/reading . The navigation lists documents in your selected language. Select a folder heading to expand or collapse it. Breadcrumbs appear above the article. The contents on the right come from the article headings. Small screens give the main reading area more space. Search the documentation Enter keywords in the header and press Enter. Results show the title, description, and a matching excerpt. Try Markdown , code , or guide . Matches in titles and tags rank above matches in the article body. Switch languages Use 中文 / English in the header to open a translation of the same article. If a translation is unavailable, the interface tells you explicitly. Copy and share Use the copy button on a code block to copy its plain text. If clipboard access fails, you can still select the text yourself. { "example": "replace-with-your-value", "enabled": true } Heading links open a specific section. Images can be opened at a larger size, and public attachment links stay inside the article. Accessible reading Use Tab to reach search, language controls, navigation, and article links. The skip link at the top goes directly to the content. The theme button remembers your choice. [!TIP] Reading never requires registration or login.');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'reading guide','guide navigation search','find what you need and read your way.','guide/reading','browse the navigation document addresses contain a language and a path, such as /en/guide/reading . the navigation lists documents in your selected language. select a folder heading to expand or collapse it. breadcrumbs appear above the article. the contents on the right come from the article headings. small screens give the main reading area more space. search the documentation enter keywords in the header and press enter. results show the title, description, and a matching excerpt. try markdown , code , or guide . matches in titles and tags rank above matches in the article body. switch languages use 中 文 / english in the header to open a translation of the same article. if a translation is unavailable, the interface tells you explicitly. copy and share use the copy button on a code block to copy its plain text. if clipboard access fails, you can still select the text yourself. { "example": "replace-with-your-value", "enabled": true } heading links open a specific section. images can be opened at a larger size, and public attachment links stay inside the article. accessible reading use tab to reach search, language controls, navigation, and article links. the skip link at the top goes directly to the content. the theme button remembers your choice. [!tip] reading never requires registration or login.' FROM published_search WHERE translation_id='starter-reading-en';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-reading-en-r1',published_revision_id='starter-reading-en-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-reading-en';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-reading-en-initial-publication','starter-reading-en','publish',1,'starter-reading-en-r1','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO pages (id,created_at) VALUES ('starter-markdown','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-markdown-zh','starter-markdown','zh','guide/markdown','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-markdown-zh-r1','starter-markdown-zh',1,'Markdown 格式参考','代码、表格、公式与图表，让技术说明更清晰。','## 文本与列表

Markdown 将内容和结构保存在可读的纯文本中。你可以使用 **加粗**、*强调*、~~删除线~~，也可以写行内代码 `library.json`。

- 将一个步骤写成一个段落。
- 把配置示例放在相关说明旁边。
- 用标题描述每一节要解决的问题。

任务列表用于展示检查步骤：

- [x] 阅读前置条件
- [x] 检查配置示例
- [ ] 在自己的环境中验证

## 代码与表格

代码块可以指定语言。复制按钮只复制代码本身。

```json
{
  "library": "example-library",
  "folders": ["/path/to/media"],
  "enabled": true
}
```

| 格式 | 用途 |
| :--- | :--- |
| 行内代码 | 字段、文件名和短命令 |
| 代码块 | 完整配置或多行示例 |
| 表格 | 对比参数、选项和结果 |

## 提示与折叠内容

> [!NOTE]
> 提示用于补充背景信息，不应藏起完成操作所必需的步骤。

> [!WARNING]
> 执行修改前，先核对目标路径并保留可恢复的备份。

<details><summary>展开查看文档建议</summary>

每个教程都应明确说明目的、前提和验证结果。

</details>

## 链接和脚注

用内部链接回到 [[home|文档首页]]，或查看 [[guide/reading|阅读指南]]。脚注适合放置补充说明。[^note]

[^note]: 脚注会显示在文章底部，并提供返回正文的链接。

## 数学表达式

行内公式：$a^2 + b^2 = c^2$。

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

## 流程图

Mermaid 可以描述一个简单的处理流程。

```mermaid
flowchart LR
  A[准备] --> B[配置]
  B --> C[验证]
```

## 分组示例

:::tabs
::tab[配置]
把配置和说明保存在同一篇文档中。

::tab[验证]
记录一个可以重复的验证步骤。
:::
','["Markdown","格式","代码","语法"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('zh','guide/markdown','starter-markdown-zh','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-markdown-zh','zh','starter-markdown-zh-r1','Markdown 格式参考','代码、表格、公式与图表，让技术说明更清晰。','guide/markdown','["Markdown","格式","代码","语法"]','文本与列表 Markdown 将内容和结构保存在可读的纯文本中。你可以使用 加粗 、 强调 、 删除线 ，也可以写行内代码 library.json 。 将一个步骤写成一个段落。 把配置示例放在相关说明旁边。 用标题描述每一节要解决的问题。 任务列表用于展示检查步骤： 阅读前置条件 检查配置示例 在自己的环境中验证 代码与表格 代码块可以指定语言。复制按钮只复制代码本身。 { "library": "example-library", "folders": ["/path/to/media"], "enabled": true } 格式 用途 行内代码 字段、文件名和短命令 代码块 完整配置或多行示例 表格 对比参数、选项和结果 提示与折叠内容 [!NOTE] 提示用于补充背景信息，不应藏起完成操作所必需的步骤。 [!WARNING] 执行修改前，先核对目标路径并保留可恢复的备份。 展开查看文档建议 每个教程都应明确说明目的、前提和验证结果。 链接和脚注 用内部链接回到 文档首页，或查看 阅读指南。脚注适合放置补充说明。 脚注会显示在文章底部，并提供返回正文的链接。 数学表达式 行内公式： a^2 + b^2 = c^2 。 \sum_{i=1}^{n} i = \frac{n(n+1)}{2} 流程图 Mermaid 可以描述一个简单的处理流程。 flowchart LR A[准备] --> B[配置] B --> C[验证] 分组示例 配置 把配置和说明保存在同一篇文档中。 验证 记录一个可以重复的验证步骤。');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'markdown 格 式 参 考','markdown 格 式 代 码 语 法','代 码 、 表 格 、 公 式 与 图 表 , 让 技 术 说 明 更 清 晰 。','guide/markdown','文 本 与 列 表 markdown 将 内 容 和 结 构 保 存 在 可 读 的 纯 文 本 中 。 你 可 以 使 用 加 粗 、 强 调 、 删 除 线 , 也 可 以 写 行 内 代 码 library.json 。 将 一 个 步 骤 写 成 一 个 段 落 。 把 配 置 示 例 放 在 相 关 说 明 旁 边 。 用 标 题 描 述 每 一 节 要 解 决 的 问 题 。 任 务 列 表 用 于 展 示 检 查 步 骤 : 阅 读 前 置 条 件 检 查 配 置 示 例 在 自 己 的 环 境 中 验 证 代 码 与 表 格 代 码 块 可 以 指 定 语 言 。 复 制 按 钮 只 复 制 代 码 本 身 。 { "library": "example-library", "folders": ["/path/to/media"], "enabled": true } 格 式 用 途 行 内 代 码 字 段 、 文 件 名 和 短 命 令 代 码 块 完 整 配 置 或 多 行 示 例 表 格 对 比 参 数 、 选 项 和 结 果 提 示 与 折 叠 内 容 [!note] 提 示 用 于 补 充 背 景 信 息 , 不 应 藏 起 完 成 操 作 所 必 需 的 步 骤 。 [!warning] 执 行 修 改 前 , 先 核 对 目 标 路 径 并 保 留 可 恢 复 的 备 份 。 展 开 查 看 文 档 建 议 每 个 教 程 都 应 明 确 说 明 目 的 、 前 提 和 验 证 结 果 。 链 接 和 脚 注 用 内 部 链 接 回 到 文 档 首 页 , 或 查 看 阅 读 指 南 。 脚 注 适 合 放 置 补 充 说 明 。 脚 注 会 显 示 在 文 章 底 部 , 并 提 供 返 回 正 文 的 链 接 。 数 学 表 达 式 行 内 公 式 : a^2 + b^2 = c^2 。 \sum_{i=1}^{n} i = \frac{n(n+1)}{2} 流 程 图 mermaid 可 以 描 述 一 个 简 单 的 处 理 流 程 。 flowchart lr a[ 准 备 ] --> b[ 配 置 ] b --> c[ 验 证 ] 分 组 示 例 配 置 把 配 置 和 说 明 保 存 在 同 一 篇 文 档 中 。 验 证 记 录 一 个 可 以 重 复 的 验 证 步 骤 。' FROM published_search WHERE translation_id='starter-markdown-zh';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-markdown-zh-r1',published_revision_id='starter-markdown-zh-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-markdown-zh';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-markdown-zh-initial-publication','starter-markdown-zh','publish',1,'starter-markdown-zh-r1','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_translations (id,page_id,language,slug,created_at,updated_at) VALUES ('starter-markdown-en','starter-markdown','en','guide/markdown','2026-09-21T00:00:00.000Z','2026-09-21T00:00:00.000Z');

INSERT INTO page_revisions (id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES ('starter-markdown-en-r1','starter-markdown-en',1,'Markdown reference','Code, tables, mathematics, and diagrams for clear technical writing.','## Text and lists

Markdown keeps content and structure in readable plain text. Use **bold**, *emphasis*, ~~strikethrough~~, and inline code such as `library.json`.

- Keep one step in each paragraph.
- Put configuration examples beside their explanations.
- Give each section a heading that describes its purpose.

Task lists communicate verification steps:

- [x] Read the prerequisites
- [x] Review the configuration example
- [ ] Verify in your own environment

## Code and tables

Code blocks can specify a language. The copy button copies only the code.

```json
{
  "library": "example-library",
  "folders": ["/path/to/media"],
  "enabled": true
}
```

| Format | Purpose |
| :--- | :--- |
| Inline code | Fields, filenames, and short commands |
| Code block | Complete configuration or multiline examples |
| Table | Compare parameters, options, and results |

## Callouts and disclosure

> [!NOTE]
> A note adds context. Keep essential steps in the main flow of a guide.

> [!WARNING]
> Check the target path and keep a recoverable backup before making changes.

<details><summary>Show a documentation tip</summary>

A guide should explain its goal, prerequisites, and verification steps.

</details>

## Links and footnotes

Return to the [[home|documentation home]] or open the [[guide/reading|reading guide]]. Use footnotes for supporting information.[^note]

[^note]: Footnotes appear at the end of the article with a link back to the reference.

## Mathematics

Inline formula: $a^2 + b^2 = c^2$.

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

## Diagrams

Mermaid describes a simple process as text.

```mermaid
flowchart LR
  A[Prepare] --> B[Configure]
  B --> C[Verify]
```

## Grouped examples

:::tabs
::tab[Configuration]
Keep the configuration and explanation in the same document.

::tab[Verification]
Describe a repeatable verification step.
:::
','["Markdown","format","code","syntax"]','Initial documentation','2026-09-21T00:00:00.000Z');

INSERT INTO page_routes (language,path,translation_id,created_at) VALUES ('en','guide/markdown','starter-markdown-en','2026-09-21T00:00:00.000Z');

INSERT INTO published_search (translation_id,language,revision_id,title,description,path,tags_json,body_text) VALUES ('starter-markdown-en','en','starter-markdown-en-r1','Markdown reference','Code, tables, mathematics, and diagrams for clear technical writing.','guide/markdown','["Markdown","format","code","syntax"]','Text and lists Markdown keeps content and structure in readable plain text. Use bold , emphasis , strikethrough , and inline code such as library.json . Keep one step in each paragraph. Put configuration examples beside their explanations. Give each section a heading that describes its purpose. Task lists communicate verification steps: Read the prerequisites Review the configuration example Verify in your own environment Code and tables Code blocks can specify a language. The copy button copies only the code. { "library": "example-library", "folders": ["/path/to/media"], "enabled": true } Format Purpose Inline code Fields, filenames, and short commands Code block Complete configuration or multiline examples Table Compare parameters, options, and results Callouts and disclosure [!NOTE] A note adds context. Keep essential steps in the main flow of a guide. [!WARNING] Check the target path and keep a recoverable backup before making changes. Show a documentation tip A guide should explain its goal, prerequisites, and verification steps. Links and footnotes Return to the documentation home or open the reading guide. Use footnotes for supporting information. Footnotes appear at the end of the article with a link back to the reference. Mathematics Inline formula: a^2 + b^2 = c^2 . \sum_{i=1}^{n} i = \frac{n(n+1)}{2} Diagrams Mermaid describes a simple process as text. flowchart LR A[Prepare] --> B[Configure] B --> C[Verify] Grouped examples Configuration Keep the configuration and explanation in the same document. Verification Describe a repeatable verification step.');

INSERT INTO published_search_fts (rowid,translation_id,language,title,tags,description,path,body) SELECT rowid,translation_id,language,'markdown reference','markdown format code syntax','code, tables, mathematics, and diagrams for clear technical writing.','guide/markdown','text and lists markdown keeps content and structure in readable plain text. use bold , emphasis , strikethrough , and inline code such as library.json . keep one step in each paragraph. put configuration examples beside their explanations. give each section a heading that describes its purpose. task lists communicate verification steps: read the prerequisites review the configuration example verify in your own environment code and tables code blocks can specify a language. the copy button copies only the code. { "library": "example-library", "folders": ["/path/to/media"], "enabled": true } format purpose inline code fields, filenames, and short commands code block complete configuration or multiline examples table compare parameters, options, and results callouts and disclosure [!note] a note adds context. keep essential steps in the main flow of a guide. [!warning] check the target path and keep a recoverable backup before making changes. show a documentation tip a guide should explain its goal, prerequisites, and verification steps. links and footnotes return to the documentation home or open the reading guide. use footnotes for supporting information. footnotes appear at the end of the article with a link back to the reference. mathematics inline formula: a^2 + b^2 = c^2 . \sum_{i=1}^{n} i = \frac{n(n+1)}{2} diagrams mermaid describes a simple process as text. flowchart lr a[prepare] --> b[configure] b --> c[verify] grouped examples configuration keep the configuration and explanation in the same document. verification describe a repeatable verification step.' FROM published_search WHERE translation_id='starter-markdown-en';

UPDATE page_translations SET write_version=1,revision_seq=1,draft_revision_id='starter-markdown-en-r1',published_revision_id='starter-markdown-en-r1',published_at='2026-09-21T00:00:00.000Z' WHERE id='starter-markdown-en';

INSERT INTO page_events (id,translation_id,event_type,version,revision_id,change_note,created_at) VALUES ('starter-markdown-en-initial-publication','starter-markdown-en','publish',1,'starter-markdown-en-r1','Initial documentation','2026-09-21T00:00:00.000Z');
