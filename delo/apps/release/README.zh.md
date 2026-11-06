# Delo 发布工具

[English](README.md) | 中文

`@delo/release` 是 Delo 的发布工具，一个位于 `delo/apps/release` 的私有包。它包含变更片段门禁、发布说明汇总工具、用于构建运行时发行包（runtime closure）的已发布构建配方、签名所需的两次构建的比较、发布的 SBOM（软件物料清单）、依赖安全公告检查、发布元数据的签名与验证、发布日志（release log），以及 S2 与 S3 镜像。[发布 manifest（release manifest）约定](../../docs/contracts/c02-release-manifest.zh.md)（C2）定义了本包所实现的发布文件、可复现范围与签名规则。

## 模块

- `src/changelog/paths.ts` 把路径分类为需要变更条目的产品文件，或片段文件。
- `src/changelog/fragment.ts` 解析片段的前置元数据和正文，并列出未发布文件夹。
- `src/changelog/version.ts` 接受发布版本。
- `src/changelog/check.ts` 是门禁 `gates:changelog`。它检查范围内的每个提交，以及工作树中的每个片段。
- `src/changelog/assemble.ts` 汇总一次发布的说明、`CHANGELOG.md` 的块，以及移入的片段。
- `src/build-closure.ts` 是运行时发行包配方的命令；`src/closure/` 存放其各步骤：配方文件（`config.ts`）、固定的下载（`sources.ts`）、暂存目录树与运行时文件列表（`tree.ts`）、原生代码检查（`native.ts`）以及归档（`archive-closure.ts`）。
- `src/archive/` 存放确定性 tar、gzip 与 ZIP 写入器、对应的读取器，以及用于检查归档是否为确定性形式的检查模块。
- `src/compare-rebuild.ts` 是重建比较的命令；`src/rebuild/` 存放比较逻辑，以及其第一条例外所对应的 PE 规范化。
- `src/record-rebuild.ts`、`src/sign-release.ts`、`src/sign-root.ts` 与 `src/sign-timestamp.ts` 是签名命令；`src/rebuild/record.ts` 存放重建记录的事实，`src/sign/` 存放签名信封、RFC 8785 序列化（canonical JSON）、各签名文件的读取器、时间戳元数据内容、签名与客户端验证。
- `src/sbom/` 从运行时归档写入 SPDX SBOM；`src/check-advisories.ts` 与 `src/advisory/` 运行依赖安全公告检查。
- `src/build-images.ts` 与 `src/images/` 从 `images.json` 与 `images/` 构建 S2 与 S3 镜像；`src/log-release.ts` 与 `src/log/` 写入并验证发布日志 bundle。
- `tests/` 存放规格。变更片段规格在临时 git 仓库上运行两个入口；归档、运行时发行包与重建规格则在临时目录中构建 fixture（测试前置数据）运行时发行包，并从本地 HTTP 替身提供固定的下载；签名规格用测试中生成的密钥签署 fixture 发布，发布日志规格则运行本地日志与见证者（witness）替身，因此都不需要网络，也不需要真实密钥。`tests/images/images.docker.spec.ts` 将两个镜像各构建两次，仅在设置 `DELO_DOCKER_SPECS=1` 时运行，因为检查运行器（check runner）没有 Docker 通道。

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
6. 将 `delorun-<version>-<platform>.tar.gz`（`win32-x64` 为 `.zip`）及其未签名的运行时文件列表 `delorun-<version>-<platform>.files.json` 写入 `--out`，且从不替换已有文件；在构建完每个平台之后，它还把 SBOM `delorun-<version>.spdx.json` 写入同一目录。

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
- 运行时文件列表在每份副本都等于由其自身归档推导出的列表，且 SBOM 在每份副本都等于由同目录中归档推导出的 SBOM 时匹配。
- 其他文件在字节完全相同时匹配。

`rebuild-exceptions.json` 列出每项被接受的差异，包括其 id、所适用的比较（`pe` 为唯一一种）及其理由；出现未知字段时校验失败。其第一条为 `pe-authenticode`，仅适用于 Windows 归档：它在比较 PE 文件时去掉 Authenticode 证书表、安全数据目录项与头部校验和，并以零补齐至 8 字节，因为发布工作流会对 Windows 运行时发行包中的 PE 文件签名，而工作流之外的重建无法签名。证书表必须由修订版本 2.0、类型为 PKCS #7 SignedData 的 `WIN_CERTIFICATE` 条目组成，并一直填充到文件末尾；每个条目只含一个 DER SEQUENCE，其后至多跟随少于 8 个零字节，条目之间补齐到 8 字节的填充也只能是零字节；其他任何追加或隐藏的字节都算作差异。

## SBOM

`delorun-<version>.spdx.json` 是一份 SPDX 2.3 JSON 文档，仅由运行时归档与 `toolchain.json` 推导而来：每个归档对应一个包并附其 SHA-256；固定的 Node 与 pnpm 各对应一个包；在某个归档中以 `node_modules/<name>/package.json` 形式找到的每个已安装 npm 包版本，各对应一个包，并附其 `pkg:npm` purl、其声明的许可证（当它是许可证表达式时），以及运行时发行包锁文件为其记录的 SHA-512。每个包的 SPDX id 由其类型以及其类型、名称与版本的 SHA-256 的前 128 位组成，因此仅在 SPDX id 无法容纳的字符上不同的名称仍彼此区分；两个包会共用的 id 使构建失败。`created` 取归档的 `SOURCE_DATE_EPOCH`，因此相同的归档总是得到相同的文档。当输出中包含 `delorun-<version>.images.json` 时，该文档还会按索引摘要描述 S2 与 S3 镜像，每个镜像都派生自按摘要固定的基础镜像，其中 S3 镜像包含 Linux 运行时发行包；它不列出基础镜像内的 Debian 软件包。

## 依赖安全公告检查

`node_modules/.bin/tsx delo/apps/release/src/check-advisories.ts --version <version> --release <dir> [--commit <rev>] [--feed <url>]` 读取 `--release` 中的每个运行时归档，把其中的每个包版本发送给 npm 的批量安全公告 API：`app/pnpm-lock.yaml` 锁定的每个注册表版本、SBOM 所列的每个已安装包版本（包括锁文件未列出、打包在另一个包内部的依赖），以及 `--commit` 处 `toolchain.json` 固定的 pnpm 版本。本地的 `file:` 与 `link:` 包是发布自身的源码，不在其列。该 API 为 `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`，并写入 `delorun-<version>.advisories.json`。当被检查的版本满足某条安全公告的受影响版本范围时，该安全公告影响此版本；检查无法读取的范围属于格式错误的响应，会使检查失败，而不是视为不匹配。只有当每条影响锁定版本的安全公告，在 `--commit`（省略时为 `HEAD`；发布工作流中为该发布的标签，签名时为该发布的提交）处提交的 [`delo/release/advisory-acceptances.yaml`](../../release/advisory-acceptances.yaml) 中都有一条安全公告接受记录，且该记录的安全公告与包相同、其范围为锁定版本所满足、其 `lapsesAfter` 不低于本次发布的版本，其 `approver` 又是同一提交处 `.github/CODEOWNERS` 所指定的该文件所有者时，检查才通过。每个条目还记录 `added`，即添加该条目的日期（`YYYY-MM-DD`），发布说明会显示它。出现以下任一情况时检查失败，它以 1 退出：存在其他影响锁定版本的安全公告；某条安全公告接受记录已失效，或其批准者不是所有者；某个条目缺少 `added`；安全公告接受记录文件含未知字段或重复键；或公告源无法访问、返回格式错误的响应。

报告包含 `schema`（`delo.release-advisories/1`）、`version`、`feed`、`packages`（已检查的锁定版本数）、`findings`（每条受影响的安全公告，附其包、版本、严重级别、标题与受影响版本范围，以及覆盖它的安全公告接受记录，或该接受记录已失效的原因（`lapsed`）或被拒绝的原因（`unapproved`））、`result`（`pass` 或 `fail`）与 `problems`。签名会再次运行检查，只有当已发布的报告作为 JSON 与其自身运行得到的报告相同时才继续。`assemble.ts --advisories <report> --manifest <signed manifest>` 会在发布说明中加入「Accepted advisories」一节，逐条列出每个已接受的安全公告及其包、范围、原因、批准者、日期与失效版本；它拒绝不是已签名 manifest 按长度与 SHA-256 所指明文件的报告、其已接受 id 与 manifest 不同的报告、另一次发布的报告，以及失败的报告。

## 签名

签名在目标密钥持有者的机器上、CI 之外进行，发生于发布工作流已从标签 `v<version>` 构建发布、且持有者已完成重建之后：

1. 将草稿发布中发布工作流的文件（包括其 `manifest-draft.json`）下载到某个目录中，例如 `release/`。
2. 在仓库中检出该标签，用同一配方构建它，并为输出生成证明：`node_modules/.bin/tsx delo/apps/release/src/build-closure.ts --version <version> --commit v<version> --out rebuild/ --attestation-key ~/.config/delo/rebuild-attestation.key --attestation rebuild.attestation.json`，然后对同一输出构建镜像：`node_modules/.bin/tsx delo/apps/release/src/build-images.ts --version <version> --commit v<version> --out rebuild/ --oci rebuild-oci/ --attestation-key ~/.config/delo/rebuild-attestation.key --attestation rebuild.attestation.json`，它会重写证明，使其也覆盖镜像文件与重写后的 SBOM。
3. 记录重建：`node_modules/.bin/tsx delo/apps/release/src/record-rebuild.ts --version <version> --release release/ --rebuild rebuild/ --record delorun-<version>.rebuild.json --builder <name> --compared-with <workflow run URL>`。它依据该标签处提交的 `rebuild-exceptions.json`，将每个重建文件与发布工作流中同名的文件比较，将记录写入 `release/` 之外的 `--record`，并在比较发现差异时以 1 退出。设置了 `CI` 或 `GITHUB_ACTIONS` 时，它拒绝运行；重建缺少任一平台的归档或文件列表或 SBOM 时，它也拒绝。
4. 签名：`node_modules/.bin/tsx delo/apps/release/src/sign-release.ts --release release/ --rebuild rebuild/ --record delorun-<version>.rebuild.json --attestation rebuild.attestation.json --attestation-key ~/.config/delo/rebuild-attestation.key --key <targets.pem>`。

`sign-release.ts` 会拒绝运行，并给出一条写明所需来源的消息，即 "a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe"。出现以下任一情况时，它都会拒绝：重建记录缺失或无法读取；`release/` 中已有 `delorun-<version>.rebuild.json`，或 `--record` 或 `--rebuild` 位于 `release/` 之中；记录写明 `ci: true` 或报告了差异；设置了 `CI` 或 `GITHUB_ACTIONS`；`--rebuild` 不是本机上的目录、其文件无法复现记录中的摘要，或缺少任一平台的运行时归档或文件列表或 SBOM；记录的提交不是标签所指的提交，或记录中的配方摘要或工具链（Node.js、pnpm、编译器与链接器）与该提交的配方不一致；证明缺失、位于 `release/` 或 `rebuild/` 之中，或无法用证明密钥对版本、提交以及 `rebuild/` 中的每个文件验证通过；或将发布工作流的文件与重建再次比较时发现差异。它还会依据该发布提交处已提交的接受记录，针对 npm 的公告源再次运行依赖安全公告检查，并在检查失败，或其接受的安全公告与草稿的 `advisories.accepted` 不同时拒绝。它还拒绝这样的草稿：其 SBOM 不是 `delorun-<version>.spdx.json`，其运行时条目不是对应平台自身的 `delorun-<version>-<platform>.tar.gz`（`win32-x64` 为 `.zip`）与 `delorun-<version>-<platform>.files.json`，或其文件未以草稿所列的长度与摘要出现在发布目录中。所有检查通过后，它会先以临时文件名在 `release/` 中写入每个已签名的运行时文件列表、以 `delorun-<version>.rebuild.json` 为名的记录，以及 `delorun-<version>.manifest.json`（该 manifest 的 `rebuild` 字段写明记录与持有者，并标注 `ci: false`），再将它们重命名到位，manifest 最后重命名；重命名之前的任何失败都不会改动 `release/`。

### targets 密钥

targets 密钥是一个 Ed25519 私钥，保存在 PKCS #8 PEM 文件中，且只有其所有者可读；`sign-release.ts` 会拒绝组用户或其他用户拥有任何权限的密钥文件。仓库中不保存任何密钥。所有者在用于签署发布的离线机器上，于签名步骤中创建该密钥，例如使用 OpenSSL 3：

```sh
umask 077
openssl genpkey -algorithm ed25519 -out targets.pem
openssl pkey -in targets.pem -pubout -out targets.pub.pem
```

公钥写入根元数据（root metadata）的 `keys` 与 `roles.targets`，并由根密钥签名（[C2](../../docs/contracts/c02-release-manifest.zh.md#root-metadata)）；私钥绝不进入 CI、云服务，或发布工作流可以访问的机器。

### 重建证明密钥

证明密钥是一个至少 32 字节的机密，位于持有者签名机器上的 `~/.config/delo/rebuild-attestation.key`，只有其所有者可读；它从不离开那台机器。持有者只需创建一次：

```sh
mkdir -p ~/.config/delo && umask 077
openssl rand -out ~/.config/delo/rebuild-attestation.key 32
```

`build-closure.ts --attestation-key` 对发布版本、提交以及 `--out` 中每个文件的长度与 SHA-256 写入一个 HMAC-SHA256，`sign-release.ts` 会检查它。它能发现把 `--rebuild` 指向并非本机构建所写目录的失误，例如发布工作流输出的下载副本。它无法阻止蓄意作弊的持有者，因为持有者掌握密钥，可以为任何目录生成证明；C2 已说明重建的独立性无法证明。

### 根元数据与时间戳元数据

`node_modules/.bin/tsx delo/apps/release/src/sign-root.ts --draft <file> --key <root.pem>... [--previous <root file>] --out <root/<n>.root.json>` 在所有者的签名步骤中签署根元数据：草稿即根元数据的 `signed` 内容；只有当该文件以其自身的根阈值验证通过且尚未过期时，才会写入该文件；对于轮换，它还须作为 `--previous` 之后的版本，并以该根的阈值同样验证通过。

`node_modules/.bin/tsx delo/apps/release/src/sign-timestamp.ts --state <state.json> --root <file>... [--first] --stable <manifest> --beta <manifest> [--replaced <manifest>]... --out <timestamp.json>` 使用来自 `DELO_TIMESTAMP_KEY` 环境变量的在线密钥，从状态所保存的最近一次时间戳继续签署下一个时间戳，并先写入新的状态，再写入时间戳。`--root` 从状态所信任的根开始，根轮换之后可重复，最后给出最新的根。状态中的最近一次时间戳必须与状态记录的摘要和版本一致，能用其所指明的根中的时间戳密钥验证通过，且与该根文件的摘要一致；它可以已经过期。调用方不传入上一个时间戳。`--first` 在没有上一个时间戳的情况下签名，仅当状态尚未记录任何时间戳时才可使用。每个通道的 manifest 都必须能用最新根中的 targets 密钥验证通过；stable 通道指明一个 stable 发布，beta 通道指明一个 beta 或 stable 发布；任何通道都不会移向更低的版本。只有当通道所指明的 manifest（以 `--replaced` 传入）与新的 manifest 仅签名不同，或在其已无法用最新根中的 targets 密钥验证通过之后（例如 targets 密钥轮换之后）仅签名与 `published` 不同时，通道才会移向同一发布的另一个 manifest；签名内容的任何其他改动都会被拒绝。新版本比 `--previous` 高一号，过期时间为签发后 3 天。

状态文件（`delo.release-timestamp-state/1`）保存签名者所信任的根，以及最近一次签署的时间戳及其版本、SHA-256 与字节，因此不受信任的元数据主机提供的真实但较旧的时间戳无法让通道回滚。所有者在根签名步骤中用 `node_modules/.bin/tsx delo/apps/release/src/sign-timestamp.ts --init-state --root root/1.root.json --state state.json` 写入一次，并把其内容保存为发布工作流受保护的 `release` 环境中的变量 `DELO_TIMESTAMP_STATE`，绝不放在元数据主机上。每个签名作业把该变量还原为文件，签名后，用一个只对该环境中的作业可用、且可写入该环境变量的令牌，把新状态写回该变量。所有者尚未编写的发布工作流文件必须：

- 把每个签署时间戳的作业放进同一个 `concurrency` 组，使两次签名绝不会从同一状态开始；
- 在发布时间戳之前把新状态写回 `DELO_TIMESTAMP_STATE`，使已发布的时间戳始终是状态所保存的那一个。

## 验证

`src/sign/verify.ts` 实施 C2 的客户端验证：`trustRootChain` 从调用方持有的根开始遍历各根版本，每个版本都须由上一版本根密钥的阈值及其自身根密钥的阈值签名，签发时间早于过期时间，有效期至多 365 天，且最新版本尚未过期；把同一密钥分配给两个角色、或 `active` 的 targets 密钥不恰好为一个的根读取失败；`verifyTimestamp` 检查时间戳角色的签名、3 天有效期、签发时间不晚于本地时间、不设时钟容差的过期检查（其拒绝消息写明过期时间与本地时间）、已存储的版本，以及其所指明的根版本与根文件摘要；`verifyChannelManifest` 只接受新鲜的时间戳为该通道指明的 manifest 文件，其发布与通道须与时间戳所指明的一致（beta 通道也指明 stable 发布），且该文件须由对该发布有效的 targets 密钥签名（`active` 密钥，或 `lastRelease` 不低于该发布的 `retired` 密钥；绝不接受 `revoked` 密钥）；`verifyFileList` 与 `checkFileRef` 依据 manifest 检查每个文件的长度与 SHA-256。每个签名文件都先按其大小上限读取，再进行解析；重复的 JSON 键、未知字段或未知的 `schema` 都会使读取失败。`src/sign/json.ts` 存放签名所覆盖的 RFC 8785 序列化。

## 镜像

`node_modules/.bin/tsx delo/apps/release/src/build-images.ts --version <version> --out <dir> --oci <dir> [--commit <rev>] [--attestation-key <file> --attestation <file>]` 紧接在 `build-closure.ts` 之后，对同一输出运行。它为 `images.json` 所列的每个镜像构建 `linux/amd64` 与 `linux/arm64` 两个平台，各自以其按摘要固定的 Debian 基础镜像为基础；构建时使用 BuildKit 的 `rewrite-timestamp`，时间戳取运行时发行包的 `SOURCE_DATE_EPOCH`，不使用缓存，也不生成 provenance 或 SBOM attestation，因为二者的构建时间与调用 id 会使各次构建不同。Dockerfile 按摘要固定其 frontend。

- S2 工作区镜像（`images/s2/`）添加空的辅助套接字目录 `/run/delo-helper`。S2 辅助程序与出站代理（egress proxy）尚未包含在其中。
- S3 harness 镜像（`images/s3/`）添加用户 `delo`（uid 1000）与 `delo-harness`（uid 1001），以及各架构的 Linux 运行时发行包（只读，位于 `/opt/delo/runtime`），并以 `delo-harness` 身份运行。

该命令把各镜像的 OCI 布局写入 `--oci`，并把 `delorun-<version>.images.json` 写入 `--out`。该文件记录每个镜像的仓库，以及其索引与各平台 manifest 的摘要；重建比较会逐字节比较它。当 `--out` 中包含所有平台的运行时发行包时，命令还会重写 SBOM，使其同时描述两个镜像。发布工作流按摘要推送各 OCI 布局，发布 manifest 的 `images` 复制该文件。镜像文件是每次重建与签名比较都必须覆盖的文件之一；草稿的 `images` 与之不同时，签名会拒绝；签名时，SBOM 中的镜像条目依据该发布提交处 `images.json` 所列的基础镜像推导。

## 发布日志

`sign-release.ts` 还会写入 `delorun-<version>.manifest.entry.json`，即 C18 约定中的 `hashedrekord` 条目主体：其中包含 manifest 文件的 SHA-256、targets 密钥对 manifest 文件字节的 Ed25519 签名，以及 PKIX PEM 格式的 targets 公钥。`node_modules/.bin/tsx delo/apps/release/src/log-release.ts --root <file> --manifest <file> --entry <file> --submit <url> --checkpoint <url> --proof <url> --out <bundle>` 在发布工作流中运行：它提交该条目，每 30 秒轮询一次、至多 60 次，等待某个检查点获得根元数据所列见证者的共同签名，且该检查点覆盖该条目；只有当 bundle 验证通过时，它才写入 `delorun-<version>.manifest.log.json`；否则它以 1 退出，该发布版本不会发布。

`src/log/bundle.ts` 按 C18 的五个步骤离线验证 bundle：manifest 摘要、条目的 targets 签名、RFC 6962 包含证明、检查点的 origin、大小、根哈希与日志签名，以及来自所列见证者的共同签名，其数量至少达到根元数据的阈值。没有此类共同签名的检查点会验证失败，无论其日志签名如何，且每次失败都带有 C18 所定义的原因码。`src/log/note.ts` 读取 C2SP signed-note，并使用 Ed25519 note 密钥与 `cosignature/v1` 见证者密钥；`src/log/merkle.ts` 验证包含证明与一致性证明。

## 待完成事项

以下发布内容尚未在此构建；每一项归属于所注明的工作包。

- SBOM 尚未描述桌面安装包，它们有待桌面应用（P6，已推迟）。
