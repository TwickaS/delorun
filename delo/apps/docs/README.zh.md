# Delo 文档网站

[English](README.md) | 中文

本包构建 Delo 的文档网站：以静态站点的形式提供中英文的用户指南和参考资料。站点直接读取 [`delo/docs/guide/`](../../docs/guide/README.zh.md) 和 [`delo/docs/reference/`](../../docs/reference/README.zh.md) 下的每一对页面，不复制任何页面。站点是一个独立的私有工作区，拥有自己的锁文件，因此不属于仓库的根工作区。

## 路由

| 路由 | 提供的内容 |
| --- | --- |
| `/` | 首页，链接到两个部分 |
| `/guide`、`/guide/<页面>` | 英文的用户指南 |
| `/reference`、`/reference/<页面>` | 英文的参考资料 |
| `/zh/...` | 同样的路由，中文版，适用于每个有中文对应页的页面 |
| `/llms.mdx/<部分>/<页面>` 和 `/zh/llms.mdx/...` | 每个页面的 Markdown 版本。部分的索引页为 `/llms.mdx/<部分>/index`，目录的索引页为 `/llms.mdx/<部分>/<目录>/index` |
| `/llms.txt`、`/zh/llms.txt` | 每种语言页面的索引，链接到它们的 Markdown 版本 |

页面的英文路由与中文路由是同一个 slug 加上语言前缀。某一语言的页面链接到同一语言的对应页面：中文页面中指向 `trust.md` 的链接会变为它的中文路由。

## 链接

页面中的每个相对链接都在构建时解析。遇到指向不存在文件的链接，构建失败。

- 指向已发布页面的链接变为该页面的路由。
- 指向上游仓库文件的链接变为它在 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 中的 URL。
- 指向其他 Delo 文件（例如契约或威胁模型）的链接变为写明该文件名的代码文本，因为站点只发布用户指南和参考资料。
- 中文页面按位置采用英文页面的标题 id，使目录链接在两种语言中都能解析；这些链接由成对的一致性记录固定。

构建之后运行死链接检查。它检查构建生成的 HTML，以及 Markdown 和 `llms.txt` 文件中的每个内部链接和片段，确认其指向已构建的文件，或该页面上的某个 id。它不抓取外部链接。

## 版本

每个页面都标明它描述的 Delo 版本。版本从 [`delo/apps/release/package.json`](../release/package.json) 读取，这是站点唯一引用的来源。

## 命令

在仓库根目录运行，使用 `.nvmrc` 指定的 Node 主版本。

```sh
(cd delo/apps && pnpm --dir docs install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delo/apps && pnpm --dir docs run build)                  # builds into out/ and runs the dead-link check
(cd delo/apps && pnpm --dir docs run dev)                    # serves the site for local work
```

本地检查 `pnpm check` 在变更涉及站点、其页面或发布版本时，将构建作为 `docs-site` 检查运行。在安装命令成功执行之前，该检查拒绝运行。

## 部署

构建输出是静态目录 `out/`。本包不负责部署、不配置主机，也不设置域名。部署方案确定后，主机必须以 `text/markdown; charset=utf-8` 提供 Markdown 路由，这些路由没有文件扩展名。

站点在构建期间不发出任何网络请求，也不加载远程字体或脚本。构建时关闭遥测（`NEXT_TELEMETRY_DISABLED=1`）。搜索功能尚未包含，搜索控件处于禁用状态。

## 配对

本 README 有其中文对应文件。`README.zh.md` 保存中文文本，`README.i18n.yaml` 是一致性记录；每次修改任一侧后，用 `pnpm run verify-translation-pairing --write delo/apps/docs/README.md` 重新记录。
