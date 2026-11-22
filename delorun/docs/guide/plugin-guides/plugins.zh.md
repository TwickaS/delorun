---
description: "从零开始编写 Delorun 插件直到运行起来：delorun plugin new，用 delorun plugin dev 的开发循环，检查版本范围，从文件夹、git 或 npm 安装，构建批准，日志，调试器，安全模式，以及为什么已发布包的 fork 需要自己的名称。"
---

# 为 Delorun 编写插件

[English](plugins.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

本页描述 Delorun 目前的工作方式。

## 摘要

Delorun 所做的一切都是插件，你也可以添加自己的插件：agent 调用的工具、agent 预设、studio 中的面板，或改变其他插件设置方式的 bundle。`delorun plugin new` 写出一个可以工作的包，`delorun plugin dev` 把它加载到你正在运行的 studio 中并在每次保存时重新加载，`delorun plugin check` 说明它能在哪些 Delorun 和 DeepSeek Harness 版本上运行，`delorun plugin add` 把它永久安装。插件在 Delorun 内部以你的权限运行，位于 Delorun 运行 agent 命令所用的沙箱之外，所以请只安装你信任其代码的插件。要判断插件是否是实现你的更改的合适工具，请见[什么该在哪里定制](../customising/customise.zh.md)。

## 目录

- [开始之前](#before-you-start)
- [创建插件](#create-a-plugin)
- [在 studio 中](#from-the-studio)
- [在 chat 中](#in-a-chat)
- [在你开发它时运行它](#run-it-while-you-work-on-it)
- [检查它的版本](#check-its-versions)
- [安装它](#install-it)
- [pnpm 拒绝的构建](#builds-pnpm-refuses)
- [当它无法加载时](#when-it-does-not-load)
- [连接调试器](#attach-a-debugger)
- [仅用于一次启动的覆盖层](#overlays-for-one-start)
- [fork Delorun 自带的插件](#forking-a-plugin-delorun-ships)

<a id="before-you-start"></a>

## 开始之前

刚接触插件？[你的第一个插件](first-plugin.zh.md)带你从零开始直到在 studio 中看到它。

你需要一个已完成 setup 的 Delorun（`delorun setup`）、[Node.js](https://nodejs.org) 24.9 或更新版本，以及用于构建 TypeScript 的 pnpm。pnpm 是一个独立的工具：Delorun 自带的那份只供 `delorun plugin` 内部使用，不在你的命令路径上，所以请自行安装 pnpm，例如用 `npm install -g pnpm`，或按 [pnpm.io](https://pnpm.io/installation) 的说明安装，并用 `pnpm --version` 检查。每条 `delorun plugin` 命令都作用于你的 CLI profile，除非你设置了 `DELORUN_PROFILE` 或传入 `--profile <name>`，否则就是 `default`。插件是一个 npm 包，其 `package.json` 声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；它的 `cordis.patch.yml` 把插件的行插入你的 profile。DeepSeek Harness 的教程解释了插件模型本身：[你的第一个插件](../../../../docs/user/develop/basic/index.zh.md)、[工具](../../../../docs/user/develop/basic/tool.zh.md)、[配置](../../../../docs/user/develop/basic/config.zh.md)和[打包](../../../../docs/user/develop/basic/publish.zh.md)。Delorun 原样运行这些插件。

<a id="create-a-plugin"></a>

## 创建插件

```text
delorun plugin new my-plugin --kind tool
cd my-plugin
pnpm install
pnpm run build
```

`--kind` 选择包开始时所基于的示例：

| 类型 | 它添加什么 |
| --- | --- |
| `tool`（默认） | agent 可以调用的 `greet` 工具，用 TypeScript 和 `defineTool` 编写 |
| `preset` | 没有代码：一个 agent 预设行，指明 agent 开始时的角色和工具，适用于其 studio 提供预设的 profile |
| `ui` | studio 中的一个设置页面：构建到 `lib/client.js` 的浏览器部分，以及一个让 studio 提供它的空的 host 部分 |
| `bundle` | 没有代码：一个 `cordis.patch.yml`，开启一个现有的插件，即上游的先读后改防护 |

包被写入 `./my-plugin`，或 `--dir <folder>` 所指的文件夹，该文件夹必须为空或不存在。其中包含带有 bundle 声明以及适用于正在运行的 Delorun 和 DeepSeek Harness 的版本范围的 `package.json`、`cordis.patch.yml`、“插件”页面显示的标题、带有这些命令的 README，对于 `tool` 和 `ui`，还有 `src/` 下的 TypeScript 源代码，以及在本仓库之外将其构建到 `lib/` 的 `tsdown.config.ts`。`ui` 的构建刻意保持很小：正如它的 README 所说，它不打包 CSS 文件、图片或字体，只写出一个不带 source map 的文件。`delorun plugin new` 会拒绝 `@deepseek-ai/` 或 `@delorun/` 作用域内的名称以及 Delorun 所发布的包的名称（[原因](#forking-a-plugin-delorun-ships)）。

<a id="from-the-studio"></a>

## 在 studio 中

在你的电脑上，打开“设置”→“插件”，使用 Create a plugin。给插件起一个名称，选择它添加什么（与 `delorun plugin new` 相同的四种类型），并选择一个工作区；第一个工作区是默认的。Delorun 会把与 `delorun plugin new` 写出的相同的文件写入该工作区的 `plugins` 文件夹，显示它们去了哪里并列出它们。Open folder 会在你的文件管理器中显示该文件夹，你和 agent 都可以在那里用 chat 通常的批准方式处理它。

创建插件并不会开启它。Turn on 会把插件记录为 Changes 中等待的一项更改，你在那里审阅它的文件并批准它；这与 `delorun plugin add link:<folder>` 所通向的审阅是同一个，并且在危险模式下同样适用。手机或其他设备可以看到这个部分但不能创建插件：它会提示在你的电脑上进行。

<a id="in-a-chat"></a>

## 在 chat 中

向 agent 索要一个插件，它会加载 `delorun-plugin-authoring` skill：用 `delorun plugin new` 在 chat 的工作区的 `plugins/<name>` 下搭建插件、编辑文件，并用 `delorun plugin check` 和插件自己的测试来检查它们。它写入文件和运行命令遵循 chat 通常的批准方式。无论 chat 的访问权限或保护设置如何，它都不能开启插件或批准它的构建：它请求的安装会列在 Changes 中，由你在电脑上批准。它会告诉你插件在哪里；请像上面那样在你的电脑上开启它，或用 `delorun plugin add link:<folder>`。

开启变更保护后，你批准过的插件会继续运行已批准的文件，无论之后谁编辑它的文件夹。agent 或其他任何人的编辑，都会在 Changes 中显示为等待你审阅的更改，只有在你批准之后才会加载。保护默认是关闭的，所以 agent 对已链接插件的编辑会像你的一样实时重新加载，并被记录为未经审阅而加载；开启保护之后，它们会等待你的批准。

<a id="run-it-while-you-work-on-it"></a>

## 在你开发它时运行它

```text
delorun start
delorun plugin dev ./my-plugin
```

`delorun plugin dev <folder>` 把该文件夹链接到你的 profile，或重用它之前建立的链接，然后让 Delorun 一直加载该文件夹的当前代码，直到你按 Ctrl+C：

- 当该文件夹下的某个文件发生变化时，正在运行的 Delorun 会替换插件的代码而无需重启。当插件的 `lib/client.js` 变化时，studio 会替换插件的浏览器部分，并保留你的 chat 和工作区；插件自己的屏幕状态则重新开始。
- 带有 `build` 脚本的包会在开始时构建一次，并在 `src/` 下每次变化之后再次构建。构建失败时会保留最后一次成功的构建，错误显示在你的终端上。
- 对插件的 `cordis.patch.yml` 或 `package.json` 的更改会在下次启动时加载：先 `delorun stop`，再 `delorun start`。
- Delorun 不必先运行：随时启动它，它就会加载该插件。
- 变更保护关闭时（默认），在它运行期间，该文件夹中的每次编辑都会实时加载，无论是你还是 agent 做的。保护开启时，编辑和其他任何编辑一样在 Changes 中等待你的审阅，只有在你应用之后才会加载；请先运行 `delorun changes work my-plugin`，才能实时加载你自己的编辑（见[开发插件](../customising/changing-your-harness.zh.md#working-on-a-plugin)）。

运行期间，`plugin dev` 会向你的 profile 的 `cordis.patch.yml` 添加一个带注释标记的条目：它设置上游的 `hmr` 行所监视的文件夹。按 Ctrl+C 会再次移除该条目；如果命令被终止，下一次 `plugin dev` 会重用它。如果你的 profile 补丁已经自己设置了 `hmr` 行，`plugin dev` 会拒绝，而不是替换你的设置。你停止时插件仍保持已安装；`delorun plugin remove my-plugin` 会将其卸载。`plugin dev` 运行期间，Delorun 的更新会等待。

<a id="check-its-versions"></a>

## 检查它的版本

```text
delorun plugin check ./my-plugin
```

插件在 `package.json` 中声明它能运行的版本：DeepSeek Harness 用 `engines.dsh`，Delorun 用 `engines.delorun`。Delorun 会拒绝安装或加载其范围不包含正在运行的版本的插件。`delorun plugin check` 读取文件夹的 `package.json` 而不运行其中的任何文件，说明每个范围接纳什么，并打印针对正在运行的 Delorun 的那个范围。当更新会因为插件的范围而关闭它时，请见[在有大量插件时更新 Delorun](updating-with-plugins.zh.md)。[Delorun 版本对插件的承诺](../../contracts/c22-delorun-plugin-interface.zh.md)说明了发布版本之间可能改变什么：在 Delorun 1.0 之前，`^0.y.0` 接纳一个次版本及其补丁版本。

<a id="install-it"></a>

## 安装它

`delorun plugin <pnpm arguments>` 像 DeepSeek Harness 的 `dsh plugin` 一样在你的 profile 中运行 pnpm，所以每条 pnpm 命令都可以使用：

| 来源 | 命令 |
| --- | --- |
| 这台电脑上的文件夹 | `delorun plugin add ./my-plugin`，或用 `link:<full path>` 让它保持与该文件夹链接 |
| npm | `delorun plugin add my-plugin` |
| git | `delorun plugin add github:you/my-plugin#<commit>` |
| 来自 `pnpm pack` 的 tarball | `delorun plugin add ./my-plugin-0.1.0.tgz` |

studio 的“插件”页面安装的是同样的来源；那里的文件夹需要完整路径，因为 studio 无法判断相对路径指的是哪个文件夹。`delorun plugin remove <name>` 卸载插件，“插件”页面则可以关闭和开启插件。请把 git 安装固定在某个 commit，这样以后的推送就无法改变你所运行的代码。

<a id="builds-pnpm-refuses"></a>

## pnpm 拒绝的构建

在你允许之前，pnpm 不会运行任何包的构建脚本。从 git 安装的插件在安装时通过它的 `prepare` 脚本自行构建，原生依赖通过它的安装脚本构建，所以它们第一次 `add` 会停止。`delorun plugin` 随后会对每个被拒绝的包询问是否允许该单个包的构建，你允许后它会再次运行命令。当 Delorun 的安装检查开启时，只会对检查已读取过的锁文件再次运行安装，与之不同的锁文件会被拒绝，并且 profile 会被放回原状。允许它就意味着该包的代码会在这台电脑上运行，现在和之后的每次安装都是如此，带着你的权限并且在沙箱之外。没有终端时，或要提前回答，请指明该包：

```text
delorun plugin add github:you/my-plugin#<commit> --allow-build my-plugin
```

`--allow-build` 接受一个包名，绝不接受通配符；更多包请重复使用它。你拒绝的构建在 profile 的 `pnpm-workspace.yaml` 中保持未决。`delorun plugin` 自己使用 `--allow-build`，所以通过它无法使用 pnpm 自己的同名标志。已经构建好 `lib/` 并发布到 npm 的插件不需要构建批准。

<a id="when-it-does-not-load"></a>

## 当它无法加载时

- `delorun doctor` 列出你已安装的插件、每个是否开启、它的版本范围是否接纳正在运行的 Delorun，以及在最近一次启动时没有启动的插件。
- `delorun logs` 显示 home 进程的日志，Delorun 在其中写下插件导入或启动失败的原因；`delorun logs --follow` 在你工作时持续打印。
- `delorun recover safe-mode` 让下一次启动略去你安装的每个插件，所以破坏 studio 的插件无法把你挡在外面；`delorun recover exit-safe-mode` 把它们带回来。

<a id="attach-a-debugger"></a>

## 连接调试器

```text
delorun start --foreground --inspect
```

`--inspect` 会在 Delorun 加载你的插件之前，在 `127.0.0.1:9229` 上打开 Node 的检查器，并打印它的地址；请连接 Chrome 的 `chrome://inspect` 或你的编辑器的 Node 调试器，然后在你的插件文件中设置断点。检查器监听期间，这台电脑上的任何进程（包括 agent 在沙箱内运行的命令）都可以在沙箱之外以 Delorun 的身份运行代码，所以 Delorun 会先要求你确认；没有终端时，`--inspect --yes` 即可确认。安全模式会拒绝它，而 `delorun status` 在检查器打开时会显示它。请只在调试期间使用它，之后不带 `--inspect` 启动。

<a id="overlays-for-one-start"></a>

## 仅用于一次启动的覆盖层

```text
delorun start --patch ./try.patch.yml
```

`--patch <file>`（即 [overlay](../../reference/glossary.zh.md#overlay)）（可重复）仅在这一次启动中把补丁文件应用到你的 profile 之上，与 DeepSeek Harness 中的 `dsh --patch` 相同，且不改变 profile。Delorun 自己的检查仍然适用：关闭 Delorun 某项保护的覆盖层会被拒绝，并指出文件名。安全模式会拒绝覆盖层，更新所启动的进程也不带它们运行。

<a id="forking-a-plugin-delorun-ships"></a>

## fork Delorun 自带的插件

Delorun 从自己的安装中加载它所发布的包，即 `@deepseek-ai/` 和 `@delorun/` 的那些。你的 profile 中同名的包永远不会被加载：加载的是已发布的那个，并且 `delorun doctor` 会对此发出警告。要改变已发布的插件，请把它复制成一个新名称的包，关闭已发布的行并插入你自己的，如[什么该在哪里定制](../customising/customise.zh.md#fork-a-shipped-plugin)所示。
