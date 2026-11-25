# Delorun 文档网站

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

本包构建 Delorun 的文档网站：以静态站点的形式提供中英文的用户指南和参考资料，站点基于 TanStack Start 上的 Fumadocs 构建。站点直接读取 [`delorun/docs/guide/`](../../docs/guide/README.zh.md) 和 [`delorun/docs/reference/`](../../docs/reference/README.zh.md) 下的每一对页面，不复制任何页面。站点是一个独立的私有工作区，拥有自己的锁文件，因此不属于仓库的根工作区。

## 路由

| 路由 | 提供的内容 |
| --- | --- |
| `/` | 首页，链接到两个部分；已汇编版本时，还以“新内容”展示最新版本 |
| `/guide`、`/guide/<页面>` | 英文的用户指南 |
| `/reference`、`/reference/<页面>` | 英文的参考资料 |
| `/changelog` | 更新日志：与上游版本的常驻对比，随后是每个已汇编版本（最新在前）；没有已汇编版本时不存在 |
| `/zh/...` | 同样的路由，中文版；没有中文对应页的页面显示其英文文本 |
| `/llms.mdx/<部分>/<页面>` 和 `/zh/llms.mdx/...` | 每个页面的 Markdown 版本。部分的索引页为 `/llms.mdx/<部分>/index`，目录的索引页为 `/llms.mdx/<部分>/<目录>/index` |
| `/llms.txt`、`/zh/llms.txt` | 每种语言页面的索引，链接到它们的 Markdown 版本 |
| `/sitemap.xml`、`/robots.txt` | 两种语言所有页面的站点地图，由构建写出；以及 `public/` 中指向它的 robots 文件 |
| `/search.json` | 两种语言所有页面的搜索索引，由搜索对话框下载 |
| `/404` | 地址没有对应文件时，主机通过 `404.html` 提供的页面 |

页面的英文路由与中文路由是同一个 slug 加上语言前缀。某一语言的页面链接到同一语言的对应页面：中文页面中指向 `trust.md` 的链接会变为它的中文路由。

## 链接

页面中的每个相对链接都在构建时解析。遇到指向不存在文件的链接，构建失败。

- 指向已发布页面的链接变为该页面的路由。
- 指向仓库顶层文件（例如 `SECURITY.md`、`GOVERNANCE.md` 或 `AGENTS.md`）的链接变为它在 Delorun 的 GitHub 仓库中的 URL：那些是项目自己的文件，上游没有它们，或以另一种形式拥有它们。
- 指向上游仓库文件的链接变为它在 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 中的 URL。
- 指向其他 Delorun 文件（例如契约或威胁模型）的链接变为写明该文件名的代码文本，因为站点只发布用户指南和参考资料。
- 中文页面按位置采用英文页面的标题 id，使目录链接在两种语言中都能解析；这些链接由成对的一致性记录固定。

构建之后运行死链接检查。它检查构建生成的 HTML，以及 Markdown 和 `llms.txt` 文件中的每个内部链接和片段，确认其指向已构建的文件，或该页面上的某个 id。它不抓取外部链接。

## 版本

每个页面都标明它描述的 Delorun 版本：下文更新日志记录中最新的版本。没有记录时，页面不标明版本。

## 更新日志

更新日志页面和首页的“新内容”部分在构建时由 Delorun 的更新日志记录 `delorun/changelog/changelog.json` 生成，发布工具在汇编版本时写入该记录。构建使用 [`delorun/apps/release/src/changelog/data.ts`](../release/src/changelog/data.ts) 的类型和函数读取该记录，这些函数同样渲染 `CHANGELOG.md` 和发布说明，因此站点与这些文件陈述相同的条目。站点从不读取未发布的片段：版本汇编后才会出现。中文页面使用中文标题和标签，条目为英文。

没有记录时构建仍然成功，并省略该页面、其预渲染文件和首页部分。要在版本汇编之前审阅站点，请把未发布的片段写成仓库之外的预览记录，并用它构建；第一条命令在仓库根目录运行。不会移动任何文件，输出也从不提交：

```sh
node_modules/.bin/tsx delorun/apps/docs/scripts/preview-record.ts 0.1.0 /tmp/docs-preview/changelog.json
(cd delorun/apps && DOCS_CHANGELOG_PREVIEW=/tmp/docs-preview/changelog.json pnpm --dir docs run build)
```

`DOCS_CHANGELOG_PREVIEW` 指定要发布的记录，以替代仓库中的记录；文件不存在时构建失败。

## 主题

站点的外观来自 [`delorun/packages/site-design`](../../packages/site-design/src/tokens.css)，本站点和[产品网站](../website/README.zh.md)按路径以 `@design/*` 导入：设计令牌、页脚、Delorun 标志和变更记录视图。其文件不读取任何页面、标签或站点设置；每个站点传入自己的文本和链接。[`src/theme/header.ts`](src/theme/header.ts) 中的页眉留在本站点，因为它适配 Fumadocs 的布局选项。

## 命令

在仓库根目录运行，使用 `.nvmrc` 指定的 Node 主版本。

```sh
(cd delorun/apps && pnpm --dir docs install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delorun/apps && pnpm --dir docs run build)                  # builds into out/, typechecks the site and runs the dead-link check
(cd delorun/apps && pnpm --dir docs run dev)                    # serves the site for local work
(cd delorun/apps && pnpm --dir docs run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

本地检查 `pnpm check` 在变更涉及站点、其页面或发布版本时，将构建作为 `docs-site` 检查运行。在安装命令成功执行之前，该检查拒绝运行。

## 部署

构建输出是静态目录 `out/`：上表中的每个路由都是预渲染的文件，构建之后站点不运行任何服务器代码。页面路由是位于其目录旁的 HTML 文件，例如 `guide/` 旁的 `guide.html`，因此主机用 `guide.html` 提供 `/guide`。站点地址 `https://docs.delorun.com`（每个页面将其作为规范 URL）以及导航栏链接的产品站点，都在 [`src/site/config.ts`](src/site/config.ts) 中设置。

在浏览器中，指向其他页面的链接会用构建写入 `out/assets/` 的页面数据渲染该页面，搜索也在浏览器中查询 `/search.json`，因此两者都不请求服务器。站点在构建期间不发出任何网络请求，不加载远程字体或脚本，也不发送遥测。

[`alchemy.run.ts`](alchemy.run.ts) 用 Alchemy 把 `out/` 部署为只含静态资源的 Cloudflare Worker：Alchemy 运行站点的构建并上传其输出，而站点的构建不依赖 Alchemy。`prod` 阶段把 `docs.delorun.com` 作为 Workers 自定义域名挂接到现有的 `delorun.com` 区域，由 Cloudflare 创建其 DNS 记录和证书；其他阶段只有各自的 `workers.dev` 地址。地址没有对应文件时，Cloudflare 以状态码 404 提供 `404.html`。[`public/_headers`](public/_headers) 由构建复制到 `out/`，它设置安全响应头、`/assets/` 中带哈希文件的长期缓存，以及 Markdown 路由的 `text/markdown; charset=utf-8` 类型。

在 `delorun/apps/docs` 中运行部署命令：

```sh
pnpm exec alchemy profile edit --add Cloudflare   # once per machine: sign in to the Cloudflare account
pnpm exec alchemy state bootstrap                 # once per account: create the state store that Cloudflare.state() uses
pnpm exec alchemy plan --stage prod               # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage prod             # builds the site and publishes it at docs.delorun.com
pnpm exec alchemy destroy --stage <stage>         # deletes a stage's Worker and its custom domain
pnpm run typecheck:deploy                         # typechecks alchemy.run.ts
```

在工作站上，如果账户还没有状态存储，第一次 `plan` 或 `deploy` 也会创建它；设置 `CI=true` 时，缺少状态存储会使运行失败，因此需先在工作站上执行一次初始化。状态存储是一个带 Durable Object 的 Worker，其令牌和加密密钥保存在账户的 Secrets Store 中。

部署作业使用 `CLOUDFLARE_ACCOUNT_ID` 和一个限定于 Delorun 账户的 `CLOUDFLARE_API_TOKEN` 进行认证，该令牌需要以下权限：账户级的 `Workers Scripts Write`（Worker、其静态资源、其 `workers.dev` 地址和自定义域名）和 `Secrets Store Write`（读取状态存储的凭据，Alchemy 通过把它们绑定到一个短暂存在的预览 Worker 来读取），以及仅限 `delorun.com` 区域的 `Zone Read`（Alchemy 按名称查找该区域）和 `Workers Routes Read`（Alchemy 读取该区域的 Worker 路由）。`pnpm exec alchemy provider check-env` 会在部署开始前报告缺少的变量。该令牌只能放在一个在默认分支上运行、处于受保护环境且需要指定审核人的部署作业中，任何拉取请求工作流都无法读取其密钥；它从不提交到仓库，也从不提供给拉取请求的构建。

## 配对

本 README 有其中文对应文件。`README.zh.md` 保存中文文本，`README.i18n.yaml` 是一致性记录；每次修改任一侧后，用 `pnpm run verify-translation-pairing --write delorun/apps/docs/README.md` 重新记录。
