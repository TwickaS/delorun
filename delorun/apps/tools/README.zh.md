# Delorun 工具

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

`@delorun/tools` 是 Delorun 的 fork 工具，一个位于 `delorun/apps/tools` 的私有包。
它包含差异台账检查器：该检查器记录本树与其锁定的上游提交之间的每一处差异，并统计这些差异的数量。
它还包含对每项变更进行检查的门禁、提交标准，以及上游工作流的清单。
检查运行器 [`src/run-checks.ts`](src/run-checks.ts) 负责排序并运行这些门禁与下文所述的其他本地检查；替身栈服务于远程访问与登录测试，仓库中没有其他 fork 工具。

## 模块

- `src/fork-boundary.ts` 包含台账的 schema、上游源码判定、fork 自有路径与路径规则的匹配器、条目与规则错误、边界错误以及差异汇总。
- `src/check-fork-boundary.ts` 是命令行门禁。它读取台账，依据台账检查本仓库，打印每条路径规则的覆盖情况，并在传入 `--count` 时打印差异数量。
- `src/ledger-record.ts` 写入台账：桩条目、对不再有差异的条目的移除，以及安全摘要，如下文的差异台账一节所述。
- `src/ledger-digests.ts` 计算并比较安全条目的摘要。
- `src/demo-home.ts` 建出用来拍摄图片的演示主目录，见下文“演示主目录与图片”一节。
- `src/fresh-home-smoke.ts` 从全新的临时主目录启动已发布的 studio，端口在 18600–18619 之间；当它没有监听、日志报告启动失败，或新手引导的设置记录没有应答时，就判为失败。请在 `pnpm run build:artifacts` 和 `delorun/packages` 的构建之后运行它，并在每次合并进集成分支之后运行它。
- `src/ledger-merge.ts` 是台账的 git 合并驱动。它按路径合并条目，按模式合并规则，规则见下文的差异台账一节。
- `src/rehearse-upstream.ts` 是预演合并。它在临时工作树中合并一个上游标签或本地引用，并按差异预算检验结果，如下文的预演合并一节所述。
- `src/upstream-update.ts` 在临时工作树中把列出的补丁带到较新的上游标签上，并在发布合并进入 `HEAD` 之后写出带过去的台账。
- `src/check-commits.ts` 是提交标准：Conventional Commits 主题行、DCO 签名，以及一个变更片段或一行 `Changelog: none (<reason>)` 尾注。它以 `--message <file>` 检查单条消息，`commit-msg` 钩子即以这种方式调用它。
- `src/checks/types.ts` 与 `src/checks/gates/index.ts` 将每个门禁描述为检查运行器执行的一条命令。
- `src/checks/gates/` 包含门禁模块及其数据：许可证、包状态、密钥、个人数据、基础设施、DCO、文档时间以及文档检查。
- `src/check-jsdoc.ts` 将上游的 JSDoc 规则应用于 `delorun/` 下的每个 `src` 树。
- `src/check-docs-site.ts` 启动文档网站的构建（包括其死链接检查），并在站点依赖安装之前拒绝运行。
- `src/run-checks.ts` 是检查运行器：层级、选择与报告。
- `src/with-slots.ts` 在运行器的各次运行共用的全机槽位预算内运行临时的重量级命令。
- `src/coverage.ts` 在槽位预算内测量指定规范或包的覆盖率，写入它自己的报告目录，并列出范围内的每个文件及其四项度量，已完全覆盖的文件也包括在内：`node_modules/.bin/tsx delorun/apps/tools/src/coverage.ts [--include <glob>]... <spec file or package directory>...`；默认的范围是这些路径所在各包的 `src` 文件，当有文件低于 100 % 时它以 1 退出。
- `src/batch/` 是集成者的批量工具，它让多个 lane 通过同一个合并层级门禁落地，并把每个失败报告给造成它的 lane。
- `src/checks/` 包含检查目录（`plan.ts`）、调度器（`run.ts`）、机器预算（`machine.ts`）、通过缓存（`cache.ts`）、全机通过存储（`shared-cache.ts`）及其决定哪些通过可被共享的规则（`sharing.ts`），以及预算（`budgets.json`）。
- `src/pairing-staged.ts` 是提交前与合并提交前的双语配对检查。它对暂存的记录，以及 `HEAD` 所持有的同一批配对，运行上游的 `verify-translation-pairing.ts --cached`（暂存的重命名会追溯到旧路径），仅在出现 `HEAD` 中没有的违规时失败。已有的偏差会以简短的“existing drift, not blocking”列表打印出来；新记录则被严格检查。`delorun/lefthook.yml` 覆盖了上游同名的作业来运行它。
- `src/setup-worktree.ts` 用一条命令完成检出或工作树的设置：钩子文件（缺失时写入；已有但未扩展 `delorun/lefthook.yml` 的会被拒绝）、安装、文档站点自己的安装、钩子、台账合并驱动，以及在 Node 与 `.nvmrc` 不一致时给出警告。检查运行器拒绝在其他 Node 主版本上运行门禁；只有提交前层级和只读列表照常运行。
- `src/build-web.ts` 以 Delorun 的产品名称构建 web studio 的客户端：除非调用方已设置，否则将 `DSH_CLIENT_TITLE` 设为 `Delorun`，通过上游的 `build:web` 并重建 `@deepseek-ai/dsh-client-ui-layout` 的客户端 bundle（它内嵌该标题）。发布发行包设置同一变量。
- `src/network-log.mjs` 是网络 fixture 用的 Node preload：设置 `NODE_OPTIONS="--import <path>"` 与 `DELORUN_NETWORK_LOG` 后，它把进程及其子进程打开的每个 TCP 连接的主机与端口追加写入该文件。
- `src/git.ts` 为各模块运行 git，并报告退出状态。
- `src/parity/composition/` 包含约定 C16 的对等覆盖层、`parity-switches` 检查（`check-parity-switches.ts`，以及 `switches.ts`、`contributions.ts`、`overlay.ts` 与 `sweep.ts`）和暂存的开关开启场景；下文的对等组合一节描述它们。
- `src/issues/` 把维护者撰写的工作 brief 转为 GitHub Issue：`brief.ts` 包含字段、规则与 Issue 正文，`references.ts` 包含 brief 可以携带的链接与路径，`labels.ts` 包含标签文件，`gh.ts` 包含 `gh` 调用，`issues.ts` 为命令行。
- `src/stack/` 是远程访问与登录测试所用的替身栈：`certificates.ts`（测试授权机构、证书与请求）、`loopback.ts`（回环 HTTPS 服务器与客户端）、`network-guard.ts`、`oidc-provider.ts`、`acme.ts` 与 `caa.ts`、`certificate-transparency.ts`，以及 `index.ts`，后者把它们一并启动；下文的替身栈一节描述它们。
- `tests/` 包含测试规范。台账规则在临时 git 仓库中运行，`ledger-merge.integration.spec.ts` 还在其中让分支经由合并驱动完成变基。`rehearse/` 在临时目录中构建一个上游仓库及其 fork，并在二者之间预演合并。门禁规范在临时树中为每个门禁植入一处违规，文档规范则在植入违规的 fixture 树上运行上游脚本。`checks.spec.ts` 与 `checks-cache.spec.ts` 覆盖运行器的选择、层级、预算、通过缓存与 `--plan`。`parity/` 在真实仓库与植入违规的 fixture 上覆盖对等检查，并以植入的覆盖层运行上游的 headless 适配器。`stack/` 像 home 那样驱动每个替身，并配有规范端的 ACME 客户端（`acme-client.ts`）与 C14 的依赖方检查（`c14-relying-party.ts`），还在网络守卫下运行整个栈。

## 差异台账

[`delorun/upstream-patches.json`](../../upstream-patches.json) 记录本树与上游的差异；[差异索引](../../docs/reference/parity-with-deepseek-harness/divergence/README.zh.md)定义了上游源码、路径规则、类别与功能 id。
`upstream.commit` 锁定上游提交，各项差异以它为基准计量。
`forkOwned` 列出 Delorun 完全自有的路径与 glob。`*` 匹配单个路径段内的字符，`**` 跨路径段匹配。一条目覆盖它所匹配的路径，以及匹配目录之下的所有路径。
`rules` 列出路径规则，每条含 `pattern`、`kind` 与 `reason`。规则覆盖其 glob 所匹配、且不属于上游源码的有差异路径；只有精确的 `generated` 规则可以指名源文件，且没有任何规则覆盖 `vendor/` 下的路径。模式由 `path.posix.matchesGlob` 整体且区分大小写地匹配，其 `*` 与 `**` 不匹配以 `.` 开头的路径段。
`patches` 列出每个需要条目的上游路径，并给出其 `class`（`delorun-feature`、`generic-fix` 或 `security`）与 `reason`。`security` 条目记录其文件的 `sha256`；其他条目指名其 `feature`，不记录摘要。`security` 条目还可以列出 `nonModelVisibleHunks`，每项含该文件相对锁定提交的零上下文 diff 中某个差异块的 `sha256`，以及一行 `reason`：这些差异块虽然触及注册模型可见贡献的语句，但已由负责人评审为非模型可见，`parity-switches` 随后放行它们（见[`parity-switches` 检测什么](#what-parity-switches-detects)）。
`retired` 列出上游已吸收其改动的条目。每项都写明吸收该改动的上游提交，以及该条目原有的差异块。

以下情况下检查器失败：

- 台账无法解析，或某个补丁缺少其类别或理由；
- 理由或功能为 `TODO`，功能不是 kebab-case id，`security` 条目没有记录摘要或指名了功能，或其他条目记录了摘要或 `nonModelVisibleHunks`，或没有指名功能；
- `nonModelVisibleHunks` 为空，或某条记录的摘要不是 SHA-256，或其理由不是含有非空白字符的一行；
- 某条规则是单独的 `**`、重复某个模式、没有理由，或匹配了树中的某个上游源码路径，或匹配了检查器的某个不得覆盖的源码探针，此时会指出该模式和该路径；
- 非 `security` 条目指名了同时被某条规则覆盖的路径；
- 锁定的提交不在克隆中，或不是 HEAD 的祖先；
- 吸收提交不在锁定提交的历史中；
- 某个上游路径与锁定提交有差异，却既不是 fork 自有，也未被列出，也未被规则覆盖，而上游源文件绝不会被规则覆盖；
- `generated` 规则所覆盖的源文件，前五行中没有 `Generated by scripts/`；
- 某个列出的补丁与锁定提交不再有差异；
- 某个已退役条目仍与锁定提交有差异；
- `security` 条目记录的摘要与其文件在 HEAD 处的内容不同；
- fork 自有的树中含有某个 TypeScript 源文件的已编译孪生文件。

它会打印每条规则覆盖了多少个有差异的路径，并对一条没有覆盖任何路径的规则打印一行警告；这样的规则不会使检查失败。`--count` 打印列出的条目及其差异块，以及被规则覆盖的路径及其差异块。差异块是相对锁定提交的 `git diff --unified=0` 的一个 `@@` 头。只计受跟踪文件：新文件在加入索引之后才会计入。已退役条目单独记功并列出，不计入汇总。

[`src/ledger-record.ts`](src/ledger-record.ts) 写入台账，因此没有人或 agent 手写条目或摘要：

```sh
node_modules/.bin/tsx delorun/apps/tools/src/ledger-record.ts [--check]
node_modules/.bin/tsx delorun/apps/tools/src/ledger-record.ts --non-model-visible-hunk <path>:<line> --reason "<one line>"
```

它把工作树与锁定的提交比较。对每个既无条目也无规则覆盖的有差异路径，它添加一个桩条目，类别为 `delorun-feature`，其功能与理由均为 `TODO`；移除路径已不再有差异的每个条目；并为文件已改变的每个 `security` 条目重新记录摘要，打印旧摘要和新摘要。当它重新记录了安全摘要时以 3 退出，因为改变的文件需要负责人重新评审；`security` 条目没有可计算摘要的文件时以 1 退出；命令行有误或台账不可用时以 2 退出。`--check` 不改变任何内容，当某次运行会改变台账时以 1 退出。agent 只运行 `--check`；负责人在合并某个 lane 时运行写入形式，填写每个桩的类别、功能与理由，并写出路径规则。

`--non-model-visible-hunk` 做同样的运行，并另外向该路径的 `security` 条目的 `nonModelVisibleHunks` 添加一条记录：工作树文件在该行处的差异块的摘要，以及理由。该行是差异块新增的一行，对仅含删除的差异块则是删除之前的那一行。写入之后它以 3 退出，因为该条目的结论现在涵盖这条记录，需要负责人评审。以下情况下它以 2 退出且不写入：该路径没有 `security` 条目，锁定的提交缺少该文件，该行处读不到差异块，该差异块没有触及任何注册模型可见贡献的顶层语句，带该摘要的每个差异块都已有其记录，或者理由为空、空白或跨多行。

[`src/ledger-merge.ts`](src/ledger-merge.ts) 是台账的 git 合并驱动，[`.gitattributes`](../../../.gitattributes) 把 `delorun/upstream-patches.json` 路由到它。每个克隆配置一次驱动，该克隆的每个工作树共用这项设置：

```sh
git config merge.delorun-ledger.driver 'node_modules/.bin/tsx delorun/apps/tools/src/ledger-merge.ts %O %A %B'
```

没有这项设置时，git 把台账当作文本合并。有了它，驱动按 `path` 合并条目，按 `pattern` 合并规则。一方改动过的条目或规则取该方的版本，一方删除而另一方未动的也是如此。双方都新增或以相同方式改动的条目或规则只保留一份，因此规则是双方按模式的并集。没有 `sha256` 的条目与其他条目一样合并。`forkOwned` 是双方的有序并集，`upstream` 在双方必须一致，`$schema` 的合并方式与一个条目相同。双方以不同方式改动的条目或规则保持冲突，包括一方删除而另一方改动的条目，以及双方都新增、但种类或理由不同的同一个模式：驱动只用冲突标记包住这些元素，在标准错误上指出每一个，并以 1 退出。当合并结果未通过台账解析器或条目规则时，它在写入合并结果之后同样以 1 退出。只要任何一方仍列出某条 `forkOwned` 条目，该条目就会保留，所以条目只有在双方都删除之后才离开台账。

<a id="the-rehearsal-merge"></a>

## 预演合并

[`src/rehearse-upstream.ts`](src/rehearse-upstream.ts) 预演合并某个上游提交，并按[差异预算](../../docs/reference/parity-with-deepseek-harness/divergence/README.zh.md#divergence-budget)检验结果。在仓库根目录运行它，`--tag` 与 `--ref` 恰好给其中一个：

```sh
node_modules/.bin/tsx delorun/apps/tools/src/rehearse-upstream.ts --tag <tag>
node_modules/.bin/tsx delorun/apps/tools/src/rehearse-upstream.ts --ref <ref>
```

它读取 `HEAD` 处的台账，并在临时目录中添加一个临时工作树，分离在 `HEAD`。`--tag` 从台账的 `upstream.repository` 获取该标签；获取只写入临时工作树的 `FETCH_HEAD`。`--ref` 取克隆中已有的提交或分支，例如 `upstream/master`，不获取任何内容。它在临时工作树中不提交地合并该提交，关闭钩子与已记录的解决方案，无论结果如何都会移除临时工作树。检出的引用、分支、索引和工作树保持不变，其未提交的改动不计入度量。

它打印冲突的路径及其类别和冲突区域，以及冲突的差异块占台账在合并后提交处差异块的比例。然后对每个类别（`delorun-feature`、`generic-fix`、`security`、`ruled`、`unlisted`），打印相对锁定提交和相对合并后提交所度量的条目与差异块及其增长，并把总数与上限一并打印。没有条目列出、但被某条路径规则覆盖的有差异路径记为 `ruled`，因此规则所覆盖路径的增长同样被度量；否则记为 `unlisted`。冲突的文件连同其冲突标记一起度量，所以一个冲突区域在合并后的提交处通常计为两个差异块。与锁定提交有差异、但与合并后提交没有差异的条目被吸收：它被列为已记功，合并后提交处的计数不含它。在没有记录发布基线时，上限是预算的下限，即 20 个条目和 150 个差异块。生成的路径计入 `ruled`，输出会说明这一点。

以下情况它以 1 退出，每个失败一行：条目或差异块的总增长超过其上限；冲突的差异块超过台账在合并后提交处差异块的 15 %；以及每个冲突的 `security` 类文件，因为台账没有记录维护者的决定。除非恰好给出一个非空的 `--tag` 或 `--ref`，否则它以 2 退出并打印用法行；引用在克隆中没有指名任何提交时，以及获取或合并失败时，也以 2 退出并给出 git 的错误。

## 门禁

[`src/checks/gates/index.ts`](src/checks/gates/index.ts) 把每个门禁列为运行器从仓库根目录执行的一条命令。命令以 0 退出时门禁通过。暂存门禁接受路径作为尾随参数，运行器在提交前追加它们。范围门禁比较从 `origin/main` 到 HEAD 的提交，除非给出 `--base <rev>`，并且排除 `delorun/upstream-patches.json` 所锁定的上游提交可以到达的那些提交，因为上游自己为其提交签名和措辞。`DELORUN_RANGE_BASE=<rev>` 会取代 `origin/main`，成为每个范围门禁和树通过记录的基准，适用于 `origin/main` 是旧分支的克隆，以及向空仓库的首次推送。指名不到任何提交的基准会在任何检查开始前停止运行，运行标题会指明覆盖。除非门禁指名了较轻的层级，否则它在每个门禁层级中运行：`gates:docs` 与耗时超过约十秒的上游门禁跳过 lane 层级，耗时超过约一分钟、构建站点或读取上游构建产物的上游门禁只在合并层级运行（[本地检查](#local-checks)）。

| 门禁 | 暂存 | 拒绝或检查 |
|---|---|---|
| `gates:licence` | 否 | `delorun/` 下的每个包都声明 MIT，且根 `LICENSE` 是 MIT 许可证。 |
| `gates:no-unknown-casts` | 否 | 上游的 [`verify-no-unknown-casts`](../../../scripts/verify-no-unknown-casts.ts) 作用于每个受跟踪和新增的源文件，包括 Delorun 的：除 `scripts/no-unknown-casts.baseline.json` 中记录的数量之外，不得有向 `unknown` 的断言（`as unknown`、`<unknown>`）。基线是上游的；Delorun 的变更要么移除一个断言，要么用有类型的值取代它，绝不新增条目。 |
| `gates:package-states` | 否 | `delorun/packages` 与 `delorun/apps` 下的每个包和应用都记录 `"delorun": { "state": "shipped" \| "experimental" \| "parked", "unreached"?: "<lane>", "connections"?: [...] }`（`connections` 由 [`@delorun/plugin-onboarding`](../../packages/plugin-onboarding/README.zh.md#connections) 读取），并且该状态与从根（`cli`、`npm-launcher`、`install`、`release`、`tools`、`docs`）出发、经 `dependencies`、`peerDependencies` 与 `optionalDependencies` 的依赖图一致。没有 `unreached` 的 shipped 或 experimental 包是可到达的；带有 `unreached` 的包不可到达，所以该标记在把它接入的变更中去掉；parked 包不可到达，且没有 shipped 或 experimental 包依赖它。没有 `package.json` 的目录（例如 `packages/reach`）被列为非包，不使任何检查失败。 |
| `gates:workspace-graph` | 否 | `delorun/packages` 与 `delorun/apps` 下的包之间，在全部四个依赖区段（包括 `devDependencies`）上都没有依赖环，因为 `pnpm run` 据此排序发布构建并拒绝环；并且 `delorun/apps/release/closure.json` 所指名的部署根，经 `dependencies`、`peerDependencies` 与 `optionalDependencies`，既到达不了 `@delorun/release` 也到达不了 `@delorun/tools`，因此运行时发行包不含发布工具或开发者工具。 |
| `gates:preview-flags` | 否 | `delorun/packages` 下的每个包在 `delorun.previewFlags` 中列出的预览开关，恰好是其插件声明的那些：列出开关或带有 `src/preview-flags.ts` 的包，在该文件中以 `PREVIEW_FLAGS` 导出这些声明；列出的 id 与声明的 id 是同一集合；每个声明都以该包为所有者；其他源码不调用 `previewFlags.declare(`；除非门禁检查的 `HOST_READERS` 列出该文件并说明该读取不会到达模型的原因，否则任何 Host 源码都不得用 `isOn` 读取开关（[`@delorun/preview-flags`](../../packages/preview-flags/README.zh.md)） |
| `gates:secrets` | 是 | 令牌形态的字符串、私钥和密钥文件名，使用 secretlint 的推荐预设和 DeepSeek 的密钥形态。上游逐字持有的某行上的发现会通过。 |
| `gates:personal-data` | 是 | 个人数据模式的加盐哈希，检查暂存变更和范围所新增的行，以及范围内的 Author、Committer 与 Signed-off-by 行；并按形态检查这些行和提交消息中的邮政地址。邮政地址指同一行上的门牌号和街道词，且在该行的街道词之后或下一行的任何位置带有完整的英国邮政编码，或美国州缩写和 ZIP 码。明文模式只存放在 `~/.config/delorun/personal-data.txt` 中；`--rehash` 据该文件重新生成 [`personal-data.hashes.json`](src/checks/gates/personal-data.hashes.json)，文件不存在时以 1 退出。 |
| `gates:infrastructure` | 是 | 回环、未指定与广播地址、RFC 5737 文档范围、云元数据地址 `169.254.169.254`，以及保留 IPv4 块的基地址（`10.0.0.0`、`100.64.0.0`、`169.254.0.0`、`172.16.0.0`、`192.168.0.0`、`224.0.0.0`）之外的 IPv4 地址；全球可路由或唯一本地块中、RFC 3849 文档范围、云元数据地址 `fd00:ec2::254` 与基地址 `fc00::` 之外的 IPv6 地址；`example.ts.net` 之外的 tailnet 名称；以及云账户 ID。已记录的例外按路径和值列在 [`infrastructure.allowlist.json`](src/checks/gates/infrastructure.allowlist.json) 中。 |
| `gates:dco` | 否 | 范围内每个非合并提交都有 `Signed-off-by` 行，其姓名和邮箱是作者的。 |
| `gates:commits` | 否 | 对范围应用提交标准，包括变更日志规则。 |
| `gates:changelog` | 否 | 范围内每个修改了产品文件的提交，要么在 `delorun/changelog/unreleased/` 下新增一个变更片段，要么带有写明理由的 `Changelog: none` 尾注，并且那里的每个片段都能解析。 |
| `gates:doc-times` | 否 | 范围向 `delorun/` 下 Markdown 文件新增的行不含截止日期、季度、日程估计或时间承诺。 |
| `gates:spec-lanes` | 否 | 单元规范（`delorun/apps/*/tests` 或 `delorun/packages/*/tests` 下的 `*.spec.ts` 或 `*.spec.tsx`，`*.integration.spec.ts` 与 `*.docker.spec.ts` 除外）不启动任何进程：它不导入 `child_process`，不调用 `git` 辅助函数，不传入 `tsx/esm` 加载器，也不导入会这样做的测试辅助模块；这样的规范命名为 `*.integration.spec.ts`。这些 `tests` 目录下文件中的每个 `spawnSync`、`execFileSync` 与 `execSync` 调用，都传入带 `timeout` 的字面量选项对象。位于 `// spec-lanes-allow: <reason>` 注释之下或带有该注释的行不受此限。 |
| `gates:whitespace` | 否 | 变更所新增的行上没有行尾空白、缩进中制表符前的空格或结尾的空行（对照与 `origin/main` 的合并基准执行 `git diff --check`，无论是否已提交），并且每个变更的文本文件恰好以一个换行结尾。`--fix` 移除所报告的行尾空白并修复结尾换行；制表符前的空格留给人处理。 |
| `gates:docs` | 否 | 上游对 `delorun/docs/` 的双语配对、字数预算、硬换行、相对链接与 TypeScript 代码围栏检查。当撰写只有英文时，双语配对检查只报告不阻断：它的发现会打印，但其失败不使门禁失败（[翻译命令](#translation-command-specified-not-built)）。 |
| `gates:<upstream id>` | 否 | [`scripts/run-gates.ts`](../../../scripts/run-gates.ts) 中上游的每个静态门禁，经由它自己的包脚本或规范文件，如 [`src/checks/gates/upstream.ts`](src/checks/gates/upstream.ts) 连同其层级所列：生成的目录与图、文档、Agent Note、README、locale、包、依赖、客户端与持久化规则、rescope、重复代码与 lint 检查、publint 以及 NodeNext 声明检查。其他 lane 已运行的检查不重复：`gates:docs` 运行预算、换行、链接与代码围栏检查，并在翻译完成之前仅报告配对检查，`typecheck:upstream` 运行类型检查，`tests:snapshots` 运行录制会话重放。上游的测试、覆盖率、基准、Node 兼容性、Windows 与已构建冒烟 lane 不是仓库门禁，也不在列。在 `main` 上失败的门禁列在[门禁欠账](#gate-debt)中。 |
| `gates:fundamentals` | 否 | [`delorun/docs/security/fundamentals.md`](../../docs/security/fundamentals.zh.md) 的表格有 ID、Fundamental、Status、Enforced by 与 Proven by 这几列；id 不重复，且都是 `F` 加数字；每个状态是 `enforced` 或 `designed`。对 `enforced` 行，所指名的每个文件都存在且是该门禁声明的输入之一，所指名的每个规范文件都有一个 `it` 或 `test` 调用（包含 `.each` 与 `.concurrent`，不含被跳过的测试），其字面标题或 `.each` 模板等于所引用的标题。`designed` 行的路径不检查。它打印每种状态下的 fundamental 数量。 |

网络测试的允许清单 [`network-requests.json`](src/checks/network-requests.json) 列出 Delorun 未经请求而发出的每个请求，包括其主机、目的、发送的内容、关闭它的开关和披露位置，以及仅在此人要求时才发出请求的文件；fork 套件中的 [`tests/gates/network-requests.integration.spec.ts`](tests/gates/network-requests.integration.spec.ts) 在以下情况下失败：已发布的源文件使用了对外网络原语却未列出，或列出的开关、披露位置或文件不存在。它发现不了在已列出的文件中新增的请求，也发现不了经由另一个包的客户端发出的请求。

[门禁工作流](../../../.github/workflows/gates.yml)在拉取请求和对 `main` 的推送上运行每个门禁，并把每个拉取请求的基点或每次推送的上一个顶端作为范围传入。它的个人数据步骤只对照已提交的哈希，检查范围所新增的行和提交元数据。

### 门禁欠账

[`src/checks/gates/debt.json`](src/checks/gates/debt.json) 列出在 `main` 上失败的门禁，每个带一行理由；[`src/checks/gates/debt.ts`](src/checks/gates/debt.ts) 读取它。运行器通过 `debt.ts` 运行列出的门禁，后者在门禁通常的层级中运行该门禁自己的命令：失败时打印该门禁的发现和 `reported, not failing`，并算作通过；通过时则让这次运行带着 `passes, so remove its entry` 失败，因此修复某个门禁的变更同时移除其条目，列表只会缩短。无法启动或被信号终止的门禁会使运行失败，因为它什么也没有报告。当条目没有指名任何门禁时加载目录失败；当条目没有理由或理由跨多行时，列表的 JSON 被拒绝，所以条目只有连同理由才能添加。该列表是每个所列门禁的输入之一，所以编辑它会重新运行该门禁。

## 翻译命令（已规定，尚未构建）

撰写只用英文。页面的中文对应页（`*.zh.md`）及其一致性记录（`*.i18n.yaml`）在一次翻译中写成，因此 `gates:docs` 的双语配对检查只报告缺失或过期的配对，不使门禁失败。

该命令是 `node_modules/.bin/tsx delorun/apps/tools/src/translate-docs.ts [--check] [path…]`。它不在仓库中。

- 它用与上游配对检查相同的发现方式，找出每个范围内的源文件，其 `.zh.md` 缺失或其记录已过期。
- 对每个源文件，它用模型写出中文对应页，按 [docs/i18n/README.md](../../../docs/i18n/README.zh.md) 的要求逐行对齐，然后用 `scripts/verify-translation-pairing.ts --write` 记录该配对。
- `--check` 列出它将会写入的内容并以 0 退出。
- 它需要模型密钥，只有负责人运行它，lane agent 绝不运行。
- 在它运行过且其列表为空之后，从 [`docs.ts`](src/checks/gates/docs.ts) 的双语配对条目中移除 `reportOnly`，使配对检查再次让变更失败。

## 工作流

上游的工作流位于 [`.github/workflows`](../../../.github/workflows)。每一行给出工作流的触发条件、它需要 DeepSeek 的什么，以及 Delorun 的处置。**保留**（Keep）表示该工作流在本仓库中运行，并带有其台账条目所指名的运行器路由。**守卫**（Guard）表示它的作业带有 `if: github.repository == 'deepseek-ai/deepseek-harness'`，因此只在上游的仓库中运行；每个被守卫的文件在台账中都有一个 `delorun-feature` 条目。Delorun 自己的工作流是 [`gates.yml`](../../../.github/workflows/gates.yml)。

| 工作流 | 触发条件 | 需要 DeepSeek 的密钥或基础设施 | 处置 |
|---|---|---|---|
| `build-exe-for-python-sdk.yml` | `workflow_call`、`workflow_dispatch` | 用于已安装 wheel 真实 API 测试的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `build-exe-for-ssh-helper.yml` | `workflow_call`、`workflow_dispatch` | 无；GitHub 托管运行器 | 保留 |
| `build-preview-cloudflare.yml` | `pull_request` | Cloudflare Pages 与 Access 密钥（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`） | 守卫 |
| `ci-master.yml` | 对 `master` 的 `push`、`workflow_dispatch` | 密钥 `DEEPSEEK_API_KEY_EXTERNAL`；自托管运行器 `dsh-win-ci` 与 `vm-backup` | 守卫 |
| `ci-python.yml` | `pull_request` | 用于已安装 wheel 测试的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `ci-windows.yml` | `pull_request` | 无需任何东西。上游的运行器标签只在上游的仓库中适用（见下面的说明） | 保留，已路由 |
| `ci.yml` | `pull_request` | 无需任何东西。上游的运行器标签只在上游的仓库中适用（见下面的说明） | 保留，已路由 |
| `cua-helper-package.yml` | `workflow_dispatch`、`workflow_call` | 带签名配置的自托管运行器 `dsh-mac-package-trial` | 守卫 |
| `desktop-publish.yml` | `workflow_dispatch` | 经由 `DESKTOP_PUBLISH_RUNNERS` 路由的自托管运行器；环境 `desktop-test` 与 `desktop-production` | 守卫 |
| `docs-pages.yml` | `workflow_dispatch` | GitHub Pages 环境 `github-pages` 与一个 Blacksmith 运行器 | 守卫 |
| `e2e.yml` | `workflow_dispatch`、对 `main` 和 `master` 的 `push`、`pull_request`、每夜 `schedule` | 用于真实 DeepSeek API 的密钥 `DEEPSEEK_API_KEY_EXTERNAL` | 守卫 |
| `expected-filenames.yml` | `pull_request` | 无；GitHub 托管运行器 | 保留 |
| `issue-lifecycle.yml` | `issues`、`pull_request`、`pull_request_review` | GitHub App 密钥 `DSH_ISSUE_APP_PRIVATE_KEY` 与变量 `DSH_ISSUE_APP_CLIENT_ID`；上游的 Issue 类型与字段 | 守卫 |
| `issue-policy.yml` | `pull_request`、`pull_request_review` | 同一个 GitHub App 密钥与变量 | 守卫 |
| `macos-intel-package.yml` | `workflow_dispatch` | 自托管运行器 `dsh-mac-package-trial`；签名与更新渠道 | 守卫 |
| `macos-package.yml` | `workflow_dispatch` | 自托管运行器 `dsh-mac-package-trial`；签名与更新渠道 | 守卫 |
| `node-addon-system-release.yml` | `workflow_dispatch` | 用于 `@deepseek-ai` 作用域的密钥 `NPM_TOKEN` 与环境 `npm-publish` | 守卫 |
| `node-addon-system.yml` | 按路径的 `pull_request` 与对 `master` 的 `push`；`workflow_dispatch` | 无；GitHub 托管运行器 | 保留 |
| `pi-ai-provider-e2e.yml` | `workflow_dispatch` | 用于付费提供方调用的密钥 `ANTHROPIC_API_KEY_EXTERNAL` 与 `AZURE_OPENAI_API_KEY_EXTERNAL` | 守卫 |
| `pr-check-after-approve.yml` | `pull_request_target`、`pull_request_review` | GitHub App 密钥 `DSH_APPROVAL_APP_PRIVATE_KEY`；上游的 `Policy` 检查 | 守卫 |
| `pr-check-on-base-branch.yml` | 对 `master` 的 `push`、`workflow_dispatch` | 密钥 `DSH_RECHECK_LABEL_TOKEN`；上游的 `deepseek-harness-check` action | 守卫 |
| `pr-check-on-head-branch.yml` | `pull_request_target` | 上游的 `deepseek-harness-check` action；一个 Blacksmith 运行器 | 守卫 |
| `publish-ssh-helper.yml` | `workflow_dispatch` | 为上游的 `dsh-v` 标签发布 GitHub Release | 守卫 |
| `python-release.yml` | `workflow_dispatch` | PyPI 环境 `pypi` 与 `pypi-runtime`；变量 `PYPI_PUBLISHER_REPOSITORY` 与 `PUBLIC_PYPI_RELEASE_ENABLED` | 守卫 |
| `release-publish.yml` | `workflow_dispatch` | 用于 `dsh` 发布序列的密钥 `NPM_TOKEN` 与环境 `npm-publish` | 守卫 |
| `release-vendor-publish.yml` | `workflow_dispatch` | 用于 vendor 序列的密钥 `NPM_TOKEN` 与环境 `npm-publish` | 守卫 |
| `release-vendor.yml` | `pull_request`、对 `master` 的 `push`、`workflow_dispatch` | 无；打包不需要凭据。仅当设置了故障转移变量时，才适用自托管路由 | 保留 |
| `release.yml` | `pull_request`、对 `master` 的 `push`、`workflow_dispatch` | 无；打包不需要凭据。仅当设置了故障转移变量时，才适用自托管路由 | 保留 |
| `sandbox.yml` | 对 `master` 的 `push` | 无；GitHub 托管镜像。触发条件指名 `master`，Delorun 不使用它 | 保留 |
| `weighted-approval-review-event.yml` | `pull_request_review` | 无；记录 `weighted-approval` 所读取的评审事件 | 保留 |
| `weighted-approval.yml` | `pull_request_target`、`issue_comment`、`workflow_run` | GitHub App 密钥 `DSH_APPROVAL_APP_PRIVATE_KEY`；变量 `DSH_APPROVAL_APP_CLIENT_ID` 与 `DSH_APPROVAL_APP_SLUG` | 守卫 |
| `windows-package.yml` | `workflow_dispatch` | 带签名配置的自托管运行器 `dsh-win-package-trial` | 守卫 |

`ci.yml` 与 `ci-windows.yml` 不需要任何密钥，所以保留。每个作业都保留上游的运行器表达式，作为在上游仓库中适用的分支，在那里 DeepSeek 的运行器标签（例如 `dsh-ubuntu-24-04-16core` 与 `dsh-windows-2025-16core`）继续使用。其他每个仓库都在 `ubuntu-latest` 或 `windows-latest` 上运行该作业，所以本仓库从不等待 DeepSeek 的运行器。每个文件都有一个针对这一路由的 `delorun-feature` 台账条目。

`release.yml` 与 `release-vendor.yml` 中的自托管路由由 `github.repository == 'deepseek-harness/deepseek-harness'` 守卫，它所指名的组织与台账中的上游仓库不同。该路由仅在设置了故障转移变量时适用，所以 Delorun 到达不了它；守卫中的组织名保持上游所写的样子。

## Brief Issue

`src/issues/issues.ts` 把 brief 文件转为 brief Issue。
brief 文件是一个 JSON 对象数组。
每个对象按[brief 模板](../../../.agents/skills/delorun-delegation/SKILL.md#write-the-brief)的标签持有其十六个字段，另有 `title`、Issue 所带的 `labels` 以及它的 `milestone`。
Issue 表单 [`brief.yml`](../../../.github/ISSUE_TEMPLATE/brief.yml) 按相同的顺序索取相同的字段，[`labels.yml`](../../../.github/labels.yml) 定义这些标签。

在仓库根目录以三种模式之一运行该工具：

- `--input <briefs.json> --dry-run` 验证 brief 并打印每个 Issue 正文。
- `--input <briefs.json> --create --repo <owner/name>` 验证 brief，并检查 `gh` 是以该仓库的维护者身份登录的。然后对每个 brief 创建 Issue 并锁定它；若已存在同标题的 Issue，则在它未锁定时锁定它，已锁定时跳过它。
- `--sync-labels --repo <owner/name>` 用 `gh label create --force` 创建或更新 `labels.yml` 中的每个标签。

```sh
node_modules/.bin/tsx delorun/apps/tools/src/issues/issues.ts --input delorun/apps/tools/tests/issues/fixtures/briefs.valid.json --dry-run
```

每个问题在标准错误上打印一行，并在任何 GitHub 调用之前以 1 退出。
brief 在以下情况下有问题：

- 字段缺失、为空或未知，或文件不是非空的 brief JSON 数组；
- `Model` 不是 Haiku 的 medium、high 或 max 强度，或 Opus 的 medium 或 high 强度，所以 Opus 的 max 强度会被拒绝；
- 链接既不是 github.com/twickas/delorun 或 docs.delorun.com 上的 `https://` URL，也不是仓库所跟踪的相对路径；
- 带反引号的路径（其第一段是仓库的顶层目录）没有指名任何受跟踪的文件或目录，但 `You own` 中允许新文件或新目录，只要其最近的现有父目录是受跟踪的；
- 文本指名了私有计划目录 `delorun/docs/plans/`，或指名了机器路径，例如以 `/home/`、`/Users/` 或 `~/` 开头的路径；
- 标签没有在 `labels.yml` 中定义，标签省略了 `brief`，或 brief 带有 `kind/*` 标签（它属于拉取请求）；
- 某个字段向正文添加了 Markdown 标题，两个 brief 共用同一标题，或已有两个 Issue 共用某个 brief 的标题。

路径对照 `git ls-files` 检查，所以在 `You own` 之外，文件必须先进入索引，brief 才能指名它。
当 `You own` 中的新路径其在工作树中最近的现有父目录未被跟踪时，它被拒绝。
渲染后的正文把每个受跟踪的路径链接到公共仓库 `main` 分支上的对应位置：文件链接到其 `blob`，目录链接到其 `tree`。
brief 已带有的链接以同样的方式改写。
包含命令的代码片段和围栏代码块保持原样。
在 `--create` 之前，在仓库中创建标签和里程碑，因为 `gh issue create` 遇到仓库未定义的标签或里程碑会失败。

已知限制：

- `gh` 2.45 没有设置原生 Issue Type 的标志，所以 `--create` 创建的 Issue 没有 Issue Type。
- 链接指向 `main` 分支，所以只存在于 brief 自己分支上的路径在该分支合并之后才会解析。
- 标题检查最多读取 1000 个 Issue，并拒绝达到该数量的列表。

`tests/issues/` 中的规范在临时仓库中运行该工具，并把一个假的 `gh` 放在 `PATH` 的最前面，没有任何规范访问 GitHub。

## Studio 浏览器

[`src/studio-browser.ts`](src/studio-browser.ts) 针对回环地址上的 studio 运行 Playwright 风格的脚本，并可把运行录制为 WebM：`node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts check` 与 `... run --url <studio url> --code '<js>' [--record <out.webm>]`。
浏览器工具位于 [`src/studio-browser/adapter.ts`](src/studio-browser/adapter.ts) 中的 `StudioBrowser` 接口之后；默认适配器 `playwright` 会按所选视口和配色方案启动仓库自带的无头 Chromium，运行步骤和脚本并截图，而用 `--adapter browse` 选择的 `browse` 适配器则通过 `browse` CLI 驱动此人自己的 Chrome。[`origin.ts`](src/studio-browser/origin.ts) 拒绝每个非回环地址，且没有办法放宽。
流程见 [`delorun-studio-browser`](../../../.agents/skills/delorun-studio-browser/SKILL.md) skill。

<a id="local-checks"></a>

## 演示主目录与图片

产品网站的首屏图和指南中的图片，都是演示主目录的截图。这个主目录里只有虚构的 chat 和项目：没有任何人自己的内容，也没有真实的路径、姓名、地址或密钥。[`src/demo-home.ts`](src/demo-home.ts) 不用模型就能建好它。它从源码运行 `delorun setup --yes`，使用一个不会被发送的占位密钥，写出 [`src/demo-home/content.ts`](src/demo-home/content.ts) 中虚构的项目文件夹，把它们登记为工作区，并通过 DeepSeek chat 导入自己的上传路由存入它们的 chat。之后 studio 把它们当作普通历史来读取。

```sh
node_modules/.bin/tsx delorun/apps/tools/src/demo-home.ts --home /tmp/delorun-demo/home
node_modules/.bin/tsx delorun/apps/tools/src/demo-home.ts --home /tmp/delorun-fresh/home --no-chats
```

第一条命令建出含三个项目和六个 chat 的主目录，项目文件夹在它旁边的 `/tmp/delorun-demo/projects`。第二条建出没有 chat 的主目录，用于首次运行向导。每次运行时 studio 都要处于停止状态，并且要先运行 `pnpm run build:artifacts`，再构建 `delorun/packages` 中带 `build` 脚本的包。脚本把 setup 用的用户主目录设为 `--home` 的上一级文件夹，因此不会出现真实路径。

要从源码提供一个主目录，在 `<home>/profiles/default/cordis.patch.yml` 末尾追加一行 `webserver`，写上一个空闲的高端口（`host: 127.0.0.1`、`port: <n>`），然后在 `delorun/apps/cli` 中运行 `delorun start --foreground`，并设置 `HOME` 和 `DELORUN_HOME` 为上述文件夹、`DEMO_HOME_KEY=sk-demonstration-placeholder-never-sent`，以及 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost`。代理设置让 studio 的密钥测试到不了任何提供方，所以不会出现“key did not pass its test”横幅，占位密钥也不会离开这台电脑。`delorun open --print` 会打印登录链接。

图片通过所有者的浏览器用 `browse`（Windows：`/mnt/c/Users/<user>/.local/bin/browse.exe`）在回环地址上拍摄。在标签页中打开 studio 的源，用 `browse emulate <tab> --viewport '{"width":1440,"height":900,"deviceScaleFactor":1}'` 设定窗口，用 `browse eval <tab>` 运行 `location.href = '<link>'` 登录，再用 `browse screenshot <tab> --format webp --quality 85 --scale device --path <name>.webp` 保存每张图片。标签页可能在两次调用之间消失，`browse` 提示它已消失时重新打开即可。在新的演示主目录中，先在首次运行向导上选择 **Finish later** 和 **Continue**，再把每个 chat 打开一次，侧边栏才会显示它的标题。

| 图片 | 文件 | 页面 | 窗口 | 路径与步骤 |
| --- | --- | --- | --- | --- |
| 打开了一个 chat 的 studio | `delorun/apps/website/public/hero-studio.webp` | 网站首页 | 1440 × 900 | 演示主目录。打开“Lay out four raised beds”，向上滚动到它的表格出现。 |
| 首次运行向导 | `delorun/docs/guide/pictures/first-run-guide.webp` | [安装与首次运行](../../docs/guide/get-started/install.zh.md) | 1440 × 900 | 没有 chat 的主目录。studio 打开时的 Welcome 步骤。 |
| 更改主题，之前 | `delorun/docs/guide/pictures/theme-soft.webp` | [自定义](../../docs/guide/customising/customise.zh.md) | 1440 × 900 | 演示主目录。Settings，然后 Appearance。 |
| 更改主题，之后 | `delorun/docs/guide/pictures/theme-ocean.webp` | [自定义](../../docs/guide/customising/customise.zh.md) | 1440 × 900 | 在 Theme 下选择 Ocean 之后的同一页。之后再选回 Soft。 |
| 设置版本 | `delorun/docs/guide/pictures/setup-versions.webp` | [更新](../../docs/guide/safety-and-updates/updates.zh.md) | 1440 × 900 | 更改主题之后：Settings，然后 Data 下的 Setup versions。 |
| 手机上的 studio | `delorun/docs/guide/pictures/phone-chat.webp` | [远程访问](../../docs/guide/everyday-use/reach.zh.md) | 390 × 844，倍率 2，移动端；`--scale css` | 演示主目录。用 `"deviceScaleFactor":2,"mobile":true` 运行 `browse emulate`，重新加载，打开“Lay out four raised beds”。 |

更新报告是 `delorun update --report` 的输出，它需要两个版本和一个正在运行的已安装 Delorun，所以“更新”页改为展示设置版本。指南的图片放在 `delorun/docs/guide/pictures/`；页面用 `pictures/phone-chat.webp` 这样的相对路径引用图片，文档站点的构建会带内容哈希地把它打包进页面，并把该文件夹复制到 `/guide/pictures/`，供 Markdown 路由使用。

## 本地检查

[`src/run-checks.ts`](src/run-checks.ts) 运行本地检查。目录是 [`src/checks/plan.ts`](src/checks/plan.ts)，它按变更和按包选择检查；[`src/checks/run.ts`](src/checks/run.ts) 在每个检查的前置条件通过、CPU 和内存空闲时启动它；[`src/checks/machine.ts`](src/checks/machine.ts) 设置内存上限；[`src/checks/cache.ts`](src/checks/cache.ts) 从通过缓存中提供未变化的检查。仓库门禁来自 [`src/checks/gates/index.ts`](src/checks/gates/index.ts)，预算来自 [`src/checks/budgets.json`](src/checks/budgets.json)。

重量级运行通过系统临时目录下的槽位预算共用机器（[`src/checks/slots.ts`](src/checks/slots.ts)），而不是一次只运行一个。机器有 CPU 槽位（它的 CPU 数，或 `DELORUN_CHECKS_SLOTS`）、运行器所预算的内存，以及三个重磁盘位置（`DELORUN_CHECKS_DISK_RUNS`），用于构建、生成器、文档站点和 fork 套件，因为共享机器的磁盘比其 CPU 先饱和。一次运行请求其真正会运行的检查能让其保持忙碌的槽位（已存通过所服务的检查不请求任何东西，没有东西可运行的运行不占用槽位）、在能用到时至少四个、其最大检查的内存，以及在需要时一个重磁盘位置（[`src/checks/demand.ts`](src/checks/demand.ts)）。它在用户自己的 `delorun-checks-<uid>.slots/` 中写入请求 `req-<priority>-<milliseconds>-<pid>.json`，该目录以模式 0700 创建，并在它是链接、属于另一用户或对其他人开放时被拒绝；当其最小需求能与持有者并存、且所有更早的请求都已启动时，请求按先到先得（在同一优先级内）被批准；不接触磁盘的请求可以越过只等待重磁盘位置的请求, and a later request may start beside the head (the first request that does not fit) when it fits, touches no disk and is granted its minimum, as long as the slots and memory held by runs granted after the head began to wait, with its grant, stay within the machine less the head's minimum and memory, so the head still starts as soon as the runs that were there before it finish。批准量是该运行所请求的、最多到空闲槽位数，且至多为机器的槽位数减去其四分之一，所以小的运行总能与大的运行一起启动；主干优先级（推送的引用包含主干的 pre-push，或 `DELORUN_GATE_PRIORITY=trunk`）排在每个等待请求之前，也可以占用那四分之一，且从不中断持有者。获得批准的运行把其测试运行器的 `--maxWorkers` 收窄到它的槽位数（没有通过键记录它），并把批准记录为 `held-<pid>.json`，直到它结束或被中断；每个文件记录其进程的启动时间，所以已死进程的文件会被最先发现它们的任何运行移除，即使之后的进程重用了它的 id；两个同时声明而使槽位、内存或重磁盘位置超额的运行，由对该资源较晚声明的一方退让来解决。等待的运行在每次变化时以及每 30 秒打印一次它为何等待、它的位置和已等待多久，运行的摘要和 `report.json`（`waitedSeconds`、`slots`、`ioPressureAtStart`、`ioPressureAtEnd`）记录等待、批准，以及开始和结束时的磁盘压力（`/proc/pressure/io`，`some avg10`）。`run-checks --queue` 打印持有者及其槽位、内存和已持有多久，以及按服务顺序排列的等待请求。如果一次运行中将要运行的检查各只让一个 CPU 保持忙碌，既不是 `exclusive` 也不是 `mergeOnly`，并且内存预算之和至多 4 GiB（`isLightPlan`），例如在同一棵树的一次通过的运行之后紧接着推送的范围门禁和边界检查，则它不占用槽位，提交前层级和 `--preflight` 也不占用。仅作为另一个检查的前置条件而被规划的检查（例如原生插件的构建），在已存通过服务于每个需要它的检查时不运行。较旧工作树的运行仍然在 `delorun-checks.queue/` 中取一张票，或使用锁文件 `delorun-checks.lock`：那里的存活持有者对新的运行持有整台机器，那里等待的较旧的票先于这里较晚的请求得到服务，并且这里的每个请求也在那里持有一张等待的票，批准后继续持有，所以较旧与较新的运行保持同一个先到先得的顺序，较旧的运行等待新的持有者，就像等待一个持有者那样。机器暂停（hold）让队列不再批准任何新请求：`run-checks --hold "<reason>" [--allow <worktree>]...` 在槽位目录中写入 `hold.json`（`{ reason, since, allow }`，先写入 `.tmp` 文件再重命名）并打印它；该文件存在期间，无论还有多少空闲槽位，每个请求都等待，原因为 `machine held: <reason>`，但工作目录（记录在请求文件的 `cwd` 中）位于某个允许的工作树内的请求除外；没有记录工作目录的请求（如较旧的请求文件）不豁免，`/w/ab` 不在 `/w/a` 之内。被暂停挡住的请求不会启动任何东西，所以它们既不占用槽位，也不挡住排在它们后面的允许请求；`--allow` 会解析符号链接，使链接形式的工作树路径与工作目录相匹配。已在运行的持有者从不被中断；`with-slots.ts` 和 `run-checks` 不需要新的选项，因为它们本来就通过队列等待，30 秒的等待报告会显示原因。`--unhold` 删除该文件，之后等待的请求按其正常顺序继续，没有请求会丢失位置；损坏或无法读取的暂停文件视为一次暂停，原因为 `hold file unreadable`，`--unhold` 同样会删除它。`--queue` 先于预算打印暂停及其原因、开始时间和允许的工作树。较旧工作树的运行不读取该暂停：它们照旧在先前的队列中排队，所以该暂停只约束拥有此代码的工作树。

一次运行的临时文件放在系统临时目录下的一个临时目录中，位于磁盘上。`DELORUN_CHECKS_SCRATCH=memory` 在内存文件系统（`/dev/shm`，否则 `$XDG_RUNTIME_DIR`）有 `DELORUN_CHECKS_SCRATCH_GIB`（默认 4）空闲空间时，改把它们放在内存文件系统上，运行的内存预算让出这么多；没有一个有这么多空间时，运行会说明并使用磁盘。`DELORUN_CHECKS_SCRATCH=disk` 是默认值，因为内存文件系统会使 `fsync` 什么也不做，而一些规范要证明持久性或文件系统自身的行为。

[`src/with-slots.ts`](src/with-slots.ts) 在同一预算内运行临时的重量级命令，使 agent 自己的构建、编译器运行和有针对性的测试运行像运行器那样占用机器：`node_modules/.bin/tsx delorun/apps/tools/src/with-slots.ts [--slots <n>] [--disk] [--memory-gib <n>] -- <command> [args...]` 等待 `--slots` 个槽位（默认 4），带 `--disk` 时还等待一个重磁盘位置，用 `DELORUN_SLOTS` 中的批准量运行该命令（以 `--maxWorkers=$DELORUN_SLOTS` 传给测试运行器），命令结束或被中断时释放槽位，并以该命令的状态退出。仓库、其工作树、pnpm 存储和缓存必须位于 Linux 文件系统上：在 WSL 上，运行器会从它启动的每个检查的 `PATH` 中去掉 Windows 目录（`/mnt/<letter>/...`），而位于 `/mnt/` 下的检出会让每次文件读取都落在 Windows 磁盘上。

每个检查都有预算，即其峰值常驻内存及其 CPU 数，运行器把它们保持在这次运行的上限之内；还有层级，即选中它的调用方式：`pre-commit` 在暂存路径上运行，`changed` 按变更选择（`--changed` 和 pre-push 钩子），`full` 是完整门禁。

| 检查 | 它证明什么 | 预算 | 层级 |
| --- | --- | --- | --- |
| `boundary` | 与上游的每一处差异都是 fork 自有的、台账条目或路径规则（[`check-fork-boundary.ts`](src/check-fork-boundary.ts)） | 0.3 GiB，1 个 CPU | `changed`、`full` |
| `gates:*` | [`checks/gates/index.ts`](src/checks/gates/index.ts) 中的每个仓库门禁；标为 `staged` 的门禁也在 `pre-commit` 中运行 | 各 0.5 GiB，1 个 CPU | `changed`、`full`；暂存门禁还有 `pre-commit` |
| `whitespace:staged` | 暂存的变更中没有空白错误（`git diff --cached --check`） | 0.1 GiB，1 个 CPU | `pre-commit` |
| `jsdoc` | 上游的 JSDoc 规则作用于 fork 的 `src` 树的每个导出（[`check-jsdoc.ts`](src/check-jsdoc.ts)） | 1.5 GiB，1 个 CPU | `changed`、`full` |
| `typecheck:upstream` | 上游的增量类型检查（`pnpm run typecheck`），fork 的程序读取它的声明 | 2.5 GiB，2 个 CPU | `changed`、`full` |
| `typecheck:delorun:<program>` | 对每个 Delorun tsconfig 执行 `tsc -p`，每个程序一个检查；`--only typecheck:delorun` 选中全部 | 各 1 GiB，1 个 CPU | `changed`、`full` |
| `build:artifacts` | 上游的运行时 bundle，仅当某个缺失或比其源码旧时才构建（`pnpm run build:artifacts`） | 4 GiB，4 个 CPU | `changed`、`full`，过期时 |
| `tests:fork` | 单元阶段：`delorun/apps/*/tests` 与 `delorun/packages/*/tests` 下除集成和 Docker 规范之外的每个 `*.spec.ts` 与 `*.spec.tsx`（[`vitest.config.ts`](../../vitest.config.ts)，项目 `fork` 与 `fork-client`），每个测试 10 秒、每个钩子 20 秒；客户端组件规范（`.spec.tsx`）为 30 秒，因为 jsdom 渲染是 CPU 工作，并在 jsdom 中运行，上游包解析到其源码 | 每个 worker 0.5 GiB | `changed`、`full` |
| `tests:fork:integration` | 集成阶段，在单元阶段之后：每个 `*.integration.spec.ts`（项目 `fork-integration`），即启动 git、Node 或 `tsx` 子进程、组合真实配置、构建真实发布树，或对真实文件树进行大量持久写入的规范，每个测试 60 秒、每个钩子 120 秒，最多 4 个 worker | 每个 worker 1 GiB | `changed`、`full` |
| `tests:moved-clock` | 单元与客户端组件规范在进程内运行三次，`Date` 分别取真实时间、向前拨 2 天和 400 天（[`vitest.moved-clock.config.ts`](../../vitest.moved-clock.config.ts)、[`checks/moved-clock.ts`](src/checks/moved-clock.ts)）；对于今天通过而在拨动日期后失败的每个测试，它都会失败，这类测试固定了一个日期，却让代码读取时钟。它不拨动文件系统所记录的时间；对这种情形，它会先对每个含有今天及以后日期、且写文件时未设置其时间（`utimes`）的规范打印一条警告，而不是失败。它不含集成项目（其子进程读取系统时钟），也不含 `MOVED_CLOCK_EXCLUDED` 连同理由列出的规范（OpenSSL 对照系统时钟检查的 TLS 证书；规范所写文件的时间与 `Date.now()` 比较） | 每个 worker 0.5 GiB，最多 8 个 worker | 无：`--only tests:moved-clock`，在发布前以及添加了带日期 fixture 的变更之后 |
| `tests:docker` | `delorun/apps/*/tests` 与 `delorun/packages/*/tests` 下的每个 `*.docker.spec.ts` 规范，一次一个文件，针对当前上下文的 Docker 引擎（[`vitest.docker.config.ts`](../../vitest.docker.config.ts)）；只在含有 Docker 规范的树中提供，在变更所触及的包上，带 `DELORUN_DOCKER_SPECS=1` 运行；在没有引擎应答 `docker info` 时被拒绝 | 1 GiB，2 个 CPU | `changed`（仅合并层级）、`full` |
| `journey` | 由该树的产物构建的发布，通过打包的启动器在只能访问规范服务器的干净容器中安装，并从第一次 `npx` 起依次走过 setup、一次 chat、自定义、更新、回滚、`verify`、回收站、导出和导入（[`delorun/apps/release/tests/journey`](../release/README.zh.md#the-journey)）；只在含有其规范的树中提供，由对 Delorun 代码或上游运行时代码的变更选中，运行时会等待 `build:artifacts` 和 `build:delorun`，并带 `DELORUN_JOURNEY=1` 运行；在没有引擎应答 `docker info` 时被拒绝 | 6 GiB，4 个 CPU，独占，1800 秒 | `changed`（仅合并层级）、`full` |
| `tests:snapshots` | 上游的免密钥录制会话重放（`pnpm run test:snapshot`） | 每个 worker 0.6 GiB，5 个 CPU，独占 | `changed`（仅合并层级）、`full` |
| `tests:upstream-changed` | 每个变更的上游包的规范，以及在 150 个规范文件之内，或在该包持有 `security` 台账条目时，它的直接依赖方的规范（[上游的 `vitest.config.ts`](../../../vitest.config.ts)） | 每个 worker 0.6 GiB，最多 8 个 worker | `changed` |
| `tests:web-changed` | 所触及的、在 `apps/web/tests` 下的 Chromium e2e 规范，在官方客户端构建上运行，最多 12 个规范，超过此数则在合并层级中取有界的选择（[`checks/web.ts`](src/checks/web.ts)） | 5 GiB，8 个 CPU，独占，1200 秒 | `changed`（仅合并层级） |
| `tests:closure` | 由工作树的产物用 `build-closure.ts --artifacts existing` 构建的 `HEAD` 的 `linux-x64` 运行时发行包，然后对它运行 [`boot.closure.integration.spec.ts`](../release/tests/closure/boot.closure.integration.spec.ts)：setup 与启动、回环上的 studio，以及对每个顶层命令各一条命令的 `--version`，`PATH` 中既没有 pnpm 也没有 git（[`checks/closure.ts`](src/checks/closure.ts)）；规范文件缺失，或这次运行没有通过任何测试或跳过了某个测试时失败；由对 Delorun 代码、manifest 或锁文件的变更选中；需要位于 `HEAD` 的干净工作树；在 `linux-x64` 之外的主机上被拒绝，这会使合并层级的运行失败 | 4 GiB，4 个 CPU，独占，1800 秒 | `changed`（仅合并层级）、`full` |
| `build:delorun` | 声明了 `build` 脚本的 Delorun 各包的构建产物（`pnpm --filter <package> run build`，一次一个包）；仅当某个包在 `lib/` 下其 `exports` 与 `files` 所指名的运行时文件缺失或比其 `src` 旧时才出现，每个加载构建代码的 lane 都等待它 | 1.5 GiB，2 个 CPU | `changed`、`full`，过期时 |
| `generate:native` | 上游的原生系统插件（`pnpm run build:native-system`）；没有层级选中它，加载该插件的每个 lane（`tests:fork`、`tests:fork:integration`、`tests:snapshots`、`tests:upstream-changed`、`parity-replay`、`parity-replay:control`）都在其前置条件中声明它 | 1 GiB，2 个 CPU | 无：这些 lane 的前置条件，或 `--only generate:native` |
| `benchmark:delorun` | Delorun 的等待时间基准，对照 [`budgets.json`](../benchmarks/budgets.json) 中的上限（`pnpm run benchmark:delorun -- --check-budgets`，[基准](../benchmarks/README.zh.md)）；需要先运行 `pnpm run benchmark:delorun -- --prepare` | 6 GiB，4 个 CPU，独占 | 无：`--only benchmark:delorun` |
| `docs-site` | Delorun 的文档网站能构建，且其死链接检查通过（[`delorun/apps/docs`](../docs/README.zh.md)）；在站点依赖安装之前拒绝运行（[`check-docs-site.ts`](src/check-docs-site.ts)） | 2 GiB，2 个 CPU，900 秒 | `changed`、`full` |
| `website-site` | Delorun 的产品网站能构建，且其死链接检查通过（[`delorun/apps/website`](../website/README.zh.md)）；与 `docs-site` 是同一个运行器，参数为 `website`；由对站点、[`delorun/packages/site-design`](../../packages/site-design/src/tokens.css) 或变更日志记录的变更选中 | 2 GiB，2 个 CPU，900 秒 | `changed`、`full` |
| `generated:notices` | 已提交的 `THIRD_PARTY_NOTICES.md` 与上游的生成器根据已安装的 manifest 写出的内容一致（`scripts/gen-third-party-notices.ts --check`）；由对任何 `package.json`、锁文件、声明或生成器的变更选中 | 1 GiB，1 个 CPU，120 秒 | `changed`、`full` |
| `parity-switches` | C16 的注册表对照开关字段、对等覆盖层和模型可见贡献，以及开关扫描（[`check-parity-switches.ts`](src/parity/composition/check-parity-switches.ts)） | 0.5 GiB，1 个 CPU | Delorun 代码或上游编辑时为 `changed`，`full` |
| `parity-replay` | 上游的录制会话重放（`pnpm run test:snapshot`），其中 `DSH_SNAPSHOT_PATCH` 指名对等覆盖层 | 每个 worker 0.6 GiB，5 个 CPU，独占 | Delorun 代码或上游编辑时为 `changed`（仅合并层级），`full` |
| `parity-replay:control` | 重放的反向对照，即 C16 的拒绝测试 `parity replay refuses a model-visible switch left on`：一个录制的 headless 场景，在植入的覆盖层让 `profile_history` 保持开启的情况下重放，必须在其请求头上失败（[`replay-control.ts`](src/parity/composition/replay-control.ts)） | 1.5 GiB，1 个 CPU | Delorun 代码或上游编辑时为 `changed`（仅合并层级），`full` |

变更运行还有门禁层级，它规定对其选择要付出多少。lane 层级是推送非主干分支时运行的：边界检查、JSDoc 规则（`jsdoc`）、每个没有指名较轻层级的仓库门禁（`gates:docs` 和较慢的上游门禁指名 agent 层级，最重的指名合并层级）、变更包中 Delorun 程序的类型检查（以及它们读取的 `typecheck:upstream`），以及仅针对变更包（不含其依赖方）的 fork 套件的两个阶段；这些所需的检查（例如过期的构建）也会运行。agent 层级是某个 lane 的 agent 在工作时运行的：变更路径选中的、除仅合并之外的每个检查，包括依赖方。合并层级也运行仅合并的检查，只有合并层级的通过才让提交到达主干。agent 层级是 `--changed`、`--base` 和显式路径的默认值；`--tier lane|agent|merge` 选择层级，与 `--pre-commit` 或完整门禁（它没有层级，运行一切）一起使用是用法错误。当目录将检查标为 `mergeOnly` 时它是仅合并的，门禁用 `tier: 'merge'` 提出该要求；`--only <id>` 仍然在任何层级运行它，`--plan` 把较轻层级遗漏的列为“left for the merge tier”。

`--preflight` 是不含测试 lane 的 `--changed` 的 lane 层级，用于变更最先触犯的规则：提交标准与签名、变更片段、空白与结尾换行、密钥与部署标识符、JSDoc 规则、边界检查，以及变更包的类型检查。它不在任何队列中等待，也不占用内存范围。

| 仅合并检查 | 为什么它等待合并 |
| --- | --- |
| `parity-replay` | 一次约 100 秒的未缓存重放 |
| `parity-replay:control` | 一个场景的重放 |
| `tests:snapshots` | 一次约 100 秒的未缓存重放 |
| `tests:web-changed` | 浏览器 lane，在官方客户端构建之后 |
| `tests:closure` | 构建并启动的运行时发行包 |
| `tests:docker` | 针对 Docker 引擎的规范 |
| `journey` | 一次发布构建及其在容器中的安装，约 15 分钟 |

Docker lane 和 journey 在没有 Docker 时绝不会通过。在规划时，运行器询问引擎（`docker info`，30 秒）；没有引擎应答时，该 lane 会被拒绝，并给出原因以及如何启动引擎（Docker Desktop 或引擎），在合并层级中这一拒绝使运行失败，因为只有合并层级的通过才让提交到达主干，而该 lane 没有运行。一次探测同时决定两者。对于超出这次运行内存上限的仅合并检查同样如此。因为没有东西可运行而被拒绝（例如没有规范映射到变更时的 web lane）不使任何内容失败。该 lane 设置 `DELORUN_DOCKER_SPECS=1`：镜像构建规范只在设置它时运行，而监督器规范在本来会因缺少引擎或其 fixture 镜像的仓库摘要而跳过的地方失败，并指出人必须做什么（引擎需要 containerd 镜像存储）。不设置该变量而手动运行时，这些规范会跳过。在不提供 S2 传输的引擎上，工作区容器规范被跳过，而 lane 仍然通过，所以该 lane 在这样的引擎上不证明容器工作区。

对持有 `security` 台账条目的上游包的变更，总是在合并层级中运行其直接依赖方的规范，无论数量多少，也无论在哪个依赖区段（开发依赖也算，因为依赖方的规范可以加载该包）。150 个规范的预算仍然适用于其他每个包，在 agent 层级中也适用于这个包：那里超出预算的依赖方被排除，`--plan` 用“left for the merge tier”指出它们。

当任何被推送的引用是主干 `refs/heads/main` 时（无论 `DELORUN_TIER` 或 `--tier` 怎么说），或设置了 `DELORUN_TIER=merge` 时，推送采用合并层级；`DELORUN_TIER=agent git push` 采用 agent 层级；任何其他推送采用 lane 层级。树通过记录服务于其自身层级或更轻层级的运行，所以 lane 层级的记录从不覆盖合并层级。`pnpm check:merge` 是 `--changed --tier merge`，负责人在把主干快进之前运行一次。

`pre-commit` 层级在 5 秒的预算内运行（`budgets.json`），并报告超出预算的运行。web lane（`tests:web-changed`，[`src/checks/web.ts`](src/checks/web.ts)）运行变更所触及的 `apps/web/tests` 下的 Chromium e2e 规范。当非文档路径位于 `packages/client` 或 `apps/web` 之下，或位于该清单中某个规范所导入的包之下时，变更触及该 lane。当规范自己的文件改变，或它映射到某个变更的包时，它被选中；变更的规范文件只选中它自己，不使其所属的包被视为变更。规范映射到其导入所触及的包：包按其名称，相对导入按其解析后路径所在的包，所以每个规范都经其辅助导入映射到 `apps/web`。导入没有映射到任何包的规范，按其文件名映射到目录名是该名称的以连字符分隔的一段的包。没有规范指名映射到某个包的路由或客户端界面，所以没有页面目标被映射。在合并层级中，触及该 lane 的变更总会运行规范：当触及它的规范多于 12 个，或没有任何规范映射到它时，该 lane 运行至多 12 个的有界选择，即冒烟规范（`WEB_SMOKE_SPECS`：启动到选定的对话、DeepSeek 账户登录、打开一个录制的对话和设置界面），然后按以下顺序取被触及的规范：变更的规范、文件名带有变更包目录名的规范、映射到它的规范数最少的变更包的规范，然后按路径。`--plan` 和运行的摘要会说明遗漏了多少被触及的规范，清单中缺少冒烟规范会使规划停止。在合并层级之外，超过 12 个规范的选择会被拒绝并给出数量。既未指名变更也未指名目标的运行会选中整个清单，所以同一个上限会拒绝它。只有当这台主机无法运行它（其内存超过这次运行的上限）时，合并层级才拒绝该 lane，这和任何没有运行的仅合并检查一样使合并层级失败。该 lane 先用 `DSH_BUILD_CLIENT_PROFILE=official` 运行 `pnpm run build:artifacts`，然后在上游的 `vitest.web.config.ts` 之下一次一个地运行选中的规范，设置 `DSH_SNAPSHOT=replay` 且不设 `DEEPSEEK_API_KEY`。它的预算是 5 GiB、8 个 CPU、独占，以及 1200 秒的墙钟时间，运行超出时命令会报告。该 lane 只运行 Chromium。十一个规范内联启动 WebKit，且没有提供只运行其 Chromium 部分的开关，所以在主机具备 WebKit 的系统库之前，该 lane 排除这十一个文件；CI 带 WebKit 运行它们。该 lane 不声明输入，所以只要变更触及它就会运行。fork lane 把 `*.docker.spec.ts` 文件留给 Docker lane。已构建包的规范、工作流检查和 Cordis 检查随需要它们的包一起到来。

fork 套件分两个阶段运行，使启动进程的规范绝不与单元阶段的 worker 共用 CPU。规范按其名称属于某个阶段：`*.integration.spec.ts` 在集成阶段运行，任何其他 `*.spec.ts` 或 `*.spec.tsx` 在单元阶段运行，所以新规范不需要列表条目。运行 git、Node 或 `tsx` 子进程、组合真实配置、构建发布树，或对真实文件树进行大量持久写入（安装、回收站、更新副本、发布记录）的规范是集成规范，因为它的耗时取决于磁盘的负载而不是 CPU 的；`gates:spec-lanes` 拒绝启动进程的单元规范。运行 10 秒的单元测试是挂起而不是缓慢，并在运行还很短时失败。失败的单元阶段使集成阶段不运行。

上游的 `build:artifacts` 不构建 Delorun 的包，所以运行器单独检查它们。当 Delorun 包的 manifest 在 `lib/` 下所指名的运行时文件（`exports` 或 `files` 中的 JavaScript 文件，不含模式或声明文件）不存在，或其最新的 `src` 文件比其最新的输出更新时，带 `build` 脚本的包就是过期的；`build:delorun` 检查随后在 `build:artifacts` 之后，在这次运行的锁和内存预算之下构建过期的包，加载构建代码的 lane 等待它：fork 套件的两个阶段、`tests:snapshots`、`tests:upstream-changed`、`parity-replay` 与 `parity-replay:control`。规范从不自己构建包；需要已构建包而发现它缺失的规范会失败，并指名 `--only build:delorun`。没有 `build` 脚本、或其 manifest 没有指名这样的文件的包从不过期。因此，变基给了它新的已构建包的工作树会在运行中构建它，lane 不手动构建它。

每个检查继承运行器的环境，但不含 git 的仓库变量，并且在 WSL 上不含 `PATH` 中的 Windows 目录和 Windows 侧的变量，其中包括 `NoDefaultCurrentDirectoryInExePath`（[`src/checks/machine.ts`](src/checks/machine.ts)）。当一次运行规划了运行 pnpm 的检查，或规划了 `tests:upstream-changed`（其规范自己启动 pnpm）时，它给每个检查 `pnpm run` 给脚本的环境：固定版本的 pnpm 排在 `PATH` 最前并作为 `npm_execpath`，以及 `pnpm_config_verify_deps_before_run=false`。上游的整个单元套件不是一个 lane；绿色基线运行它，其流程和前提见[对等基线](../../docs/reference/parity-with-deepseek-harness/parity-baseline.zh.md#green-base-on-main)。

命令，在仓库根目录运行：

```sh
pnpm check                       # --changed, agent tier: what changed since main, without the merge-only checks
pnpm check:merge                 # --changed --tier merge: the same with the merge-only checks
pnpm check:full                  # the full gate, with no pass cache
pnpm check -- --plan             # the selection with each reason, cache state, expected time and budget; runs nothing
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --list        # the whole catalogue
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --queue       # who holds the machine's slots and who waits
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --hold "<reason>" --allow <worktree>    # make the queue refuse new runs, except inside the allowed worktrees
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --unhold      # lift the hold
node_modules/.bin/tsx delorun/apps/tools/src/with-slots.ts --slots 4 -- node_modules/.bin/tsc -p delorun/apps/tools/tsconfig.json --noEmit
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only tests:fork    # both phases of the fork suite: unit, then integration
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts delorun/apps/tools    # targets: that package's specs, and the typechecks of the packages that depend on it
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only tests:web-changed apps/web/tests/forge-panel.e2e.ts    # the web lane for named specs, after the official client build
```

选项：`--changed`、`--pre-commit`、`--pre-push` 和 `--preflight` 各选择一种调用方式，所以只给其中一个；`--queue` 打印机器暂停、槽位预算的持有者和等待的运行；`--hold "<reason>"` 加可重复的 `--allow <worktree>` 暂停机器，`--unhold` 解除暂停；`--tier lane|agent|merge` 设置变更运行的门禁层级；`--base <ref>` 从另一个引用度量 `--changed`（默认 `main`）；`--only` 和 `--skip` 接受以逗号分隔的检查 id 或分组（`boundary`、`gates`、`whitespace`、`docs`、`typecheck`、`tests`、`generate`、`parity`）；`--plan` 和 `--list` 只打印不运行；`--no-cache` 跳过通过缓存；`--no-shared-cache` 让这次运行只用本工作树的通过；`--bail` 在第一个失败时停止；`--workers <n>` 设置 fork 套件的单元 worker 数，集成阶段至多取其中 4 个；`--no-scope` 不使用 systemd 用户范围而运行。

声明了输入的检查每个键通过一次（[`src/checks/cache.ts`](src/checks/cache.ts)）：检查 id 的 sha256；其输入文件的 git blob id 的有序列表（受跟踪且未修改文件的 blob id；已修改、已删除或未跟踪文件的内容哈希）；其命令所运行代码的 Delorun 包、以及该包所依赖的每个 Delorun 包的源码与 manifest（上游的脚本则为 `scripts/**`）；锁文件以及 pnpm 上次据以安装的锁文件副本（`node_modules/.pnpm/lock.yaml`），所以安装已过期的工作树有另一个键；Node 与 pnpm 版本；平台；克隆（其 git 公共目录）；HEAD，对读取历史的检查而言；命令、它的预算条目以及它所列环境变量的值；以及每个 `DELORUN_*`、`DSH_*`、`DOCKER_*`、`VITEST*`、`NODE_OPTIONS`、`NODE_PATH`、`TZ`、`LANG` 与 `LC_*` 变量的值（仓库根目录写作 `<root>`），以及每个 `DEEPSEEK_*` 变量是否设置。引导运行器的变量（`DELORUN_TIER`、`DELORUN_GATE_PRIORITY`、`DELORUN_FULL_GATE`、`DELORUN_PUSH_SKIP`、`DELORUN_CHECKS_SCOPE`）不会到达任何检查，也不进入键。具有相同键的已存通过报告为 `cached pass (<key prefix>)`，该检查不运行。缓存在 `--no-cache`、`pnpm check:full`、带 `DELORUN_FULL_GATE=1` 的推送以及设置了 `CI` 时关闭。没有声明输入的检查总是运行：重放、构建、原生插件、范围门禁和暂存的空白检查。

通过保存在工作树中（`node_modules/.cache/delorun-checks/pass/`），对于其键涵盖其结果所依赖的一切的检查，还保存在该克隆的每个工作树都读取的全机存储中（[`src/checks/shared-cache.ts`](src/checks/shared-cache.ts)）：设置时为 `$DELORUN_CHECKS_SHARED_CACHE`（绝对路径），否则 `$XDG_CACHE_HOME/delorun/checks`，再否则 `~/.cache/delorun/checks`。它的条目以其键命名，并通过重命名到位的文件写入，所以来自多个工作树的并发运行各自留下完整的条目；超过 14 天的条目会被移除。在任何检查开始之前，运行器会拒绝位于仓库内的存储目录、符号链接，以及属于另一用户或组或其他人可访问的目录（模式不是 0700）；`chmod 700` 或 `--no-shared-cache` 可以解决。存储无法写入的通过（例如磁盘已满）会被报告，不改变任何结果。从存储提供的通过报告为 `cached pass (shared, <key prefix>)`。

fork 套件的每个阶段为每个包记住一次通过（[`src/checks/units.ts`](src/checks/units.ts)），某个阶段的通过只服务于该阶段。每个带规范的 Delorun 包是一个单元，其键涵盖该包自己的文件、它直接或间接依赖的 Delorun 包的文件、那些包直接或间接依赖的上游包的文件、共享的测试配置（`delorun/vitest*`、`delorun/package.json`、根配置文件、`vendor/`、`native/` 和 DOM 设置脚本），以及每个键都涵盖的内容。一次运行只对尚无该阶段已存通过的包启动每个阶段，并报告运行了多少个、从本工作树或共享存储中提供了多少个；`--plan` 列出要运行的包。只有每个启动的包都通过的运行才记录通过；失败的运行不记录任何通过，所以它的包全部再次运行。包之外的文档（例如 `delorun/docs/` 和变更片段）不在任何包的键中，所以对它们的变更不会重新运行任何规范，而对包的键所指名的任何文件的变更，会重新运行该包及依赖它的每个包。对每个包的规范在此之外还读取什么的审计，是同一模块中的 `UNIT_RULES`：规范读取其他包的文件的包会指名它们；规范启动配置的 `delorun/packages/bundle-local` 与 `delorun/packages/home-auth` 以整棵树为键；`UNSHAREABLE_PACKAGES` 中的包以整棵树和 HEAD 为键，并把它们的通过保存在工作树中。当含规范的目录不是该树的包时，整个套件不按包拆分，指名规范文件的运行被当作一个检查来取键。

[`src/checks/sharing.ts`](src/checks/sharing.ts) 根据对每个命令所读取内容的审计，保存每个检查的规则及其理由。规则没有指名的检查不共享。目前共享的有：`gates:package-states`、`parity-switches`、不读取已发出声明的 `typecheck:delorun:*` 程序（没有项目引用，不是 CLI，没有带构建的 Delorun 依赖）、`tests:upstream-changed`（其键加入了其存在会切换模块别名的生成文件），以及 fork 套件两个阶段的每包通过（`tests:fork:integration` 采用 `tests:fork` 规则），但其规范读取 home 目录、Docker 或真实仓库 git 状态的包（`delorun/apps/cli`、`delorun/apps/release`、`delorun/apps/tools`、`delorun/packages/home-process`、`delorun/packages/supervisor`）的通过除外。其他每个检查都把通过保存在它的工作树中：边界检查和范围门禁读取历史；`typecheck:upstream` 写入后续检查读取的声明；`gates:docs`、`jsdoc`、`gates:licence`、`docs-site` 和 `generated:notices` 读取被 git 忽略的或已构建的文件，没有键涵盖它们；Docker、web 和重放 lane 读取引擎、官方构建，或不声明输入。

合并层级、带 `DELORUN_GATE_PRIORITY=trunk` 的运行以及不带 `--only` 的完整门禁，是主干的最后一道防线：它们不读取任何共享的通过，其安全类检查和仅合并检查无论任何缓存持有什么都会运行。它们仍然保存自己所证明的通过。安全类检查是 `boundary`、`gates:secrets`、`gates:personal-data`、`gates:infrastructure` 和 `gates:fundamentals`，以及其范围运行了某个强制执行安全 fundamental 的包（`gates:fundamentals` 所指名的文件所属的包）、或带有 `security` 台账条目的上游包、或其直接依赖方的测试 lane。`--plan` 指出每个检查的缓存状态以及它的通过是否共享，不共享时给出原因；运行的摘要统计从本工作树和从存储提供的通过数，`report.json` 记录每个检查的 `cacheSource`，并在 `passCache` 之下记录这次运行的计数。

干净的树上通过它所选的每个检查的 pre-push 运行或变更运行（`--changed`、`--base`），会写入树通过记录 `<git common directory>/delorun-checks/trees/<tree>-node<major>.json`，键为 HEAD 的树和 Node 主版本（[`src/checks/tree-pass.ts`](src/checks/tree-pass.ts)）。记录写明其门禁层级，没有层级的记录算作 agent 层级的通过。记录服务于其自身层级或更轻层级的运行，所以需要合并层级的主干推送会重新运行合并层级选中的一切，除非有合并层级的记录覆盖（通过缓存仍然服务声明了输入的检查，安全类和仅合并检查除外）。该克隆的每个工作树共享那个目录，所以一个工作树中的通过服务于另一个工作树中的同一棵树，而一个 Node 主版本上的通过从不服务于另一个。当记录覆盖它所选的每个检查时，该树之后的运行报告通过并且不启动任何内容：记录写明检查，检查的范围位于记录的范围之内（缩窄的套件所运行的包或规范），并且锁文件、Node 与 pnpm 版本以及检查所列的环境变量全部匹配。边界检查和范围门禁读取 HEAD 的历史以及从 `origin/main` 到 HEAD 的提交，这些不由树决定，所以它们只在相同的 HEAD 提交和 `origin/main` 下才算被覆盖。分支推送从其远程顶端与它和 `origin/main` 的合并基准中较旧的一个开始度量，所以只要 `origin/main` 没有移动，把 `main` 快进到它所检查的那个提交就不会启动任何内容，而树相同的另一个提交则会重新运行读取历史的检查。有未提交改动的工作树、`--no-cache`、`CI` 与 `DELORUN_FULL_GATE=1` 既不读取也不写入记录。被覆盖的运行在槽位预算之前就得到应答，所以它不等待槽位。

要安装钩子，在根目录写一行 `lefthook-local.yml`：`extends: [delorun/lefthook.yml]`（git 忽略它），然后运行 `node scripts/install-lefthook.mjs`。已安装的 `commit-msg`、`pre-commit` 和 `pre-push` 钩子在找不到 Lefthook 时以 1 退出并指出安装命令，所以缺失的二进制文件使钩子失败，而不是通过。在带有 `delorun/lefthook.yml` 的树中，当 `lefthook-local.yml` 缺失，或其中没有未注释的一行指名 `delorun/lefthook.yml` 时，推送同样以 1 退出并指出 `setup-worktree.ts`，因为此时推送只会运行上游的钩子，而不运行任何 Delorun 的检查。有两处强制执行这一点：已安装的 `pre-push` 钩子文件，以及上游 `lefthook.yml` 的第一个 `pre-push` 作业。Lefthook 在同步时（例如单纯的 `lefthook install`，或该克隆每个工作树共用的校验和文件不同时）用它的普通模板重写钩子文件，这次重写会丢掉钩子文件检查；该作业保留，因为无论 Lefthook 写的是哪个模板，它都会运行该作业。`setup-worktree.ts` 恢复钩子文件检查。`pre-commit` 钩子运行 `pre-commit` 层级。`pre-push` 钩子运行 `--pre-push`：自远程分支顶端与它和 `origin/main` 的合并基准中较旧者以来的变更（对于新分支，在 `origin/main` 不存在时取它与 `main` 的合并基准）。`DELORUN_PUSH_SKIP=<check or group>,… git push` 让另一个分支的推送略过某些检查；带 `DELORUN_PUSH_SKIP`、`--skip` 或 `--only` 的主干推送会被拒绝，因为它运行合并层级的每个检查。`DELORUN_FULL_GATE=1 git push` 运行完整门禁。分支推送之后以快进方式合并不会重新运行门禁。`commit-msg` 钩子对每条提交消息运行 `check-commits.ts --message <file>`。

报告和日志位于 `node_modules/.cache/delorun-checks/` 之下：`report.json` 保存每个检查的状态、是否由缓存的通过服务及来自何处、其原因、日志、耗时和峰值内存，以及这次运行的缓存计数；`logs/<check>.log` 保存其完整输出；`pass/` 保存本工作树的通过，全机存储如上所述位于仓库之外，树通过记录位于 git 公共目录中，由各工作树共享；`durations.json` 保存每个检查上一次的耗时，用来为下一次运行排序；`tsbuildinfo/` 保存增量类型检查的状态。

单独的台账检查是 `pnpm --filter @delorun/tools check`。一个门禁可用 `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/<name>.ts` 运行，例如 `licence`，范围门禁接受 `--base <rev>`。规范用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts` 运行，本包用 `node_modules/.bin/tsc -p delorun/apps/tools/tsconfig.json --noEmit` 进行类型检查。

[delorun-dev-workflow skill](../../../.agents/skills/delorun-dev-workflow/SKILL.md) 说明何时运行每个检查。

## 批量集成

[`src/batch/batch.ts`](src/batch/batch.ts) 一次落地多个 lane：`node_modules/.bin/tsx delorun/apps/tools/src/batch/batch.ts --lanes <branch>[,<branch>...] [--trunk main] [--remote origin] [--no-land]`，在某个分支上的干净集成者工作树的根目录运行。它拒绝有未提交改动的工作树、分离的 HEAD、没有指名任何提交的 lane 分支，以及不是分支名的 lane 名。`--plan` 打印顺序、每个 lane 的提交数和包，以及每个检查会怀疑哪些 lane，不获取也不改变任何内容。

该工具获取 `<remote>/<trunk>`，在那里创建候选分支 `batch/<id>`（id 是 UTC 开始时间，`YYYYMMDD-HHMMSS`），并用 `git cherry-pick` 一次一个地重放每个 lane 自其与主干的合并基准起的提交，保留作者、作者日期、消息和签名。候选分支已有的提交会被丢弃。有合并提交或没有提交的 lane 在应用之前就被放到一边，冲突的 lane 会被撤销并连同冲突路径一起放到一边。

门禁是批量自己对候选提交运行的 `run-checks.ts --changed --base <start> --tier merge`。仅当运行器以 0 退出，并且已存下一个其 head 就是该提交的合并层级树通过记录时，它才通过；记录缺失、层级不同或 head 不同都是门禁错误。落地的批量随后用 `git push <remote> batch/<id>:refs/heads/<trunk>` 和 `DELORUN_TIER=merge` 推送候选，其 pre-push 钩子会找到该记录，`--no-land` 在门禁之后停止。远程因主干已移动而拒绝的推送会使批量停止；该工具从不重写远程，也从不向任何进程传入 `--force`、`--force-with-lease`、`--no-verify`、`+` 引用规格、`--tier agent`、`DELORUN_TIER=agent` 或 `DELORUN_PUSH_SKIP`（[`src/batch/process.ts`](src/batch/process.ts)）。

当 pre-push 钩子可能被跳过时，批量以 `hooks-bypassed` 拒绝开始或恢复：环境中有不是 `1` 或 `true` 的 `LEFTHOOK`、`LEFTHOOK_EXCLUDE`、`LEFTHOOK_BIN`、`DELORUN_PUSH_SKIP` 或任何 `GIT_CONFIG*` 变量，`core.hooksPath` 不是安装器的 `dsh-hooks` 目录，`pre-push` 钩子不运行 lefthook，`lefthook-local.yml` 不包含 `delorun/lefthook.yml`，或缺少 `node_modules/.bin/lefthook`。这些变量从不到达批量自己的进程，它启动的任何进程也不会得到 `--skip` 或 `core.hooksPath` 覆盖，除了丢弃候选已有提交的 `git cherry-pick --skip`。

门禁失败时，该工具从运行器的报告读取失败的检查，并重读每个日志中的第一个失败、失败的规范文件和被指名的提交。它对同一个候选重新运行失败的检查一次；通过的检查被报告为不稳定（flaky），第二轮仅在不稳定检查上失败时批量停止。当运行器对某个 lane 自己的变更路径所做的选择选中某个检查时，该 lane 就是该检查的嫌疑对象。测试 lane 所指名的规范把嫌疑对象缩小到其选择触及它们的 lane，范围门禁所指名的提交把它们缩小到贡献了这些提交的 lane。归因只用 `--only` 在去掉了某些 lane 的候选上重新运行失败的检查（[`src/batch/attribute.ts`](src/batch/attribute.ts)）：仅移除就能修复该失败的 lane 有过错。当多个单个移除都能修复时，在主干上单独失败的那些有过错，如果没有一个这样，它们就被报告为共同失败。当没有单个移除能修复时，移除每个嫌疑对象；如果失败仍然存在，它就无法归因，不会落地任何内容，否则单独失败的嫌疑对象有过错。某个 lane 不再适用的候选不算证据。然后候选在不含有过错的 lane 的情况下重建，再次过门禁，通过缓存提供它未变化的检查。

每一步的结果在下一步开始之前，通过重命名到位的临时文件写入 `<git common dir>/delorun-batch/<id>/state.json`。`--resume <id>` 结束被中断所遗留的 cherry-pick，把 `batch/<id>` 重置到最后记录的候选，并从第一个未完成的步骤继续；推送只在它返回之后才记录。状态旁边，`summary.md` 列出已落地、被放到一边、有过错和不稳定的 lane，以及主干移动到的提交。每个被放到一边或有过错的 lane 得到 `<lane>.md`，其中含原因、每个失败检查的第一个失败的测试和断言或第一批错误行、它与哪些 lane 一起失败，以及在该 lane 自己的工作树中复现它的命令：冲突时是 `git fetch <remote> && git rebase <remote>/<trunk>`，失败时是 `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only <check> --changed --tier merge`，对规范则是 `node_modules/.bin/vitest run --config <config> <spec>`。

候选已落地，或带 `--no-land` 通过时，退出状态为 0；批量未落地而停止时为 1；在任何内容改变之前被拒绝时为 2。

## 替身栈

[`src/stack/`](src/stack/index.ts) 保存远程访问与登录所对话的外部服务的本地替身，使它们的测试不访问任何实时提供方。`startStandInStack()` 在 `127.0.0.1` 上启动一个测试授权机构和四个替身，各自使用临时端口，并经由 HTTPS 提供，证书来自该授权机构；客户端只信任 `authority.certificate.pem`，别无其他。每个替身也可以单独启动。这些替身是测试基础设施：它们模拟提供方的文档化行为，它们的钩子产生约定的拒绝测试必须拒绝的响应。

| 替身 | 它替代什么 | 它提供什么 | 拒绝测试用的钩子 |
|---|---|---|---|
| `startOidcStandIn`（[`oidc-provider.ts`](src/stack/oidc-provider.ts)）；栈启动两个，`issuerA` 与 `issuerB` | 此人自己的 OpenID Connect 提供方（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md)） | 发现文档、密钥集、带 S256 PKCE、`nonce` 与 RFC 9207 `iss` 参数的授权码流程、令牌端点的 `client_secret_basic`、RFC 7591 与 7592 动态注册。它没有登录页面：每次授权都以当前的 `auth_time` 登录其配置的主体。它以 RS256、PS256、ES256 或 EdDSA 签名 | 下一个声明改变或缺失的 ID 令牌（另一个 `aud`、没有 `azp` 的多个受众、另一个 `iss`、`sub` 或 `nonce`、过旧的 `iat` 或 `auth_time`）；伪造的令牌（`alg: none`、以公钥为密钥的 HS256、未知密钥、没有 `kid`、被破坏的签名）；另一个或没有的 `iss` 响应参数；密钥的发布、轮换与退役，以及用已退役的密钥签名；改变的元数据；任何端点的原始应答或沉默 |
| `startAcmeStandIn`（[`acme.ts`](src/stack/acme.ts)、[`caa.ts`](src/stack/caa.ts)） | 所指名的证书授权机构的 ACME 服务器（[C7](../../docs/contracts/c07-reach-providers.zh.md#own-domain-reach)） | RFC 8555 的目录、nonce、账户、订单、授权、质询、完成、下载与吊销，每个请求的 JWS、nonce 与 URL 都经过验证。每个授权提供 `http-01`、`dns-01` 与 `tls-alpn-01`，通配符只提供 `dns-01`。TLS-ALPN-01（RFC 8737）连接调用方为该标识符指名的回环目标；DNS-01 读取调用方提供的 TXT 记录。在签发之前，它按 CAA 身份为 `letsencrypt.org` 的 CA 的方式应用调用方的 CAA 记录，包括 `accounturi` 与 `validationmethods` | 客户端发起的每个质询都被记录，所以规范可以证明某个 home 没有发起 HTTP-01 或 DNS-01 质询；为另一个账户签发的证书；CA 的吊销；用问题文档取代某个端点的下一个应答 |
| `startCtStandIn`（[`certificate-transparency.ts`](src/stack/certificate-transparency.ts)） | Cert Spotter 的签发搜索，即 [C6](../../docs/contracts/c06-relay-protocol.zh.md#certificate-monitoring) 默认的证书来源 | `GET /v1/issuances`，带 `domain`、`include_subdomains`、`match_wildcards`、`after` 与 `expand`，使用 Cert Spotter 的字段和错误形式；`sourceUrl` 是约定的来源，换成了该替身的来源 | 由规范记入日志的 fixture，例如 `*.example.com` 或多名称证书；在某个日志收录之前一直被扣留的证书；吊销；用 `rate_limited` 之类的错误取代下一个应答 |
| `installNetworkGuard`（[`network-guard.ts`](src/stack/network-guard.ts)） | 无：它监视测试进程 | 在发送任何数据包之前，拒绝每个目标不是回环地址的 TCP 或 TLS 连接、UDP 发送或绑定、监听器和 DNS 查询，并记录每个到达其对端的连接 | 名称查找只解析 `localhost`，所以替身以其 IP 字面量寻址 |

该栈把 ACME 替身签发的每个证书记入证书透明度替身，并标记它所吊销的证书。必须证明没有任何东西离开回环的规范，会在启动该栈之前安装守卫，并在结束时读取 `guard.connections` 和 `guard.refusals`。守卫只在它自己的进程中修补 `node:net`、`node:dgram` 与 `node:dns`：它看不到子进程、工作线程、自己打开套接字的原生插件，也看不到在它安装之前打开的套接字。

这些替身使用三个仍在维护的库，各自声明在本包的 manifest 中：

- [`jose`](https://github.com/panva/jose) 签署并验证 JSON Web Token 和 JWS，导出 JSON Web Key 并计算指纹。同一作者的完整提供方库 `oidc-provider` 没有被采用，因为它的令牌端点无法签发拒绝测试所需的伪造、受众错误和签发方混用的令牌，而且它的交互流程需要一个由规范驱动的登录页面。
- [`pkijs`](https://github.com/PeculiarVentures/PKI.js) 与 [`asn1js`](https://github.com/PeculiarVentures/ASN1.js) 在 Node 的 Web Crypto 之上生成证书和 PKCS #10 请求并读取其扩展，所以没有任何替身调用 `openssl` 命令。它已经通过桌面构建进入了锁文件。`@peculiar/x509` 没有被采用，因为它需要全局的 `reflect-metadata` polyfill。
- ACME 服务器是该替身自己的代码：Pebble 这一参考测试服务器是 Go 二进制文件，无法在守卫之下于测试进程内运行。规范用规范端的客户端驱动它；没有添加 `acme-client`，因为它的 `axios` 依赖会改变锁文件中上游网站依赖的解析。

[`tests/stack/`](tests/stack/) 中的规范证明：OpenID Connect 替身的发现元数据以及各种允许算法的 ID 令牌通过每项 C14 检查，并且每个钩子产生 C14 以其代码拒绝的响应；ACME 替身在回环上应答的 TLS-ALPN-01 质询之后为测试名称签发，并拒绝被篡改的请求，以及指名另一个账户、方法或 CA 的 CAA 记录；证书透明度替身应答精确、通配符与多名称的搜索；以及在安装了守卫的情况下，一次登录、一次签发和一次搜索只向回环打开连接，而任何会离开回环的连接、查找、监听器或 UDP 发送都会被拒绝。

## 对等组合

[约定 C16](../../docs/contracts/c16-parity-composition.zh.md) 规定：关闭其模型可见新增内容的 Delorun，在 `dsh-v0.2.2-rc.1` 处重放上游录制的场景时，与它们的预期输出没有任何差异。本包用两个检查来检验这一规定：`parity-replay` 经由对等覆盖层运行上游的重放，`parity-switches` 检查每个模型可见的 Delorun 变更都有一个已注册的开关，且覆盖层会将其关闭。

### 覆盖层

[`src/parity/composition/parity.overlay.yml`](src/parity/composition/parity.overlay.yml) 是一个 Cordis 补丁文件。每个录制会话适配器在其模块加载时，经由 `packages/test-support/session-snapshot/src/snapshot-patch.ts` 中上游的 `snapshotPatchOverlay` 读取 `DSH_SNAPSHOT_PATCH`。它把所指名的文件放在其启动的每个进程的根配置之后、每个场景层之前：headless、SDK 和 ACP 适配器把它作为 `--patch` 参数传入，Web 脚手架在已发布 bundle 各层之后应用它。在 `DSH_SNAPSHOT=record` 或 `refresh` 模式下，收到该变量的适配器会在启动进程之前抛出异常。没有任何已发布的配置、bundle 或命令行选项指名该文件，`dsh` 命令也不读取该变量。

补丁行替换其条目的整个 `config`，且只触及根树的条目，所以覆盖层只在没有更早的层配置该条目的地方设置开关。其他每个已构建的开关都通过其经过验证的 Config 默认值处于对等值：

| 开关 | 对等组合如何设置它 |
|---|---|
| `plugin_manager_read_exemption`、`profile_history` | 覆盖层的行 `tool-plugin-manager`，`name: '@deepseek-ai/dsh-plugin-manager/tools'`，设置 `readActionsExempt: false` 与 `profileHistory: false`。 |
| `preset_inspect` | Config 默认值为 `false`。该行位于每个 Web 预设的插件列表中，补丁只能通过替换整个预设行才能触及它。 |
| `container_denial_marker` | Config 默认值为 `false`。bundle 和根配置设置了 `sandbox-policy` 的模式与工作区根，覆盖层的行会把它们抹掉。 |
| `sandbox_protected_reads` | Config 默认值为 `false`。bundle 设置了搜索工具超出上限时的采样选择，覆盖层的行会把它抹掉。 |
| `one_time_launch_tokens` | `@deepseek-ai/dsh-client-connection` 的 `oneTimeLaunchTokens` 的 Config 默认值为 `false`。`connection` 行携带 web bundle 的 `trustedHosts` 表达式，覆盖层的行会把它抹掉。 |
| `default_workspace_directory` | 存在性开关：覆盖层省略 `@delorun/bundle-local` 的 `workspace-controller` 行，所以上游的行不设置 `defaultWorkspaceDirectory`，由上游自己的文档查找来放置首次使用的工作区。 |
| `doctor` | Config 默认值为 `false`。只有 `doctor` 配置会挂载该应用，而重放不启动任何 doctor 进程。 |
| `studio_additions`、`main_chat` | `@delorun/plugin-theme` 的 `studioAdditions` 与 `@delorun/plugin-main-chat` 的 `enabled` 的 Config 默认值为 `false`。重放组合的是上游的 bundle，它们既不挂载 `@delorun/bundle-studio`，也不挂载主 chat。 |

覆盖层还挂载 [`@delorun/bundle-local`](../../packages/bundle-local/README.zh.md)：在开关行之后，它按每个 `LOCAL_ROWS` 条目给出的对等形式重述该 bundle 的 `cordis.patch.yml`，当重述与该 bundle 文件的 `parityPatches` 不同时，`parity-switches` 失败（[`overlay.ts`](src/parity/composition/overlay.ts) 中的 `localBundleErrors`）。会话日志上传行（C16 的更改默认值）被省略，所以它保留上游的值：覆盖层遵循每次重放的根配置，该配置在 headless 和 ACP 语料中关闭上传，在其他地方保持开启。桌面分析保持 Delorun 的 `false`，隐私一节的行存在且被禁用。studio bundle 不属于重放的组合，主 chat 没有任何配置挂载；预设默认值保持上游的值（`standard`）。

### 注册表

[`@delorun/contract-parity-composition`](../../packages/contract-parity-composition/README.zh.md) 中的 `PARITY_SWITCHES` 是开关的唯一列表。已构建条目指名其 Config 字段（`cordis.yml` 行所挂载的模块、该模块的源文件和键）以及它所关闭其模型可见贡献的源文件。计划条目是 C16 列出、但其变更尚不在树中的开关；它指名构建它的工作包，没有字段。`doctor` 是功能开关：它不是模型可见的，没有开关开启场景。

| 开关 | 状态 | 字段 | 注册表默认值 | 在 CLI 配置中 | 对等 | 模型可见 |
| --- | --- | --- | --- | --- | --- | --- |
| `studio_additions` | 已构建 | `@delorun/plugin-theme` `studioAdditions` | 开 | 开，经由 `@delorun/bundle-studio` | 关 | 否 |
| `main_chat` | 已构建 | `@delorun/plugin-main-chat` `enabled` | 开 | 关：没有 Delorun 配置挂载主 chat | 关 | 是 |
| `permission_defaults` | 已构建 | `@delorun/plugin-permission-defaults` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `fetch_guard` | 已构建 | `@delorun/plugin-fetch-guard` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `preset_inspect` | 已构建 | `@deepseek-ai/dsh-agent-preset-registry/tools` `presetInspect` | 开 | 关：没有已发布的行设置它，所以 Config 默认值生效 | 关 | 是 |
| `doctor` | 已构建 | `@deepseek-ai/dsh-doctor/app` `doctor` | 开 | 未挂载：只有上游的 `doctor` 配置挂载该应用 | 关 | 否 |
| `plugin_manager_read_exemption` | 已构建 | `@deepseek-ai/dsh-plugin-manager/tools` `readActionsExempt` | 开 | 在标准和 Creator 预设的工具行中开启，所以列出动作无需询问即可运行，每个更改都会升级；顶层行保持禁用 | 关 | 是 |
| `profile_history` | 已构建 | `@deepseek-ai/dsh-plugin-manager/tools` `profileHistory` | 开 | 关：没有已发布的行设置它 | 关 | 是 |
| `scheduled_task_consent` | 已构建 | `@delorun/plugin-schedule-consent` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `instruction_layer_consent` | 已构建 | `@delorun/plugin-instruction-consent` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `approved_plugin_write_consent` | 已构建 | `@delorun/plugin-instruction-consent` `approvedPluginWrites` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `mcp_add_consent` | 已构建 | `@delorun/plugin-mcp-consent` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `container_denial_marker` | 已构建 | `@deepseek-ai/dsh-sandbox-policy` `containerDenialMarker` | 开 | 关：没有已发布的行设置它 | 关 | 是 |
| `sandbox_protected_reads` | 已构建 | `@deepseek-ai/dsh-sandbox-local` `protectedHome` | 开 | 开，经由 `@delorun/bundle-local` 的 `sandbox` 行 | 关 | 是 |
| `update_turn_refusal` | 已构建 | `@delorun/bundle-local/update-gate` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `one_time_launch_tokens` | 已构建 | `@deepseek-ai/dsh-client-connection` `oneTimeLaunchTokens` | 开 | 开，经由 `@delorun/bundle-local` 的 `connection` 行 | 关 | 否 |
| `default_workspace_directory` | 已构建 | `@deepseek-ai/dsh-api-workspace-controller` `defaultWorkspaceDirectory` | 开 | 开，当 `delorun start` 启动该配置时，经由 `@delorun/bundle-local` 的 `workspace-controller` 行 | 关 | 是 |
| `plugin_changes_pending` | 已构建 | `@delorun/plugin-changes` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |
| `rename_workspace_tool` | 已构建 | `@delorun/bundle-local/workspace-rename` `enabled` | 开 | 开，经由 `@delorun/bundle-local` | 关 | 是 |

注册表默认值是注册表为 Delorun 的默认组合所陈述的值；CLI 配置一列是 `delorun` 启动的配置目前所组合的内容，对 `main_chat`、`preset_inspect`、`plugin_manager_read_exemption`、`profile_history` 与 `container_denial_marker`，两者不同。`delorun headless` 用 `@delorun/bundle-headless` 运行上游的 `headless` 模板，该 bundle 像 CLI 配置那样打开 `permission_defaults`、`fetch_guard`、`instruction_layer_consent` 与 `update_turn_refusal`；对等组合不挂载该 bundle，所以检查不要求它的任何行符合注册表。每个已构建字段的 schema 默认值就是对等值。

<a id="what-parity-switches-detects"></a>

### `parity-switches` 检测什么

该检查读取 `delorun/**/src` 下的 TypeScript 源文件，以及 `packages/` 和 `apps/` 下每个已入台账的上游源文件，不含规范。以下情况它失败：

- 名为 `Config` 的接口的属性，或某个 `const Config: z<…>` schema 所类型化的接口的属性，其 JSDoc 写着 `` C16 switch `<id>` ``，却没有带该字段的已构建注册表条目，或其条目仍是计划状态；
- 已构建条目的源文件没有这样的字段，该字段的 `z.boolean().default(…)` 不是对等值，条目的对等值等于其默认值，或模型可见条目没有指名任何源文件，或没有场景 `<profile>/delorun-<id>`；
- Delorun 自有的源文件调用了模型可见的注册 API，或入台账的上游编辑改动了调用其中之一的顶层语句内的一行，而没有已构建的模型可见条目把该文件列入其源文件；
- `security` 条目的 `nonModelVisibleHunks` 中的某个摘要，其记录数与该文件中带该摘要且触及这类语句的差异块数不同，或该条目的文件不是该检查所读取的文件。

差异块的摘要是 `@@ -<old count> +<new count> @@` 加上其每一行（按 `git diff --unified=0` 的打印方式，包括 `-`、`+` 或 `\` 标记，每行都以换行结尾）的 SHA-256。它不含起始行和函数上下文，所以别处的编辑使差异块移位时它的摘要保持不变。当差异块新增的一行，或对仅含删除的差异块，删除之前的那一行，位于某条语句之中时，该差异块触及这条语句。一条记录连同其摘要放行一个差异块的变更行，仅含删除的差异块与其他差异块一样。带同一摘要的差异块只有在带该摘要的记录数恰好与之相等时才放行，所以一条记录不覆盖有相同行的第二个差异块，而与任何这样的差异块都不匹配的记录是过期的。已记录差异块之内或旁边的任何进一步变更（例如 diff 把一个被删除的注册调用并入其中）会改变它的摘要，因此它的行重新计入。另一个类别的条目上的记录放行不了任何内容。
- 覆盖层的某一行指名了没有已构建开关的模块，设置了不是该模块开关的键或不是对等值的值，或设置了 `id`、`name` 与 `config` 之外的任何东西，或某个已构建的开关既不在覆盖层中，也不在 `overlay.ts` 的 `DEFAULT_PARITY` 中带其理由；
- 模型可见的已构建开关既没有录制的场景，也没有暂存的场景。

模型可见的注册 API 是 `systemPrompt.section`、`systemPrompt.context` 与 `systemPrompt.suppressRuntimeContext`；`tools.register`、`tools.restrict`、`tools.setExecutor` 与 `tools.guard`；`defineTool`；以及用 `on` 为 `system-prompt/assemble`、`agent/request`、`agent/pre-step`、`request/context`、`tools/execute`、`tools/pre-execute`、`tools/post-execute` 与 `tools/result` 注册的监听器。

### 它检测不到什么

扫描匹配的是名称，而不是类型或数据流，所以它会漏掉：

- 经由注册语句之外的辅助函数到达模型的文本，例如渲染模块或文件顶部的常量，而没有变更的行落在注册语句之内；
- 经由另一个接收者名称、别名或动态属性的调用，以及不在其列表中的模型可见事件；
- 同样的删除行和新增行移到注册语句中另一处的已记录非模型可见差异块：记录绑定的是差异块的行和计数，不是它的位置；
- 列出的开关是否真的在其对等值上门控了该贡献。重放对触及该贡献的场景证明这一点，而开关开启场景在被录制之后证明该开关的开启路径。

它还接受所列源文件中的任何贡献，所以向同一文件添加的第二个未设开关的贡献会通过扫描，必须让重放失败。

### 开关扫描

每个模型可见的已构建开关都有一个开关开启场景 `snapshots/<profile>/delorun-<id>`，其 `runtime.cordis.yml` 只把那一个开关设为非对等值，另有场景局部的 `agent-default-model` 固定值，选择语料模型 `deepseek-v4-flash`。录制之后，`parity-replay` 在覆盖层之下与语料的其余部分一起重放它，所以被测的开关是与对等组合之间唯一的行为差异。Web 场景通过 `apps/web/tests` 下的 e2e 驱动运行，它用 `launchWebScaffold` 的 `presetInspect` 选项打开 `preset_inspect`，并在重放时通过 agent 默认模型选择同一个模型。

十五个开关开启场景中有五个已录制：`session/delorun-plugin-manager-read-exemption`、`session/delorun-profile-history`、`session/delorun-container-denial-marker`、`session/delorun-tool-failure-guard` 与 `web/delorun-preset-inspect`。工具失败守卫的模型是脚本化的（`recording: authored`）：它对 `pnpm run mock:llm` 无密钥录制。它们的目录在 `snapshots/` 之下，带覆盖层和不带覆盖层都可免密钥重放（Web 场景经由 `test:web:built`）。其余十个等待录制：`web/delorun-main-chat`、`web/delorun-default-workspace-directory`、`session/delorun-permission-defaults`、`session/delorun-fetch-guard`、`session/delorun-scheduled-task-consent`、`session/delorun-instruction-layer-consent`、`session/delorun-mcp-add-consent`、`session/delorun-external-agent-consent`、`session/delorun-sandbox-protected-reads` 与 `session/delorun-update-turn-refusal`。每个都把配置保存在 [`src/parity/composition/scenarios/`](src/parity/composition/scenarios/) 之下，`parity-switches` 把它报告为 `pending recording`。

要录制其中一个，把它的目录移到 `snapshots/<profile>/`，不带 `DSH_SNAPSHOT_PATCH` 地运行上游针对该场景的录制命令，评审输出，并在 Session fixture 带有任务之后移除 `input.task`。录制会从场景目录中已有的 Session fixture 读取其任务，所以用改过的 `input.task` 录制之前，要先把任何更早的 fixture 移走。

### 命令

```sh
node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only parity
DSH_SNAPSHOT_PATCH=delorun/apps/tools/src/parity/composition/parity.overlay.yml pnpm run test:snapshot
node_modules/.bin/tsx delorun/apps/tools/src/parity/composition/check-parity-switches.ts
```

`pnpm run test:snapshot` 经由适配器重放会话、SDK 和 ACP 场景，并对照上游的语料门禁检查语料中的每个场景，包括 Web 场景。Web 场景在 `test:web` 中通过它们的 e2e 驱动重放，后者经由脚手架读取同一个变量：`DSH_SNAPSHOT=replay DSH_SNAPSHOT_PATCH=<overlay> pnpm run test:web:built`。

## 与 rc.1 的对账

本树已对照 `dsh-v0.2.2-rc.1`（台账锁定的提交）完成对账。
每一行写明文件、它在上游处置报告中的处置编号、处置方式，以及保留或推迟的内容。
被推迟的差异块等待拥有其功能的包；referent 是差异块所指名的标识符、包或路径。

- `pnpm-workspace.yaml`：处置 0，已应用，类别 `security`。四个差异块全部保留：`delorun/apps/*` 与 `delorun/packages/*` glob、`!delorun/apps/docs` 排除项、passkey ASN.1 覆盖项，以及 `allowBuilds` 条目。
- `pnpm-lock.yaml`：处置报告中没有条目。覆盖项记录与本包的 importer 保留；在上游合并时用 `pnpm install` 重新生成锁文件。
- `scripts/verify-export-jsdoc.ts`：处置 6，已应用。范围参数保留。
- `scripts/gen-third-party-notices.ts`：处置 235，部分应用。保留差异块 2 与 3，所以声明读取 pnpm 所安装的成员，并跳过它用 `!` 排除的成员。差异块 1，即 `ssh2` 许可证覆盖项，推迟到引入 `ssh2` 的包；本树中没有包依赖它。
- `scripts/gen-third-party-notices.spec.ts`：处置 409，已应用。两个差异块都保留。
- `scripts/verify-repository-references.ts`：处置 251，重新推导为窄范围。保留对 `pnpm-lock.yaml` 的排除，以及对台账中锁定的 `upstream.commit` 字段的豁免。不带入更宽的 `delorun/` 前缀，所以其他每个 `delorun/` 文件仍被扫描，也不带入对 `uv.lock` 的排除，因为上游自己的规范会扫描该文件。
- `scripts/verify-repository-references.spec.ts`：连同处置 251，两个用例覆盖这些豁免。
- `scripts/test-non-loopback-address.ts`：处置 449，重新推导。保留链路本地排除和 IPv6 回环探测。导入这些探测的 Web e2e 文件 `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` 未在此处修改，所以在该文件被对账之前，新的 IPv6 回环探测在本树中没有调用方。
- `scripts/test-non-loopback-address.spec.ts`：处置 450，重新推导。两个差异块都保留。
- `scripts/types/client-assets/index.d.ts`：处置 548，已应用。保留 `*.woff2` 声明。
- `ROADMAP.md`：由 Delorun 的基线添加，处置报告中没有条目。它只有一个台账条目。

推迟、未带入：

- `scripts/translation-pairing.manifest.json`（处置 250）：它的 `delorun/` 排除项会排除配对门禁所要求的 Delorun 文档配对，而该门禁会把每个这样的配对报告为违规。
- `scripts/verify-concrete-terms.ts`（处置 252）：它的 `delorun/apps/tools/catalogue/` 排除项指名了本树没有的目录。
- `scripts/gen-cordis-catalog.ts`（处置 22）：全部七个差异块都在等待。差异块 1、2、3 和 7 是 doctor、pluginAudit、profile-history 和 config-editor 行，按 referent 规则推迟。差异块 4 指名 agent-team 类型 `TeamMemberModel`，差异块 6 指名 `PresetExtension`，差异块 5 指名 `ProjectionRegistrationListener`；这些在 rc.1 中都没有定义。
- `scripts/type-equiv.manifest.json`（处置 101）：全部三个差异块都在等待。它们指名 agent-team 类型 `TeamMessageView`、`TeamMessageRecord`、`TeamMemberModel` 与 `TeamMemberModelRecord`，以及类型 `ProjectionRegistrationListener`，rc.1 没有定义它们。
- `scripts/gen-doc-graphs.ts`（处置 253）：`pluginAudit` 行等待定义审计 seam 的包。处置报告把该行标记为留给安全评审。
