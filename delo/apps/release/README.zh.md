# Delo 发布工具

[English](README.md) | 中文

`@delo/release` 是 Delo 的发布工具，一个位于 `delo/apps/release` 的私有包。它包含变更片段门禁、发布说明汇总工具、用于构建运行时发行包（runtime closure）的已发布构建配方，以及签名所需的两次构建的比较。[发布 manifest（release manifest）约定](../../docs/contracts/c02-release-manifest.zh.md)（C2）定义了本包所实现的发布文件、可复现范围与签名规则。

## 模块

- `src/changelog/paths.ts` 把路径分类为需要变更条目的产品文件，或片段文件。
- `src/changelog/fragment.ts` 解析片段的前置元数据和正文，并列出未发布文件夹。
- `src/changelog/version.ts` 接受发布版本。
- `src/changelog/check.ts` 是门禁 `gates:changelog`。它检查范围内的每个提交，以及工作树中的每个片段。
- `src/changelog/assemble.ts` 汇总一次发布的说明、`CHANGELOG.md` 的块，以及移入的片段。
- `src/build-closure.ts` 是运行时发行包配方的命令；`src/closure/` 存放其各步骤：配方文件（`config.ts`）、固定的下载（`sources.ts`）、暂存目录树与运行时文件列表（`tree.ts`）、原生代码检查（`native.ts`）以及归档（`archive-closure.ts`）。
- `src/archive/` 存放确定性 tar、gzip 与 ZIP 写入器、对应的读取器，以及用于检查归档是否为确定性形式的检查模块。
- `src/compare-rebuild.ts` 是重建比较的命令；`src/rebuild/` 存放比较逻辑，以及其第一条例外所对应的 PE 规范化。
- `tests/` 存放规格。变更片段规格在临时 git 仓库上运行两个入口；归档、运行时发行包与重建规格则在临时目录中构建 fixture（测试前置数据）运行时发行包，并从本地 HTTP 替身提供固定的下载，因此都不需要网络。

## 门禁

`node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>` 检查 `<rev>` 之后的每个提交。改动产品文件的提交，须在 `delo/changelog/unreleased/` 下添加片段，或带有 `Changelog: none (<reason>)` 尾注。产品文件指文档、工具、发布、工作流和变更日志目录之外的路径，但 Markdown 文件和双语配对记录（`*.i18n.yaml`）在任何位置都属于文档，不是产品文件。门禁还拒绝没有理由的尾注，以及无法解析的片段。它为每项违规输出一行，并以退出码 1 结束。

## 汇总

`node_modules/.bin/tsx delo/apps/release/src/changelog/assemble.ts --version <version> [--dry-run] [--first-public-release]` 从未发布的片段汇总一次发布。版本形如 `0.x.y`，可带 `-alpha.N`、`-beta.N` 或 `-rc.N` 后缀。除非传入 `--first-public-release`，否则拒绝 `1.0.0`。

`From upstream` 部分的上游版本取自 `delo/upstream-patches.json` 的 `upstream.ref`。汇总会在仓库根目录的 `CHANGELOG.md` 前面加上 `## <version>` 块，并把发布说明写入 `delo/changelog/releases/<version>.md`。上游的标签中没有 `CHANGELOG.md`，因此该文件属于 Delo 自身。首次提交该文件的发布，须在同一提交中添加其差异账本条目。已有说明或块的版本会被拒绝。

汇总会把每个已使用的片段移入 `delo/changelog/releases/<version>/`。`--dry-run` 输出块和说明，但不写入任何文件。

## 运行时发行包

运行时发行包是某个平台可安装的运行时。它在 `node/` 下包含固定的 Node 可执行文件及其许可证（`node/bin/node`，Windows 上为 `node/node.exe`），在 `pnpm/` 下包含 pnpm，并在 `app/` 下包含发行包根包的 `package.json`、`pnpm-lock.yaml` 与生产依赖。根包即 `closure.json` 指定的包：上游的 `dsh-python-runtime-closure`（`python/sdk-runtime`），这是一个仅含依赖的 manifest，其依赖为 `dsh` 命令，加上随发行版提供的 profile 所加载的每个插件及其工作区对等依赖；上游的 `verify-runtime-closure` 检查使该清单保持完整。`dsh` 命令的入口文件是 `app/node_modules/@deepseek-ai/dsh/lib/bin.js`。

`node_modules/.bin/tsx delo/apps/release/src/build-closure.ts --version <version> --out <dir> [--commit <rev>] [--platform <platform>]... [--cache <dir>]` 从某个提交（默认为 `HEAD`）构建所有平台的运行时发行包，或构建所指定平台的运行时发行包。它在 Linux 或 macOS 上运行；若 Node 或 pnpm 版本与 `toolchain.json` 所固定的不一致，则拒绝运行。对每次构建，它依次执行以下步骤：

1. 将提交的目录树导出到 `closure.json` 所固定的构建根目录 `/var/tmp/delo-release-build/source`，使打包工具嵌入客户端产物的绝对路径在每台构建机上都相同；若该路径上已有本命令未创建的目录，则命令拒绝继续，并且从不删除该目录；
2. 在构建根目录中运行 `pnpm install --frozen-lockfile` 与 `pnpm run build:artifacts`，环境变量仅保留构建机的 `PATH`、`HOME`、`USER`、`TMPDIR` 与代理变量，并额外设置 `SOURCE_DATE_EPOCH`（提交的 committer 时间）、`CFLAGS` 与 `CXXFLAGS` 中的 `-ffile-prefix-map=<build root>=.`、`TZ=UTC`、`LC_ALL=C`，以及客户端产物所嵌入的提交 id；
3. 对每个平台，以该平台的 `--os`、`--cpu` 与 `--libc` 对根包运行 `pnpm deploy --prod --ignore-scripts`，采用提升的 `node_modules` 并复制文件；将包链接替换为文件；像上游的可执行构建一样，让每个工作区包在其使用方之间共享；删除 pnpm 的 deploy 元数据以及根包的其他文件；并将 `prebuilt-pins.json` 在 `substitutes` 下列出的每个工作区包替换为其已发布的 tarball，替换前检查该 tarball 的完整性，并检查其版本与所部署源码的版本相等；
4. 添加 `toolchain.json` 按 SHA-256 固定的分发归档中的 Node 可执行文件，以及按完整性固定的 tarball 中的 pnpm；两者各下载一次到缓存（默认为 `~/.cache/delo-release`），且仅在字节匹配时才被使用；
5. 将 `node/` 之外的每个 ELF、Mach-O 与 PE 文件与 `prebuilt-pins.json` 中该平台的 `files` 条目核对：未列出的文件、摘要改变，或已列出却缺失的文件，都会使构建中止；
6. 将 `delorun-<version>-<platform>.tar.gz`（`win32-x64` 为 `.zip`）及其未签名的运行时文件列表 `delorun-<version>-<platform>.files.json` 写入 `--out`，且从不替换已有文件。

`--write-pins` 将已构建平台的原生文件记录到 `prebuilt-pins.json` 中，而不做核对；所记录的变更与对配方的任何其他变更一样需要评审。

一个运行时发行包中的每个原生插件（addon）都是预构建文件：上游的 `@deepseek-ai/node-addon-system` 平台包来自其 npm 发布，其他插件则来自 lockfile 按完整性固定的 npm tarball。因此 `toolchain.json` 不指定任何编译器或链接器，前缀映射仅在某个构建步骤编译代码时才适用。

### 归档格式

两种格式都只包含普通文件，按路径的 UTF-8 字节序排列，不含目录、链接或设备条目；文件模式为 `0644`，若暂存树中某文件带有任一执行位，则为 `0755`。

- **tar.gz**：POSIX ustar 头部，uid 与 gid 为 0，用户名与组名为空，每个 mtime 均为 `SOURCE_DATE_EPOCH`；名称与前缀字段无法容纳的路径，会获得一个含单条 `path` 记录的 pax 头部。归档以两个零块结束。gzip 成员的 mtime 为 0，不含文件名，操作系统字节为 255，并以 deflate 压缩，级别为 9。
- **ZIP**：「version made by」字段为 Unix 2.0，文件模式位于外部属性中，文件名使用 UTF-8，不含扩展字段、注释、数据描述符或 ZIP64 记录；DOS 时间取 `SOURCE_DATE_EPOCH` 的 UTC 时间，并向下取整到偶数秒；每个条目以 deflate 压缩，级别为 9，除非存储方式的结果更小。归档最多包含 65,535 个条目。

归档最大为 1 GiB，即 [C1](../../docs/contracts/c01-home-layout.zh.md) 所规定的下载上限。

## 重建比较

`node_modules/.bin/tsx delo/apps/release/src/compare-rebuild.ts <first> <second>` 比较同一发布的两个输出目录，例如发布工作流的重建与目标密钥持有者的重建。当两者的文件名相同且每个文件都匹配时，它以 0 退出，并输出被 `rebuild-exceptions.json` 中某条目接受的每项差异及该条目的 id。出现任何其他差异时，它以 1 退出，并逐项输出这些差异；签名会拒绝这样的重建。用法错误、目录不可读，或例外文件未通过校验时，它以 2 退出。

- 运行时归档在以下条件同时满足时匹配：两份副本都为确定性形式（重新编码其条目可复现归档的字节），包含相同路径且模式与 mtime 相同，并且每个条目的字节相同，或其差异被某个例外接受。
- 运行时文件列表在每份副本都等于由其自身归档推导出的列表时匹配。
- 其他文件在字节完全相同时匹配。

`rebuild-exceptions.json` 列出每项被接受的差异，包括其 id、所适用的比较（`pe` 为唯一一种）及其理由；出现未知字段时校验失败。其第一条为 `pe-authenticode`，仅适用于 Windows 归档：它在比较 PE 文件时去掉 Authenticode 证书表、安全数据目录项与头部校验和，并以零补齐至 8 字节，因为发布工作流会对 Windows 运行时发行包中的 PE 文件签名，而工作流之外的重建无法签名。证书表必须由修订版本 2.0、类型为 PKCS #7 SignedData 的 `WIN_CERTIFICATE` 条目组成，并一直填充到文件末尾；其他任何追加字节都算作差异。
