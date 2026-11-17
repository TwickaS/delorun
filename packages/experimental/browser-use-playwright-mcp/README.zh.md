---
description: "通过 Playwright MCP 操作 Chromium，为每个活动 Session 保持独立浏览器状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

[English](README.md) | 中文

## 概述

通过 Playwright MCP 的上游工具检查网页并操作 Chromium。提供方在 Session 创建或恢复完成前初始化其 MCP 连接，并跨轮次保留连接。可以启动独立浏览器，也可以让一个 Session 接入已有浏览器，使用其现有标签页和登录状态。本包以实验状态发布，仅在显式挂载后启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在创建或恢复 Session 前，将以下条目挂载到已提供 Agent、工具、系统提示词和工作目录服务的 profile 组合中。加载或重新加载此提供方不会接管已经活动的 Session。`browser` 决定启动哪个浏览器：默认值 `auto` 在 Playwright 的 `chrome` 通道查找的位置装有 Google Chrome 时启动它，否则启动 Playwright 自己的 Chromium 版本；`chrome` 和 `chromium` 总是启动对应的那一个。Chrome 使用 Playwright 为本次启动创建的配置文件（`--isolated`）运行，从不使用用户自己的 Chrome 配置文件。只有 Chromium 版本与固定的 Playwright 版本绑定，因此本包更新后，仅在实际启动 Chromium 时才可能需要重新下载 Chromium：即 `chromium`，或没有安装 Chrome 的电脑上的 `auto`。使用 `executablePath` 选择其他 Chromium 安装；在 `auto` 下它保留 Chromium 的启动设置。提供方在加载时决定启动哪个浏览器，因此安装或移除 Chrome 要在 Harness 重启后才生效。开启 `browserAdditions` 时，固定的 Playwright 所需的 Chromium 版本未安装，或设置了 `chrome` 而 Chrome 未安装，浏览器工具调用会以一条简短消息失败，告诉模型停止尝试，并请用户完成 Browser 设置；关闭时，调用以 Playwright 自己的报告失败。

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: launch
    headless: true
```

使用 `mode: attach`，并在 `endpoint` 中设置 HTTP(S) 调试 URL 或 WS(S) 浏览器端点，即可操作已有浏览器。新的活动 Session 在初始化时占用附加连接，并持续保留直到卸载。如果连接已被占用，本次激活不使用该浏览器，但继续运行，后续轮次不会重试。连接释放后，新创建或恢复的激活可以获取它。其他 Session 的直接调用会失败。清理只断开连接，保留外部浏览器及其页面。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | 必填 | `launch` 或 `attach`，在本次提供方激活期间固定 |
| `headless` | `true` | 启动时不显示窗口 |
| `browser` | `auto` | `auto` 启动已安装的 Chrome，否则启动 Playwright 的 Chromium 版本；`chrome` 或 `chromium` 强制使用其一。仅用于 launch 模式 |
| `executablePath` | 上游发现 | 启动使用的 Chromium 可执行文件 |
| `endpoint` | attach 时必填 | 已有浏览器调试端点 |
| `toolCallTimeoutMs` | MCP 客户端默认值 | 单次调用超时，单位为毫秒 |
| `deniedTools` | `[]` | 除始终关闭的 `browser_run_code_unsafe` 之外，另外要关闭的服务器自有工具名称：从不提供给模型，被调用时拒绝 |
| `browserAdditions` | `false` | Delorun 的附加功能，由 Delorun 的 Browser 套件开启：浏览器未安装时简短的 Browser 设置消息。无论取值如何，关闭的工具、文件夹防护和 MCP root 都保持不变 |
| `serverDirectory` | `session` | MCP 服务器的运行位置：`session` 为每个 Session 的工作目录，`home` 为所有 Session 共用的 Harness 主目录中的一个文件夹（`browser-use/<服务器名称>`），因此它的命令和文件夹保持不变 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-browser-use-playwright-mcp)列出接受的字段。浏览器模式由 profile 或 preset 选择。子进程会清空继承的 `PLAYWRIGHT_MCP_*` 选项，避免其替换该配置。

为整个进程配置系统提示词的 `toolOrder` 时，将浏览器工具留在 `<unlisted-tools>` 中。显式列出浏览器工具名称可能导致未获得浏览器连接的 Session 无法组装提示词。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供方解析固定版本 npm 包的可执行入口，并使用当前 Node 启动。服务进程之前可能运行临时协议探测进程。[共享运行时](../browser-use-runtime/README.zh.md)负责等待 Agent 初始化、逐 Session 串行执行与清理；[MCP 客户端](../../mcp/mcp-client/README.zh.md)负责传输、发现和结果投影。

只要活动 Session 保持连接，浏览器状态就会跨轮次保留。MCP 服务器在经验证的 Session 当前工作目录中启动；Session 后续改变目录时，服务器保留启动目录。销毁会等待服务器关闭，再释放资源。重新加载后恢复 Session 会创建新的浏览器运行状态；已保存的对话历史不会还原 Cookie 或页面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器使用](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [浏览器使用服务](../../browser-use/browser-use/README.zh.md) — 提供方独占注册。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — 上游安装与浏览器行为。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具与截图

#### 模型可见内容

工具以 `mcp__playwright-mcp__<tool>` 命名，保留上游描述和 JSON schema。`browser_run_code_unsafe` 会在服务器进程中、页面之外、智能体沙箱之外运行模型编写的代码，始终关闭：MCP 客户端从不注册它，因此模型不会得到它，对它的调用也会被拒绝。任何配置都不能重新开启它。它是固定版本服务器中唯一在那里运行此类代码的工具；`deniedTools` 可关闭更多工具。文本与截图通过常规工具结果流程进入 Session 日志。服务器保存的文件，例如截图、下载和 PDF，会放进 Delorun 为每个对话在用户缓存目录中创建的输出文件夹（`$XDG_CACHE_HOME/delorun-browser-output`，macOS 上为 `~/Library/Caches/delorun-browser-output`，Windows 上为 `%LOCALAPPDATA%\delorun-browser-output`），仅所有者可访问，工具结果会说明每个文件的位置。该文件夹位于对话文件夹之外、`/tmp` 之外，也在受保护的 Delorun 主目录之外，因此沙箱对受限命令以只读方式挂载它：对话可以读取其中保存的文件，但不能写入、删除、重命名或替换该文件夹，也不能在其中放置链接。新对话的文件夹不会有 `.playwright-mcp`；对话中已有的那个保持原样，不再有任何内容写入。Playwright 的服务器按文本把工具的 `filename` 与 `paths` 同其文件夹比较，因此当 `filename` 或 `paths` 的真实位置（经由链接或其他方式）既不在对话文件夹也不在输出文件夹内时，提供方会在调用到达服务器之前拒绝它；模型会读到一句话，要求使用对话文件夹内的路径。每次调用之后，提供方会再检查一次：解析该调用的 `filename`，以及输出文件夹内指向这两个文件夹之外的每个链接所通向的文件夹；若其中有该调用刚创建的普通文件，就在不跟随任何链接的前提下将其删除，并把调用结果替换为拒绝信息，同时写一行日志。若对话在检查与服务器写入之间，在对话文件夹内放了链接，让要保存到对话文件夹内的文件经由该链接写出，调用之后的检查会发现并删除它，所以这种情况下它是拒绝而不是屏障。拥有完全访问权限的对话运行在沙箱之外，也可以替换输出文件夹；此时该防护是拒绝而不是屏障，与其他所有完全访问操作一样。截图需要附件存储及支持图片输入的模型路由；其他路由会收到 MCP 图片诊断。MCP 客户端还提供资源工具和注明服务器来源的指导。只有当前 Session 拥有连接后才显示浏览器指导；针对该服务器的资源请求执行相同的所有权检查。

#### Token 影响

工具目录、资源工具和服务器指导会增加工具定义与提示词文本。调用会向 Session 历史加入参数、文本和获准输入的图片。内联图片字节不进入模型可见历史。

#### KV Cache 影响

不变的工具目录会保留工具定义前缀。结果追加到历史；更换提供方或目录可能降低前缀复用率。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

本集成保留固定版本服务器的浏览器与工具限制。

- 仅支持 Chrome 与 Chromium；不可选择 Firefox 或 WebKit。
- 启动失败或取消会拒绝 Session 创建或恢复，并触发客户端清理。断开的客户端不会重试；修复原因后，创建新 Session，或卸载并恢复已有 Session。
- 连接独占仅在此提供方实例内有效。其他进程与浏览器用户仍可修改相同页面。
- 共享资源服务器目录可以显示继承的服务器名称，但不会授予对其他 Session 浏览器的访问权限。
- 取消不会撤销已发送给浏览器的导航、点击或其他操作。
- 工具 schema 跟随固定的实验依赖版本，不承诺 DSH 稳定性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
