# Delo 工具

[English](README.md) | 中文

`@delo/tools` 是 Delo 的 fork 工具，一个位于 `delo/apps/tools` 的私有包。
它包含差异台账检查器：该检查器记录本树与其锁定的上游提交之间的每一处差异，并统计这些差异的数量。
检查运行器、本地 stack 以及其他 fork 工具将随后续工作包到达。

## 模块

- `src/fork-boundary.ts` 包含台账的 schema、fork 自有路径与 glob 的匹配器、边界错误以及差异汇总。
- `src/check-fork-boundary.ts` 是命令行门禁。它读取台账，依据台账检查本仓库，并在传入 `--count` 时打印差异数量。
- `src/git.ts` 为上述两个模块运行 git，并报告退出状态。
- `tests/` 包含测试规范。台账规则在临时 git 仓库中运行；别名检查读取所锁定的上游 `tsconfig.base.json`。

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

## 本地检查

检查运行器 `delo/apps/tools/src/run-checks.ts` 将随 WP1.10 到达。在此之前，从仓库根目录运行以下命令：

- `pnpm --filter @delo/tools check` 运行上文所述的台账检查，出现任何违规时以 1 退出。
- `node_modules/.bin/tsx delo/apps/tools/src/check-fork-boundary.ts --count` 运行同样的检查，并打印差异数量。
- `node_modules/.bin/vitest run --config delo/vitest.config.ts` 运行 `delo/apps/*/tests` 与 `delo/packages/*/tests` 下的测试规范。
- `node_modules/.bin/tsc -p delo/apps/tools/tsconfig.json --noEmit` 对本包进行类型检查。

[delo-dev-workflow 技能](../../../.agents/skills/delo-dev-workflow/SKILL.md)说明了何时运行每项检查。

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
