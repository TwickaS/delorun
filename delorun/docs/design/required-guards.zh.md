---
description: "必需防护措施的设计：在上游的防护查找上加一个标记，使 Delorun 组合出来之后又因重新加载、插件失败或缺少它的组合而丢失的防护措施，拒绝被防护的动作而不是让它在无防护的情况下运行；以及为什么 headless 运行会挂载需要询问人的防护措施。"
---

# 必需的防护措施

[English](required-guards.md) | 中文

## 摘要

Delorun 的防护措施通过可选的服务查找到达上游：上游用 `ctx.get` 请求该防护，而防护缺失就意味着上游自己的行为，即允许该动作。对于不带 Delorun 的防护措施发布的上游来说，这是正确的默认值，对 Delorun 来说则是错误的：被重新加载、启动失败或在某个组合中缺失的防护措施，会让它的动作在它回来之前处于无防护状态，而且没有任何东西拒绝。本设计增加一个标记，即消费方所在行的 config 中的必需防护名称列表，这样，防护被列为必需而又缺失的消费方，会以指出该防护的类型化错误拒绝该动作。它还在没有人回答的 `delorun headless` 中挂载需要询问人的防护措施，使每一个都在那里拒绝，而不是缺失。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- 上游通过可选查找读取每个防护，防护缺失就允许该动作：`packages/web/web-fetch-http/src/index.ts` 中的 `fetchGuard`、`packages/fs/tool-fs/src/consent.ts` 中的 `writeConsent`、`packages/mcp/mcp-client/src/index.ts` 中的 `mcpAddConsent`、`packages/schedule/schedule/src/runtime.ts` 和 `packages/schedule/tool-schedule/src/index.ts` 中的 `scheduleConsent`，以及 `packages/interaction/permission-presets/src/index.ts` 中的 `sandboxModeGuard`。
- Delorun 在 `@delorun/bundle-local` 的行中，由它自己的插件提供每个防护。[C19](../contracts/c19-home-process.zh.md) 的 Host 不变式在启动之前和启动之后各检查一次，Delorun bundle 插入的每一行在 CLI profile 中都是活动的。启动之后不再检查，所以被重新加载停止、或在重启时失败的行，会使它的防护在 Host 运行期间缺失。
- `delorun headless` 启动 home 的 `headless` profile，即上游的 `headless` 模板，其中链接了 `@delorun/bundle-headless`。它具有 C1 的沙箱覆盖层、安全模式以及该 bundle 的防护行，C19 的 Host 不变式在启动之前和之后都持有这些行。在受防护的消费方中，它挂载了 `web-fetch-http`、`tool-fs` 和 `permission-presets`；它不挂载 MCP 客户端和计划运行时，该 bundle 的 MCP 和计划同意是用来防护此人自己的补丁所添加的那一个。它的批准服务没有应答者，所以询问会以 `unavailable` 解析，询问的防护会拒绝。

<a id="the-rules"></a>

## 规则

### 标记

1. 上游每个使用防护的消费方，在其行的 config 中接受一个可选的 `requiredGuards` 列表，列出它所查询的防护服务名称。默认是空列表，保持上游的行为。
2. 消费方通过一个上游辅助函数 `guardOf(ctx, name, requiredGuards)` 读取防护：当防护已注册时，它返回该防护；当防护缺失且未被列出时，它返回 `undefined`；当防护缺失且被列出时，它抛出指出该防护和消费方的 `GuardMissingError`。消费方让这个错误像防护自己的拒绝一样拒绝该动作：获取失败，写入被拒绝，MCP 服务器不启动，计划的投递不运行，模式切换不被追加。
3. 辅助函数在每个动作时读取防护，就像消费方今天所做的那样，所以在重新加载之后回来的防护，无需重启就防护下一个动作。
4. Delorun 的 bundle 在它组合的每个消费行上设置 `requiredGuards`，组合不变式会检查每个列表是否指出了 Delorun 为该行提供的每个防护。

### Headless

5. `delorun headless` 在沙箱覆盖层之前添加一个 Delorun 覆盖层，它挂载获取防护、指令写入同意和权限默认值，开关与 CLI profile 相同，并为该 profile 所挂载的消费方设置 `requiredGuards`。headless 不变式要求这些行是活动的。
6. 在 headless 下，询问人的防护会拒绝，因为没有组合应答者：模型对指令文件的写入，以及对没有已记录授权的工作区选择完全访问，都会以防护的原因被拒绝。人在 studio 中授予过完全访问的工作区保持其完全访问，因为该授权记录在 home 中。
7. 更新门只在 headless 中挂载，用来扣住任务的第一步，直到后置启动检查通过（`holdUntilChecked`）：headless 运行不是 home 进程，没有更新或停止在等待它的 chat，并且当它被列为数据使用者时，更新或回退会拒绝（[C1](../contracts/c01-home-layout.zh.md)）。

### 更改涉及的文件

- 上游：一个新的零依赖包 `packages/util/required-guard`，带有 `guardOf` 和 `GuardMissingError`，其中 `guardOf` 把查找 `ctx.get` 作为函数接收，以及上述六个消费方位置，每个都增加 `requiredGuards` config 字段及其 README 条目。
- Delorun：`@delorun/bundle-local` 的行设置 `requiredGuards`；它们旁边有一个 headless 覆盖层；`delorun/apps/cli/src/compose.ts` 增加 headless 行和 `requiredGuards` 检查；C16 和 C19 陈述这些规则。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **存在但有错误的防护。**该标记只拒绝缺失的防护；已注册但允许了本应拒绝的内容的防护，不在本设计的范围之内。
- **有自己生命周期缺口的 Delorun 行。**`plugin-main-chat` 在 `agent/created` 时限制主 chat 的工具，所以在该行停止期间创建的 chat 会保留它们；回收站、工作区和 chat 状态插件让排队的工作在其行被释放之后仍然运行。每一个都需要在它的插件中单独修复。
- **安全模式。**安全模式保留 Delorun 的防护行，所以它不会丢弃该标记的防护；它确实丢弃第三方的行，而该标记不涵盖这些。

<a id="denial-tests"></a>

## 拒绝测试

- `a required fetch guard that is absent refuses the fetch and names the guard`
- `a required write consent that is absent refuses the write`
- `a required MCP consent that is absent leaves the stdio server stopped`
- `a required schedule consent that is absent refuses the delivery`
- `a required sandbox mode guard that is absent refuses the switch and appends no mode event`
- `an unlisted absent guard keeps upstream's behaviour`
- `a guard that returns after a reload guards the next action`
- `a headless model write to an instruction file is refused`
- `a headless full-access selection without a recorded grant is refused`

<a id="implementation-status"></a>

## 实现状态

headless 的规则 5 到 7 已作为 `@delorun/bundle-headless` 构建，这是一个链接到 `headless` profile 的 bundle，而不是覆盖层；`requiredGuards` 标记以及在它之前的规则尚未构建。
