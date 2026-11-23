---
description: "npm 作为 delorun 提供的 Delorun 启动器：它通过 @delorun/install 校验并安装频道指定的发布，拒绝无法校验的运行时，并用自己的 Node 可执行文件启动已安装的运行时（约定 C1 的启动协议 1）。"
---

# @delorun/npm-launcher

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

此应用即 `npx delorun` 运行的内容。它启动本机已安装的运行时，若没有可启动的运行时，则先安装频道指定的发布。启动不需要网络：约定 C2 的启动检查在运行时存储内部运行。它对存储的标识记录无法担保的每个文件计算哈希，所以它读到的被改动的文件会使启动停止；该记录不含密钥，因此以本人权限运行的程序可以改写它，让任何被改动的文件（包括运行时的 Node 和 `delorun` 本身）通过普通的启动，所以启动器会在 `delorun verify` 运行之前对每个文件计算哈希。安装经由 [`@delorun/install`](../install/README.zh.md) 完成，它会依据签名清单与发布日志校验该发布；任一检查拒绝时，`~/.delorun/runtimes/` 下不会留下任何内容。启动器从不切换 `current`：切换由存储的安装完成，且只在存储完全没有运行时的情况下发生。

## 目录

- [命令](#commands)
- [启动流程](#the-launch-flow)
- [它打印什么](#what-it-prints)
- [它随包携带的根](#the-roots-it-ships)
- [构建该包](#building-the-package)
- [拒绝](#refusals)
- [退出码](#exit-codes)
- [开发](#development)

<a id="commands"></a>

## 命令

| 命令行 | 作用 |
| --- | --- |
| `delorun [--profile <name>]` | 以给定的参数启动已安装的运行时；存储中没有运行时时先安装频道指定的发布 |
| `--profile <name>` | CLI profile，同时传给运行时；默认为 `default`，未提供该标志时由 `DELORUN_PROFILE` 提供。profile 名称为 1 至 32 个小写字母、数字、`-` 或 `_`，且以字母或数字开头；其他名称，以及[约定 C1](../../docs/contracts/c01-home-layout.zh.md#profiles) 保留的每个名称（`desktop`、`headless`、`data-users` 与 `node_modules`），都在读取 home 之前即被拒绝 |
| `--release <version>` | 在存储中没有运行时时，安装此发布而非频道的当前发布；新时间戳未指定的发布会被拒绝，而已安装运行时时启动器会停下并同时指明两个版本，而非忽略该参数 |
| `--help`、`-h` | 打印用法说明 |
| `--` | 结束启动器自身的选项：其后的每个参数都原样传给运行时，因此运行时保有自己的 `--release` 与 `--profile` |
| 其他任何参数 | 原样传给运行时，因为 `delorun` 的命令由运行时拥有 |
| `DELORUN_RUNTIME_FULL_CHECK_DAYS` | 启动改为对每个运行时文件计算哈希、而不再比对上次哈希后记录的文件标识的间隔：从 0（每次启动都计算哈希）到 30 的整天数；未设置时为 7。该间隔从标识记录所指名的时间算起，而以本人身份运行的程序可以改写它。`delorun verify` 总是得到 0。其他任何值都会在读取 home 之前连同用法说明一起被拒绝 |
| `DELORUN_REPAIR_MARK_GRACE_SECONDS` | 无法解析的 `run/repair.json` 仍被算作正在运行的修复的秒数，因为写入它的修复可能正写到一半：从 1 到 60 的整秒数；未设置时为 5。其他任何值都会在读取 home 之前连同用法说明一起被拒绝 |

<a id="the-launch-flow"></a>

## 启动流程

`runLauncher` 先尝试启动，仅在存储回答 `NO_ACTIVE_RUNTIME` 时才安装。启动会读取 `trust/root.json`（本 home 最近校验通过的根）并交给存储，由存储以其完整哈希的间隔（`delorun verify` 为 0，所以在该命令运行之前每个文件都被计算哈希）对 `current` 运行约定 C2 的启动检查，并构建约定 C1 的启动协议 1 命令。该根只经由启动器随包携带的根获信（见[它随包携带的根](#the-roots-it-ships)）；没有已存储的根时按没有运行时的存储处理，因为本 home 还没有校验过任何内容。在运行时启动之前，启动器通过 `@delorun/release-verify` 运行约定 C18 的启动检查：先离线校验已存储的发布日志 bundle，再依据根所指的日志进行在线检查，并把状态与校验通过的检查点记录在 `trust/` 下。未能完成的检查会打印警告并照常启动；可校验的失败会打印拒绝信息，指明 `delorun verify` 与重新安装，并以 1 退出而不启动；`delorun verify` 本身例外，它会启动，以便本人看到每项检查。缺失已存储的 bundle（每次经由存储的安装都会保留它）会以同样方式被拒绝，拒绝信息指明 bundle 的路径，并提供 `delorun recover rollback` 或恢复该文件；随后 `delorun recover rollback` 会在 `previous` 通过其自身的启动检查与发布日志检查之后启动它，与 `current` 未通过启动检查时一样。运行时启动时，`DELORUN_LAUNCHER_ROOTS` 被设为启动器的 `roots/` 目录，`DELORUN_LAUNCHER_VERSION` 被设为启动器自身 `package.json` 的 `version`，读不出时则不设置，`DELORUN_START_CHECK` 被设为启动检查的记录：它何时开始、是否对每个文件计算了哈希、计算了多少个文件的哈希、上一次完整检查何时运行，以及启动器的版本和目录，`delorun verify` 和 studio 据此报告而无需再次计算哈希；继承来的 `DELORUN_LAUNCHER_*` 变量从不传到运行时；`delorun setup` 安装 `delorun` 命令时固定到该版本，`delorun verify` 则把它与发布已签名的 `npm` 条目比对。

当 `current` 未通过启动检查时，启动器会查找上一次更新所替换的版本，只读取 home 而不写入任何内容：已存储的根必须锚定在随包携带的根上，存储必须指明一个 `previous`，且 `previous` 必须通过同样的启动检查。存在这样的 `previous` 时，结果取决于命令。不带参数的 `delorun`、`delorun start` 与 `delorun recover rollback`，在其周围只有 `--profile <name>` 或 `--profile=<name>` 选项且 `--` 之后没有内容时，会打印一行，对 `previous` 运行发布日志启动检查，并以 `delorun recover rollback` 代替本人的参数启动它，profile 按启动协议 1 的方式经由 `DELORUN_PROFILE` 传递：

```text
Delorun did not start release 0.2.0: it failed its start check. Starting release 0.1.0, the version before the last update, to roll back to it: delorun recover rollback
```

该命令应用约定 C3 的回滚表，因此指针只经由它改变；若没有记录对 `current` 的更新，它以 `NO_UPDATE_RECORD` 拒绝；启动器以它的状态退出。其他每个命令都会被拒绝，包括 `delorun verify`、`delorun stop`、`delorun status`、`delorun update`、`delorun recover status`、未知命令、带有 `--foreground` 等其他任何选项的启动，以及 `--` 之后带有参数的任何命令行（启动器不读取其中的 `--profile`）：启动器不启动任何发布，不改动 home 中的任何内容，打印哪个发布未通过启动检查及原因，指明 `delorun recover rollback` 是启动 `previous` 并回滚到它的方式，并以 1 退出，因为以回滚代替该命令会在一个两者都未要求的命令上回滚运行时与 chat 数据：

```text
Delorun did not run delorun verify: release 0.2.0 failed its start check, so Delorun ran no release.
Why: RUNTIME_CHANGED: runtime 0.2.0 differs from its signed file list: app/entry.js (sha256)
What you can do:
  Start release 0.1.0, the version before the last update, to roll back to it: delorun recover rollback --profile default
```

没有可用的 `previous` 时，以及每当以 `--release` 指定了发布时，启动自身的拒绝对每个命令都成立。

以 `--release` 指定的发布会被安装，而本启动器只在存储中没有运行时时安装：它从不替换本人已有的运行时，也从不切换 `current`。因此已持有运行时的存储会拒绝该指定发布，指明已安装的版本并给出运行时自身的更新方式，而不是启动已安装的运行时并把本人的请求悄悄丢掉。

安装会解析发布，请存储以频道的 `fill` 作为下载步骤来安装它，然后保留指针所指的两个版本并移除其余版本。存储无法完成的清理会作为警告报告，并在下次运行时重试；它从不会让启动失败。

运行时取代本进程运行：启动器用存储构建的环境叠加在本进程自身的环境之上来启动它——其中去掉载入代码或决定信任的变量，不论大小写：`NODE_OPTIONS`、`NODE_PATH`、`NODE_EXTRA_CA_CERTS`、`NODE_TLS_REJECT_UNAUTHORIZED`、`NODE_COMPILE_CACHE`、`NODE_V8_COVERAGE`、`NODE_ICU_DATA`、`OPENSSL_CONF`、`OPENSSL_MODULES`、`OPENSSL_ENGINES`、`GCONV_PATH`、`LOCPATH`、`LD_*` 与 `DYLD_*`（这是拒绝列表而非允许列表，因为运行时会运行本人的命令与工具，它们需要 `PATH`、代理、凭据、SSH agent 与工具链变量，而允许列表会去掉这些变量），因此运行 `npx delorun` 的 shell 既无法把代码载入运行时的 Node 或其动态加载器，也无法决定其 HTTPS 连接信任什么（`@delorun/contract-home-layout` 中的 `DROPPED_LAUNCH_ENV` 和 `inheritableEnvironment`，更新的后继进程和 studio 的 Check 现在也应用它们）——与其共享标准输入输出，并以运行时自身的状态退出。

<a id="what-it-prints"></a>

## 它打印什么

An install prints a checklist to standard error, so the output of the command that runs next stays on standard output unmixed. Each step is a line: a spinner while it runs, then a tick and how long it took, with the durations right-aligned in one column. The download and the extraction also show a bar under their line. On a terminal the block redraws in place:

```text
✔ Found release 0.1.0-preview.2.7 on the stable channel                    0.4s
✔ Signature checked (release root 1)                                       0.1s
✔ Release log checked                                                      0.6s
⠹ Downloading delorun-0.1.0-preview.2.7-linux-x64.tar.gz
  ██████████████░░░░░░░░░░   58%  126.4 / 218.0 MB  6.7 MB/s  ~14s left
```

The bar shortens, and then drops the time left, the speed and the amounts, on a narrow terminal. The speed and the time left are worked out over the last five seconds, and the time left reads `estimating…` until a second of data gives a speed. A download that delivers no byte for three seconds reads `waiting for data… 12s`, and the spinner keeps turning, so the screen is never silent. Setting `NO_COLOR` removes the colour.

The steps follow the order the checks run: the signature is checked before the archive is downloaded, because the signed manifest is what names the archive and its size. When the install ends and the command says what happens next, it prints one `Next:` line: `a few setup questions` for a bare `delorun` on a home without the CLI profile and for `delorun setup`, `opening the studio` for a bare `delorun` on a home that has it and for `delorun start`, and no line for any other command. When standard error is not a terminal, or `TERM` is `dumb`, the same steps print as plain lines, and the download prints one line for each tenth:

```text
✔ Found release 0.1.0-preview.2.7 on the stable channel  0.4s
✔ Signature checked (release root 1)  0.1s
✔ Release log checked  0.6s
Downloading delorun-0.1.0-preview.2.7-linux-x64.tar.gz…
  10%  21.8 / 218.0 MB  6.7 MB/s
  20%  43.6 / 218.0 MB  6.8 MB/s
…
✔ Downloaded 218.0 MB at 6.8 MB/s average  32s
✔ Download matches its signed hash  0.9s
Unpacking the runtime…
  10%  352 / 3,516 files
…
✔ Unpacked the runtime (3,516 files)  4.5s
✔ Installed release 0.1.0-preview.2.7  0.2s
✔ Starting Delorun  0.0s
Next: a few setup questions
```

When the release log or its witness cannot be reached, or its newest witnessed checkpoint is older than 24 hours, the step is marked `!` with the reason, and one warning follows in the words of contract C18:

```text
! Release log not checked (the release log did not answer: …)  0.6s
  Warning: Release 0.1.0-preview.2.7 has not been checked against the release log; Delorun checks it at the next connection.
```

The install then goes on with the release's signature, and the home records the release as `unchecked` in `trust/release-log.json` (see [`@delorun/install`](../install/README.zh.md#the-release-log)). A log that answers and contradicts the release refuses instead, as [Refusals](#refusals) describes: the running step is marked `✖`, and the refusal's own text follows. A question the launcher asks, such as the one `delorun repair` asks, clears the checklist while it is asked. A start prints none of these lines. The checklist is `@delorun/install`'s `InstallRenderer`, which `src/progress.ts` re-exports, so `delorun update`, `delorun repair` and a plugin pack download draw the same lines from the same events. The renderer only displays: verification, its order, its refusals and their messages do not depend on it.

比该包 `engines` 范围（`>=24.9.0`）更旧的 Node 会在其他任何内容运行之前得到一行信息，说明它发现的版本以及在哪里获取更新的版本，并以状态 1 退出：发布的 `bin`（`src/entry.ts`）只在版本检查通过后才载入启动器的主模块，因此无法解析主模块语法的 Node 仍能读到这条拒绝信息。

<a id="the-roots-it-ships"></a>

## 它随包携带的根

启动器只通过自己包内 `roots/` 目录中的根文件（`1.root.json`、`2.root.json` 及以后）信任一个发布。随包携带的根必须构成一条链：每个根既由前一个根签名，也由自身的键签名；启动器在读取时检查这一点，构建在打包时检查这一点。更新的根只能从本包携带的最新根逐级走到，因此根版本出现缺号的包会拒绝任何安装，而不会信任网络提供的内容。完全没有根的包会以 `NO_TRUSTED_ROOT` 拒绝任何安装，并提示本人改用发布页面上的安装脚本。该规则即 `@delorun/install` 的 `readShippedRoots`，本启动器启动的运行时经由 `DELORUN_LAUNCHER_ROOTS` 对同一目录应用它。

同一批根也是启动的锚点。存储的根会在存储运行启动检查之前被读回并与之核对：在启动器携带的某个版本上，存储的根必须正是该根（键与角色一致），因此未经安装校验的根无法让无关运行时看起来已签名。比携带的最新根更旧的存储根（包括比携带的所有根都旧的存储根）不是锚点：启动检查在携带的最新根下运行，因此被该根撤销的 targets 密钥会让启动失败，而存储的文件保持原样，直到下一次安装或更新存储它所走到的根。比携带的所有根都新的存储根，只有在安装于 `trust/roots/` 下走过的链能到达它时才被信任：从携带的某个根到该根的每个版本，都由前一个根的键与自身的键共同签名。没有携带的根作为起点的存储根会被拒绝，即 `RUNTIME_CHANGED`，因此还原或同步放在 `trust/` 下的根不会成为锚点。日后随包携带了该更新根的启动器会再精确核对它。运行时经由 `DELORUN_LAUNCHER_ROOTS` 把每次更新、回滚与健康检查都锚定在同一批根上，因此同一本人的进程写到 `trust/root.json` 上的根在那里同样会被拒绝。

<a id="refusals"></a>

## 拒绝

`refusalFor` 以 `delorun` 共用的拒绝格式（`@delorun/home` 的 `renderRefusal`）把任何失败打印到标准错误：一行说明 Delorun 做了什么，一行 `Why:` 给出错误代码及其涉及的发布、主机、文件或细节，以及 `What you can do:` 之下的补救方法。每个包描述自己的错误（`@delorun/home` 的被拒绝 home、`@delorun/install` 的安装失败、`@delorun/runtime-store` 的存储拒绝，以及 `@delorun/release-verify` 的发布日志失败）；`LAUNCHER_DESCRIBERS` 列出启动器组合的那些描述器。其他任何失败打印 `Delorun stopped: <message>`，不带堆栈，也不带补救方法。每条拒绝信息在打印前都经过 `@delorun/logs` 的脱敏器（`renderLauncherRefusal`），因此消息中的密钥、令牌或凭据路径会打印为 `[redacted:<kind>]`。发布的 `bin` 在载入主模块之前安装 `@delorun/home` 的兜底处理器（`installLauncherLastResort`）：启动器未捕获的失败会打印同样经过脱敏的拒绝信息，最后一条补救方法说明启动器不保留日志，并以 1 退出，从不输出 Node 堆栈。安装类拒绝会给出该代码所带的补救方法：

- 发布主机不可达时，提示本人检查连接并再次运行同一命令。日志不可达不算拒绝：安装会发出警告并继续。
- 没有可信根的启动器会指向 `npx delorun@latest`，它随包携带当前的根。
- 无法读取的信任文件提示本人把它移开；启动器会依据它校验的发布重新存储它。
- 不属于启动器随包携带的根、或没有携带的根能走到它的存储根，提示本人重新安装该发布；重新安装会从携带的根重新校验根链，并存储其验证结果。
- 被拒绝或无法校验的发布，提示本人在发布页面列出更新发布时再次运行同一命令，并在重复出现时报告。
- 已持有运行时的存储上使用 `--release` 时，拒绝会指明请求的发布与已安装的版本，并给出运行时自身的更新方式。
- 不是 profile 名称的名字或不是版本的 `--release` 属于命令行有误：启动器打印用法说明并以状态 2 退出，既不读取也不写入 home。

存储类拒绝会把存储自身的补救方法作为本人可以运行的命令提供，例如重新安装该发布，或切回为回滚保留的版本。

<a id="building-the-package"></a>

## 构建该包

`src/build.ts` 构建 npm 以 `delorun` 提供的包并将其打包。该包包含打包为纯 JavaScript 并内联其依赖的启动器（`dist/bin.js` 与一个 chunk）、`roots/` 中的根文件、`LICENSE` 与一份简短的 `README.md`；其 `bin` 指向 `dist/bin.js`，`engines.node` 设为 `>=24.9.0`；`npx` 只需 Node 即可运行它。

```sh
node_modules/.bin/tsx delorun/apps/npm-launcher/src/build.ts --root <root.json>... --out <dir> \
  [--channel-origin <origin>] [--log-origin <origin>] [--package-version <version>]
```

- 每个 `--root` 在用其自身的根签名校验通过后，复制为 `roots/<n>.root.json`，以该根自身的版本命名。这些根合起来必须是连续的版本；没有 `--root` 的构建会被拒绝，因为由此生成的启动器会以 `NO_TRUSTED_ROOT` 拒绝每次安装。
- `--channel-origin` 与 `--log-origin` 成为打包器写入代码的构建常量；此后没有任何设置、参数或环境变量能改变它们。不提供它们时，构建出的是生产启动器：频道为 `releases.delorun.com`，并以 GitHub Releases 和 `releases.delo.run` 作为约定 C1 主机列表下的镜像，日志是受信任根所指的日志：根的 `log.origin` 是日志的主机，启动器读取 `https://<host>/api/v2/checkpoint` 以及 `https://<host>/api/v2/` 之下的 tile，即 Rekor v2 的布局。origin 为不带路径的 `https:`，或本机回环地址上的 `http:`，因此本地频道与日志可以为一个构建提供服务。频道 origin 提供 `timestamp.json`、`root/<n>.root.json` 与 `releases/download/v<version>/<file>`，即 `apps/release/src/local-release.ts` 写出的布局；下载器随后只允许该 origin 的主机。
- 该包先暂存在 `<out>/package`，再由 `npm pack` 打包为 `<out>/delorun-<version>.tgz`。`--package-version` 设置版本，默认使用本包自身的版本。
- Before it packs, the build scans the whole output folder, the staged package and anything else in `<out>`, for the building user's home directory, the user name as a folder (`/<name>/` or `\<name>\`) and a unique build root `delorun-release-build-*`, and refuses with every offending file named, so no tarball is written. Nothing skips the scan (`@delorun/release-formats/gate/home-paths`, the gate the release build runs over its closures).

<a id="exit-codes"></a>

## 退出码

| 代码 | 何时 |
| --- | --- |
| 0 | 运行时运行并以状态 0 结束，或已打印用法说明 |
| 1 | Delorun 拒绝或失败且没有运行任何内容，或运行时以自身的非零状态结束 |
| 2 | 命令行有误 |

<a id="development"></a>

## 开发

`tests/` 中的测试用替身存储、频道与启动过程驱动 `runLauncher`，因此不访问网络，也不会在运行测试的机器上安装任何内容；`tests/build.integration.spec.ts` 用一次性的根构建并打包启动器。[`@delorun/release`](../release/README.zh.md#local-release) 中的端到端规格测试通过打包好的启动器安装一个本地发布。用仓库的 Vitest 配置运行：`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/npm-launcher`。
