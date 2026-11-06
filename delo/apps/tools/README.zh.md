# Delo 工具

[English](README.md) | 中文

`@delo/tools` 是 Delo 的 fork 工具，一个位于 `delo/apps/tools` 的私有包。
它包含差异台账检查器：该检查器记录本树与其锁定的上游提交之间的每一处差异，并统计这些差异的数量。
它还包含对每项变更进行检查的门禁、提交标准，以及上游工作流的清单。
检查运行器 [`src/run-checks.ts`](src/run-checks.ts) 负责排序并运行这些门禁与下文所述的其他本地检查；本地 stack 以及其他 fork 工具将随后续工作包到达。

## 模块

- `src/fork-boundary.ts` 包含台账的 schema、fork 自有路径与 glob 的匹配器、边界错误以及差异汇总。
- `src/check-fork-boundary.ts` 是命令行门禁。它读取台账，依据台账检查本仓库，并在传入 `--count` 时打印差异数量。
- `src/check-commits.ts` 是提交标准：Conventional Commits 主题行、DCO 签名，以及一个变更片段或一行 `Changelog: none (<reason>)` 尾注。它以 `--message <file>` 检查单条消息，`commit-msg` 钩子即以这种方式调用它。
- `src/checks/types.ts` 与 `src/checks/gates/index.ts` 将每个门禁描述为检查运行器执行的一条命令。
- `src/checks/gates/` 包含门禁模块及其数据：许可证、密钥、个人数据、基础设施、DCO、文档时间以及文档检查。
- `src/check-jsdoc.ts` 将上游的 JSDoc 规则应用于 `delo/` 下的每个 `src` 树。
- `src/run-checks.ts` 是检查运行器：层级、选择与报告。
- `src/checks/` 包含检查目录（`plan.ts`）、调度器（`run.ts`）、机器预算（`machine.ts`）、通过缓存（`cache.ts`）与预算（`budgets.json`）。
- `src/git.ts` 为各模块运行 git，并报告退出状态。
- `src/issues/` 把维护者撰写的 brief 转为 GitHub Issue：`brief.ts` 包含字段、规则与 Issue 正文，`references.ts` 包含 brief 可以携带的链接与路径，`labels.ts` 包含标签文件，`gh.ts` 包含 `gh` 调用，`issues.ts` 为命令行。
- `tests/` 包含测试规范。台账规则在临时 git 仓库中运行。门禁规范在临时树中为每个门禁植入一处违规，文档规范则在植入违规的夹具树上运行上游脚本。`checks.spec.ts` 与 `checks-cache.spec.ts` 覆盖运行器的选择、层级、预算、通过缓存与 `--plan`。

## 差异台账

[`delo/upstream-patches.json`](../../upstream-patches.json) 记录本树与上游的差异。
`upstream.commit` 锁定上游提交，各项差异以它为基准计量。
`forkOwned` 列出 Delo 完全自有的路径与 glob。`*` 匹配单个路径段内的字符，`**` 跨路径段匹配。一条目覆盖它所匹配的路径，以及匹配目录之下的所有路径。
`patches` 列出 Delo 修改、新增或删除的每一个上游路径，并给出其 `class`（`delo-feature`、`generic-fix` 或 `security`）与 `reason`。
`retired` 列出上游已吸收其改动的条目。每项都写明吸收该改动的上游提交，以及该条目原有的差异块数。

以下情况下检查器失败：

- 台账无法解析，或某个 patch 缺少 class 或 reason；
- 锁定的提交不在本地克隆中，或不是 HEAD 的祖先；
- 吸收提交不在锁定提交的历史中；
- 某个上游路径与锁定提交不同，且既不属于 fork 自有范围，也未列入台账；
- 某个已列出的 patch 不再与锁定提交不同；
- 某个 retired 条目仍与锁定提交不同；
- fork 自有的目录中含有某个 TypeScript 源文件的编译产物。

`--count` 打印已列出条目及其差异块数。差异块是 `git diff --unified=0` 相对于锁定提交输出的一个 `@@` 头，未跟踪文件计为一个差异块。retired 条目被计入抵免并单独列出；它们不计入总数。

## 门禁

[`src/checks/gates/index.ts`](src/checks/gates/index.ts) 将每个门禁列为检查运行器从仓库根目录执行的一条命令。命令以 0 退出时，该门禁通过。暂存门禁在末尾接受路径参数，运行器在 pre-commit 时追加暂存的路径。范围门禁比较 `origin/v5` 至 HEAD 之间的提交，除非传入 `--base <rev>`。

| 门禁 | 暂存 | 拒绝或检查的内容 |
|---|---|---|
| `gates:licence` | 否 | `delo/` 下的每个包都声明 MIT，且根目录 `LICENSE` 为 MIT 许可证。 |
| `gates:secrets` | 是 | 形似令牌的字符串、私钥以及密钥文件名，依据 secretlint 的推荐预设与 DeepSeek 的密钥格式检查。上游逐字持有的行上的发现予以通过。 |
| `gates:personal-data` | 是 | 暂存改动与范围新增行中个人数据模式的加盐哈希，以及范围内各提交的 Author、Committer 与 Signed-off-by 行中的同类哈希；并依据形态检查这些行与提交信息中的邮政地址。邮政地址是同一行中的门牌号与街道词，其后同一行或下一行中出现完整的英国邮政编码，或美国州缩写与 ZIP 码。明文模式仅存于 `~/.config/delo/personal-data.txt`；`--rehash` 依该文件重新生成 [`personal-data.hashes.json`](src/checks/gates/personal-data.hashes.json)，文件不存在时以 1 退出。 |
| `gates:infrastructure` | 是 | 环回、未指定与广播地址、RFC 5737 文档地址段、云元数据地址 `169.254.169.254`，以及保留 IPv4 地址块的基地址（`10.0.0.0`、`100.64.0.0`、`169.254.0.0`、`172.16.0.0`、`192.168.0.0`、`224.0.0.0`）之外的 IPv4 地址；全局可路由或唯一本地地址块中，RFC 3849 文档地址段、云元数据地址 `fd00:ec2::254` 与基地址 `fc00::` 之外的 IPv6 地址；`example.ts.net` 之外的 tailnet 名称；以及云账户 ID。文档化的例外按路径与值列于 [`infrastructure.allowlist.json`](src/checks/gates/infrastructure.allowlist.json)。 |
| `gates:dco` | 否 | 范围内每个非合并提交都有一行 `Signed-off-by`，其姓名与邮箱即作者的姓名与邮箱。 |
| `gates:commits` | 否 | 对范围内的提交执行提交标准，包括变更片段规则。 |
| `gates:changelog` | 否 | 范围内改动产品文件的每个提交，都须在 `delo/changelog/unreleased/` 下添加变更片段，或带有附理由的 `Changelog: none` 尾注；其中每个片段都须能解析。 |
| `gates:doc-times` | 否 | 范围新增的 `delo/` 下 Markdown 文件中，任何一行都不得含有截止日期、季度、排期估计或时间承诺。 |
| `gates:docs` | 否 | 对 `delo/docs/` 执行上游的双语配对、字数预算、硬换行、相对链接与 TypeScript 代码块检查。 |

[门禁工作流](../../../.github/workflows/gates.yml)在拉取请求以及向 `v5` 和 `main` 的推送上运行每个门禁，并以每个拉取请求的基准或每次推送的前一个顶端作为范围。其个人数据步骤仅依据已提交的哈希，比对范围新增的行与提交元数据。

## 工作流

上游的工作流位于 [`.github/workflows`](../../../.github/workflows)。下表的每一行给出工作流的触发条件、其所需的 DeepSeek 资源，以及 Delo 的处置。**保留**表示该工作流在本仓库中运行，其中任何运行器路由都记录在台账条目中。**守卫**表示其作业带有 `if: github.repository == 'deepseek-ai/deepseek-harness'`，因而仅在上游仓库中运行；每个被守卫的文件在台账中都有一条 `delo-feature` 条目。Delo 自有的工作流是 [`gates.yml`](../../../.github/workflows/gates.yml)。

| 工作流 | 触发条件 | 需要 DeepSeek 的密钥或基础设施 | 处置 |
|---|---|---|---|
| `build-exe-for-python-sdk.yml` | `workflow_call`、`workflow_dispatch` | 用于已安装 wheel 真实 API 测试的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `build-exe-for-ssh-helper.yml` | `workflow_call`、`workflow_dispatch` | 无；使用 GitHub 托管的运行器 | 保留 |
| `build-preview-cloudflare.yml` | `pull_request` | Cloudflare Pages 与 Access 密钥（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`） | 守卫 |
| `ci-master.yml` | 向 `master` 推送、`workflow_dispatch` | 密钥 `DEEPSEEK_API_KEY_EXTERNAL`；自托管运行器 `dsh-win-ci` 与 `vm-backup` | 守卫 |
| `ci-python.yml` | `pull_request` | 已安装 wheel 测试所用的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `ci-windows.yml` | `pull_request` | 无需要；上游的运行器标签仅在上游仓库中适用（见下文说明） | 保留，已路由 |
| `ci.yml` | `pull_request` | 无需要；上游的运行器标签仅在上游仓库中适用（见下文说明） | 保留，已路由 |
| `cua-helper-package.yml` | `workflow_dispatch`、`workflow_call` | 带签名配置的自托管运行器 `dsh-mac-package-trial` | 守卫 |
| `desktop-publish.yml` | `workflow_dispatch` | 经 `DESKTOP_PUBLISH_RUNNERS` 的自托管运行器路由；环境 `desktop-test` 与 `desktop-production` | 守卫 |
| `docs-pages.yml` | `workflow_dispatch` | GitHub Pages 环境 `github-pages` 与 Blacksmith 运行器 | 守卫 |
| `e2e.yml` | `workflow_dispatch`、向 `main` 与 `master` 推送、`pull_request`、每晚的 `schedule` | 用于真实 DeepSeek API 的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `expected-filenames.yml` | `pull_request` | 无；使用 GitHub 托管的运行器 | 保留 |
| `issue-lifecycle.yml` | `issues`、`pull_request`、`pull_request_review` | GitHub App 密钥 `DSH_ISSUE_APP_PRIVATE_KEY` 与变量 `DSH_ISSUE_APP_CLIENT_ID`；上游的 issue 类型与字段 | 守卫 |
| `issue-policy.yml` | `pull_request`、`pull_request_review` | 同一 GitHub App 的密钥与变量 | 守卫 |
| `macos-intel-package.yml` | `workflow_dispatch` | 自托管运行器 `dsh-mac-package-trial`；签名与升级通道 | 守卫 |
| `macos-package.yml` | `workflow_dispatch` | 自托管运行器 `dsh-mac-package-trial`；签名与升级通道 | 守卫 |
| `node-addon-system-release.yml` | `workflow_dispatch` | 密钥 `NPM_TOKEN` 与环境 `npm-publish`，用于 `@deepseek-ai` 作用域 | 守卫 |
| `node-addon-system.yml` | 按路径的 `pull_request` 与向 `master` 的推送；`workflow_dispatch` | 无；使用 GitHub 托管的运行器 | 保留 |
| `pi-ai-provider-e2e.yml` | `workflow_dispatch` | 用于付费提供方调用的密钥 `ANTHROPIC_API_KEY_EXTERNAL` 与 `AZURE_OPENAI_API_KEY_EXTERNAL` | 守卫 |
| `pr-check-after-approve.yml` | `pull_request_target`、`pull_request_review` | GitHub App 密钥 `DSH_APPROVAL_APP_PRIVATE_KEY`；上游的 `Policy` 检查 | 守卫 |
| `pr-check-on-base-branch.yml` | 向 `master` 推送、`workflow_dispatch` | 密钥 `DSH_RECHECK_LABEL_TOKEN`；上游的 `deepseek-harness-check` 动作 | 守卫 |
| `pr-check-on-head-branch.yml` | `pull_request_target` | 上游的 `deepseek-harness-check` 动作；Blacksmith 运行器 | 守卫 |
| `publish-ssh-helper.yml` | `workflow_dispatch` | 为上游的 `dsh-v` 标签发布 GitHub Release | 守卫 |
| `python-release.yml` | `workflow_dispatch` | PyPI 环境 `pypi` 与 `pypi-runtime`；变量 `PYPI_PUBLISHER_REPOSITORY` 与 `PUBLIC_PYPI_RELEASE_ENABLED` | 守卫 |
| `release-publish.yml` | `workflow_dispatch` | 密钥 `NPM_TOKEN` 与环境 `npm-publish`，用于 `dsh` 发布序列 | 守卫 |
| `release-vendor-publish.yml` | `workflow_dispatch` | 密钥 `NPM_TOKEN` 与环境 `npm-publish`，用于 vendor 序列 | 守卫 |
| `release-vendor.yml` | `pull_request`、向 `master` 推送、`workflow_dispatch` | 无；打包不需要凭据。仅当故障切换变量被设置时才使用自托管路由 | 保留 |
| `release.yml` | `pull_request`、向 `master` 推送、`workflow_dispatch` | 无；打包不需要凭据。仅当故障切换变量被设置时才使用自托管路由 | 保留 |
| `sandbox.yml` | 向 `master` 推送 | 无；使用 GitHub 托管的镜像。其触发分支为 `master`，而 Delo 不使用该分支 | 保留 |
| `weighted-approval-review-event.yml` | `pull_request_review` | 无；记录 `weighted-approval` 所读取的审核事件 | 保留 |
| `weighted-approval.yml` | `pull_request_target`、`issue_comment`、`workflow_run` | GitHub App 密钥 `DSH_APPROVAL_APP_PRIVATE_KEY`；变量 `DSH_APPROVAL_APP_CLIENT_ID` 与 `DSH_APPROVAL_APP_SLUG` | 守卫 |
| `windows-package.yml` | `workflow_dispatch` | 带签名配置的自托管运行器 `dsh-win-package-trial` | 守卫 |

`ci.yml` 与 `ci-windows.yml` 不需要密钥，因此予以保留。每个作业都把上游的运行器表达式作为仅在上游仓库中适用的分支，那里仍使用 `dsh-ubuntu-24-04-16core` 与 `dsh-windows-2025-16core` 等 DeepSeek 运行器标签。其他仓库一律在 `ubuntu-latest` 或 `windows-latest` 上运行该作业，因此本仓库从不等待 DeepSeek 的运行器。两个文件各有一条 `delo-feature` 台账条目记录此路由。

`release.yml` 与 `release-vendor.yml` 中的自托管路由由 `github.repository == 'deepseek-harness/deepseek-harness'` 守卫，该名称所指的组织与台账中的上游仓库不同。该路由仅在故障切换变量被设置时才适用，Delo 不会进入该路由；守卫中的组织名称保持上游原有的写法。

## brief Issue

`src/issues/issues.ts` 把 briefs 文件转为 brief Issue。
briefs 文件是一个 JSON 数组，其中每个对象以字段标签保存 [brief 模板](../../../.agents/skills/delo-delegation/SKILL.md#write-the-brief)的十六个字段，另有 `title`、该 Issue 所带的 `labels` 以及 `milestone`。
Issue 表单 [`brief.yml`](../../../.github/ISSUE_TEMPLATE/brief.yml) 按相同顺序询问相同的字段，[`labels.yml`](../../../.github/labels.yml) 则定义标签。

在仓库根目录以以下三种模式之一运行该工具：

- `--input <briefs.json> --dry-run` 校验 briefs 并打印每个 Issue 的正文。
- `--input <briefs.json> --create --repo <owner/name>` 校验 briefs，并检查 `gh` 是否以该仓库维护者的身份登录。随后对每个 brief：创建 Issue 并将其锁定；若已存在同标题的 Issue，则在其未锁定时将其锁定，已锁定时跳过。
- `--sync-labels --repo <owner/name>` 以 `gh label create --force` 创建或更新 `labels.yml` 中的每个标签。

```sh
node_modules/.bin/tsx delo/apps/tools/src/issues/issues.ts --input delo/apps/tools/tests/issues/fixtures/briefs.valid.json --dry-run
```

任何问题都会在标准错误输出一行，并在任何 GitHub 调用之前以 1 退出。
brief 存在问题的情形如下：

- 字段缺失、为空或未知，或文件不是非空的 brief JSON 数组；
- `Model` 不是 Haiku 的 medium、high 或 max effort，也不是 Opus 的 medium 或 high effort，因此 Opus 的 max effort 会被拒绝；
- 链接既不是 github.com/Delo-Run/delo 或 docs.delorun.com 上的 `https://` URL，也不是仓库已跟踪的相对路径；
- 反引号中的路径（其首段为仓库的顶层目录）所指的文件或目录未被跟踪，但 `You own` 字段除外：该字段允许新文件或新目录，前提是其最近的已存在父目录已被跟踪；
- 文本提及私有计划目录 `delo/docs/plans/`，或提及以 `/home/`、`/Users/` 或 `~/` 开头的机器路径；
- 标签未在 `labels.yml` 中定义，标签中缺少 `brief`，或该 brief 带有属于拉取请求的 `kind/*` 标签；
- 字段向正文添加了 Markdown 标题，两个 brief 共用同一标题，或两个已有 Issue 共用某个 brief 的标题。

除 `You own` 之外，路径依据 `git ls-files` 检查，因此 brief 引用某个文件之前，该文件必须已加入 git 索引（暂存区）。
`You own` 中的新路径，若其在工作树中最近的已存在父目录未被跟踪，同样会被拒绝。
渲染后的正文会把每个已跟踪路径链接到公开仓库 `v5` 分支上的对应位置：文件链接到 `blob`，目录链接到 `tree`。
brief 中原有的链接也按同样方式改写。
运行命令的代码片段与围栏代码块保持原样。
在 `--create` 之前，先在仓库中创建标签与里程碑，因为 `gh issue create` 遇到仓库中未定义的标签或里程碑会失败。

已知限制：

- `gh` 2.45 没有设置 GitHub 内置 Issue Type 的参数，因此 `--create` 创建的 Issue 不带 Issue Type。
- 链接指向 `v5` 分支，因此只存在于 brief 自身分支上的路径，要等该分支合并后才能解析。
- 标题检查最多读取 1000 个 Issue，列表达到该数量时会拒绝运行。

`tests/issues/` 下的测试规范在临时仓库中运行该工具，并将假的 `gh` 置于 `PATH` 之首；没有任何规范会访问 GitHub。

## 本地检查

[`src/run-checks.ts`](src/run-checks.ts) 运行本地检查。检查目录位于 [`src/checks/plan.ts`](src/checks/plan.ts)，它按变更与包选择检查；[`src/checks/run.ts`](src/checks/run.ts) 在某个检查的依赖通过且所需的 CPU 与内存空闲后启动它；[`src/checks/machine.ts`](src/checks/machine.ts) 设定内存上限；[`src/checks/cache.ts`](src/checks/cache.ts) 为未变化的检查提供通过缓存。仓库门禁来自 [`src/checks/gates/index.ts`](src/checks/gates/index.ts)，预算来自 [`src/checks/budgets.json`](src/checks/budgets.json)。

每个检查都有预算（其峰值常驻内存与所用的 CPU，运行器将其控制在本次运行的上限之内）和层级（选中它的调用方式）：`pre-commit` 针对暂存路径运行，`changed` 按变更选择（即 `--changed` 与推送前钩子），`full` 为完整门禁。

| 检查 | 证明的内容 | 预算 | 层级 |
| --- | --- | --- | --- |
| `boundary` | 与上游的每处差异都属于 fork 自有，或是已列出的补丁（[`check-fork-boundary.ts`](src/check-fork-boundary.ts)） | 0.3 GiB，1 个 CPU | `changed`、`full` |
| `gates:*` | [`checks/gates/index.ts`](src/checks/gates/index.ts) 中的八个仓库门禁；标记为 `staged` 的门禁也在 `pre-commit` 中运行 | 每个 0.5 GiB，1 个 CPU | `changed`、`full`；标记为 staged 的门禁另含 `pre-commit` |
| `whitespace:staged` | 暂存的改动中没有空白错误（`git diff --cached --check`） | 0.1 GiB，1 个 CPU | `pre-commit` |
| `jsdoc` | 上游的 JSDoc 规则应用于 fork 每个 `src` 树中的所有导出（[`check-jsdoc.ts`](src/check-jsdoc.ts)） | 1.5 GiB，1 个 CPU | `changed`、`full` |
| `typecheck:upstream` | 上游的增量类型检查（`pnpm run typecheck`），fork 的程序所读取的声明由它提供 | 2.5 GiB，2 个 CPU | `changed`、`full` |
| `typecheck:delo:<program>` | 对每个 Delo tsconfig 运行 `tsc -p`，每个程序一个检查；`--only typecheck:delo` 选中全部 | 每个 1 GiB，1 个 CPU | `changed`、`full` |
| `build:artifacts` | 上游的运行时产物，仅当某个产物缺失或早于其源码时构建（`pnpm run build:artifacts`） | 4 GiB，4 个 CPU | `changed`、`full`，且仅在过期时 |
| `tests:fork` | `delo/apps/*/tests` 与 `delo/packages/*/tests` 下的每个规范（[`vitest.config.ts`](../../vitest.config.ts)） | 每个 worker 0.5 GiB | `changed`、`full` |
| `tests:snapshots` | 上游的无密钥录制会话回放（`pnpm run test:snapshot`） | 每个 worker 0.6 GiB，5 个 CPU，独占 | `changed`、`full` |
| `tests:upstream-changed` | 每个有变更的上游包的规范，以及在 150 个规范文件之内其直接依赖的规范（[上游的 `vitest.config.ts`](../../../vitest.config.ts)） | 每个 worker 0.6 GiB，至多 8 个 worker | `changed` |
| `generate:native` | 上游的原生系统插件（`pnpm run build:native-system`） | 1 GiB，2 个 CPU | 无：仅 `--only generate:native` |

`pre-commit` 层级在 5 秒预算内运行（见 `budgets.json`），运行超出预算时会报告。Docker 通道、构建后包的规范、文档站点、工作流检查与 Cordis 检查，将随需要它们的包一同到达。

在仓库根目录运行的命令：

```sh
pnpm check                       # --changed: what changed since v5, and the checks it needs
pnpm check:full                  # the full gate, with no pass cache
pnpm check -- --plan             # the selection with each reason, cache state, expected time and budget; runs nothing
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --list        # the whole catalogue
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only tests:fork
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts delo/apps/tools    # targets: that package's specs, and the typechecks of the packages that depend on it
```

选项：`--changed`、`--pre-commit` 与 `--pre-push` 各自选择一个层级，只能给出其一；`--base <ref>` 让 `--changed` 从另一个引用开始度量（默认 `v5`）；`--only` 与 `--skip` 接受检查 id 或分组（`boundary`、`gates`、`whitespace`、`docs`、`typecheck`、`tests`、`generate`），以逗号分隔；`--plan` 与 `--list` 只打印而不运行；`--no-cache` 跳过通过缓存；`--bail` 在第一个失败处停止；`--workers <n>` 设置 fork 规范套件的 worker 数；`--no-scope` 不在 systemd 用户作用域中运行。

声明了输入的检查，每个键只通过一次。键由以下内容构成：其输入文件的 git blob id 排序列表的 sha256（已跟踪且未修改的文件取其 blob id；已修改、已删除或未跟踪的文件取其内容哈希）、锁文件的 blob id、Node 与 pnpm 版本、命令、其预算条目，以及其列出的环境变量的取值。键相同的已存储通过结果会报告为 `cached pass (<键前缀>)`，该检查不再运行。以下情况下缓存关闭：`--no-cache`、`pnpm check:full`、带 `DELO_FULL_GATE=1` 的推送，以及设置了 `CI` 时。未声明输入的检查总是运行：回放、产物构建、原生插件与暂存的空白检查。

安装钩子时，在仓库根目录写入一行 `lefthook-local.yml`，内容为 `extends: [delo/lefthook.yml]`（Git 会忽略它），然后运行 `node scripts/install-lefthook.mjs`。`pre-commit` 钩子运行 `pre-commit` 层级。`pre-push` 钩子运行 `--pre-push`：自远程分支的最新提交以来的改动；对于新分支，则是自其与 `v5` 的合并基以来的改动。`DELO_PUSH_SKIP=<检查或分组>,… git push` 会跳过指定的检查，`DELO_FULL_GATE=1 git push` 运行完整门禁。`commit-msg` 钩子在 `check-commits.ts` 进入分支后运行它；在此之前该任务跳过。

报告与日志位于 `node_modules/.cache/delo-checks/` 下：`report.json` 记录每个检查的状态、是否由通过缓存提供、原因、日志、耗时与内存峰值；`logs/<check>.log` 保存完整输出；`pass/` 为通过缓存；`durations.json` 记录每个检查最近一次的耗时，用于安排下一次运行的顺序；`tsbuildinfo/` 保存增量类型检查的状态。机器范围的锁使第二次运行等待第一次结束。

账本检查单独运行为 `pnpm --filter @delo/tools check`。单个门禁用 `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/<name>.ts` 运行（如 `licence`），范围门禁接受 `--base <rev>`。规范用 `node_modules/.bin/vitest run --config delo/vitest.config.ts` 运行，本包的类型检查用 `node_modules/.bin/tsc -p delo/apps/tools/tsconfig.json --noEmit`。

[delo-dev-workflow 技能](../../../.agents/skills/delo-dev-workflow/SKILL.md)说明了何时运行各项检查。

## 与 rc.1 的对齐

本树已与 `dsh-v0.2.2-rc.1` 对齐，即台账所锁定的提交。
每行给出文件、其在上游处置报告中的处置编号、处置结果，以及保留或暂缓的内容。
暂缓的差异块等待拥有其功能的包；被引用对象指差异块所指名的标识符、包或路径。

- `pnpm-workspace.yaml`：处置编号 0，已应用，class 为 `security`。四个差异块全部保留：`delo/apps/*` 与 `delo/packages/*` 的 glob、`!delo/apps/docs` 排除项、passkey ASN.1 覆盖项，以及 `allowBuilds` 条目。
- `pnpm-lock.yaml`：没有处置条目。保留覆盖项的记录以及本包的 importer；在上游合并时通过 `pnpm install` 重新生成锁文件。
- `scripts/verify-export-jsdoc.ts`：处置编号 6，已应用。保留 scope 参数。
- `scripts/gen-third-party-notices.ts`：处置编号 235，部分应用。保留差异块 2 与 3，使声明生成器读取 pnpm 安装的成员，并跳过 pnpm 以 `!` 排除的成员。差异块 1 即 `ssh2` 的许可证覆盖项暂缓，留给引入 `ssh2` 的包；本树中没有任何包依赖它。
- `scripts/gen-third-party-notices.spec.ts`：处置编号 409，已应用。两个差异块全部保留。
- `scripts/verify-repository-references.ts`：处置编号 251，已窄化重新推导。保留对 `pnpm-lock.yaml` 的排除，以及对台账中锁定的 `upstream.commit` 字段的豁免。未带入更宽泛的 `delo/` 前缀，因此 `delo/` 下的其他文件仍会被扫描；也未带入对 `uv.lock` 的排除，因为上游自身的规范会扫描该文件。
- `scripts/verify-repository-references.spec.ts`：随处置编号 251 带入，两个用例覆盖上述豁免。
- `scripts/test-non-loopback-address.ts`：处置编号 449，重新推导。保留 link-local 排除与 IPv6 回环探测。导入这些探测的 Web e2e 文件 `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` 在此未作修改，因此在该文件完成对齐之前，新的 IPv6 回环探测在本树中没有调用方。
- `scripts/test-non-loopback-address.spec.ts`：处置编号 450，重新推导。两个差异块全部保留。
- `scripts/types/client-assets/index.d.ts`：处置编号 548，已应用。保留 `*.woff2` 声明。
- `ROADMAP.md`：由 Delo 的基线新增，没有处置条目。只有台账条目。

暂缓，未带入：

- `scripts/translation-pairing.manifest.json`（处置编号 250）：其 `delo/` 排除项会把配对门禁要求的 Delo 文档配对全部排除，门禁会把每一对都报告为违规。
- `scripts/verify-concrete-terms.ts`（处置编号 252）：其 `delo/apps/tools/catalogue/` 排除项指向本树中不存在的目录。
- `scripts/gen-cordis-catalog.ts`（处置编号 22）：七个差异块全部暂缓。差异块 1、2、3 与 7 分别是 doctor、pluginAudit、profile-history 与 config-editor 的行，依据被引用对象规则暂缓。差异块 4 指名 agent-team 类型 `TeamMemberModel`，差异块 6 指名 `PresetExtension`，差异块 5 指名 `ProjectionRegistrationListener`；这些在 rc.1 中均未定义。
- `scripts/type-equiv.manifest.json`（处置编号 101）：三个差异块全部暂缓。它们指名 agent-team 类型 `TeamMessageView`、`TeamMessageRecord`、`TeamMemberModel` 与 `TeamMemberModelRecord`，以及 rc.1 未定义的类型 `ProjectionRegistrationListener`。
- `scripts/gen-doc-graphs.ts`（处置编号 253）：`pluginAudit` 行等待定义审计 seam 的包。处置报告将该行标记给安全审查。
