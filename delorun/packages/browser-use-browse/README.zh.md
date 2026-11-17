---
description: "通过 browse 把本人自己的浏览器作为 Delorun 的第二个浏览器，供维护者修改对话如何请求它、许可持续多久、哪些运行可以使用它，以及 browse 服务器继承哪些设置。"
kind: "package-bundle"
---

# @delorun/browser-use-browse

[English](README.md) | 中文

## 摘要

`@delorun/browser-use-browse` 让智能体在每个对话已有的隔离浏览器之外，使用本人自己的浏览器（包括其登录状态）。它把 [browse](https://github.com/anomalyco/browse)（`@opencode/browse`，MIT）作为 MCP 服务器，通过 [`@deepseek-ai/dsh-experimental-browser-use-runtime`](../../../packages/experimental/browser-use-runtime) 的会话 MCP 挂载运行，并且只在本人允许的对话中运行。智能体用 `use_my_browser` 工具请求；本人在审批卡片上允许，每个对话一次。该许可一直有效，直到本人关闭它或对话结束，重启后依然有效。本人没有发起的运行（例如计划运行）只有在对话同时持有“我不在时也允许”许可时才能使用它。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [界面](#surfaces)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **请求。** `use_my_browser` 接收一行任务说明，并弹出带 `real-browser` 授权标记的审批卡片（[文案](src/copy.ts)）。`@delorun/home-auth` 接受来自本机或已用验证码或 PIN 解锁的已批准设备的回答；仅已登录、或只处于审批宽限期的设备会被拒绝，卡片保持待答。允许会先记录 `approval/decided`，再记录 `real-browser/granted`，后者指明它回答的 `approval/asked`。其他回答都不记录许可，并告诉模型继续使用隔离浏览器。审批策略为 `never` 的对话会直接拒绝请求，不询问任何人。
- **许可。** `realBrowserGrant` 投影（[grant](src/grant.ts)）从对话自己的日志折叠 `real-browser/granted`、`real-browser/away` 和 `real-browser/ended`，因此恢复的对话保留许可，分叉的对话不继承父对话的许可。关闭许可会追加 `real-browser/ended`，同时结束“不在时”许可。
- **谁可以使用。** browse 调用只在由本人自己的提示（`user` 或 `retry`）发起的轮次中运行，或在“不在时”许可有效期间的任何轮次中运行；其他调用都会在服务器收到之前以一句话被拒绝（[guard](src/tool.ts)）。在本人没有发起的轮次中，以及在委派会话中（其提示来自委派它的智能体），`use_my_browser` 都不会弹出卡片。没有许可的运行（例如普通的 `delorun headless` 任务）保持使用隔离浏览器，并会被告知。
- **“不在时”许可。** `real-browser/away` 记录许可的结束时间，即给出后 `awayDays` 天，并带 `cause: 'person'`；再次给出会续期，关闭则记录 `until: null`。非本人发起的运行中的 browse 调用因许可到期被拒绝时，会以 `until: null` 和 `cause: 'expired'` 记录一次到期。
- **服务器。** browse 只为许可有效的对话启动；`use_my_browser` 在它启动后才回答，因此其工具在模型的下一步就已可用。browse 尚未提供工具时（例如本人还没有接受在本机启动它），回答会说明这一点，而不是列出这些工具。许可结束时它会停止。该配置行不占用浏览器使用槽位，因此隔离浏览器保持可用。程序是 `@opencode/browse` 为本机固定的平台二进制文件（[config](src/config.ts)）。其环境是 MCP 客户端清理过的环境：除 `inheritEnv` 列出的变量外，所有继承的 `OPENCODE_BROWSER_*` 变量都被清空，`inheritEnv` 永远不能列出的名称即使未设置也会被清空，并设置 `OPENCODE_BROWSER_AUTO_UPDATE=off` 和 `OPENCODE_BROWSER_UPDATE_CHECK=0`。`inheritEnv` 永远不能列出更新开关、放宽限制的变量（`ALLOW_ALL_COOKIES`、`ALLOW_ALL_STORAGE`、`ALLOW_FILE_URLS`、`ALLOW_FOREGROUND`、`FILE_ROOTS`）或工具形式开关（`TOOLS`）；列出它们的配置行无法加载。
- **服务。** 该配置行运行期间提供 `realBrowser`（各对话的许可），只在驱动旁边才有意义的插件（例如其技能）会注入它。

<a id="configuration"></a>

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `variant` | `auto` | 运行哪个平台的二进制文件；`auto` 选择本机的。在 Linux 上选 `windows-x64` 会通过 WSL 运行 Windows 二进制文件。 |
| `command` | 未设置 | 替代该二进制文件的绝对路径程序，例如测试用的替身服务器。 |
| `args` | `["mcp"]` | 程序的参数。 |
| `inheritEnv` | `[]` | 可以传给服务器的本人 browse 变量名（不含 `OPENCODE_BROWSER_` 前缀）。 |
| `toolCallTimeoutMs` | 未设置 | browse 工具每次调用的超时。 |
| `awayDays` | 7 | “不在时”许可持续的天数，1 到 30。 |

二进制文件缺失、或本机没有 browse 构建的配置行无法加载，并会指明对应的平台。browse 包会安装 `@opencode/browse` 及其平台包；本包不依赖它们。

<a id="surfaces"></a>

## 界面

- **审批卡片。** `real-browser` 卡片以中英文显示智能体的任务及其能访问的内容。
- **路由。** `POST /api/delorunRealBrowser.state` 和 `.end` 可由任何已批准的设备读取和结束对话的许可；`.away` 打开或关闭“不在时”许可，需要已用验证码或 PIN 解锁的设备，审批宽限期不算（[routes](src/routes.ts)，[messages](src/wire.ts)）。家庭无法确定来源的请求会在读取正文之前以 `LOOPBACK_REQUIRED` 拒绝。

<a id="known-limitations"></a>

## 已知限制

- 一旦允许，智能体就会以本人的登录状态在其浏览器中操作；许可限制的是哪些对话和轮次可以使用它，而不是哪些网站。
- 环境规则只适用于 Delorun 启动的 browse 服务器。本人已在运行的 browse 中继保留其自己的设置。

<a id="tests"></a>

## 测试

[`tests/grant.spec.ts`](tests/grant.spec.ts) 通过真实的智能体循环、会话日志和审批服务驱动 `use_my_browser` 和守卫：允许会记录指明其请求的许可，“暂不”不记录许可且 browse 调用被拒绝，无人可答的运行和计划运行会以一句话被拒绝，委派会话不会弹出卡片，已获许可对话中的计划运行只在“不在时”许可有效期间被接纳且到期只记录一次，关闭许可会同时结束两者，许可在从日志重启后依然有效。[`tests/plugin.spec.ts`](tests/plugin.spec.ts) 用替身 browse 服务器运行整个配置行：没有许可就不启动服务器，允许后在下一步之前只为该对话启动，两个对话以相同方式启动它，没有工具的 browse 会如实报告，关闭许可会停止它。[`tests/routes.spec.ts`](tests/routes.spec.ts) 覆盖每个路由的访问级别，包括锁定设备和处于宽限期的设备打开“不在时”许可被拒绝；[`tests/config.spec.ts`](tests/config.spec.ts) 覆盖二进制文件的解析和环境的拒绝规则。回答守卫（包括危险模式）在 `delorun/packages/home-auth/tests/authenticator.spec.ts` 中覆盖。
