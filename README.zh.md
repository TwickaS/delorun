# Delorun

[English](README.md) | 中文

<!-- GIF SLOT: the recorded demo goes here, in the first screen, below the title and above the headline. -->

**你的 harness（智能体框架），没有限制。**

任何东西都能改，任何改动都能撤销。

Delorun 是一个按你自己的工作方式塑造的 agent harness（智能体框架）：主题、侧边栏、插件、模式，乃至 Delorun 本身，都可以改。每一处改动都能一步撤销，所以你可以放心尝试。每次更新前，Delorun 都会保存一份你的配置副本，一条命令就能回到更新之前。

撤销的范围是 harness 和你的聊天：你的配置、插件和设置都会恢复原样。它不会撤销 agent 对工作区文件所做的改动，因为工作区检查点尚未构建。

运行 `npx delorun` 即可。构建于 DeepSeek Harness 之上；能运行它的插件，也能导入你的聊天。

Delorun 是独立项目。它不是 DeepSeek 的产品，DeepSeek 也没有为它背书。

## 状态

Delorun 目前是预览版，使用预览密钥签名，尚未经过外部安全评审。[使用 Delorun 时你要信任什么](delorun/docs/guide/trust.zh.md)说明了这意味着什么，以及何时会改变。Delorun 可在 Linux 上运行，也可通过 WSL2 在 Windows 上运行。

## Delorun 提供什么

`delorun` 命令提供：

- `setup`、`start`、`stop` 和 `status`：创建 Delorun home，运行 home 进程并查看其状态。
- `doctor`：检查 home 的权限、Docker、DeepSeek API 密钥的格式，以及 studio 的端口是否空闲。
- `logs`：查找、阅读、跟随、清空和修剪 Delorun 的运行日志。
- `update`：显示最新版本的报告，并在你确认后应用；`recover`：查看更新后配置的状态，并回滚、恢复某个版本或进入安全模式。
- `verify`：对照已签名的清单和发布日志，检查已安装的版本。
- `trash`、`export` 和 `import`：恢复或彻底清除已删除的聊天和工作区，并以签名归档的形式在不同 home 之间移动聊天或工作区。
- `open`：在浏览器中打开 studio，或打印一个只能登录一次的链接。
- `reach` 和 `devices`：通过你自己的 tailnet 在手机上访问 studio，并批准、解锁和移除可以登录的设备，包括 PIN 模式。
- `changes`：查看、应用、放弃或撤销等待你处理的变更。
- `workspace`：在本机上，让聊天在某个文件夹中使用完全访问权限，或让外部 agent 在那里启动。
- `mcp`：在本机上，回答聊天想要启动的工具服务器所提出的问题。
- `import-home`：在预览之后，把 DeepSeek Harness 的 home（`~/.dsh`）复制到你的 Delorun home。
- `plugin` 和 `headless`。`delorun plugin` 在你的 Delorun home 内运行 DeepSeek Harness 的插件安装器，不带 Delorun 的保护。`delorun headless` 与 `dsh headless` 一样回答一个任务后退出，但带有 Delorun 的沙箱保护、守卫和授权确认，并关闭 DeepSeek 的会话日志上传；需要询问你的授权确认会直接拒绝，因为此时没有人可以回答。

“撤销一切”指的是 harness 和你的聊天，不包括 agent 在工作区里改动过的文件，所以请用 git 管理那些文件。

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。[用户指南](delorun/docs/guide/README.zh.md)说明如何安装和使用 Delorun。[路线图](delorun/docs/guide/roadmap.zh.md)说明正在构建什么、接下来是什么，以及更远的方向。

<a id="run"></a>

## 运行

安装 Node.js 24.9 或更高版本，然后运行 `npx delorun`。[安装与首次运行](delorun/docs/guide/install.md)带你完成设置和第一次聊天。

<a id="run-from-source"></a>

### 从源码运行

要运行源码检出，请安装 Node.js 24.9 或更高版本以及 pnpm，然后运行：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 准备构建产物，`pnpm dsh web` 用这些产物启动 Web UI。`pnpm dsh --profile headless "task"` 运行单个任务，需要 `DEEPSEEK_API_KEY`。当在源码检出中运行 `delorun start` 提示缺少构建文件时，运行 `pnpm run build:artifacts` 和 `pnpm --filter @delorun/bundle-local run build`，然后再次启动。要运行覆盖你所做变更的检查，使用 `pnpm check`。[AGENTS.md](AGENTS.md) 列出了所有命令。

## 已知问题与常见问题

[已知问题](delorun/docs/guide/known-issues.zh.md)页面列出你可能遇到的毛边，每条都写明会发生什么以及该怎么做。[问答](delorun/docs/guide/questions.zh.md)页面回答那些难回答的问题：为什么 Delorun 构建在 DeepSeek Harness 之上，为什么它不是装在原版上的一组插件，大部分代码由 agent 编写意味着什么，它有多安全，以及代价是什么。

## Delorun 是怎样构建的

维护者在这个项目上投入了很长时间，大部分实现由 agent 完成。每一项变更都要通过评审、移除保护就会失败的拒绝测试，以及回放真实会话的录制检查。[贡献指南](CONTRIBUTING.zh.md)说明了变更须遵守的规则，无论是人还是 agent 编写的。

## 面向团队

Delorun 可以通过定制插件、模式和集成，按团队的工作方式来塑造。请写信到 support@delorun.com。

## 与原版的兼容性

Delorun 保持上游的插件 API、profile 和 Session 格式与原版兼容。变更进入主干之前，有一项检查会在关闭所有对模型可见的 Delorun 变更的情况下回放上游录制的场景；它不会加载原版用户自己的插件或 profile。Delorun 的界面和默认设置可能与原版不同。[Delorun 与原版 DeepSeek Harness](delorun/docs/guide/delorun-vs-stock.zh.md)列出了所有差异。

## 与上游的关系

Delorun 构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）之上，后者是 [DeepSeek AI](https://deepseek.com) 的开源 agent harness。Delorun 自己的代码位于 `delorun/` 下，对上游文件的改动会连同它所服务的功能一起记录。[差异索引](delorun/docs/reference/divergence/README.zh.md)说明了这份记录。原版文档请见[上游仓库](https://github.com/deepseek-ai/deepseek-harness)及其[文档站点](https://deepseek-harness.github.io/deepseek-harness/)。

## 文档

- [用户指南](delorun/docs/guide/README.zh.md)：安装、首次运行、日常使用、更新、自定义、安全与故障排查
- [Delorun 文档](delorun/docs/README.zh.md)
- [架构](delorun/docs/architecture/README.zh.md)
- [安全与威胁模型](delorun/docs/security/README.zh.md)
- [安全基本原则](delorun/docs/security/fundamentals.md)
- [路线图](delorun/docs/guide/roadmap.zh.md)
- [尚未构建的功能设计](delorun/docs/design/README.md)

## 社区

- [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 说明如何报告 bug、提出功能建议和提交 pull request。
- [SECURITY.md](SECURITY.md) 说明如何私下报告漏洞。
- [GOVERNANCE.md](GOVERNANCE.md) 说明谁决定合并什么。
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 适用于所有项目空间。
- 请在 GitHub Discussions 中提问，或写信到 support@delorun.com。

## 许可证

[MIT](LICENSE)。上游的版权声明保留在许可证文件中，Delorun 自己的改动的版权归 Delo Run 及贡献者所有。第三方依赖及其许可证披露在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
