# Delo 发布工具

[English](README.md) | 中文

`@delo/release` 是 Delo 的发布工具，一个位于 `delo/apps/release` 的私有包。它包含变更片段门禁和发布说明汇总工具。发布清单合约所描述的签名、重建和依赖公告检查，将由后续工作包提供。

## 模块

- `src/changelog/paths.ts` 把路径分类为需要变更条目的产品文件，或片段文件。
- `src/changelog/fragment.ts` 解析片段的前置元数据和正文，并列出未发布文件夹。
- `src/changelog/version.ts` 接受发布版本。
- `src/changelog/check.ts` 是门禁 `gates:changelog`。它检查范围内的每个提交，以及工作树中的每个片段。
- `src/changelog/assemble.ts` 汇总一次发布的说明、`CHANGELOG.md` 的块，以及移入的片段。
- `tests/changelog/` 存放规格。它们在临时 git 仓库和夹具目录树上运行两个入口。

## 门禁

`node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>` 检查 `<rev>` 之后的每个提交。改动产品文件的提交，须在 `delo/changelog/unreleased/` 下添加片段，或带有 `Changelog: none (<reason>)` 尾注。产品文件指文档、工具、发布、工作流和变更日志目录之外的路径，但 Markdown 文件和双语配对记录（`*.i18n.yaml`）在任何位置都属于文档，不是产品文件。门禁还拒绝没有理由的尾注，以及无法解析的片段。它为每项违规输出一行，并以退出码 1 结束。

## 汇总

`node_modules/.bin/tsx delo/apps/release/src/changelog/assemble.ts --version <version> [--dry-run] [--first-public-release]` 从未发布的片段汇总一次发布。版本形如 `0.x.y`，可带 `-alpha.N`、`-beta.N` 或 `-rc.N` 后缀。除非传入 `--first-public-release`，否则拒绝 `1.0.0`。

`From upstream` 部分的上游版本取自 `delo/upstream-patches.json` 的 `upstream.ref`。汇总会在仓库根目录的 `CHANGELOG.md` 前面加上 `## <version>` 块，并把发布说明写入 `delo/changelog/releases/<version>.md`。上游的标签中没有 `CHANGELOG.md`，因此该文件属于 Delo 自身。首次提交该文件的发布，须在同一提交中添加其差异账本条目。已有说明或块的版本会被拒绝。

汇总会把每个已使用的片段移入 `delo/changelog/releases/<version>/`。`--dry-run` 输出块和说明，但不写入任何文件。
