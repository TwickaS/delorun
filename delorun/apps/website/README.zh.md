# Delorun 产品网站

[English](README.md) | 中文

本包构建 delorun.com，即 Delorun 的产品站点：主页、隐私页和未找到页面，是基于 TanStack Start 的静态站点，并有一个接收发布消息订阅的小型 Worker。文档在[文档站点](../docs/README.zh.md)，各页面链接到它。该站点是私有工作区，有自己的锁文件，因此在仓库根工作区之外。

## 路由

| 路由 | 内容 |
| --- | --- |
| `/` | Delorun 是什么、安装命令、第一个设置问题，以及六个各链接一页指南的简短小节；已有汇编版本时，还有来自变更记录的“最新动态”小节 |
| `/privacy` | 站点收集什么、主机记录什么，以及程序发送的内容该去哪里阅读 |
| `/404` | 主机在没有对应文件的地址上从 `404.html` 提供的页面 |
| `POST /api/subscribe` | 接收订阅表单：校验表单，对连接限速，用 Siteverify 验证 Turnstile 令牌，然后保存或刷新一条 `pending` 记录。每次被接受的订阅都得到相同的回答，无论该地址是否已知 |
| `GET /api/signup-config` | Turnstile 站点密钥，表单在访客首次使用时获取 |
| `GET /confirm?token=` | 一个带按钮的页面；`POST /confirm` 确认该地址。因此邮件扫描器打开链接不能替任何人确认 |
| `GET /unsubscribe?token=` | 立即退订。`POST /unsubscribe?token=` 为邮件程序的一键 `List-Unsubscribe-Post` 做同样的事。两者都是幂等的 |

静态文件来自 `out/`；只有这四个订阅路由会到达 Worker（[`alchemy.run.ts`](alchemy.run.ts) 中的 `runWorkerFirst`）。Worker 在 [`src/worker`](src/worker/routes.ts)，订阅表单是 [`src/components/signup.tsx`](src/components/signup.tsx)。

## 发布消息订阅

每个阶段都有自己的 D1 数据库 `delorun-website-<stage>-subscribers`，在 Alchemy 部署时由 [`migrations/0001_subscribers.sql`](migrations/0001_subscribers.sql) 创建。表 `subscribers` 保存 `email`（唯一，不区分大小写）、`first_name`、同意记录（`consent_at`、`consent_page`、`consent_text_version`）、`status`（`pending`、`confirmed` 或 `unsubscribed`）、确认令牌和退订令牌的 SHA-256 哈希、`confirmed_at`、`confirmation_sent_at` 以及两个时间戳。它不保存 IP 地址、浏览器信息或原始令牌。

- 新地址为 `pending`。只有确认链接能使其变为 `confirmed`，之后的再次订阅不会改变已确认的记录。已退订的地址作为屏蔽记录保留；再次订阅会使其变为 `pending`。
- 每个待确认地址每小时最多收到一封新的确认邮件。
- 每日定时任务（UTC `17 03 * * *`）删除同意时间超过 30 天的 `pending` 记录，并在发送开启时，向尚未收到确认邮件的待确认记录发送确认邮件。令牌以哈希形式保存，因此该任务会签发新令牌。
- 发送使用 Cloudflare Email Service 的 `send_email` 绑定，发件地址为 `updates@delorun.com`，回复地址为 `support@delorun.com`，并带有 `List-Unsubscribe` 头。标志 `WEBSITE_CONFIRMATION_EMAIL`（`on` 或 `off`）决定绑定是否存在以及是否发送；未设置时，`prod` 阶段为 `on`，其他阶段均为 `off`。`prod` 以外的阶段若开启发送，还需设置 `WEBSITE_PUBLIC_ORIGIN`，即邮件中链接使用的来源。关闭时，订阅保持 `pending`，不发送任何邮件。
- 速率限制使用 Cloudflare 的速率限制绑定，每个连接每分钟五次订阅。Worker 不保存该地址。

要列出可以发送邮件的人，请在本目录中运行，并为持有该数据库的账户设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`：

```sh
node scripts/export-subscribers.ts --stage prod > subscribers.csv  # email, first_name, confirmed_at of every confirmed subscriber
```

该脚本通过 `wrangler d1 execute` 只读取 `confirmed` 行。它的测试与 Worker 的测试一起位于 `tests/`，随仓库的单元测试运行；测试使用内存中的 SQLite 和真实的迁移，不发送任何邮件。

## 设计

设计令牌、Delorun 标志、页脚和变更记录视图位于 [`delorun/packages/site-design`](../../packages/site-design/src/tokens.css)，本站点和文档站点按路径导入（`tsconfig.json` 中的 `@design/*`）。该目录没有 `package.json`：每个站点都是有自己锁文件的独立工作区，都无法安装工作区包。每个站点的 `vite.config.ts` 把设计中的 `fumadocs-ui/css/` 导入指向自己的安装。

站点跟随设备的浅色或深色设置。它不加载远程字体或脚本，也不设置 cookie。

## 命令

在仓库根目录运行，使用 `.nvmrc` 固定的 Node 主版本。

```sh
(cd delorun/apps && pnpm --dir website install --frozen-lockfile)  # installs the site's dependencies from its own lockfile
(cd delorun/apps && pnpm --dir website run build)                  # builds into out/, typechecks the site and runs the dead-link check
(cd delorun/apps && pnpm --dir website run preview)                # serves the built out/ on 127.0.0.1:4173 as a static host would
```

当改动涉及本站点、共享设计或变更记录时，本地检查 `pnpm check` 会把构建作为 `website-site` 检查运行。`scripts/og.html` 是链接预览图 `public/og.png` 的源文件。

## 部署

[`alchemy.run.ts`](alchemy.run.ts) 用 Alchemy 把 `out/` 部署为带静态资源的 Cloudflare Worker，并带有该阶段的 D1 数据库、一个 Turnstile 小组件、一个速率限制器，以及发送开启时的邮件绑定（[文档站点的部署步骤](../docs/README.zh.md#deployment)）。Turnstile 在 `prod` 阶段覆盖 `delorun.com`，在其他阶段覆盖 `workers.dev`。`prod` 阶段绑定 `delorun.com`；其他阶段只有 `workers.dev` 地址。[`public/_headers`](public/_headers) 设置安全头，并为 `/assets/` 中带哈希的文件设置长期缓存。

```sh
pnpm exec alchemy plan --stage <stage>    # shows what a deploy would change, changing nothing
pnpm exec alchemy deploy --stage <stage>  # builds the site and publishes it
pnpm run typecheck:deploy                 # typechecks alchemy.run.ts
```

## 配对

本 README 有中文配对文件。`README.zh.md` 保存中文文本，`README.i18n.yaml` 是一致性记录，每次修改任一侧后用 `pnpm run verify-translation-pairing --write delorun/apps/website/README.md` 重新记录。
