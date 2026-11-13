# Delorun 产品网站

[English](README.md) | 中文

本包构建 delorun.com，即 Delorun 的产品站点：主页、隐私页和未找到页面，是基于 TanStack Start 的静态站点。文档在[文档站点](../docs/README.zh.md)，各页面链接到它。该站点是私有工作区，有自己的锁文件，因此在仓库根工作区之外。

## 路由

| 路由 | 内容 |
| --- | --- |
| `/` | Delorun 是什么、安装命令、第一个设置问题，以及六个各链接一页指南的简短小节；已有汇编版本时，还有来自变更记录的“最新动态”小节 |
| `/privacy` | 站点收集什么、主机记录什么，以及程序发送的内容该去哪里阅读 |
| `/404` | 主机在没有对应文件的地址上从 `404.html` 提供的页面 |

## 设计

设计令牌、Delorun 标志、页脚和变更记录视图位于 [`delo/packages/site-design`](../../packages/site-design/src/tokens.css)，本站点和文档站点按路径导入（`tsconfig.json` 中的 `@design/*`）。该目录没有 `package.json`：每个站点都是有自己锁文件的独立工作区，都无法安装工作区包。每个站点的 `vite.config.ts` 把设计中的 `fumadocs-ui/css/` 导入指向自己的安装。

站点跟随设备的浅色或深色设置。它不加载远程字体或脚本，也不设置 cookie。

## 命令

在仓库根目录运行，使用 `.nvmrc` 固定的 Node 主版本。

```sh
(cd delo/apps && pnpm --dir website install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delo/apps && pnpm --dir website run build)                  # builds into out/, typechecks the site and runs the dead-link check
(cd delo/apps && pnpm --dir website run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

当改动涉及本站点、共享设计或变更记录时，本地检查 `pnpm check` 会把构建作为 `website-site` 检查运行。`scripts/og.html` 是链接预览图 `public/og.png` 的源文件。

## 部署

[`alchemy.run.ts`](alchemy.run.ts) 与文档站点一样，用 Alchemy 把 `out/` 部署为仅含静态资源的 Cloudflare Worker（[其部署步骤](../docs/README.zh.md#deployment)）。`prod` 阶段绑定 `delorun.com`；其他阶段只有 `workers.dev` 地址。[`public/_headers`](public/_headers) 设置安全头，并为 `/assets/` 中带哈希的文件设置长期缓存。

```sh
pnpm exec alchemy plan --stage <stage>    # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage <stage>  # builds the site and publishes it
pnpm run typecheck:deploy                 # typechecks alchemy.run.ts
```

## 配对

本 README 有中文配对文件。`README.zh.md` 保存中文文本，`README.i18n.yaml` 是一致性记录，每次修改任一侧后用 `pnpm run verify-translation-pairing --write delo/apps/website/README.md` 重新记录。
