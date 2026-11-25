---
description: "studio 的客户端门控如何得知页面位于 Delorun 桌面应用内本人的电脑上，供添加门控或修改桌面端所报告内容的维护者阅读。"
kind: "package-library"
---

# @delorun/desktop-home

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在 Web 上，studio 依据页面的主机名区分“在你的电脑上”和“在设备上”：回环主机名就是这台电脑。Delorun 桌面应用在 `dsh-app://app` 下提供它自带的 studio，因此主机名是 `app`，说明不了本人在哪里。桌面端的 preload 因此暴露 `globalThis.delorunDesktop`，一个只有一个键 `homeKind` 的冻结对象，而这个包把它转成客户端门控所需的答案。该包是一个 studio 库，从源码导出：它在浏览器中运行，没有依赖，也不导入 Cordis。

## 目录

- [答案](#the-answer)
- [它决定什么、不决定什么](#what-it-decides-and-what-it-does-not)
- [调用点](#call-sites)
- [测试](#tests)

## 答案

`atComputer(fallback)` 返回：

| `delorunDesktop.homeKind` | 答案 | 含义 |
| --- | --- | --- |
| `bundled` | `true` | 应用在这台电脑上运行的 home |
| `wsl` | `true` | 本人自己的 WSL 发行版中的 home；应用就是“这台电脑”（A579） |
| `remote` | `false` | 另一台机器上的 home；应用是一台设备 |
| 缺失、`null`、不是对象、任何其他值、读取时抛出异常，或除应用文档之外的任何页面 | `fallback` | 在桌面应用之外：调用方自己的判断，保持不变 |

该对象只在桌面端的应用文档上被读取：`location.protocol` 是 `dsh-app:` 且 `location.hostname` 是 `app`，这正是 preload 暴露它的条件。在任何其他页面上（包括 Web 页面），`delorunDesktop` 都被忽略，因此在那些页面上定义它的脚本，或通过元素的 `id` 或 `name` 使该元素成为全局变量的标记（DOM clobbering），都不会改变任何东西：该值必须恰好是这三个字符串之一。

每个调用方都传入它此前使用的判断：页面的主机名，或连接的 `isLoopback`。因此，缺失、未知或恶意的值，以及 Web 页面上的任何值，都不会改变 Web 的行为。`desktopHomeKind()` 在同样的规则下返回该类型本身，或 `undefined`。

## 它决定什么、不决定什么

只决定页面显示或隐藏什么。客户端门控显示一个仅限电脑的控件，或指向电脑；它不授予任何权限。home 的服务端检查仍是权威：没有到达电脑自己的监听器的请求会被拒绝（`403 LOOPBACK_REQUIRED`），无论页面显示或声称了什么，而 preload 的值是页面读取的标签，绝不是凭据。谎报自己 home 类型的页面会看到 home 随后拒绝的控件。

## 调用点

读取桌面端 home 类型的每一处，以及每一处读取它的原因：

| 调用点 | 它显示或隐藏什么 |
| --- | --- |
| [`plugin-onboarding/src/client/host-api.ts`](../plugin-onboarding/src/client/host-api.ts) 的 `pageAtComputer`，由 `readReach` 使用 | 引导的“远程访问”步骤是否适用：远程页面会跳过它 |
| [`plugin-onboarding/src/client/index.ts`](../plugin-onboarding/src/client/index.ts) 的 `deferredEntry.atComputer` | 侧栏的“完成设置”入口，它只在电脑上显示 |
| [`plugin-onboarding/src/client/index.ts`](../plugin-onboarding/src/client/index.ts) 的 `browserPage.services.remote` | “浏览器”设置页面上的下载与测试按钮，远程页面会隐藏它们 |
| [`bundle-local/src/client/at-computer.ts`](../bundle-local/src/client/at-computer.ts) 的 `pageAtComputer`，在 [`bundle-local/src/client/index.ts`](../bundle-local/src/client/index.ts) 的十处使用 | 页面的 Face ID 授权与通行期（`applyFaceGrant`）、PIN（`applyPin`）和解锁（`applyUnlock`）来源；智能体席位的远程访问（`provideAgentSeatReach`）；只有电脑上的页面才注册的配对通知，以及只有设备上的页面才设置的会话轮换重载；以及 PIN 模式、Face ID、设置命令和设置版本这几个分区。每一项都在电脑上显示其仅限电脑的控件，在设备上则指向电脑 |

新的门控若问“在电脑上吗？”，就使用这个包并被加入该表；没有任何一处自己读取 `location.hostname`。

上游的 `ConnectionHandle.isLoopback` 未被改动：它还驱动连接的离线处理和设置页面的主机信息，并且它仍是每个调用方作为 `fallback` 传入的 Web 答案。

## 测试

`pnpm exec vitest run --config delorun/vitest.config.ts delorun/packages/desktop-home` 覆盖每一种类型、缺失的情形、不是 preload 自身形态的值（字符串、`null`、数字、拼写错误、抛异常的 getter、多余的键）、冻结对象、在 `http:` 或 `https:` 页面上植入的值，以及由元素或表单输入造成的 DOM clobbering。`bundle-local/tests/client-gates-source.spec.ts` 与 `plugin-onboarding/tests/client-gates-source.spec.ts` 中的源码守卫会在客户端源码再次为回环名称读取 `isLoopback` 或主机名时失败。调用点自己的规范覆盖接线：[`bundle-local/tests/at-computer.spec.ts`](../bundle-local/tests/at-computer.spec.ts) 以及 [`plugin-onboarding/tests/guide.client.spec.tsx`](../plugin-onboarding/tests/guide.client.spec.tsx) 的 host-api 用例。
