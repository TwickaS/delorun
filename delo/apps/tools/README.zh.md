# Delo 工具

[English](README.md) | 中文

`@delo/tools` 是 Delo 的 fork 工具，一个位于 `delo/apps/tools` 的私有包。
它包含差异台账检查器：该检查器记录本树与其锁定的上游提交之间的每一处差异，并统计这些差异的数量。
它还包含对每项变更进行检查的门禁、提交标准，以及上游工作流的清单。
检查运行器 [`src/run-checks.ts`](src/run-checks.ts) 负责排序并运行这些门禁与下文所述的其他本地检查；替身栈服务于远程访问与登录测试，其他 fork 工具将随后续工作包到达。

## 模块

- `src/fork-boundary.ts` 包含台账的 schema、fork 自有路径与 glob 的匹配器、边界错误以及差异汇总。
- `src/check-fork-boundary.ts` 是命令行门禁。它读取台账，依据台账检查本仓库，并在传入 `--count` 时打印差异数量。
- `src/ledger-merge.ts` 是台账的 git 合并驱动。它按 `path` 合并条目，规则见下文的差异台账一节。
- `src/build-web.ts` 以 Delo 的产品名称构建 web studio 的客户端：除非调用方已设置，否则将 `DSH_CLIENT_TITLE` 设为 `Delo`，通过上游的 `build:web` 并重建 `@deepseek-ai/dsh-client-ui-layout` 的客户端 bundle（它内嵌该标题）。发布流程（WP3.1）设置同一变量。
- `src/network-log.mjs` 是网络 fixture 用的 Node preload：设置 `NODE_OPTIONS="--import <路径>"` 与 `DELO_NETWORK_LOG` 后，它把进程及其子进程打开的每个 TCP 连接的主机与端口追加写入该文件。
- `src/rehearse-upstream.ts` 是预演合并。它在临时工作树中合并一个上游标签，并按差异预算检验结果，如下文的预演合并一节所述。
- `src/check-commits.ts` 是提交标准：Conventional Commits 主题行、DCO 签名，以及一个变更片段或一行 `Changelog: none (<reason>)` 尾注。它以 `--message <file>` 检查单条消息，`commit-msg` 钩子即以这种方式调用它。
- `src/checks/types.ts` 与 `src/checks/gates/index.ts` 将每个门禁描述为检查运行器执行的一条命令。
- `src/checks/gates/` 包含门禁模块及其数据：许可证、密钥、个人数据、基础设施、DCO、文档时间以及文档检查。
- `src/check-jsdoc.ts` 将上游的 JSDoc 规则应用于 `delo/` 下的每个 `src` 树。
- `src/check-docs-site.ts` 启动文档网站的构建（包括其死链接检查），并在站点依赖安装之前拒绝运行。
- `src/run-checks.ts` 是检查运行器：层级、选择与报告。
- `src/checks/` 包含检查目录（`plan.ts`）、调度器（`run.ts`）、机器预算（`machine.ts`）、通过缓存（`cache.ts`）与预算（`budgets.json`）。
- `src/setup-worktree.ts` 用一条命令完成检出或工作树的设置：钩子文件、安装、钩子、台账合并驱动，以及在 Node 与 `.nvmrc` 不一致时给出警告。检查运行器拒绝在其他 Node 主版本上运行门禁；只有提交前层级和只读列表照常运行。
- `src/git.ts` 为各模块运行 git，并报告退出状态。
- `src/parity/composition/` 包含约定 C16 的对等覆盖层、`parity-switches` 检查（`check-parity-switches.ts`，以及 `switches.ts`、`contributions.ts`、`overlay.ts` 与 `sweep.ts`）和暂存的开关开启场景；下文的对等组合一节描述它们。
- `src/issues/` 把维护者撰写的 brief 转为 GitHub Issue：`brief.ts` 包含字段、规则与 Issue 正文，`references.ts` 包含 brief 可以携带的链接与路径，`labels.ts` 包含标签文件，`gh.ts` 包含 `gh` 调用，`issues.ts` 为命令行。
- `src/stack/` 包含远程访问与登录测试所用的替身栈：`certificates.ts`（测试授权机构、证书与请求）、`loopback.ts`（回环 HTTPS 服务器与客户端）、`network-guard.ts`、`oidc-provider.ts`、`acme.ts` 与 `caa.ts`、`certificate-transparency.ts`，以及 `index.ts`，后者把它们一并启动；下文的替身栈一节描述它们。
- `tests/` 包含测试规范。台账规则在临时 git 仓库中运行，`ledger-merge.spec.ts` 还在其中让分支经由合并驱动完成变基。`rehearse/` 在临时目录中构建一个上游仓库及其 fork，并在二者之间预演合并。门禁规范在临时树中为每个门禁植入一处违规，文档规范则在植入违规的夹具树上运行上游脚本。`checks.spec.ts` 与 `checks-cache.spec.ts` 覆盖运行器的选择、层级、预算、通过缓存与 `--plan`。`parity/` 在真实仓库与植入违规的夹具上覆盖对等检查，并以植入的覆盖层运行上游的 headless 适配器。`stack/` 像 home 那样驱动每个替身，并配有规范端的 ACME 客户端（`acme-client.ts`）与 C14 的依赖方检查（`c14-relying-party.ts`），还在网络守卫下运行整个栈。

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

[`src/ledger-merge.ts`](src/ledger-merge.ts) 是台账的 git 合并驱动，[`.gitattributes`](../../../.gitattributes) 将 `delo/upstream-patches.json` 指向它。每个克隆仓库配置一次该驱动，该克隆的所有工作树共享这一设置：

```sh
git config merge.delo-ledger.driver 'node_modules/.bin/tsx delo/apps/tools/src/ledger-merge.ts %O %A %B'
```

未配置该设置时，git 把台账当作文本合并。配置后，驱动按 `path` 合并条目：仅一方修改的条目采用该方的版本，仅一方删除而另一方未改动的条目同样予以删除；两方以相同方式新增或修改的条目只保留一份。`forkOwned` 取两方的有序并集，`upstream` 须在两方之间一致，`$schema` 的合并方式与一个条目相同。两方以不同方式修改的条目保持冲突，包括一方删除而另一方修改的条目：驱动只在这些条目外围写入冲突标记，在标准错误中逐条说明，并以 1 退出。合并后的台账未通过解析器或条目规则校验时，驱动同样写入结果并以 1 退出。`forkOwned` 只要任一方仍列出某条目就保留它，因此只有两方都删除后，该条目才会离开台账。

<a id="the-rehearsal-merge"></a>
## 预演合并

[`src/rehearse-upstream.ts`](src/rehearse-upstream.ts) 预演一个上游标签的合并，并按[差异预算](../../docs/reference/divergence/README.zh.md#divergence-budget)检验结果。在仓库根目录运行它：

```sh
node_modules/.bin/tsx delo/apps/tools/src/rehearse-upstream.ts --tag <tag>
```

它读取 `HEAD` 处的台账，从台账的 `upstream.repository` 获取该标签，并在临时目录中添加一个分离于 `HEAD` 的临时工作树。在其中，它合并标签的提交但不提交，关闭钩子与已记录的冲突解决，并且无论结果如何都会移除该临时工作树。获取操作只写入临时工作树的 `FETCH_HEAD`，因此检出的引用、分支、暂存区与工作树保持不变，其未提交的改动不计入测量。

它打印冲突路径及其类别与冲突区域，以及冲突的差异块占标签处台账差异块数的比例。随后它按类别（`delo-feature`、`generic-fix`、`security`）分别打印相对于锁定的提交与相对于标签测得的条目与差异块及其增长，并把总数与上限并列打印。有差异且未被任何条目列出的路径计为 `unlisted`。冲突文件连同其冲突标记一并测量，因此一个冲突区域通常在标签处计为两个差异块。与锁定的提交不同、却与标签相同的条目已被标签吸收：它被列为抵免，标签处的计数不含它。在记录第一次发布的基线之前，上限取差异预算的下限值，即 20 条条目与 150 个差异块。台账未将任何条目标记为生成条目，因此每个条目都计入，输出会对此予以说明。

当条目或差异块的总增长超过其上限时、当冲突差异块超过标签处台账差异块数的 15 % 时，以及对每个发生冲突的 `security` 类文件（因为台账未记录维护者的决定）时，它以 1 退出，并为每项失败输出一行。缺少 `--tag` 时，它以 2 退出并输出一行用法说明；获取或合并失败时，它以 2 退出并输出 git 的错误信息。

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

<a id="local-checks"></a>
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
| `tests:fork` | `delo/apps/*/tests` 与 `delo/packages/*/tests` 下的每个规范（[`vitest.config.ts`](../../vitest.config.ts)）；客户端组件规范（`.spec.tsx`）在 jsdom 中运行，上游包解析为其源码 | 每个 worker 0.5 GiB | `changed`、`full` |
| `tests:snapshots` | 上游的无密钥录制会话回放（`pnpm run test:snapshot`） | 每个 worker 0.6 GiB，5 个 CPU，独占 | `changed`、`full` |
| `tests:upstream-changed` | 每个有变更的上游包的规范，以及在 150 个规范文件之内其直接依赖的规范（[上游的 `vitest.config.ts`](../../../vitest.config.ts)） | 每个 worker 0.6 GiB，至多 8 个 worker | `changed` |
| `tests:web-changed` | 基于官方客户端构建运行的、变更所涉及的 `apps/web/tests` 下的 Chromium 端到端规范，至多 12 个规范（[`checks/web.ts`](src/checks/web.ts)） | 5 GiB，8 个 CPU，独占，1200 秒 | `changed` |
| `generate:native` | 上游的原生系统插件（`pnpm run build:native-system`） | 1 GiB，2 个 CPU | 无：仅 `--only generate:native` |
| `docs-site` | Delo 文档网站可以构建，且其死链接检查通过（[`delo/apps/docs`](../docs/README.zh.md)）；在站点依赖安装之前拒绝运行（[`check-docs-site.ts`](src/check-docs-site.ts)） | 2 GiB，2 个 CPU，900 秒 | `changed`、`full` |
| `parity-switches` | C16 的注册表与开关字段、对等覆盖层和对模型可见的贡献相符，以及开关清点（[`check-parity-switches.ts`](src/parity/composition/check-parity-switches.ts)） | 0.5 GiB，1 个 CPU | Delo 代码或上游编辑改动时为 `changed`；`full` |
| `parity-replay` | 在 `DSH_SNAPSHOT_PATCH` 指向对等覆盖层时运行上游的录制会话回放（`pnpm run test:snapshot`） | 每个 worker 0.6 GiB，5 个 CPU，单独运行 | Delo 代码或上游编辑改动时为 `changed`；`full` |

`pre-commit` 层级在 5 秒预算内运行（见 `budgets.json`），运行超出预算时会报告。网页通道（`tests:web-changed`，[`src/checks/web.ts`](src/checks/web.ts)）运行变更所涉及的、`apps/web/tests` 下的 Chromium 端到端规范。当非文档路径位于 `packages/client` 或 `apps/web` 之下，或位于清单中某个规范所导入的包之下时，变更便涉及该通道。规范自身的文件有变更，或它映射到有变更的包，则该规范被选中；变更的规范文件只选中它自己，不会使其所在的包视为有变更。规范映射到其导入所触及的包：包名导入映射到该包，相对导入映射到其解析路径所在的包，因此每个规范都通过其辅助导入映射到 `apps/web`。若某个规范的导入都不映射任何包，则按文件名映射到目录名是该文件名主干中以连字符分隔的连续片段的包。没有规范命名能映射到某个包的路由或客户端界面，因此不映射页面目标。选中的规范超过 12 个时，检查被拒绝而不是部分运行：检查报告数量，并由 CI 的网页快照门禁运行整个清单。既未指定变更也未指定目标的运行会选中整个清单，因此同一上限会拒绝它。该通道先以 `DSH_BUILD_CLIENT_PROFILE=official` 运行 `pnpm run build:artifacts`，然后在上游的 `vitest.web.config.ts` 下逐一运行选中的规范，设置 `DSH_SNAPSHOT=replay`，且不带 `DEEPSEEK_API_KEY`。其预算为 5 GiB、8 个 CPU、独占，以及 1200 秒的挂钟时间，运行超出时命令会报告。该通道只运行 Chromium。有十一个规范在内部启动 WebKit，且没有能单独运行其 Chromium 部分的开关，因此在本机具备 WebKit 的系统库之前，该通道会排除这十一个文件；CI 会以 WebKit 运行它们。该通道不声明输入，因此只要变更涉及它便会运行。Docker 通道、构建后包的规范、文档站点、工作流检查与 Cordis 检查，将随需要它们的包一同到达。

每个检查都继承运行器的环境，但不含 git 的仓库变量；在 WSL 上，还不含 `PATH` 中的 Windows 目录与 Windows 侧的变量，其中包括 `NoDefaultCurrentDirectoryInExePath`（[`src/checks/machine.ts`](src/checks/machine.ts)）。若某次运行所规划的检查会运行 pnpm，或规划了 `tests:upstream-changed`（其规范自行启动 pnpm），则该次运行会为每个检查提供 `pnpm run` 为脚本提供的环境：固定版本的 pnpm 置于 `PATH` 首位并作为 `npm_execpath`，且设定 `pnpm_config_verify_deps_before_run=false`。上游的整个单元测试套件不属于任何通道；绿色基线按[对等基线](../../docs/reference/parity-baseline.zh.md#green-base-on-v5)中的运行步骤与前置条件运行它。

在仓库根目录运行的命令：

```sh
pnpm check                       # --changed: what changed since v5, and the checks it needs
pnpm check:full                  # the full gate, with no pass cache
pnpm check -- --plan             # the selection with each reason, cache state, expected time and budget; runs nothing
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --list        # the whole catalogue
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only tests:fork
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts delo/apps/tools    # targets: that package's specs, and the typechecks of the packages that depend on it
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only tests:web-changed apps/web/tests/forge-panel.e2e.ts    # the web lane for named specs, after the official client build
```

选项：`--changed`、`--pre-commit` 与 `--pre-push` 各自选择一个层级，只能给出其一；`--base <ref>` 让 `--changed` 从另一个引用开始度量（默认 `v5`）；`--only` 与 `--skip` 接受检查 id 或分组（`boundary`、`gates`、`whitespace`、`docs`、`typecheck`、`tests`、`generate`、`parity`），以逗号分隔；`--plan` 与 `--list` 只打印而不运行；`--no-cache` 跳过通过缓存；`--bail` 在第一个失败处停止；`--workers <n>` 设置 fork 规范套件的 worker 数；`--no-scope` 不在 systemd 用户作用域中运行。

声明了输入的检查，每个键只通过一次。键由以下内容构成：其输入文件的 git blob id 排序列表的 sha256（已跟踪且未修改的文件取其 blob id；已修改、已删除或未跟踪的文件取其内容哈希）、锁文件的 blob id、Node 与 pnpm 版本、命令、其预算条目，以及其列出的环境变量的取值。键相同的已存储通过结果会报告为 `cached pass (<键前缀>)`，该检查不再运行。以下情况下缓存关闭：`--no-cache`、`pnpm check:full`、带 `DELO_FULL_GATE=1` 的推送，以及设置了 `CI` 时。未声明输入的检查总是运行：两项回放、产物构建、原生插件与暂存的空白检查。

推送前运行若通过了它所选的每个检查，便以 HEAD 的树与 Node 主版本为键写入一份树通过记录 `<git 公共目录>/delo-checks/trees/<tree>-node<major>.json`（见 [`src/checks/tree-pass.ts`](src/checks/tree-pass.ts)）。克隆的每个工作树共享该目录，因此一个工作树中的通过记录可服务于另一工作树中的同一棵树，而一个 Node 主版本上的通过记录绝不服务于另一个主版本。之后对同一棵树的运行，若该记录覆盖了它所选的每个检查，便报告该通过且不启动任何检查：记录须包含该检查，该检查的范围须落在记录的范围之内（收窄套件所运行的包或规范），且锁文件、Node 与 pnpm 版本以及检查所列的环境变量全部一致。`boundary` 检查与范围门禁读取 HEAD 的历史以及从 `origin/v5` 到 HEAD 的提交，这些内容不由树决定，因此它们只在相同的 HEAD 提交与 `origin/v5` 下才被覆盖。分支推送从其远程提交与其和 `origin/v5` 的合并基二者中较早者开始度量，所以把 `v5` 快进到它所检查过的提交，只要 `origin/v5` 未移动，便不启动任何检查；树相同而历史不同的另一个提交，则会重新运行读取历史的检查。工作树不干净、`--no-cache`、`CI` 与 `DELO_FULL_GATE=1` 既不读取也不写入记录。被记录覆盖的运行在机器范围的锁之前即作答，因此不会等待本机上正在运行的门禁。

安装钩子时，在仓库根目录写入一行 `lefthook-local.yml`，内容为 `extends: [delo/lefthook.yml]`（Git 会忽略它），然后运行 `node scripts/install-lefthook.mjs`。`pre-commit` 钩子运行 `pre-commit` 层级。`pre-push` 钩子运行 `--pre-push`：自远程分支的最新提交与其和 `origin/v5` 的合并基二者中较早者以来的改动（新分支在没有 `origin/v5` 时，则是自其与 `v5` 的合并基以来的改动）。`DELO_PUSH_SKIP=<检查或分组>,… git push` 会跳过指定的检查，`DELO_FULL_GATE=1 git push` 运行完整门禁。在分支推送之后以快进方式合并，不会重新运行门禁。`commit-msg` 钩子对每条提交消息运行 `check-commits.ts --message <file>`。

报告与日志位于 `node_modules/.cache/delo-checks/` 下：`report.json` 记录每个检查的状态、是否由通过缓存提供、原因、日志、耗时与内存峰值；`logs/<check>.log` 保存完整输出；`pass/` 为通过缓存，树通过记录位于 git 公共目录中，由各工作树共享；`durations.json` 记录每个检查最近一次的耗时，用于安排下一次运行的顺序；`tsbuildinfo/` 保存增量类型检查的状态。机器范围的锁使第二次运行等待第一次结束。

账本检查单独运行为 `pnpm --filter @delo/tools check`。单个门禁用 `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/<name>.ts` 运行（如 `licence`），范围门禁接受 `--base <rev>`。规范用 `node_modules/.bin/vitest run --config delo/vitest.config.ts` 运行，本包的类型检查用 `node_modules/.bin/tsc -p delo/apps/tools/tsconfig.json --noEmit`。

[delo-dev-workflow 技能](../../../.agents/skills/delo-dev-workflow/SKILL.md)说明了何时运行各项检查。

## 替身栈

[`src/stack/`](src/stack/index.ts) 包含远程访问与登录所联系的外部服务的本地替身，使其测试不接触任何在线提供方。`startStandInStack()` 在 `127.0.0.1` 上启动一个测试授权机构和四个替身，每个替身监听临时端口，并以该授权机构签发的证书通过 HTTPS 提供服务；客户端只信任 `authority.certificate.pem`，不信任其他任何证书。每个替身也可以单独启动。替身属于测试基础设施：它们模拟提供方有文档记载的行为，其钩子产生的响应正是约定的拒绝测试必须拒绝的那些。

| 替身 | 替代对象 | 提供的内容 | 拒绝测试的钩子 |
| --- | --- | --- | --- |
| `startOidcStandIn`（[`oidc-provider.ts`](src/stack/oidc-provider.ts)）；栈启动两个，`issuerA` 与 `issuerB` | 本人自己的 OpenID Connect 提供方（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md)） | 发现文档、密钥集、使用 S256 PKCE 的授权码流程、`nonce` 与 RFC 9207 的 `iss` 参数、令牌端点上的 `client_secret_basic`、RFC 7591 与 7592 动态注册。它没有登录页面：每次授权都以其配置的主体登录，`auth_time` 为当前时间。它使用 RS256、PS256、ES256 或 EdDSA 签名 | 下一个 ID 令牌中的声明被改动或缺失（另一个 `aud`、多个受众且无 `azp`、另一个 `iss`、`sub` 或 `nonce`、过旧的 `iat` 或 `auth_time`）；伪造的令牌（`alg: none`、以公钥为密钥的 HS256、未知密钥、无 `kid`、签名错误）；另一个或缺失的 `iss` 响应参数；密钥的发布、轮换与退役，以及用已退役的密钥签名；元数据被改动；任一端点的原始应答或无应答 |
| `startAcmeStandIn`（[`acme.ts`](src/stack/acme.ts)、[`caa.ts`](src/stack/caa.ts)） | 所指名的证书授权机构的 ACME 服务器（[C7](../../docs/contracts/c07-reach-providers.zh.md#own-domain-reach)） | RFC 8555 目录、nonce、账户、订单、授权、挑战、定稿、下载与吊销，并验证每个请求的 JWS、nonce 与 URL。每个授权提供 `http-01`、`dns-01` 与 `tls-alpn-01`，通配符授权只提供 `dns-01`。TLS-ALPN-01（RFC 8737）连接到调用方为该标识符指定的回环目标；DNS-01 读取调用方提供的 TXT 记录。签发前，它以 CAA 标识为 `letsencrypt.org` 的证书授权机构身份，应用调用方提供的 CAA 记录及其 `accounturi` 与 `validationmethods` | 客户端启动的每个挑战都会被记录，因此规范可以证明 home 没有启动 HTTP-01 或 DNS-01 挑战；为另一账户签发的证书；CA 的吊销；以问题文档代替某端点的下一个应答 |
| `startCtStandIn`（[`certificate-transparency.ts`](src/stack/certificate-transparency.ts)） | Cert Spotter 的签发搜索，即 [C6](../../docs/contracts/c06-relay-protocol.zh.md#certificate-monitoring) 的默认证书来源 | `GET /v1/issuances`，带有 `domain`、`include_subdomains`、`match_wildcards`、`after` 与 `expand` 参数，采用 Cert Spotter 的字段与错误格式；`sourceUrl` 为约定中的来源，其 origin 指向替身 | 规范登记的夹具，例如 `*.example.com` 或多名称证书；在日志收录之前暂不返回的证书；吊销；以 `rate_limited` 等错误代替下一个应答 |
| `installNetworkGuard`（[`network-guard.ts`](src/stack/network-guard.ts)） | 无：它监视测试进程 | 在发出任何数据包之前，拒绝每个目标不是回环地址的 TCP 或 TLS 连接、UDP 发送或绑定、监听器与 DNS 查询，并记录每个到达其对端的连接 | 名称解析只解析 `localhost`，因此替身需以 IP 字面量寻址 |

替身栈会把 ACME 替身签发的每张证书记入证书透明性替身，并标记其中被 ACME 替身吊销的证书。若某个规范必须证明没有流量离开回环，它需要在启动栈之前安装守卫，并在结束时读取 `guard.connections` 与 `guard.refusals`。守卫只在其自身进程中修补 `node:net`、`node:dgram` 与 `node:dns`：它看不到子进程、工作线程、自行打开套接字的原生插件，也看不到安装之前已打开的套接字。

替身使用三个维护中的库，每个都在本包的清单中声明：

- [`jose`](https://github.com/panva/jose) 签名并验证 JSON Web Token 与 JWS，导出 JSON Web Key 并计算指纹（thumbprint）。未使用同一作者的完整提供方库（如 `oidc-provider`），因为其令牌端点无法签发拒绝测试所需的伪造令牌、受众错误的令牌与混合签发方的令牌，且其交互流程需要由规范驱动的登录页面。
- [`pkijs`](https://github.com/PeculiarVentures/PKI.js) 与 [`asn1js`](https://github.com/PeculiarVentures/ASN1.js) 通过 Node 的 Web Crypto 生成证书与 PKCS #10 请求，并读取其扩展，因此没有任何替身调用 `openssl`。它已经通过桌面构建进入锁文件。未使用 `@peculiar/x509`，因为它需要全局的 `reflect-metadata` polyfill。
- ACME 服务器是替身自身的代码：参考测试服务器 Pebble 是 Go 二进制文件，无法在守卫之下于测试进程内运行。规范通过规范端客户端驱动它；未添加 `acme-client`，因为它的 `axios` 依赖会改变锁文件中上游网站依赖的解析结果。

[`tests/stack/`](tests/stack/) 中的规范证明以下各点：OpenID Connect 替身的发现元数据与 ID 令牌（按每种允许的算法）通过每项 C14 检查，并且每个钩子产生的响应都是 C14 以其代码拒绝的响应；ACME 替身在回环上应答 TLS-ALPN-01 挑战后，为测试名称签发证书，并拒绝被篡改的请求，以及指名另一个账户、方法或 CA 的 CAA 记录；证书透明性替身能应答精确、通配符与多名称搜索；在安装守卫的情况下，一次登录、一次签发和一次搜索只打开到回环的连接，而任何会离开回环的连接、名称查询、监听器或 UDP 发送都被拒绝。

## 对等组合

[约定 C16](../../docs/contracts/c16-parity-composition.zh.md) 规定：Delo 在关闭其对模型可见的新增内容后，回放上游在 `dsh-v0.2.2-rc.1` 录制的场景，与其预期输出没有任何差异。本包用两项检查验证这一点：`parity-replay` 经由对等覆盖层运行上游的回放，`parity-switches` 检查每项对模型可见的 Delo 变更都有一个已注册、且被覆盖层关闭的开关。

### 覆盖层

[`src/parity/composition/parity.overlay.yml`](src/parity/composition/parity.overlay.yml) 是一个 Cordis patch 文件。每个录制会话适配器在其模块加载时，经由上游 `packages/test-support/session-snapshot/src/snapshot-patch.ts` 中的 `snapshotPatchOverlay` 读取 `DSH_SNAPSHOT_PATCH`。它把所指定的文件放在其启动的每个进程的根配置之后、每个场景层之前：headless、SDK 与 ACP 适配器将其作为 `--patch` 参数传入，Web 脚手架则在随附的 bundle 层之后应用它。在 `DSH_SNAPSHOT=record` 或 `refresh` 模式下，收到该变量的适配器在启动任何进程之前抛出错误。没有任何随附的 profile、bundle 或命令行选项指向该文件，`dsh` 命令也不读取该变量。

一条 patch 行会替换其条目的整个 `config`，并且只能到达根树中的条目，因此覆盖层只在之前没有任何层配置该条目时才设置开关。其余每个已构建的开关都通过其经过校验的 Config 默认值处于对等取值：

| 开关 | 对等组合如何设置它 |
| --- | --- |
| `plugin_manager_read_exemption`、`profile_history` | 覆盖层的 `tool-plugin-manager` 行（`name: '@deepseek-ai/dsh-plugin-manager/tools'`）设置 `readActionsExempt: false` 与 `profileHistory: false`。 |
| `preset_inspect` | Config 默认值 `false`。该行位于每个 Web preset 的插件列表中，patch 只有替换整个 preset 行才能到达它。 |
| `container_denial_marker` | Config 默认值 `false`。bundle 与根配置设置了 `sandbox-policy` 的模式与工作区根目录，覆盖层的一行会抹掉它们。 |
| `doctor` | Config 默认值 `false`。只有 `doctor` profile 挂载该应用，回放不启动 doctor 进程。 |
| `studio_additions` | Config 默认值 `false`，属于 `@delo/plugin-main-chat` 的 `studioAdditions`。尚无已发布的 profile 或 bundle 挂载主对话。 |

覆盖层还挂载 [`@delo/bundle-local`](../../packages/bundle-local/README.zh.md)：在开关行之后，它按各 `LOCAL_ROWS` 条目给出的对等形式，重述该组合包 `cordis.patch.yml` 的 patch；当重述与该文件的 `parityPatches` 不一致时，`parity-switches` 失败（[`overlay.ts`](src/parity/composition/overlay.ts) 中的 `localBundleErrors`）。会话日志上传行是 C16 所列的变更默认值，它被省略，因此保持上游的取值：覆盖层跟随每次回放的根配置，该配置对 headless 与 ACP 语料关闭上传，在其他语料中保持开启。桌面端分析保持 Delo 的 `false`，“隐私”分区行存在且已禁用。studio bundle、权限默认值与 fetch 防护尚在计划中；studio 附加功能中只有主对话在本树中，且默认关闭；preset 默认值保持上游的取值（`standard`）。

### 注册表

[`@delo/contract-parity-composition`](../../packages/contract-parity-composition/README.zh.md) 中的 `PARITY_SWITCHES` 是唯一的开关列表。已构建的条目给出其 Config 字段（`cordis.yml` 行挂载的模块、该模块的源文件与键），以及它所关闭的对模型可见贡献所在的源文件。计划中的条目是 C16 列出、但其变更尚未进入本仓库的开关；它给出构建它的工作包，没有字段。`doctor` 是功能开关：它对模型不可见，也没有开关开启场景。

| 开关 | 状态 | 字段 | 默认 | 对等 | 对模型可见 |
| --- | --- | --- | --- | --- | --- |
| `studio_additions` | 已构建 | `@delo/plugin-main-chat` `studioAdditions` | 开 | 关 | 是 |
| `permission_defaults` | 计划中 | 无 | 开 | 关 | 是 |
| `fetch_guard` | 计划中 | 无 | 开 | 关 | 是 |
| `preset_inspect` | 已构建 | `@deepseek-ai/dsh-agent-preset-registry/tools` `presetInspect` | 开 | 关 | 是 |
| `doctor` | 已构建 | `@deepseek-ai/dsh-doctor/app` `doctor` | 开 | 关 | 否 |
| `plugin_manager_read_exemption` | 已构建 | `@deepseek-ai/dsh-plugin-manager/tools` `readActionsExempt` | 开 | 关 | 是 |
| `profile_history` | 已构建 | `@deepseek-ai/dsh-plugin-manager/tools` `profileHistory` | 开 | 关 | 是 |
| `scheduled_task_consent` | 计划中 | 无 | 开 | 关 | 是 |
| `instruction_layer_consent` | 计划中 | 无 | 开 | 关 | 是 |
| `mcp_add_consent` | 计划中 | 无 | 开 | 关 | 是 |
| `container_denial_marker` | 已构建 | `@deepseek-ai/dsh-sandbox-policy` `containerDenialMarker` | 开 | 关 | 是 |

默认一列是 Delo 默认组合中的取值；每个已构建字段的 schema 默认值都是对等取值。

### `parity-switches` 能检测什么

该检查读取 `delo/**/src` 下的 TypeScript 源文件，以及 `packages/` 与 `apps/` 下每个列入台账的上游源文件，不含测试规范。以下情况它会失败：

- 名为 `Config` 的接口中，某个属性的 JSDoc 写有 `` C16 switch `<id>` ``，但没有带该字段的已构建注册表条目，或其条目仍在计划中；
- 已构建条目的源文件中没有这样的字段，该字段的 `z.boolean().default(…)` 不是对等取值，条目的对等取值等于其默认值，或对模型可见的条目没有给出源文件或 `<profile>/delo-<id>` 场景；
- Delo 自有的源文件调用了对模型可见的注册 API，或列入台账的上游编辑改动了调用这类 API 的顶层语句中的某一行，而没有任何已构建、对模型可见的条目在其源文件中列出该文件；
- 覆盖层的某行指向没有已构建开关的模块，设置了不属于该模块开关的键或不是对等取值的值，或者设置了 `id`、`name` 与 `config` 之外的内容；或者某个已构建开关既不在覆盖层中，也不在 `overlay.ts` 的 `DEFAULT_PARITY` 中附带理由；
- 某个对模型可见的已构建开关既没有已录制的场景，也没有暂存的场景。

对模型可见的注册 API 包括：`systemPrompt.section`、`systemPrompt.context` 与 `systemPrompt.suppressRuntimeContext`；`tools.register`、`tools.restrict`、`tools.setExecutor` 与 `tools.guard`；`defineTool`；以及用 `on` 为 `system-prompt/assemble`、`agent/request`、`agent/pre-step`、`request/context`、`tools/execute`、`tools/pre-execute`、`tools/post-execute` 与 `tools/result` 注册的监听器。

### 它无法检测什么

该扫描按名称匹配，而不按类型或数据流，因此会漏掉：

- 经由注册语句之外的辅助代码到达模型的文本，例如渲染模块或文件顶部的常量，且没有改动的行落在注册语句之内；
- 通过其他接收者名称、别名或动态属性发起的调用，以及不在其列表中的对模型可见的事件；
- 所列开关在其对等取值下是否真的关闭了该贡献。对于触及该贡献的场景，回放证明这一点；开关开启场景录制之后，则证明开关开启时的路径。

它还接受所列源文件中的任何贡献，因此在同一文件中新增的第二个未受开关控制的贡献能通过扫描，必须由回放使其失败。

### 开关清点

每个对模型可见的已构建开关都有一个开关开启场景 `snapshots/<profile>/delo-<id>`，其 `runtime.cordis.yml` 只把这一个开关设为非对等取值，并加上一条场景本地的 `agent-default-model` 配置，用以固定语料库模型 `deepseek-v4-flash`。录制之后，`parity-replay` 在覆盖层下把它与语料库的其余部分一同回放，因此被测开关是与对等组合的唯一行为差异。Web 场景经由 `apps/web/tests` 下的 e2e 驱动运行，该驱动用 `launchWebScaffold` 的 `presetInspect` 选项开启 `preset_inspect`，并在回放时通过智能体默认模型选择同一模型。

五个开关开启场景中有四个已录制：`session/delo-plugin-manager-read-exemption`、`session/delo-profile-history`、`session/delo-container-denial-marker` 与 `web/delo-preset-inspect`。它们的目录位于 `snapshots/` 下，并可在无密钥的情况下回放，有覆盖层与无覆盖层两种方式（Web 场景经由 `test:web:built` 回放）。第五个场景 `web/delo-studio-additions` 尚未录制：其 `snapshot.yml` 仍在 [`src/parity/composition/scenarios/`](src/parity/composition/scenarios/) 下，其驱动尚未编写，`parity-switches` 将其报告为 `pending recording`（待录制）。

录制其中一个时，把其目录移到 `snapshots/<profile>/`，在不设 `DSH_SNAPSHOT_PATCH` 的情况下为该场景运行上游的录制命令，审阅输出，并在 Session 夹具携带任务之后删除 `input.task`。录制时若场景目录中已有 Session 夹具，则从该夹具读取任务，因此在改动 `input.task` 后录制之前，须先把较早的夹具移出。

### 命令

```sh
node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts --only parity
DSH_SNAPSHOT_PATCH=delo/apps/tools/src/parity/composition/parity.overlay.yml pnpm run test:snapshot
node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts
```

`pnpm run test:snapshot` 经由各自的适配器回放 session、SDK 与 ACP 场景，并用上游的语料库门禁检查语料库中的每个场景，包括 Web 场景。Web 场景在 `test:web` 中经由其 e2e 驱动回放，后者通过脚手架读取同一个变量：`DSH_SNAPSHOT=replay DSH_SNAPSHOT_PATCH=<overlay> pnpm run test:web:built`。

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
