---
description: "Delorun 发布工作流的设计：构建发布版本、记录日志并在 targets 密钥持有者签名后发布它的 CI 工作流，定时的时间戳重新签名，签名之前的公告检查，无需令牌的 npm 可信发布，二选 N 的重新构建，Authenticode，以及安装脚本。"
---

# 发布工作流

[English](release-workflow.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

[约定 C2](../contracts/c02-release-manifest.zh.md) 和[约定 C18](../contracts/c18-release-log.zh.md) 陈述了发布版本如何被签名、记录日志和验证，而对发布版本进行签名、加时间戳、记录日志和检查的命令存在于 [`delorun/apps/release`](../../apps/release/README.zh.md) 中。本页给出 Delorun 为在 CI 中运行的部分，或发布版本在 npm 启动器之外附带的部分所采纳的规则：发布工作流、定时的时间戳重新签名、作为工作流一个步骤的公告检查、无需令牌的 npm 发布、维护者开始签名之后的二选 N 重新构建、Authenticode 签名，以及安装脚本。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- `.github/workflows` 下没有任何工作流构建、签名、记录日志或发布 Delorun 的发布版本。为发布版本签名、为时间戳签名、写发布日志条目、检查公告以及比较重新构建，都是由人运行的命令：`delorun/apps/release/src/` 下的 `sign-release.ts`、`sign-timestamp.ts`、`log-release.ts`、`check-advisories.ts` 和 `compare-rebuild.ts`。
- 签名命令在没有在 CI 之外做出的匹配的重新构建记录时会拒绝，在 `CI` 或 `GITHUB_ACTIONS` 下会拒绝，并在签名之前重新运行公告检查。时间戳命令拒绝把渠道移到比前一个时间戳所指的更低的版本。
- 公告接受记录只有在其批准者是 `delorun/release/` 的 CODEOWNERS 所有者（按登录名）时才有效。`.github/CODEOWNERS` 只指名了一个团队，而检查不把它计算在内，所以没有任何接受记录有效，任何公告都会使检查失败。
- `delorun/apps/npm-launcher/src/build.ts` 用给定的发布根打包 `delorun` npm 包。没有任何工作流发布它，也不存在 `install.sh` 或 `install.ps1`。
- 发布 manifest 的 `desktop` 条目没有指名任何 Delorun 桌面构建：桌面应用是上游的。
- closure 配方在一个由基础摘要、Debian 快照和确切软件包版本固定的构建器镜像中、在没有网络的情况下，从带标签的源代码为 `linux-x64` 和 `linux-arm64` 编译上游的原生系统插件（`native/system`），而 `prebuilt-pins.json` 固定这些二进制文件。它没有为 macOS 二进制文件固定的工具链，所以 `darwin-x64` 和 `darwin-arm64` 不是发布平台；closure 中的其他所有原生文件，都是锁文件固定的预构建 npm 文件。
- 发布平台是明确的：`closure.json` 列出 `linux-x64` 和 `linux-arm64`（Windows 在 WSL2 中运行 Linux 运行时），而构建、SBOM、重新构建记录和签名恰好涵盖这些平台。当列表指出了配方无法构建其原生代码的平台时，读取配方会失败。在发布版本未列出的平台上，npm 启动器和 `delorun update` 以 `PLATFORM_NOT_RELEASED` 拒绝，并指出该平台。启动器和 `delorun update` 在原生 Windows 和 macOS 上会在任何下载之前停止，并指出 WSL2 和指南。只有当配方从带标签的源代码构建出其原生代码，且 `closure.json` 列出它时，原生 Windows 或 macOS 运行时才会加入发布版本。

<a id="the-rules"></a>

## 规则

1. **发布工作流。**Delorun 公开仓库的某个工作流构建每个带标签的发布版本，只有在 targets 密钥持有者的签名和发布日志 bundle 通过验证之后才把它的文件发布到 GitHub 发布版本，并且不持有任何根密钥或 targets 密钥。
2. **时间戳重新签名。**生产渠道的 cron Worker 每 24 小时用在线时间戳密钥重新签名 `timestamp.json`，该密钥作为该 Worker 唯一的密钥保存（见[发布渠道](../../apps/release-channel/README.zh.md)）；发布一个发布版本时会再次签名，并且发布会拒绝版本不高于已存储版本的时间戳。该 Worker 在只有它被绑定的 Workers KV 命名空间中保存一个高水位标记（版本和每个渠道的发布版本），并拒绝对回滚到它之下的存储桶重新签名，所以 S3 发布令牌无法把旧的时间戳洗成新的。Cloudflare 不提供只读的 R2 绑定，所以公开的 Worker 在代码上是只读的，并有一个测试在它调用 `put` 或 `delete` 时失败。Cloudflare 账户被攻破可以让陈旧的发布版本保持最新，但无法伪造一个发布版本。任何签名都不会把渠道移到更低的版本。
3. **签名之前的公告检查。**工作流在 targets 密钥持有者签名之前运行 [C2](../contracts/c02-release-manifest.zh.md#dependency-advisory-check) 的公告检查，检查失败时发布停止。发布说明列出每个已接受的公告，包括它的包、范围、原因、批准者、失效的发布版本和日期。
4. **npm 发布。**`delorun` 和 `create-delorun` 只通过发布工作流中的 npm 可信发布来发布：发布作业请求一个 OIDC 令牌（`permissions: id-token: write`），不持有 npm 令牌，npm 附上一份经 Sigstore 签名的 SLSA 构建证明，指出仓库、工作流文件和 commit。
5. **二选 N 重新构建。**一旦维护者持有密钥，签名就要求来自所列 N 个构建者中两个构建者的匹配的重新构建记录，其中至少一个为 `ci: false`。
6. **Authenticode。**Windows closure 和桌面应用中的每个 PE 文件都带有 Authenticode 签名，manifest 记录已签名文件的摘要。
7. **安装脚本。**`install.sh` 和 `install.ps1` 在安装之前按 [C2](../contracts/c02-release-manifest.zh.md#client-verification) 所陈述的方式验证 closure，发布说明和信任页面会打印它们的摘要。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **签名者的机器。**重新构建表明带标签的源代码和已发布的配方产生了该发布版本，而不表明签名者的机器和工具链没有被攻破。
- **带标签的源代码或固定依赖项中的恶意更改。**重新构建会重现它，签名会涵盖它。
- **构建器镜像的软件包。**重新构建表明固定的 Debian 编译器、链接器和 C 库在两台机器上给出相同的二进制文件，而不表明这些软件包没有后门；两次构建都从同一个 Debian 快照获取它们。
- **在任何 Delorun 检查之前的 npm 启动器。**`npx delorun` 运行 npm 所提供的启动器；构建证明把它与发布工作流联系起来。

<a id="denial-tests"></a>

## 拒绝测试

| 测试 | 证明什么 |
| --- | --- |
| `c02-npm-publish-has-no-token` | 当 npm 发布作业引用 npm 令牌或缺少 `id-token: write` 时，工作流 lint 失败。 |
| `c02-pe-files-signed` | `signtool verify /pa` 对 Windows closure 中的每个 PE 文件都通过。 |
| `the workflow publishes nothing before the signature and log verify` | manifest 签名或日志 bundle 未通过验证的工作流运行，不会向发布版本发布任何文件。 |
| `the scheduled timestamp never lowers a channel` | 输入为某个渠道指定了更低版本的定时运行会拒绝签名。 |
| `two of N rebuilds are required once maintainers sign` | 在二选 N 的根之下只用一条重新构建记录签名会被拒绝。 |

<a id="implementation-status"></a>

## 实现状态

签名、时间戳、日志、公告和重新构建比较的命令及其拒绝都已构建，C2 和 C18 对它们作了描述。上述规则均未构建。
