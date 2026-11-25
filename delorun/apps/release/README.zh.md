# Delorun 发布工具

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

`@delorun/release` 是 Delorun 的发布工具，一个位于 `delorun/apps/release` 的私有包。它包含变更片段门禁、发布说明汇总工具、用于构建运行时发行包（runtime closure）的已发布构建配方、签名所需的两次构建的比较、发布的 SBOM（软件物料清单）、依赖安全公告检查、发布元数据的签名与验证、发布日志（release log），以及 S2 与 S3 镜像。[发布 manifest（release manifest）约定](../../docs/contracts/c02-release-manifest.zh.md)（C2）定义了本包所实现的发布文件、可复现范围与签名规则。

## 模块

- `src/changelog/paths.ts` 把路径分类为需要变更条目的产品文件，或片段文件。
- `src/changelog/fragment.ts` 解析片段的前置元数据和正文，并列出未发布文件夹。
- `src/changelog/version.ts` 接受发布版本。
- `src/changelog/check.ts` 是门禁 `gates:changelog`。它检查范围内的每个提交，以及工作树中的每个片段。
- `src/changelog/assemble.ts` 汇总一次发布的说明、`CHANGELOG.md` 的块，以及移入的片段。
- `src/build-closure.ts` 是运行时发行包配方的命令；`src/closure/` 存放其各步骤：配方文件（`config.ts`）、固定的下载（`sources.ts`）、原生插件的编译（`native-build.ts`）、发行包中的 Delorun 各包（`delorun.ts`）、启动器用来启动发行包的文件（`launch.ts`）、暂存目录树与运行时文件列表（`tree.ts`）、原生代码检查（`native.ts`）以及归档（`archive-closure.ts`）。
- `src/local-release.ts` 把一次签名发布构建到按发布渠道布局的目录中；`src/local/release.ts` 存放其各步骤，`src/local/production-keys.ts` 读取生产密钥注册表（见[本地发布](#local-release)）。
- [`@delorun/release-formats`](../../packages/release-formats/README.zh.md) 存放本工具与已发布的验证器共用的格式：确定性的 tar、gzip 与 ZIP 写入器和读取器，以及对确定性形式的检查（`archive/`）；签名信封、规范 JSON、各签名文件的读取器与客户端验证（`sign/`）；发布日志条目、bundle、签名注记、Merkle 证明与分块（`log/`）；以及版本与摘要的品牌类型。它发布的内容不依赖本包，因此运行时发行包不含任何发布工具。
- `src/compare-rebuild.ts` 是重建比较的命令；`src/rebuild/` 存放比较逻辑；其第一条例外所对应的 PE 规范化位于 `@delorun/release-formats/archive/pe`。
- `src/record-rebuild.ts`、`src/sign-release.ts`、`src/sign-root.ts` 与 `src/sign-timestamp.ts` 是签名命令，`src/draft-root.ts` 写出 `sign-root.ts` 所签的根草稿；`src/rebuild/record.ts` 存放重建记录的事实，`src/sign/` 存放时间戳内容、发布来源检查（`source.ts`）、npm tarball 检查（`npm-package.ts`）与签名。
- `src/sbom/` 从运行时归档写入 SPDX SBOM；`src/check-advisories.ts` 与 `src/advisory/` 运行依赖安全公告检查。
- `src/build-images.ts` 与 `src/images/` 从 `images.json` 与 `images/` 构建 S2 与 S3 镜像；`src/log-release.ts` 与 `src/log/client.ts` 提交发布日志条目并写入其 bundle。
- `tests/` 存放规格。变更片段规格在临时 git 仓库上运行两个入口；归档、运行时发行包与重建规格在临时目录中构建 fixture（测试前置数据）发行包，并从本地 HTTP 替身提供固定的下载；签名规格用测试中生成的密钥签署 fixture 发布；发布日志规格运行本地日志与见证者（witness）替身，因此都不需要网络，也不需要真实密钥。`tests/images/images.docker.spec.ts` 将两个镜像各构建两次，`tests/closure/native-build.docker.spec.ts` 从两个目录为两个 Linux 平台编译原生插件，并把二进制文件互相比较，也与 `prebuilt-pins.json` 比较；二者仅在设置 `DELORUN_DOCKER_SPECS=1` 时运行，因为检查运行器（check runner）没有 Docker 通道。`tests/closure/boot.closure.integration.spec.ts` 从已构建的发行包设置一个新的 home，启动 CLI 配置，并要求每个 `@delorun/` 行都处于活动状态；它仅在 `DELORUN_CLOSURE_ARCHIVE` 指向一个已构建的 `linux-x64` 发行包归档时运行，发布工作流必须对其发布的 `linux-x64` 归档运行它。

## 门禁

`node_modules/.bin/tsx delorun/apps/release/src/changelog/check.ts --base <rev>` 检查 `<rev>` 之后的每个提交。修改了产品文件的提交，要么在 `delorun/changelog/unreleased/` 下新增一个片段，要么带有 `Changelog: none (<reason>)` 尾注。产品文件是文档、工具、发布、工作流与变更日志目录树之外的所有路径，但 Markdown 文件与双语配对记录（`*.i18n.yaml`）除外，它们无论位于何处都属于文档。门禁还会拒绝没有原因的尾注，以及每个无法解析的片段。它为每个违规打印一行，并以退出码 1 退出。

## 汇总

`node_modules/.bin/tsx delorun/apps/release/src/changelog/assemble.ts --version <version> [--date <YYYY-MM-DD>] [--dry-run] [--first-public-release]` 把未发布的片段汇总为一个版本。版本可以是预览子版本 `0.x.y-preview.N`（N 从 1 开始）、位于 `N` 与 `N+1` 之间的私有测试版本 `0.x.y-preview.N.M`（M 从 1 开始）、正式版本 `0.x.y`，或 `-alpha.N`、`-beta.N`、`-rc.N` 预发布版本；除非传入 `--first-public-release`，否则 `1.0.0` 会被拒绝。汇总 `0.x.y` 时，会把它各个预览版本与测试版本的条目并入其中。

汇总会写入 `delorun/changelog/changelog.json`（与 `delorun/upstream-patches.json` 中 `upstream.ref` 所指上游发布的常设比较，以及每个版本），据此在仓库根目录渲染 `CHANGELOG.md`，把发布说明写入 `delorun/changelog/releases/<version>.md`，并把每个已用片段移入 `delorun/changelog/releases/<version>/`。待定的片段从不会被汇总。已经汇总过的版本会被拒绝。把 `CHANGELOG.md` 加入仓库的发布提交，同时也加入它的分歧台账条目。

`--dry-run` 打印条目和说明，不写入任何内容；`--list-unreleased` 按领域打印未发布的片段，并打印待定的片段及其各自等待的条件。片段格式、领域与数据文件见 [`delorun/changelog/README.md`](../../changelog/README.zh.md)。

## 运行时发行包

运行时发行包是某一平台上可安装的运行时：固定版本的 Node 可执行文件及其许可证位于 `node/` 下（`node/bin/node`，Windows 上为 `node/node.exe`），pnpm 位于 `pnpm/` 下，发行包根包的 `package.json`、`pnpm-lock.yaml` 与生产依赖位于 `app/` 下。根包是 `closure.json` 所指定的 [`@delorun/runtime-closure`](../runtime-closure/README.zh.md)：它取自上游的 `dsh-python-runtime-closure`（`python/sdk-runtime`），是只含依赖的 manifest，其依赖包括 `dsh` 命令及其已发布配置所加载的每个插件和它们的工作区 peer（上游的 `verify-runtime-closure` 检查负责保证其完整），以及 `@delorun/cli` 与 Delorun 的各包。`delorun` 命令的入口文件是 `app/node_modules/@delorun/cli/src/bin.js`，`dsh` 命令的入口文件是 `app/node_modules/@deepseek-ai/dsh/lib/bin.js`。

`closure.json` 列出发布平台，即本次发布为之发布运行时的平台：`linux-x64` 与 `linux-arm64`；Windows 由运行 Linux 运行时的 WSL2 提供服务。构建、SBOM、重建记录的必需输出与签名恰好覆盖这些平台，当列表中出现 `toolchain.json` 把原生插件标为 `unbuilt` 的平台时，读取配方会失败。它还给出客户端标题 `Delorun`，客户端产物把它用作页面标题、主屏幕标题和 web manifest 的名称；以及安装锚点 `@deepseek-ai/dsh`，上游的运行时解析会读取其 `package.json`，以判断某个配置的插件行能导入什么，它必须声明的 Delorun bundle 是 `@delorun/bundle-local` 与 `@delorun/bundle-studio`，即每个新 CLI 配置所列出的所有 `@delorun/` bundle。没有这项声明，`delorun` 会拒绝每一次启动，因为某个 Delorun 插件行导入失败。`closure.json` 还列出 `foreignPrebuilds`：在主包中携带其他平台预构建文件的包（目前是 `@deepseek-ai/libreoffice-kit` 的 `frame-forwarding/prebuilds`，针对 macOS 与 Windows 平台），以及需要删除的平台目录。构建会从每个发行包中恰好删除这些目录，每个目录记录一行日志，并在原生代码检查之前完成；未列出的外来预构建文件仍会使检查失败，而以发行包自身平台命名的目录从不会被删除。每个列出的目录都必须存在于发行包中，否则构建会在删除任何内容之前失败；目录经由 `..` 段或符号链接解析到其包之外的规则，同样会被拒绝。配方在读取时就拒绝带有 `.` 或 `..` 段的 `directory`。

`closure.json` 还列出 `packExternals`，即插件包从不携带的包名（精确名称，或以 `*` 结尾的前缀），因为发布者的许可证禁止再分发：Claude Code 的 `@anthropic-ai/claude-agent-sdk` 包及其平台程序 `@anthropic-ai/claude-agent-sdk-*`，以及 Codex 的 `@openai/codex-*`。packs 文件按 npm tarball URL 和 SHA-512 固定其中每一个，启用插件包时会从注册表获取并校验它。

一个 pack 的 `package.json` 与 `pnpm-lock.yaml`，在同一份源码的每次构建中都是相同的字节。`pnpm deploy` 会把它注入的工作区包写成 `<name>@file:///<absolute source path>`，其中带有该次构建的临时文件夹，因此 pack 构建改为写入该 pack 所携带的那个包的确切版本，写在 `package.json` 以及锁文件的 `importers`、`packages` 与 `snapshots` 中（其 `directory` 变为 `node_modules/<name>`，而某个变体的 peer 后缀保持不变）。它还会删除运行时发行包所删除的部署元数据（`DEPLOY_METADATA`：`pnpm-workspace.yaml`、`node_modules/.modules.yaml`、`node_modules/.pnpm-workspace-state-v1.json` 与 `node_modules/.pnpm`），这些文件带有构建的文件夹、pnpm 存储的文件夹和时间戳。随后它会拒绝仍然携带其中任何文件的 pack，或拒绝其 `package.json` 的依赖字段（包括 `bundleDependencies`）、它在任意深度携带的任何 Delorun 或 vendor 包的 `package.json`、或锁文件仍然带有绝对路径（任何以 `/` 或盘符开头的值）、`file://` URL、pack 之外的路径或临时或 home 文件夹的 pack，并指出该 pack、该文件与该字段（`src/closure/pack-specifiers.ts`）。`node_modules/.bin/tsx delorun/apps/release/scripts/pack-probe.ts --source <tree> --scratch <empty dir> --out <empty dir> --name <package> --stage <dir>` 为一个包运行一次真实的 `pnpm deploy` 和 pack 步骤，不签名，并打印归档摘要；从同一棵树的两个副本运行它并比较摘要，就能看出某个 pack 是否依赖于它在哪里构建（脚本头部说明了如何准备 `--stage`）。

没有任何已发布的文件指名构建者。当构建写完全部文件后，从源码运行的 `build-closure.ts`（`--artifacts build`）会拒绝其输出中、以及其中每个 `.tar.gz` 归档的每个条目中，带有构建者用户 home 目录（`os.homedir()`）、作为文件夹的用户名（`/<name>/` 或 `\<name>\`）或唯一构建根 `delorun-release-build-*` 的任何文件，并逐一指出这些文件（`@delorun/release-formats/gate/home-paths`；共用的 `/var/tmp/delorun-release-build/source` 不算发现）。该扫描读取字节，因此覆盖 JavaScript、JSON、YAML、source map 与文本，也覆盖二进制文件中的相同字符串；它不读取 UTF-16 文本，也不读取 `.zip` 的内部。从已有产物构建（`--artifacts existing`）会嵌入工作树的路径，因此 `build-closure.ts` 对它把发现打印为警告，而 `local-release.ts` 在签名任何东西之前拒绝它们。默认情况下没有任何东西绕过这一点：`cut-rc.ts`（其 `--artifacts` 默认为 `existing`）与 `local-release.ts` 接受 `--allow-builder-paths`，运行它们的人为本地迭代候选版本传入该标志，它把拒绝换成每个违规文件一条警告。公开切版使用 `--artifacts build`，绝不使用该标志。npm 启动器的包与发行包分开构建，`npm-launcher/src/build.ts` 在打包之前对它自己的输出运行同样的拒绝，因此没有任何启动器 tarball 指名构建者；`node_modules/.bin/tsx delorun/apps/release/scripts/home-path-gate.ts <directory>...` 对任何目录运行该扫描，指出每个违规文件并以 1 退出。

`node_modules/.bin/tsx delorun/apps/release/src/build-closure.ts --version <version> --out <dir> [--commit <rev>] [--platform <platform>]... [--cache <dir>]` 从某个提交（默认 `HEAD`）构建所有发布平台或指定平台的发行包。它在带有 Docker 引擎的 Linux 或 macOS 上运行（原生步骤需要 Docker），在 Node 或 pnpm 版本与 `toolchain.json` 固定的不一致时拒绝运行，并拒绝不是发布平台的平台。每次构建它依次：

1. 把该提交的目录树导出到 `closure.json` 固定的构建根目录 `/var/tmp/delorun-release-build/source`，使打包工具嵌入客户端产物的绝对路径在每个构建者那里都相同；构建持有锁文件 `/var/tmp/delorun-release-build.lock`，其中记录进程 id，因此同一台计算机上的第二次构建会拒绝运行并指出持有者，而不是删除第一次构建的目录树，该路径上并非本命令创建的目录会被拒绝，绝不会被删除；
2. 在其中运行 `pnpm install --frozen-lockfile` 与 `pnpm run build:artifacts`，环境中只有构建者的 `PATH`、`HOME`、`USER`、`TMPDIR` 与代理变量，外加 `SOURCE_DATE_EPOCH`（提交的提交者时间）、`CFLAGS` 与 `CXXFLAGS` 中的 `-ffile-prefix-map=<build root>=.`、`TZ=UTC`、`LC_ALL=C`、客户端产物嵌入的提交 id，以及设置为客户端标题的 `DSH_CLIENT_TITLE`，使上游自己的客户端构建呈现该标题；然后构建带有 `build` 脚本的 Delorun 各包（`pnpm --filter ./delorun/packages/* run build`），这些包不由 `build:artifacts` 构建；
3. 为每个路径为 `source` 的平台编译 `native/system` 中上游的原生系统插件，如[原生代码](#native-code)所述，输出到平台包的 `bin/`；
4. 对每个平台，以该平台的 `--os`、`--cpu` 与 `--libc` 对根包运行 `pnpm deploy --prod --ignore-scripts`，使用提升的 `node_modules` 并复制文件，把包链接替换为文件，像上游的可执行构建那样让各消费者共用同一个工作区包，移除 pnpm 的部署元数据与根包的其他文件；把每个 `@delorun/` 包的 `src/**/*.ts` 在其旁边转译为 JavaScript，相对导入与 `package.json` 入口点改写为 `.js`，并删除该包的 `tests`，因为 Node 不会从 `node_modules` 运行 TypeScript；把发布版本写入 `@delorun/cli` 的 `package.json`，`delorun --version` 与插件版本检查从那里读取（工作区中是 `0.0.0`）；把锚点必须声明的每个 Delorun bundle 以其暂存版本加入锚点 `package.json` 的依赖；部署携带原生插件的平台包，其中的二进制文件即上一步编译的结果；
5. 加入 `toolchain.json` 以 SHA-256 固定的发行归档中的 Node 可执行文件，以及以完整性值固定的 tarball 中的 pnpm，二者各下载一次到缓存（默认 `~/.cache/delorun-release`），仅在字节匹配时使用；
6. 对照 `prebuilt-pins.json` 中该平台的 `files` 条目，检查 `node/` 之外的每个 ELF、Mach-O 与 PE 文件：未列出的文件、变化的摘要，或列出但缺失的文件，都会使构建停止；
7. 拒绝归档缺少启动协议 1 所需文件的发行包，这些文件是 `node/bin/node`（Windows 上为 `node/node.exe`）与 `app/node_modules/@delorun/cli/src/bin.js`，运行时存储要求它们存在后启动器才会启动某个运行时；然后把 `delorun-<version>-<platform>.tar.gz`（`win32-x64` 为 `.zip`）及其未签名的运行时文件列表 `delorun-<version>-<platform>.files.json` 写入 `--out`，从不替换已有文件；构建完所有平台后，同样在那里写入 SBOM `delorun-<version>.spdx.json`。

`--write-pins` 把所构建平台的原生文件记录到 `prebuilt-pins.json`，而不是检查它们；所记录的变更与对配方的其他变更一样要经过评审。

`--artifacts existing` 用工作树中已经构建好的产物为本地发布构建发行包，而不是在导出的目录树中运行 `pnpm run build:artifacts`。仅当工作树位于 `--commit`、其受跟踪文件干净，并且每个 `main` 指向 `lib/` 下文件的包都有该文件、其 `lib/` 比 `src/` 更新时，它才会运行（通过检查运行器 `run-checks.ts --only build:artifacts` 构建产物即可使它们保持最新）。随后，被忽略的 `lib/` 目录与客户端 bundle 会被复制到导出的目录树中，原生步骤像发布构建那样在其中编译原生插件，替换随之复制的所有二进制文件，因此发行包的原生文件同样要对照 `prebuilt-pins.json` 检查。这样的发行包嵌入了工作树的路径，所以只用于本地发布，绝不用于签名。由于它的路径本来就是本地的，它在自己专属的新目录 `/var/tmp/delorun-release-build-<suffix>` 中构建，构建结束时删除该目录，并且不持有锁，因此多个工作树的本地构建可以并行运行。

### 原生代码

上游 `native/system` 中的原生系统插件，即静态 Landlock 启动器 `landlock-run`，以及适用于 glibc 与 musl 的 flock Node-API 插件 `system.node`，由配方为 `toolchain.json` 的 `native.platforms` 中路径为 `source` 的每个平台编译：`linux-x64` 与 `linux-arm64`。它是只针对 C 库、内核头文件与 Node 头文件编译的 C 代码，因此没有需要锁定的第三方源码。

1. 构建者镜像基于 `images.json` 以摘要固定的 Debian 基础镜像，由 `native/Dockerfile` 构建，针对该平台的 OCI 架构，安装 `native.builder.packages` 以精确 Debian 版本固定的软件包（GCC 12.2.0、binutils 2.40、glibc 2.36 与 Linux 6.1 头文件、musl 1.2.3），这些软件包取自 `native.builder.snapshot` 指定的 Debian 快照。这是使用网络的步骤；镜像标签是 Dockerfile、基础镜像、快照、软件包与架构的摘要，因此带该标签的已有镜像会被复用。
2. 配方列出镜像中已安装的固定软件包版本，并拒绝版本不同的镜像。
3. 它解包该平台所固定 Node 发行版的 `bin/node` 与头文件，并在镜像内用该 Node 原样运行上游的 `native/system/scripts/build.ts`，不联网，根文件系统只读，使用构建者的用户，并设置 `TZ=UTC`、`LC_ALL=C` 与 `SOURCE_DATE_EPOCH`。`linux-arm64` 镜像在 x64 构建者上通过模拟运行，镜像构建同样如此：Docker Desktop 提供该模拟，Docker Engine 主机则需要用 `binfmt_misc` 注册 QEMU。

上游的构建脚本传入自己的编译器标志，且不读取 `CFLAGS`，因此前缀映射对它不起作用；二进制文件既不嵌入构建目录，也不嵌入时间，同一镜像编译挂载在另一路径的目录树会得到相同的字节。`prebuilt-pins.json` 固定这些字节，因此任何不同的构建都会在归档之前停止。

`darwin-x64` 与 `darwin-arm64` 是 `unbuilt`：配方没有可编译 macOS 二进制文件的固定工具链，所以 `closure.json` 不能列出它们，`build-closure.ts` 在运行任何步骤之前就拒绝这两个平台，在这样的工具链出现之前，发布不会发布 macOS 运行时。`win32-x64` 是 `none`：`native/system` 没有 Windows 包。发布不会发布 `win32-x64` 运行时，`closure.json` 也不列出它；配方保留了暂存和归档 Windows 发行包的代码（`node/node.exe`、`.zip` 归档、PE 检查），以便以后的发布可以列出它，在此之前 `build-closure.ts` 拒绝该平台。发行包中的其他所有原生文件，都是来自 npm tarball 的预构建文件，该 tarball 由锁文件以完整性值固定，`prebuilt-pins.json` 同样固定其摘要。

### 归档格式

两种格式都只含普通文件，按 UTF-8 字节序排列路径，没有目录、链接或设备条目，权限模式为 `0644`，而在暂存目录树中带有任一执行位的文件为 `0755`。

- **tar.gz**：POSIX ustar 头，uid 与 gid 为 0，用户名与组名为空，每个 mtime 都是 `SOURCE_DATE_EPOCH`；名称和前缀字段放不下的路径会得到带一条 `path` 记录的 pax 头。归档以两个全零块结尾。gzip 成员的 mtime 为 0，没有文件名，操作系统字节为 255，deflate 级别为 9。
- **ZIP**：“version made by”为 Unix 2.0，模式放在外部属性中，名称为 UTF-8，没有额外字段、注释、数据描述符或 ZIP64 记录，DOS 时间为 UTC 的 `SOURCE_DATE_EPOCH` 向下取整到偶数秒，每个条目以 9 级 deflate 压缩，除非直接存储更小。一个归档最多包含 65,535 个条目。

归档最大为 1 GiB，即 [C1](../../docs/contracts/c01-home-layout.zh.md) 的下载上限。

## 本地发布

`node_modules/.bin/tsx delorun/apps/release/src/local-release.ts --version <version> --summary <text> [--security] --out <channel dir> --root <root file>... --targets-key <targets.pem> --timestamp-key <timestamp.pem> --state <state.json> --log-submit <url> --log-checkpoint <url> --log-tiles <url> [--platform <platform>]... [--commit <rev>] [--closures-from <dir>] [--cache <dir>] [--production-keys <file>] [--allow-builder-paths]` 从某个提交构建并签署一次发布，输出到按发布渠道布局的目录中，供以该目录的来源作为渠道来源构建的启动器使用（`delorun/apps/npm-launcher`）。它组合上述各步骤，不增加任何密码学：

1. 在构建任何内容之前，它先拒绝生产信任材料：拒绝 SHA-256 被[生产密钥注册表](#production-keys)列出的 `--root` 文件、在任一角色或 `keys` 中列出此类密钥的根，以及密钥 id 被它列出的 `--targets-key` 或 `--timestamp-key`。`--production-keys` 指定注册表，默认是仓库的 `delorun/release/production-keys.json`。随后它像客户端那样检查这些根，并检查 `--targets-key` 是最新根唯一的活动 targets 密钥。
2. 它为每个 `--platform`（`closure.json` 列出的发布平台，未指定时仅 `linux-x64`）从 `--commit`（默认 `HEAD`）构建发行包，使用 `build-closure.ts` 的配方和相同的工具链检查；或者在使用 `--closures-from` 时，取用 `build-closure.ts` 运行后留在那里的每个平台的 `delorun-<version>-<platform>` 归档与 `.files.json`。`--version` 为发布命名，与提交中记载的版本无关，因此同一个提交可以构建为两个版本，从而有更新可取。
3. 它像 `sign/release.ts` 那样为每个文件列表签名，并写出由 targets 密钥签名的 manifest。manifest 的来源是公开仓库、标签 `v<version>` 与该提交；其构建者是“local release (no independent rebuild)”：在 1.0 之前，维护者用此命令在维护者的电脑上构建并签署每个发布版本，为生产频道构建的启动器会在预览根下安装这种 0.x 版本；1.0 版本或更晚的根会拒绝它。其 `runtime` 恰好列出命令所给的平台。其 `summary` 是 `--summary`，必须是不超过 200 个字符的一行普通文本，其 `security` 在带 `--security` 时为 true，否则为 false。manifest schema 要求本地发布并不构建的文件（桌面安装程序、镜像、SBOM、安装脚本、重建记录、安全公告报告），这些文件是长度为零的占位文件，渠道不提供它们。`source.tag` 不必存在。
4. 它像 `log-release.ts` 那样，把 manifest 的 Rekor v2 条目提交到 `--log-submit`、`--log-checkpoint` 与 `--log-tiles` 指定的日志，并在 bundle 能通过根的日志密钥与见证者密钥验证时写出它。命令最多请求 60 次带见证的检查点，每次间隔 30 秒。除非这次发布本就要进入公共日志，否则只指定你自己运行的日志。
5. 它用 `--timestamp-key` 根据 `--state` 中签名者的状态为下一个时间戳签名（渠道首次签名时创建，像 `sign-timestamp.ts --init-state --first` 那样，此后每次签名后替换），并为两个渠道都指定该发布。低于渠道当前所提供版本的版本会被拒绝。

此后渠道目录中包含 `timestamp.json`、每个 `--root` 对应的 `root/<n>.root.json`，以及每个版本的 `releases/download/v<version>/`，其中有 manifest、它的日志 bundle 和条目请求，以及每个平台的归档与签名文件列表。发布文件先写入，时间戳最后写入，因此构建失败时渠道仍提供原来所提供的内容，已在渠道中的版本绝不会被替换。用任意静态服务器提供该目录，并把 `--channel-origin` 设置为它的来源来构建启动器，如[启动器的 README](../npm-launcher/README.zh.md#building-the-package) 所述。

本地发布不是已发布的发布：没有第二个构建者重建过它，没有运行过安全公告检查，其密钥就是 `--root`、`--targets-key` 与 `--timestamp-key` 所指定的那些，只是生产密钥会被拒绝。`tests/local/e2e.integration.spec.ts` 用一次性密钥和本地服务器运行整条路径：用本命令签署一次发布，为它构建并打包一个启动器，在日志不可达的情况下通过 `npm exec` 安装该发布，并检查打印的步骤与警告、`trust/release-log.json` 中的记录，以及运行时的启动。它的运行时是一个 fixture，其入口文件打印它被写入的版本。当 `DELORUN_CLOSURE_FILES` 指向一个目录，其中有 `build-closure.ts --version 0.1.0` 运行所写的 `delorun-0.1.0-linux-x64` 归档和文件列表时，另一个规格会通过打包的启动器安装这个真实的发行包，并运行它的 `delorun --version`。`tests/closure/boot.closure.integration.spec.ts` 在 `DELORUN_CLOSURE_ARCHIVE` 指向该归档时（由现有产物构建时再加 `DELORUN_CLOSURE_EXISTING_ARTIFACTS=1`），用发行包设置一个 home，在每个 Delorun 行都处于活动状态的情况下启动 CLI 配置，并把 Host 作为 home 进程启动，在回环地址上请求 studio 的索引页。

## 旅程

`tests/journey/journey.docker.spec.ts` 在干净的容器中安装一个由工作树构建的发布，并按顺序走完一个人用它会做的事，全程在一个容器中，其 home 在各步骤之间延续。检查运行器把它作为仅限合并的检查 `journey` 运行（[检查](../tools/README.zh.md#local-checks)）；单独运行用 `node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only journey`。它需要一个 Docker 引擎，且 `images.json` 固定的 Debian 基础镜像已经拉取，还需要受跟踪文件均已提交的工作树，因为发布 1 用 `build-closure.ts --artifacts existing` 构建，该选项会拒绝脏工作树、缺失的产物或比源码旧的产物，并逐一指出。

它的各部分都由规格创建，并在其后删除：

- **信任。** 一次性的根、targets、时间戳与日志密钥，由 `tests/local/support.ts` 生成；不使用此人 home 中的任何密钥。
- **发布。** 发布 1（`0.1.0`）来自 `build-closure.ts`。发布 2（`0.2.0`）、2b（`0.2.1`）、3（`0.3.0`）与被篡改的发布（`0.4.0`）都是发布 1 的发行包解开后，用配方的 `stampDelorunVersion` 改成另一个版本，按该发布的需要修改，再用配方的 `archiveClosure` 重新归档而成（[`derive.ts`](tests/journey/derive.ts)），在步骤 1 到 3 运行期间各在自己的进程中完成。发布 2b 的 studio 没有索引页，因此它的 Host 永远不会回答健康检查。发布 3 提升了 Delorun 自己的一条带版本的记录：`delorun_chat_states` 存储单元升到版本 2，它读取版本 1，并在其插件启动时把自己标记为 2，`data-formats.json` 写明新版本，因此报告会指出数据变更，而发布 1 会拒绝标记为 2 的单元并在缺少该 Delorun 行时拒绝启动，只有回滚恢复了副本，它才能再次启动。被篡改发布的归档在归档生成之后，在诚实的签名文件列表之下改动了 `data-formats.json` 的一个字节。每个发布的步骤开始时，`local-release.ts --closures-from` 为它签名并记入日志，写入渠道。
- **服务器**，在规格的进程中：渠道、发布日志（在同一来源上表现为一致、沉默或自相矛盾），以及上游的 `llm-mock-server`，它以一条预设回复回答每个 chat。
- **启动器。** `npm-launcher/src/build.ts`，以本次运行的根以及渠道与日志的来源作为构建常量。
- **机器。** 一个镜像，由固定的 Debian 基础镜像和 `toolchain.json` 固定的 Node 发行版构成，二者都取自这台计算机的缓存，附带配置历史所需的 Debian `git`、一个无特权账户，不含仓库的任何内容；镜像构建只为 `git` 访问网络，机器上没有 pnpm。它的容器位于以 `--internal` 创建的 Docker 网络上，因此既访问不到互联网，也访问不到这台计算机；该网络与 Docker 默认网桥上的一个网关容器，恰好把规格的服务器端口转发到 `host.docker.internal`，每个容器中的转发器在其回环地址的这些端口上监听，因为启动器只在回环地址上接受 `http:` 来源（[`machine.ts`](tests/journey/machine.ts)）。第一个测试证明了这一点：容器向外部地址、外部名称以及直接向这台计算机发出的请求都会失败。一个替身浏览器记录 Host 交给它的每个地址，就像桌面浏览器会打开的那样，随后 [`probe.mjs`](tests/journey/probe.mjs) 用该浏览器保存的 cookie 与 studio 通信。

各步骤：(1) 对打包的启动器执行 `npm exec`，在日志一致的情况下安装发布 1，打印五行进度并记录检查；启动器按 setup 提供的方式用 `npm install --global` 安装；运行 `delorun setup --config`；`delorun` 在后台启动并打开 studio，其索引页带 cookie 时返回 200，不带时返回 401；每个已启用的行都处于活动状态；一次 chat 完成并已保存到磁盘；(2) 日志沉默时，全新安装会发出警告并记录 `unchecked`，日志自相矛盾时，全新安装会拒绝并且不安装任何内容；(3) `delorun plugin` 用发布所带的 pnpm 添加一个插件；从文件添加两个插件，再次关闭一个 bundle，关闭一行，一个主题行、一个预设行和一个 skill；(4) `PATH` 中没有 git 时，`delorun update` 在获取任何内容之前就拒绝；`delorun update` 更新到发布 2，在任何内容变化之前先指出 fixture 插件，并在此人确认后应用；(5) `delorun recover rollback`；(6) 更新到发布 2b 会自行回滚；(7) 带副本更新到发布 3，进行第二次 chat，以及恢复第一份副本并把第二份放到一边的回滚；(8) 同一更新带 `--no-data-copy`；(9) 被篡改的发布被全新安装和更新双双拒绝；(10) 某个运行时文件改变前后的 `delorun verify`；(11) 回收站、导出，以及导入到第二个容器。因产品没有做到所承诺的事而失败的步骤，会连同缺陷标记为 `it.fails`；规格会打印各部分的耗时。编写规格时，`DELORUN_JOURNEY_CLOSURE=<dir>` 指向一个目录，其中有先前一次 `build-closure.ts --version 0.1.0 --platform linux-x64 --artifacts existing` 运行所得的发布 1 归档与文件列表，规格直接使用它而不再构建；`DELORUN_JOURNEY_KEEP=1` 让运行结束后容器继续运行，以便查看其内部；检查两者都不设置。

旅程不覆盖 npm 注册表及其证明、安装脚本、已发布的根、公共发布日志、tailnet、桌面 Host、所固定版本之外的其他 Node 主版本，以及原生 Windows 与 macOS，Delorun 0.1.0 不在它们上面运行。

## 演练

`node_modules/.bin/tsx delorun/apps/release/scripts/rehearsal.ts [--work <dir>] [--closure <dir>] [--only <id>,...] [--keep]` 在这台计算机上，用发布工具而不用测试框架，像一个人那样走一遍更新旅程。它需要 Node 24、`git`、`script`（util-linux）和受跟踪文件均已提交的工作树，因为它用 `build-closure.ts --artifacts existing` 构建发布 1；`--closure` 指向一个已包含发布 1 的归档与文件列表（`0.1.0-rc.1`、`linux-x64`）的目录，来自这样的一次构建。它不使用 Docker 机器、模型密钥，也不使用回环之外的网络。它的 home、`HOME` 与 npm 缓存位于 `--work` 之下（默认是系统临时目录下的新目录），除非给出 `--keep`，否则运行结束时将其删除。无论是否带 `--keep`，每次运行都会在退出前停止它启动的 Delorun。带 `--keep` 时，它会打印删除所保留文件夹的命令；已安装的程序存储是只读的，所以该命令先用 `chmod -R u+w` 恢复写权限。

它用一次性密钥（生产密钥会被拒绝）和 `local-release.ts` 为 `0.1.0-rc.1` 及之后的测试版本签名，在回环地址上通过 HTTP 提供渠道和一个替身发布日志，用这些来源与本次运行的根打包 `delorun/apps/npm-launcher`，并像 `npx --package=<tarball> -- delorun` 那样安装它。渠道使用 HTTP，是因为启动器只在回环地址上接受 `http:`，而对任意主机接受 `https:`，但启动器从不把 `NODE_EXTRA_CA_CERTS` 或 `NODE_OPTIONS` 传给运行时，所以运行时无法从使用自签名证书的渠道更新。发布日志是测试 fixture 的替身，不是公共日志。

它的场景按顺序执行，各自打印 `PASS` 或 `FAIL`，以及此人所见：

| Id | 它证明什么 |
| --- | --- |
| `install` | 对打包的启动器执行 `npx` 会安装发布 1，打印进度行并记录日志检查 |
| `setup` | 固定的命令完成安装，`delorun setup --config` 无需提问即可运行，Delorun 启动 |
| `update` | `delorun update --yes` 取得下一个发布，并保留此人的文件 |
| `rollback-auto` | Host 永不应答的发布会自行回滚，并指出失败的标准 |
| `tampered` | 归档中被改动的一个字节会被全新安装和更新同时拒绝，存储保持原样 |
| `clock` | 启动器的时钟拨快 4 天后运行（用于 `Date` 的预加载；这里没有 `faketime`），会拒绝全新安装并指出过期，同时启动已安装的发布 |
| `update-after-clock` | 时钟恢复后，下一个已签名的发布无需任何其他操作即可更新 |
| `repair` | `delorun repair` 替换文件已改变的程序并保留数据，`delorun recover status` 与 `recover discard` 列出并删除它放到一边的程序存储 |
| `from` | `delorun update --from <folder>` 在关闭渠道的情况下安装，较低的发布会被拒绝 |
| `by-hand` | [最后手段，手动操作](../../docs/guide/help/troubleshooting.zh.md#by-hand)的各步骤，逐字输入，得到一个可用的程序 |

启动器会从运行时的环境中移除 `NODE_OPTIONS`，所以时钟预加载作用于启动器而不作用于运行时；运行时在 `delorun update` 时自己的时间戳检查，由 `c02-refuses-expired-timestamp` 以及启动器相同的检查覆盖。它需要的磁盘很大：每个发布解开后约 1.5 GB，by-hand 场景按指南第 2 步所说复制 home，当磁盘放不下副本时则省略 `runtimes/`。

`--windows` 从 WSL 运行一个更短的 Windows 探测：打包的启动器在 Windows 的 `node.exe` 下运行（`REHEARSAL_WINDOWS_NODE` 可覆盖 `/mnt/c/nvm4w/nodejs/node.exe`），home 位于 Windows 临时目录下的新文件夹中。发布不发布 Windows 运行时，所以该探测不需要发行包，它唯一的场景 `win-refuses` 检查启动器在下载之前停止，说明 Delorun 0.1.0 在 WSL2 中运行，并且不向 home 写入任何内容。这是手动检查；它不演练原生 Windows 运行时需要的命名管道，而发布目前还不支持这一点。该文件夹原样留着，由你自行删除。演练不覆盖 macOS、公共发布日志、npm 注册表或生产主机。

## 本地 RC 渠道

`node_modules/.bin/tsx delorun/apps/release/scripts/local-channel.ts serve --channel <dir> --port <n> --state <state.json> --timestamp-key <timestamp.pem> [--host 127.0.0.1] [--resign-hours 24]` 从这台计算机提供一个发布渠道目录，使发布候选版本通过真实的更新器更新。它不增加签名代码：它提供 [`local-release.ts`](#local-release) 的输出，并用 `sign/timestamp.ts` 的签名者重新签署时间戳。

- **服务器。** 它只对 `--channel` 之下的普通文件响应 GET 和 HEAD，其他一概不响应：不列目录，不接受 `..` 或编码后的分隔符，不跟随指向目录之外的符号链接（均返回 404），其他方法返回 405。`--host` 是 `127.0.0.1` 或 `::1`；任何其他地址都会使命令停止。JSON 为 `application/json`，归档为 `application/gzip`，`timestamp.json` 带 `Cache-Control: no-store`。它为每个请求错误和每次重新签名各记录一行日志；从不打印密钥材料。
- **重新签名。** 启动时以及每隔 `--resign-hours`（默认 24；最多 48，因为时间戳有效 72 小时），它写出下一个 `timestamp.json`：渠道条目与根不变，版本加一，`issued` 为当前时间之前一小时，`expires` 为其后 72 小时。`--state` 中的签名者状态随之前进，并且先写入，两个文件都通过临时名替换，因此读取者绝不会看到只写了一半的文件。如果某次重新签名失败（密钥错误，或状态与所提供的时间戳不再匹配），旧文件保持不变，日志会说明原因；下一个间隔再次尝试。更新和全新安装会拒绝已过期的时间戳，所以要让该命令持续运行。
- **启动。** 用 `local-release.ts` 把 rc.1 签入一个新的渠道目录（[运行手册](#local-release)中的选项，`--out <channel dir>`、`--state <state.json>`，以及用于发布日志的 `--log-submit`、`--log-checkpoint` 与 `--log-tiles`），用 `npm-launcher/src/build.ts --channel-origin http://127.0.0.1:<port>` 构建启动器（启动器只在回环地址上接受 `http:`），然后用相同的目录、状态和时间戳密钥运行 `serve` 命令。端口是启动器的一部分，所以每次都使用同一个端口。
- **添加 RC。** 在服务器运行的同时，用下一个 `--version`、相同的 `--out` 与相同的 `--state` 再次运行 `local-release.ts`。发布文件先写入，时间戳最后写入；服务器无需重启，下一次重新签名接着该发布所写的时间戳继续。版本不更高或已在渠道中的会被拒绝。
- **停止。** 向进程发送 `SIGINT` 或 `SIGTERM`；它会关闭服务器并退出。不会安装任何东西，也不会留下任何东西。
- **此人的更新器看到什么。** 启动器获取 `http://127.0.0.1:<port>/timestamp.json`，然后是根链、其中指名的 manifest，以及 `releases/download/v<version>/` 下的发布文件，并像对待任何渠道那样验证它们。已安装的 `~/delorun-rc` 发现更高版本时会提示更新；服务器停止期间，更新失败，已安装的运行时仍照常启动。

要让它持续运行，把下面的内容保存为 `~/.config/systemd/user/delorun-local-channel.service`，然后运行 `systemctl --user enable --now delorun-local-channel`（`loginctl enable-linger $USER` 让它在你注销后继续运行）。把路径替换为你自己的路径。该单元运行 `node_modules/tsx/dist/cli.mjs`，而不是 `node_modules/.bin/tsx`（pnpm 把后者做成 `node` 无法运行的 shell 脚本），并把 `PATH` 设为同一个 `node` 所在的目录，使它启动的脚本能找到它：

```ini
[Unit]
Description=Delorun local RC channel

[Service]
Environment=PATH=%h/path/to/node-directory:/usr/bin:/bin
ExecStart=%h/path/to/node-directory/node %h/path/to/repo/node_modules/tsx/dist/cli.mjs %h/path/to/repo/delorun/apps/release/scripts/local-channel.ts serve --channel %h/delorun-rc-release/channel --port 18080 --state %h/delorun-rc-release/timestamp-state.json --timestamp-key %h/.config/delorun/preview-release/timestamp.pem
Restart=on-failure

[Install]
WantedBy=default.target
```

## 切出预览版或发布候选版

`node_modules/.bin/tsx delorun/apps/release/scripts/cut-rc.ts --version 0.1.0-preview.<n>[.<m>]|0.1.0-rc.<n>[.<m>] --channel <dir> --state <signer state file> --keys <dir> --root <root file> --commit <sha> [--highlights <file>] [--summary <text>] [--work <dir>] [--closures-from <dir>] [--artifacts build|existing] [--platform <platform>]... [--log-submit <url> --log-checkpoint <url> --log-tiles <url>] [--log-poll-seconds <n>] [--allow-builder-paths] [--dry-run]` 把发布运行手册的各步骤变成一条命令，在 `--commit` 的检出中运行。先带 `--dry-run` 运行：它打印计划和命令，不执行任何内容。 A public cut passes `--artifacts build`; `--artifacts existing`, the default, embeds the worktree's paths and is refused at signing (see the builder-path refusal under the runtime closures) unless `--allow-builder-paths` is passed, for a local iteration candidate only.

1. **目录树。** `--commit` 必须是 `HEAD`，且受跟踪文件必须干净。
2. **日志探测。** 在构建任何东西之前，[`scripts/probe-log.ts`](scripts/probe-log.ts) 会为 `--root` 列为 `active` 的每种日志条目密钥类型，向 `--log-submit` 提交一条基于随机字节的条目，每条都由为探测而生成的密钥签名，并为每种类型打印 `probe-log: <type> accepted|refused (<answer>)`。当日志一种都不接受时，切版停止，并指出运行手册中关于轮换 root 的那一节。`node_modules/.bin/tsx delorun/apps/release/scripts/probe-log.ts --root <root file> --log-submit <url>` 单独运行它：当日志接受某个列出的类型时以 0 退出，一种都不接受时以 1 退出，用法错误、签名无法验证的 root 或没有 `logEntryKeys` 的 root 时以 2 退出。每次探测都会在日志中留下一条条目。
3. **变更日志。** 当 `delorun/changelog/changelog.json` 中没有该版本的条目时，它用 [`assemble.ts`](#assembly) 汇总出一条，并以退出码 3 停止，以便你评审并提交变更的文件；用新的 `--commit` 再次运行。已有条目时，它继续往下。
4. **发布说明。** 它把说明（`assemble.ts --highlights`）写入 `--highlights`（默认 `<work>/notes-<version>.txt`），并通过 `local-release.ts --notes` 把它们作为 `notes` 签入 manifest。
5. **发行包。** 它先清理过期的构建暂存（构建根目录旁带有其标记的目录，以及进程已不存在的锁），然后把 [`build-closure.ts`](#runtime-closures) 运行到 `<work>/closure-<version>`。`--closures-from` 会为先前一次运行构建的发行包文件签名，并跳过这两步，这是日志记录失败后的重跑方式。
6. **签名。** [`local-release.ts`](#local-release) 用 `--keys` 中的密钥文件（`targets.pem`、`timestamp.pem`）和 `--state` 中的签名者状态，对候选版本签名、记入日志，并写入 `--channel`。计划和日志中只出现密钥文件的路径。日志端点默认是运行手册中的公共 Rekor v2 实例；等待检查点最多可能需要 30 分钟（`--log-poll-seconds`，60 次轮询），所以要在后台运行该命令。
7. **验证。** 它像客户端那样检查渠道：根链、时间戳、时间戳指名的 manifest、对照字节检查的签名说明，以及渠道中其他每个发布的 manifest 签名，使上一个候选版本仍在那里供更新使用。私有测试版本 `preview.N.M`（M 从 1 开始）在 M = 1 时要求渠道中有 `preview.N`，否则要求有 `preview.N.(M-1)`。普通候选版本要求其系列中较低的最新候选版本，它可以是测试版本：在 `preview.1` 与 `preview.1.1` 之后的 `preview.2` 要求有 `preview.1.1`。preview.1 与 rc.1 不要求有更早的发布，已在渠道中的版本会被拒绝。版本的顺序是 preview.1、preview.1.1、preview.2、rc.1、rc.2，然后是 0.1.0。

每一步都连同耗时记入日志；所有命令输出都写入 `<work>/cut-rc-<version>.log`。失败时会指出步骤和下一步操作，渠道仍提供原来所提供的内容。如果日志提交已成功但等待超时，用相同的端点运行 `log-release.ts`，而不要再次提交。该命令从不打标签、推送，也不触碰已安装的 home。它最后打印这些命令：标签及其推送、保持[本地渠道](#the-local-rc-channel)持续提供服务，以及在已安装的 `~/delorun-rc` home 中用运行手册的包装器执行 `rc update --check` / `rc update`。`tests/local/cut-rc.integration.spec.ts` 用一次性密钥把 `preview.1`、其测试版本 `preview.1.1` 与 `preview.2` 切入一个临时渠道，检查每一个都为其说明签名，且其前一个仍作为供更新使用的发布而被提供。

## 重建比较

`node_modules/.bin/tsx delorun/apps/release/src/compare-rebuild.ts <first> <second>` 比较同一发布的两个输出目录，例如发布工作流的输出与 targets 密钥持有者的重建。当两者包含相同的文件名且每个文件都匹配时，它以 0 退出，并打印 `rebuild-exceptions.json` 的某个条目所接受的每个差异及该条目的 id。出现任何其他差异时，它以 1 退出并逐个打印，签名会拒绝这样的重建。出现用法错误、目录不可读或例外文件未通过验证时，它以 2 退出。

- 运行时归档在满足以下条件时匹配：两份都是确定性形式（重新编码条目能复现归档的字节），路径相同且模式与 mtime 相同，并且每个条目的字节相同，或者存在例外所接受的差异。
- 运行时文件列表在每一份都等于由其自身归档推导出的列表时匹配，SBOM 在每一份都等于由旁边的归档推导出的 SBOM 时匹配。
- 任何其他文件在字节完全相同时匹配。

`rebuild-exceptions.json` 列出每个被接受的差异，含 id、适用的比较（`pe` 是唯一的一种）与理由；未知字段会使验证失败。它的第一个条目 `pe-authenticode` 只适用于 Windows 归档：它比较去掉 Authenticode 证书表、安全数据目录条目和头部校验和的 PE 文件，并用零补齐到 8 字节，因为发布工作流会为 Windows 发行包的 PE 文件签名，而它之外的重建无法做到。该表必须由修订版 2.0、类型为 PKCS #7 SignedData 的 `WIN_CERTIFICATE` 条目组成，并填满到文件末尾，每个条目含一个 DER SEQUENCE，后跟少于 8 个零字节，条目之间只用零字节补齐到 8 字节；任何其他追加或隐藏的字节都是差异。

## SBOM

`delorun-<version>.spdx.json` 是 SPDX 2.3 JSON 文档，仅由发布平台的运行时归档和 `toolchain.json` 推导而来：每个归档一个软件包，带其 SHA-256；固定的 Node 与 pnpm；`toolchain.json` 在原生构建者镜像中固定的每个 Debian 软件包，对该镜像编译了其原生代码的每个归档记为 `BUILD_TOOL_OF`（带该镜像架构的 `pkg:deb` purl）；以及在归档中以 `node_modules/<name>/package.json` 形式找到的每个已安装 npm 包版本各一个软件包，带其 `pkg:npm` purl、当其为许可证表达式时声明的许可证，以及发行包的锁文件为它记录的 SHA-512。每个软件包的 SPDX id 是其种类，加上其种类、名称与版本的 SHA-256 的前 128 位，因此仅在 SPDX id 无法容纳的字符上有差异的名称仍保持不同，两个软件包会共用同一个 id 时构建失败。`created` 是归档的 `SOURCE_DATE_EPOCH`，所以相同的归档总是得到相同的文档。当输出中有 `delorun-<version>.images.json` 时，该文档还按索引摘要描述 S2 与 S3 镜像，每个都派生自以摘要固定的基础镜像，S3 镜像包含 Linux 发行包；它不列出基础镜像内部的 Debian 软件包。

## 依赖安全公告检查

`node_modules/.bin/tsx delorun/apps/release/src/check-advisories.ts --version <version> --release <dir> [--commit <rev>] [--feed <url>]` 读取 `--release` 中的每个运行时归档，并把其中包含的每个软件包版本发送给 npm 的批量安全公告 API：`app/pnpm-lock.yaml` 锁定的每个注册表版本、SBOM 列出的每个已安装软件包版本（其中包括捆绑在另一个包内部、锁文件并未列出的依赖），以及 `toolchain.json` 在 `--commit` 处固定的 pnpm 版本。本地 `file:` 与 `link:` 包是发布自己的源码，不在其列。该 API 是 `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`，并写入 `delorun-<version>.advisories.json`。当某个版本满足公告的易受攻击范围时，该公告影响所检查的版本；检查无法读取的范围属于格式错误的应答，会使检查失败，而不是什么也不匹配。只有当每个受影响的公告在 [`delorun/release/advisory-acceptances.yaml`](../../release/advisory-acceptances.yaml)（按 `--commit` 处提交的内容，省略时为 `HEAD`；发布工作流中为发布的标签，签名时为其提交）中都有条目时，检查才通过，该条目须有相同的公告与软件包、被锁定版本满足的范围、不早于本次发布的 `lapsesAfter`，以及 `.github/CODEOWNERS` 在同一提交中指名为该文件所有者的 `approver`。每个条目还记录 `added`，即添加的日期（`YYYY-MM-DD`），发布说明会显示它。遇到以下情况检查失败：存在任何其他受影响的公告、已失效的接受记录或批准人不是所有者的记录、没有 `added` 的条目、带有未知字段或重复键的接受文件，以及无法访问源或应答格式错误；此时它以 1 退出。

报告包含 `schema`（`delorun.release-advisories/1`）、`version`、`feed`、`packages`（检查了多少个被锁定的版本）、`findings`（每个受影响的公告及其软件包、版本、严重程度、标题与易受攻击范围，以及覆盖它的接受记录，或者其接受记录为何在 `lapsed` 中失效、在 `unapproved` 中被拒）、`result`（`pass` 或 `fail`）与 `problems`。签名会再次运行该检查，除非已发布的报告按 JSON 比较等于它自己这次运行得到的报告，否则拒绝。`assemble.ts --advisories <report> --manifest <signed manifest>` 把“Accepted advisories”一节加入发布说明，列出每个被接受的公告及其软件包、范围、理由、批准人、日期与失效发布；它会拒绝按长度和 SHA-256 判断不是已签名 manifest 所指名的那个文件的报告、被接受的 id 与 manifest 不同的报告、属于另一个发布的报告，以及未通过的报告。

## 签名

签名发生在 targets 密钥持有者的机器上，在 CI 之外，且在发布工作流已从标签 `v<version>` 构建了该发布、持有者也已重建它之后：

1. 把发布工作流为草稿发布生成的文件（包括其 `manifest-draft.json`）下载到一个目录，例如 `release/`。
2. 在仓库中检出该标签，用相同的配方构建它，并为输出出具证明：`node_modules/.bin/tsx delorun/apps/release/src/build-closure.ts --version <version> --commit v<version> --out rebuild/ --attestation-key ~/.config/delorun/rebuild-attestation.key --attestation rebuild.attestation.json`，然后在相同的输出上构建镜像：`node_modules/.bin/tsx delorun/apps/release/src/build-images.ts --version <version> --out rebuild/ --oci rebuild-oci/ --attestation-key ~/.config/delorun/rebuild-attestation.key --attestation rebuild.attestation.json`，它先检查证明能用该密钥验证并且恰好覆盖 `rebuild/` 中的文件，然后连同其提交把证明扩展到镜像文件和重写后的 SBOM；它不会为这台机器的构建没有写入的目录出具证明。
3. 记录重建：`node_modules/.bin/tsx delorun/apps/release/src/record-rebuild.ts --version <version> --release release/ --rebuild rebuild/ --record delorun-<version>.rebuild.json --builder <name> --compared-with <workflow run URL>`。它依照标签处提交的 `rebuild-exceptions.json`，把每个重建的文件与工作流中同名的文件比较，把记录写到 `release/` 之外的 `--record`，并在比较发现差异时以 1 退出。设置了 `CI` 或 `GITHUB_ACTIONS` 时它拒绝运行，并拒绝缺少任一平台的归档或文件列表或缺少 SBOM 的重建。
4. 签名：`node_modules/.bin/tsx delorun/apps/release/src/sign-release.ts --release release/ --rebuild rebuild/ --record delorun-<version>.rebuild.json --attestation rebuild.attestation.json --attestation-key ~/.config/delorun/rebuild-attestation.key --key <targets.pem>`，并已获取发布分支，例如 `git fetch origin main`。只有要针对 `origin/main` 之外的分支签名时，才加 `--release-branch <revision>`；允许签名者文件与生产密钥注册表按该分支所提交的内容读取，绝不从工作树读取。只有当版本是补丁版本（例如 `0.1.3`），并且其主版本与次版本从未发布过更早的发布时，才加 `--first-of-line`。

`sign-release.ts` 在下列情况下拒绝，并给出指明所需来源的消息：“a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe”：重建记录缺失或读不出来；`release/` 已含有 `delorun-<version>.rebuild.json`，或 `--record` 或 `--rebuild` 位于 `release/` 中；记录写着 `ci: true` 或报告了差异；设置了 `CI` 或 `GITHUB_ACTIONS`；`--rebuild` 不是这台机器上的目录，其文件不能复现记录的摘要，或缺少任一平台的运行时归档或文件列表或 SBOM；记录的提交不是标签所指的提交，或其配方摘要或工具链（Node.js、pnpm、编译器与链接器）不是该提交处配方的；证明缺失、位于 `release/` 或 `rebuild/` 中，或不能用证明密钥对版本、提交和 `rebuild/` 中每个文件的验证；或者再次比较工作流的文件与重建时发现差异。它还会针对 npm 的源，用发布提交处提交的接受记录再次运行依赖安全公告检查，并在检查失败或接受了草稿 `advisories.accepted` 之外的公告时拒绝。它还会拒绝这样的草稿：其 SBOM 不是 `delorun-<version>.spdx.json`，其运行时条目不是各自平台的 `delorun-<version>-<platform>.tar.gz`（`win32-x64` 为 `.zip`）与 `delorun-<version>-<platform>.files.json`，或者其文件不在发布目录中，或长度与摘要与它列出的不符。它还会拒绝没有 `security`（发布是否为安全修复）或 `summary`（其一行摘要，至多 200 个字符，不含控制字符、格式字符或换行字符，没有孤立的 UTF-16 代理项，两端也没有空白）的草稿，每个已签名的 manifest 都带有这两项，用于更新通知。当所有检查都通过时，它先以临时名称在 `release/` 中写入每个已签名的运行时文件列表、记录 `delorun-<version>.rebuild.json` 与 `delorun-<version>.manifest.json`（其 `rebuild` 指名该记录和持有者，并带 `ci: false`），然后重命名到位，manifest 最后；重命名之前失败则 `release/` 保持不变。

在读取重建之前，`sign-release.ts` 先检查发布的来源。它拒绝不在发布分支上的被标记提交（`git merge-base --is-ancestor`），以及没有指名任何提交的发布分支。它拒绝[生产密钥注册表](#production-keys)未列出的 targets 密钥，并且在注册表没有列出任何密钥时拒绝每一个密钥。它拒绝这样的标签 `v<version>`：轻量标签、没有 SSH 签名或为另一个标签名创建的带注解标签，或者其签名 `git verify-tag`（使用 `gpg.format=ssh` 与 `ssh-keygen`）不能用[允许签名者文件](#release-tag-signers)所列的密钥验证；该文件没有列出任何密钥时，它拒绝每一个标签。两个文件都用 `git show <branch>:<path>` 从发布分支读取。它拒绝 `install.sh` 或 `install.ps1` 不是长度为零的占位文件的草稿，因为安装脚本目前还不在重建比较之内。检查草稿的文件之后，它拒绝每个 `npm[]` 条目：其打包的 tarball（`npm pack` 所命名的 `<name>-<version>.tgz`，即 `delorun-<version>.tgz`）不在 `release/` 中，或者其完整性值（`sha512-` 加上 tarball 字节的 base64 SHA-512，即 npm 的 `dist.integrity`）与该条目的不符，或者其 `package/package.json` 指名了另一个包或版本；因此 `release/` 含有工作流所发布的已打包启动器。

补丁规则（`src/sign/patch-rule.ts`）在写入任何内容之前运行。草稿的 `dsh` 必须是标签提交处 `packages/boot/app-boot/package.json` 的 `version`。一个发布是每个主版本与次版本相同、且没有预发布后缀的较低 `v<major>.<minor>.<patch>` 标签的补丁（`0.1.3-rc.1` 算作 `0.1.3`），当补丁的上游版本、`docs/persistence-schema.json`、`delorun/packages/update/src/data-records.json` 或 `delorun/packages/contract-plugin-versions/plugin-interface.json` 的 `covered` 列表与这样一个发布的不同，或者其标签提交不再声明某个被覆盖的服务或不再读取某个被覆盖的 manifest 字段，或者这些文件之一缺失时，签名会拒绝，并指出较早的发布、差异在哪里以及应当改为发布的下一个次版本。因此，安全修复作为补丁发布，不停用任何插件，也不复制任何数据，而移动上游基线的发布至少是次版本。

缺失的标签不得跳过该规则，所以对补丁版本（补丁号大于 0），签名首先检查本地标签所指名的较早发布。在以下情况下拒绝：较早标签的提交不是发布提交的祖先（`git merge-base --is-ancestor`）；发布提交处的 `delorun/changelog/changelog.json` 缺失或不可读、没有列出较早标签的版本，或者列出了低于该发布、主版本与次版本相同、没有标签的非预发布版本；以及找不到较早发布且没有给出 `--first-of-line` 时（并指出该选项），否则缺少已发布标签的检出会让补丁与空无一物相比较。对 `X.Y.0` 版本，以及已有较早发布带标签时，`--first-of-line` 会被拒绝。变更日志记录的是版本而不是提交，所以该检查并不能证明某个标签指名的是其发布所由发布的那个提交。

清单列出 `delorun/packages/*/src` 与 `delorun/apps/*/src` 下的 `.ts`、`.tsx` 与 `.d.ts` 文件中，`declare module '@deepseek-ai/cordis'` 内声明的每个 `interface Context` 成员（`service`）和 `interface Events` 成员（`event`），标为 `covered`（提供给插件）或 `internal`；当声明的服务或事件不在其中，或列出的条目已不在其源码中时，`tests/sign/plugin-interface.spec.ts` 会失败。

### 发布标签签名者

`delorun/release/allowed-signers` 列出允许为发布标签签名的 SSH 密钥，每行一个，格式为 `<principal> namespaces="git" <key type> <base64 key>`，即 git 的 `gpg.ssh.allowedSignersFile` 格式（见 `man ssh-keygen` 的“ALLOWED SIGNERS”）。它没有列出任何密钥，所以 `sign-release.ts` 会拒绝每一个标签，直到所有者添加每个发布签名者 SSH 签名密钥的公钥；对该文件的修改需要 CODEOWNERS 评审。签名者用 `git -c gpg.format=ssh -c user.signingkey=<private key file> tag -s -m "Delorun <version>" v<version>` 为发布提交打标签。

### 生产密钥

`delorun/release/production-keys.json`（`delorun.production-keys/1`）列出 Delorun 的生产信任材料：`roots`，即每个生产根文件的 `version` 与其字节的 SHA-256；以及 `keyids`，即每个生产根、targets 与时间戳密钥的密钥 id，它是根元数据在 `keys` 之下所列原始 Ed25519 公钥的 SHA-256。它目前什么也没有列出，因为还不存在生产密钥。密钥仪式之后，所有者在一个经过评审的提交中，添加每个已签名的 `root/<n>.root.json`（带 `sha256sum` 打印的摘要）以及该根在 `roles.root.keyids`、`roles.targets.keys` 与 `roles.timestamp.keyids` 中列出的每个密钥 id，每次轮换后添加新的根与密钥，并且不删除任何旧项。信任页面和 README 公布相同的根 SHA-256 与密钥 id。`local-release.ts` 拒绝每个已列出的根与密钥，`sign-release.ts` 与 `sign-timestamp.ts` 拒绝发布分支的注册表没有列出的每个密钥，所以空注册表会阻止生产签名。1.0 之前的发布不使用生产路径：它们用 `local-release.ts` 以及预览版的根与密钥构建，注册表并不列出这些（列出它们会使 `local-release.ts` 拒绝它们），由 `release-channel/src/publish-release.ts` 上传渠道目录；注册表在 1.0 密钥仪式之前保持为空；读取器拒绝超过 64 KiB 的文件、未知或缺失的字段、重复的 JSON 键以及被列出两次的条目。

### targets 密钥

targets 密钥是 PKCS #8 PEM 文件中的 Ed25519 私钥，只有其所有者可以读取；`sign-release.ts` 会拒绝带有任何组或其他用户权限的密钥文件。仓库不保存任何密钥。所有者在签署发布的离线机器上的签名仪式中创建密钥，例如用 OpenSSL 3：

```sh
umask 077
openssl genpkey -algorithm ed25519 -out targets.pem
openssl pkey -in targets.pem -pubout -out targets.pub.pem
```

公钥写入根元数据的 `keys` 与 `roles.targets`，由根密钥签名（[C2](../../docs/contracts/c02-release-manifest.zh.md#root-metadata)）；私钥绝不进入 CI、云服务，或发布工作流可以访问到的机器。

### 重建证明密钥

证明密钥是持有者签名机器上 `~/.config/delorun/rebuild-attestation.key` 处至少 32 字节的秘密，仅其所有者可读；它绝不离开那台机器。持有者只需创建一次：

```sh
mkdir -p ~/.config/delorun && umask 077
openssl rand -out ~/.config/delorun/rebuild-attestation.key 32
```

`build-closure.ts --attestation-key` 对发布版本、提交，以及 `--out` 中每个文件的长度和 SHA-256 写入一个 HMAC-SHA256，`sign-release.ts` 检查它。它能防止把 `--rebuild` 指向并非这台机器的构建所写目录的错误，例如下载下来的发布工作流输出副本。它无法阻止蓄意作弊的持有者，因为持有者掌握密钥，可以为任何目录出具证明；C2 已经说明，重建的独立性无法被证明。

### 根元数据与时间戳元数据

`node_modules/.bin/tsx delorun/apps/release/src/sign-root.ts --draft <file> --key <root.pem>... [--previous <root file>] --out <root/<n>.root.json>` 在所有者的仪式中为根元数据签名：草稿是根的 `signed` 内容，只有当文件能用它自己的根阈值验证、尚未过期，并且在轮换时也能用 `--previous` 那个根的阈值验证为其后的下一个版本时，才会写入文件。

`node_modules/.bin/tsx delorun/apps/release/src/draft-root.ts --root-key <root.pub.pem>... --targets-key <pub.pem> --timestamp-key <pub.pem> --catalogue-key <pub.pem> --log-origin <origin> --log-vkey <vkey> --witness <vkey>... [--version <n>] [--root-threshold <n>] [--witness-threshold <n>] [--issued <time>] [--days <n>] --out <draft.json>` 从各角色的 Ed25519 公钥文件（`openssl pkey -pubout`）写出该草稿，所以草稿步骤不读取任何私钥，并拒绝含有私钥的文件。每个密钥 id 是原始公钥的 SHA-256，targets 密钥是唯一的 `active` targets 密钥，除非 `--issued` 指定了 UTC 时间，否则 `issued` 就是现在，`expires` 是其后的 `--days` 天，默认 365 天，且最多 365 天。日志验证器密钥必须指名 `--log-origin`，每个见证者的名称是其验证器密钥所带的名称，二者都必须能解析为 C2SP 签名注记验证器密钥。它从不替换已有文件。

`node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts --state <state.json> --root <file>... [--first] --stable <manifest> --beta <manifest> [--replaced <manifest>]... --out <timestamp.json> [--release-branch <revision>]` 用环境变量 `DELORUN_TIMESTAMP_KEY` 中的在线密钥签署下一个时间戳，该密钥必须是[生产密钥注册表](#production-keys)所列、且其所在仓库的 `--release-branch`（默认 `origin/main`）提交了的时间戳密钥，它从状态中保存的最后一个时间戳继续，并在写入时间戳之前先写入新状态。`--root` 从状态所信任的根开始，轮换后重复出现，最新的在最后。状态的最后一个时间戳必须与状态记录的摘要和版本匹配，并能用它所指名的根的时间戳密钥以及该根文件的摘要验证；它可以已经过期。调用方不会传入之前的时间戳。`--first` 在没有之前时间戳的情况下签名，仅当状态没有记录任何时间戳时可用。每个渠道的 manifest 必须能用最新根的 targets 密钥验证；stable 渠道指名一个稳定发布，beta 渠道指名一个 beta 或稳定发布；任何渠道都不会移到更低的版本。一个渠道只有在以下情形才会改用其所指发布的另一个 manifest：以 `--replaced` 传入的被指名 manifest 与新的相比仅签名不同，或者在被指名的那个已不能用最新根的 targets 密钥验证时（例如 targets 密钥轮换之后）还有 `published` 不同；对已签名内容的任何其他变更都会被拒绝。新版本比 `--previous` 高一，并在签发后 3 天过期。

状态文件（`delorun.release-timestamp-state/1`）保存签名者所信任的根和已签署的最后一个时间戳，连同它的版本、SHA-256 与字节，使不受信任的元数据主机所提供的真实但较旧的时间戳无法把渠道回滚。所有者在根仪式中用 `node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts --init-state --root root/1.root.json --state state.json` 写入一次，并把其内容保存为发布工作流受保护的 `release` 环境的变量 `DELORUN_TIMESTAMP_STATE`，绝不保存在元数据主机上。每个签名作业把该变量还原为文件，签名，并用一个可写该环境变量、且只对该环境中的作业可用的令牌，把新状态写回变量。所有者尚未写出的发布工作流文件必须：

- 把每个为时间戳签名的作业放在同一个 `concurrency` 组中，使两次签名绝不从同一状态开始；
- 在发布时间戳之前把新状态写回 `DELORUN_TIMESTAMP_STATE`，使已发布的时间戳始终是状态所持有的那个。

`node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts --import-from <timestamp.json | https origin> --root <root file>... --state <state.json>` 在发布渠道 Worker 每日重新签名使渠道前进之后，让状态与渠道对齐（1.0 之前，本地签名者和 Worker 都会写渠道的时间戳）。它读取渠道提供的文件，来自已下载的副本或 `<origin>/timestamp.json`（HTTPS；仅在回环地址上可用 HTTP；至多为时间戳大小限制；不跟随重定向），像客户端那样验证它（时间戳角色的签名在其所指根的某个密钥之下，约定的有效期，未过期，未在未来签发；根链从状态的根开始，文件指名其最新的根），并把该文件作为最后一个时间戳写入状态。它不需要密钥。它拒绝：未通过验证的文件、由另一个密钥签名的文件、版本低于状态最后一个的文件、同一版本的不同文件、使某个渠道回到更低发布的文件，以及已过期的文件；拒绝时状态保持原样。与状态的最后一个相同的文件则是无操作。下一次签名随后签发版本加一。两个写入者通过发布保持有序：`publish-release.ts` 只会用更高的版本替换 `timestamp.json`，并以其读取的实体标签为条件，同时把它发送到 Worker 的高水位标记，因此来自过期状态的签名，或在导入之后被 Worker 超过的签名，会在发布时被拒绝，且不替换任何内容；从渠道此时提供的内容再次导入，再次签名并发布。当渠道此前已经发布过时，在每次本地发布之前立即运行导入。

## 验证

`@delorun/release-formats/sign/verify` 应用 C2 的客户端验证：`trustRootChain` 从调用方持有的根开始逐个遍历根版本，每个都由前一个根的阈值与它自己签名，在过期之前签发，有效期至多 365 天，且最新的根未过期；给一个密钥分配两个角色、或没有恰好一个 `active` targets 密钥的根读取失败；`verifyTimestamp` 检查时间戳角色的签名、3 天的有效期、不晚于本地时钟的签发时间、不含时钟容差的过期（它的拒绝消息指出过期时间与本地时钟）、已存储的版本，以及它所指名的根版本和文件摘要；`verifyChannelManifest` 只接受最新时间戳为该渠道指名的 manifest 文件，该文件须属于时间戳所指名的发布和渠道（beta 渠道也指名稳定发布），并由对该发布有效的 targets 密钥签名（`active` 密钥，或其 `lastRelease` 不低于该发布的 `retired` 密钥；绝不是 `revoked` 密钥）；`verifyFileList` 与 `checkFileRef` 对照 manifest 检查每个文件的长度与 SHA-256。每个已签名文件在解析之前都按其大小限制读取，重复的 JSON 键、未知字段或未知的 `schema` 都会使读取失败。`@delorun/release-formats/sign/json` 存放签名所覆盖的 RFC 8785 序列化。

## 镜像

`node_modules/.bin/tsx delorun/apps/release/src/build-images.ts --version <version> --out <dir> --oci <dir> [--attestation-key <file> --attestation <file>]` 在同一输出上于 `build-closure.ts` 之后运行。它构建 `images.json` 指名的各个镜像，每个都针对 `linux/amd64` 与 `linux/arm64`，基于它以摘要固定的 Debian 基础镜像，使用 BuildKit 的 `rewrite-timestamp`，时间为发行包的 `SOURCE_DATE_EPOCH`，不用缓存，也没有 SLSA 构建或 SBOM 证明（其构建时间与调用 id 在各次构建之间会不同）。Dockerfile 以摘要固定它们的前端。

- S2 工作区镜像（`images/s2/`）加入空的辅助套接字目录 `/run/delorun-helper`。S2 辅助程序和出口代理不在其中。
- S3 harness 镜像（`images/s3/`）加入用户 `delorun`（uid 1000）与 `delorun-harness`（uid 1001），以及每个架构的 Linux 运行时发行包（只读，位于 `/opt/delorun/runtime`），并以 `delorun-harness` 运行。

该命令把每个镜像的 OCI 布局写入 `--oci`，把 `delorun-<version>.images.json` 写入 `--out`：每个镜像的仓库及其索引与各平台 manifest 摘要、构建它们的 Docker Engine 与 BuildKit 版本，以及每个镜像在各平台上已安装的 Debian 软件包，读取自携带它的最上层的 dpkg 状态。重建比较逐字节比较该文件，所以由另一个 Docker 或 BuildKit 版本、或带其他软件包的重建会不同；该命令也拒绝用 `toolchain.json` 的 `images` 所固定版本之外的版本构建。当 `--out` 含有每个平台的发行包时，它会重写 SBOM，以描述两个镜像、基础镜像及其 Debian 软件包（作为 `pkg:deb/debian` purl）。发布工作流按摘要推送这些布局，manifest 的 `images` 复制该文件的镜像引用。镜像文件是每次重建与签名比较都必须覆盖的文件之一，签名会拒绝 `images` 与它不同的草稿，并用 `images.json` 在发布提交处指名的基础镜像推导出 SBOM 的镜像条目。

`images.json` 中每个镜像的条目还指名其 seccomp 配置及该配置的许可证，二者是本目录中已提交的文件：两个镜像共用 `images/seccomp.json`，即 Docker Engine 29.9.2 的默认配置（`github.com/moby/profiles/seccomp` v0.2.4，`default.json`），许可证为 `images/seccomp.LICENSE` 中的 Apache-2.0。该命令把它们复制为 `--out` 中的 `delorun-<version>.<image>.seccomp.json` 与 `delorun-<version>.<image>.seccomp.LICENSE`，使发布把许可证发布在每个配置旁边，镜像文件中该镜像的引用以 `seccomp` 文件引用的形式携带该配置，约定 C9 的监督器在其下运行该镜像的容器。每个列出的配置及其许可证，都是每次重建与签名比较必须覆盖的文件，manifest 所签的重建记录列出它们的摘要；签名会拒绝长度或 SHA-256 与草稿引用不同的配置。

## 发布日志

`sign-release.ts` 还会写入 `delorun-<version>.manifest.entry.json`，即约定 C18 的 Rekor v2 `hashedRekordRequestV002`：manifest 文件的 SHA-512、targets 密钥对 manifest 文件字节的 Ed25519ph 签名（密钥详情为 `PKIX_ED25519_PH`），以及 DER 格式的 targets 公钥。Node 的 crypto 没有 Ed25519ph，所以 `src/log/entry.ts` 用 `@noble/curves` 对它签名并验证。`node_modules/.bin/tsx delorun/apps/release/src/log-release.ts --root <file> --manifest <file> --entry <file> --submit <url> --checkpoint <url> --tiles <url> --out <bundle>` 在发布工作流中运行：它把请求提交到 `--submit`，即日志的 `/api/v2/log/entries`，每 30 秒轮询一次 `--checkpoint`，最多 60 次，等待一个签名注记检查点，该检查点要由根所列的某个见证者共同签名并覆盖该条目；然后根据日志在 `--tiles` 之下提供的分块（C2SP `tlog-tiles`，如 Rekor v2 提供其树的方式，日志不再提供部分分块时，从其完整分块读取该部分分块）计算该条目在该检查点所属树中的包含证明，只有当 bundle 通过验证时才写入 `delorun-<version>.manifest.log.json`；否则它以 1 退出，发布不会被发布出去。

`@delorun/release-formats/log/bundle` 按 C18 的五步离线验证 bundle：manifest 摘要；条目的 Rekor v2 格式及其 targets Ed25519ph 签名（拒绝纯 Ed25519 条目）；RFC 6962 包含证明；检查点的来源、大小、根哈希与日志签名；以及至少达到根所定阈值数量的、所列见证者的共同签名。没有这种共同签名的检查点无论其日志签名如何都会失败，每个失败都带有 C18 的原因码。`log/note` 读取使用 Ed25519 注记密钥与 `cosignature/v1` 见证者密钥的 C2SP 签名注记，`log/merkle` 验证包含与一致性证明，`log/tiles` 根据日志的分块计算包含证明。

## 待完成事项

发布的这些部分尚未在这里构建；每一项都属于所指明的工作包。

- SBOM 不描述桌面安装程序，Delorun 不构建它，因为它没有桌面应用（[路线图](../../docs/guide/roadmap.zh.md)）。
- 配方没有用于上游原生系统插件 macOS 二进制文件的固定工具链，所以 `darwin-x64` 与 `darwin-arm64` 不是发布平台（[原生代码](#native-code)）。
- S2 镜像不携带 S2 辅助程序或出口代理，S3 镜像不在 `/usr/local/bin/delorun-egress-proxy`（C9 指定的路径）携带出口代理。
- 发布日志规格使用本地替身；首次提交到实时日志（`log2025-1.rekor.sigstore.dev`）是所有者的操作，因为那会公开发布。对该日志的只读请求可以显示其布局：`GET https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint` 返回一个 C2SP 签名注记，其来源行是 `log2025-1.rekor.sigstore.dev`，由该日志签名，并由多个见证者共同签名；`GET https://log2025-1.rekor.sigstore.dev/api/v2/tile/<L>/<N>` 返回 8,192 字节的哈希分块（`/api/v2/tile/entries/<N>` 返回条目 bundle），而主机根路径下的 `/checkpoint` 与 `/proof/consistency` 返回 `404`。启动器在根的 `log.origin` 中从该主机读取这一布局。因此，实时日志的 `--submit`、`--checkpoint` 与 `--tiles` 值分别是 `https://log2025-1.rekor.sigstore.dev/api/v2/log/entries`、`https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint` 与 `https://log2025-1.rekor.sigstore.dev/api/v2/`；提交路径由 C18 定义，尚未实际运行过。
