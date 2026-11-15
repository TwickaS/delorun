---
description: "Delorun 的安全扩展点设计：插件可以在哪里添加检查、警告、必需的确认或拒绝，以及由注册表强制执行的规则：添加只能让 Delorun 更严格，绝不能让它更宽松。"
---

# 安全扩展点

[English](security-extension-points.md) | 中文

## 摘要

Delorun 的安全可以在不编辑其核心的情况下增长：插件可以在审阅更改、批准设备、Delorun 启动或 Delorun 更新的地方添加检查。添加只能让 Delorun 更严格，绝不能让它更宽松。每个扩展点的注册表先运行 Delorun 的内置检查，并合并每个结果，使任何拒绝都会拒绝，任何必需的确认都是必需的，并且没有任何注册可以移除、替换、排到内置检查之前或覆盖内置检查。这使[安全基本原则](../security/fundamentals.md)无论插件添加了什么都保持成立。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

## 今天已有的内容

没有任何扩展点让插件向审阅更改、批准设备、启动或更新添加检查。`delorun verify` 所报告的验证检查，是 `@delorun/contract-verification-checks` 中的固定列表，插件不会扩展它。

## 规则

### 扩展点

1. 有四个扩展点：[Changes](changes.zh.md) 中的**审阅更改**、**批准设备**（见[远程访问](reach.zh.md)）、profile 的**启动**，以及**更新**到某个发布版本（见[更新与回退](update-and-rollback.zh.md)）。
2. 每个扩展点给已注册的检查一个只读的描述，说明它的对象：带有文件、差异和风险摘要的更改；带有标签、平台和时间的设备请求；即将启动的 profile；或更新报告。

### 注册者可以添加什么

3. 已注册的检查以一个结果作答：**通过**；**警告**，即人在对象旁边看到的一句话；**必需的确认**，即在动作继续之前人必须确认的一条具名声明；或**拒绝**，附带人看到的原因。
4. 检查不能更改它的对象、不能批准任何东西、不能代替人作答，也不能跳过后面的检查。

### 单调规则

5. 注册只能让 Delorun 更严格，绝不能移除、替换、排到内置检查之前或覆盖内置检查。
6. 注册表先运行内置检查，然后按注册顺序运行已注册的检查，并合并每个结果：任何拒绝都会拒绝，任何必需的确认都是必需的，每个警告都会显示。合并后的结果绝不比单独的内置结果更宽松。
7. 抛出异常或在扩展点的期限内没有作答的已注册检查，算作指出其插件的拒绝。安全模式在没有第三方插件、因而没有它们的检查的情况下启动，所以损坏的检查无法把人挡在外面。

### 谁可以注册

8. 只有其内容已通过 [Changes](changes.zh.md) 批准的插件才可以注册。待处理的更改不能添加、改变或移除检查，而移除插件（这会移除它的检查）本身就是人批准的一项更改。
9. 注册是其插件的一个效果：它在插件被卸载时结束，注册表列出每个注册及其插件，所以 `delorun doctor` 和 studio 可以显示每个插件添加了什么。

### 这条规则如何被强制执行和测试

10. 注册表是在这些扩展点添加检查的唯一方式，而合并是一个纯函数，它分别接收内置结果和已注册的结果。每个扩展点的拒绝测试，把内置的拒绝、确认和通过的每种组合，与每种类型的已注册结果一一运行，并且只要有任何组合比单独的内置结果更宽松，就会失败。

### 这些扩展点使什么成为可能

以下是这些扩展点使之成为可能的示例。Delorun 不包含其中任何一项（见[路线图](../guide/roadmap.zh.md)）。

- 在电脑上设置的 PIN，home 在动作之前将其作为必需的确认来索取。让远程会话用 PIN 授予完全访问，同时也会改变一项基本原则，这需要[基本原则页面](../security/fundamentals.md#changing-a-fundamental)所描述的决定。
- 插件签名：对其插件没有被此人信任的密钥签名的更改予以拒绝。
- 组织的策略：对其策略指名的更改、设备和更新予以拒绝并设置必需的确认。
- 隔离的插件进程：在启动时拒绝没有被配置为在自己的进程中运行的插件。

## 本设计不防护什么

- **注册的插件。**注册的插件和任何插件一样，以 harness 的权限运行。注册表防止它的检查削弱另一项检查；它并不阻止该插件自己的代码造成损害。
- **扩展点之外的代码。**插件可以通过上游的其他 seam，在不是扩展点的地方行事；这些扩展点只管辖上述四项决定。
- **安全模式。**按设计，安全模式下的启动在没有第三方检查的情况下运行。

## 拒绝测试

- `a registered pass does not turn a built-in refusal into an approval`
- `a registered check runs after every built-in check`
- `any registered refusal refuses the action`
- `any registered confirmation is required before the action goes on`
- `a registered check that throws or times out refuses and names its plugin`
- `a plugin with a pending change cannot register a check`
- `a registered check receives no way to change its subject`

## 实现状态

本设计的任何部分都尚未构建。
