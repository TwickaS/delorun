---
description: "Delo 计划任务开关背后的同意服务，供维护者修改计划任务批准如何说明其将创建的效果，以及每次到期投递如何对照该任务批准时所用的权限预设进行审查。"
kind: "package-bundle"
---

# @delorun/plugin-schedule-consent

[English](README.md) | 中文

## 摘要

`@delorun/plugin-schedule-consent` 提供 `scheduleConsent` 服务，它是 Schedule consent seam（[`packages/schedule`](../../../packages/schedule)）的 Service Provider：[`tool-schedule`](../../../packages/schedule/tool-schedule) 把服务的命名并入每个 `schedule_create` 与 `schedule_edit` 批准询问，Schedule 投递运行时在每次到期投递唤醒其 Session 之前向该服务询问。命名会说明该调用激活或保留的重复规则、投递到达的对话以及该对话运行的权限预设。审查只在目标对话仍运行该任务批准时所用的权限预设时放行；其他任何读取都以说明性的原因拒绝，运行时随之暂停被拒绝的任务，使之后的任何一次到期都不再重试，拒绝以类型化的 `schedule/consent-refused` 错误呈现。seam 是可选的：上游的 Schedule 以 `ctx.get('scheduleConsent')` 机会式地读取它，因此插件不在——或 `enabled` 关闭（schema 的默认值）时——批准与投递与上游完全一致。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **命名。** `nameEffect` 把一次已批准调用的 [`ScheduleEffect`](../../../packages/schedule/schedule/src/types.ts) 写成一句话：重复规则是什么、投递到达哪个对话——调用所在的对话，或第一次投递时才打开的新对话——以及该对话运行的权限预设。这段文字并入批准的原因，因此询问会说明将要开始运行什么；没有重复规则的效果不命名任何内容。
- **投递审查。** `reviewDelivery` 比较任务创建时捕获的预设与目标对话当前运行的预设，两者都由运行时读取并交给服务。预设相同则投递。批准之后对话一旦移动——包括变宽，也包括变窄——就以 `the target chat moved from the "<creation>" permission preset to "<current>" after the task was approved` 拒绝，因为批准时所命名的是投递将运行的预设，其他任何读取都未获批准。
- **未命名与不可读的预设。** 在没有预设服务时创建的任务不存储预设；一旦其对话运行某个具名预设，投递就以 `the target chat runs the "<current>" permission preset, which the task's approval did not name` 拒绝。当预设再也读不到时，投递以 `the target chat's permission preset cannot be read to compare with the "<creation>" preset the task was approved under` 拒绝，因此投递从不在未经核实的情况下运行。
- **暂停与分组。** 运行时在投递之前暂停被拒绝的任务，使之后的任何一次到期都不再重试，并逐个成员审查到期的分组，使一个被拒绝的成员单独暂停，其余成员仍保持一条消息。原因通过类型化的 `schedule/consent-refused` 错误与日志到达模型。
- **自身不做任何读取。** 服务不持有状态，也不注入任何服务：它比较交给它的两个预设，命名交给它的效果。会话中途挂载或释放它，只改变其后的批准与投递。

<a id="configuration"></a>

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | false | 挂载同意服务。Delo 的 `scheduled_task_consent` 开关就是这个字段：以 `enabled: true` 挂载本插件的组合获得命名与审查，其他任何组合都保持上游的行为。 |

<a id="known-limitations"></a>

## 已知限制

- 审查比较的是预设的名称，而不是范围：一个未改变其允许内容、只改了名称的预设会拒绝，直到任务再次获得批准；不同部署中范围相同的两个名称也互不相关。
- 服务不为预设排定宽窄，因此移动到更窄的预设同样拒绝；只要批准时所用的预设不能被证明就是投递将运行的预设，审查就偏向拒绝。
- 插件不修改已存储的任务；解除一次拒绝是本人对该任务随后的编辑或重建，而服务以当时的两个预设再次审查每次投递。

<a id="tests"></a>

## 测试

[`tests/consent.spec.ts`](tests/consent.spec.ts) 在没有组合的情况下覆盖预设矩阵：预设相同则投递；移动到更宽预设的对话以其原因拒绝；更窄、未命名与不可读的读取各自以其原因拒绝；任务与对话都没有预设时投递；命名对既有对话与新对话各自说明重复规则、对话与预设；配置 schema 把 `enabled` 默认为 false。
