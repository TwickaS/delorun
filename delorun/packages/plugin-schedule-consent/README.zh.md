---
description: "Delorun 计划任务开关背后的同意服务，供维护者修改计划任务批准如何说明其将创建的效果，以及每次到期投递如何对照该任务批准时所用的权限预设进行审查。"
kind: "package-bundle"
---

# @delorun/plugin-schedule-consent

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/plugin-schedule-consent` 提供 `scheduleConsent` 服务，它是 Schedule consent seam（[`packages/schedule`](../../../packages/schedule)）的 Service Provider：[`tool-schedule`](../../../packages/schedule/tool-schedule) 把服务的命名并入每个 `schedule_create` 与 `schedule_edit` 批准询问，Schedule 投递运行时在每次到期投递唤醒其 Session 之前向该服务询问。命名会说明该调用激活或保留的重复规则、投递到达的 chat 以及该 chat 运行的权限预设。审查只在目标 chat 仍运行该任务批准时所用的权限预设时放行；其他任何读取都以说明性的原因拒绝，运行时随之暂停被拒绝的任务，使之后的任何一次到期都不再重试，拒绝以类型化的 `schedule/consent-refused` 错误呈现。seam 是可选的：上游的 Schedule 以 `ctx.get('scheduleConsent')` 机会式地读取它，因此插件不在——或 `enabled` 关闭（schema 的默认值）时——批准与投递与上游完全一致。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **命名。** `nameEffect` 把一次已批准调用的 [`ScheduleEffect`](../../../packages/schedule/schedule/src/types.ts) 写成一句话：任务的标题、它所发送指令的开头、重复规则、投递到达的 chat（有标题时用标题，否则是第一次投递时打开的新 chat 以及它打开所在的目录），以及该 chat 运行所用的权限预设。运行时交来的每条文字事实都限定了长度且不含控制字符，而编辑会写明任务编辑之后的样子，所以只编辑指令时，写出的是新的指令。这段文字并入批准的原因，因此询问会说明将要开始运行什么；没有重复规则的效果不命名任何内容。
- **基线。** 已批准的询问所命名的预设成为任务的投递基线，即使 chat 在本人作答之前发生了移动也是如此，因此投递是对照本人所看到的内容来衡量的。
- **投递审查。** `reviewDelivery` 比较任务创建时捕获的预设与目标 chat 当前运行的预设，两者都由运行时读取并交给服务。预设相同则投递。批准之后 chat 一旦移动（包括变宽，也包括变窄）就以 `the target chat moved from the "<creation>" permission preset to "<current>" after the task was approved` 拒绝，因为批准时所命名的是投递将运行的预设，其他任何读取都未获批准。
- **未命名与不可读的预设。** 在没有组合预设服务时创建的任务不存储预设；一旦其 chat 运行某个具名预设，投递就以 `the target chat runs the "<current>" permission preset, which the task's approval did not name` 拒绝。当预设再也读不到时，投递以 `the target chat's permission preset cannot be read to compare with the "<creation>" preset the task was approved under` 拒绝，因此投递从不在未经核实的情况下运行。
- **暂停与分组。** 运行时在投递之前暂停被拒绝的任务，使之后的任何一次到期都不再重试，并逐个成员审查到期的分组，使一个被拒绝的成员单独暂停，其余成员仍保持一条消息。重复任务的每一次到期都会被审查。原因通过类型化的 `schedule/consent-refused` 错误与日志到达模型。
- **投递所打开的 chat。** `presetFor` 命名新 chat 开始时使用的预设：当挂载了 `@delorun/plugin-permission-defaults` 时，取自 `permissionDefaults.defaultPreset(cwd)` 读到的所属 Workspace 的预设，该插件会把这个预设播种到每个新 chat 中。询问命名该预设，任务把它存为基线，而打开该 chat 的投递在 chat 存在之前就按它审查，所以被拒绝的投递不会创建 chat。没有该服务或没有目录时，以部署默认值代替。chat 打开且加入其 Workspace 之后，运行时会再次读取预设，并在它与已审查的预设不同时再审查一次，对每一种目标都是如此；此时被拒绝的 chat 保留其预留，所以再次批准任务会复用它。
- **排队的提醒。** 早先的投递留下的排队提醒（例如 Host 重启之后）会在恢复唤醒它之前再次被审查。拒绝，或同意服务已经拒绝过的任务，会把该提醒从收件箱中撤回，使任何轮次都读不到它，并暂停该任务。
- **默认拒绝。** 运行时只在声明的 `allow` 裁决下投递；无法识别的裁决或没有原因的拒绝，以固定的原因拒绝。抛出错误的审查不投递任何内容，并让任务保持待命，等待下一次驱动；手动运行把它报告为类型化的 `schedule/consent-failed` 错误。
- **自己的一次读取。** 服务不持有状态，也不注入任何服务：它比较交给它的两个预设，命名交给它的效果，并为新 chat 的 Workspace 预设读取可选的 `permissionDefaults` 服务。会话中途挂载或释放它，只改变其后的批准与投递。

<a id="configuration"></a>

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | false | 挂载同意服务。Delorun 的 `scheduled_task_consent` 开关就是这个字段：以 `enabled: true` 挂载本插件的组合获得命名与审查，其他任何组合都保持上游的行为。 |

<a id="known-limitations"></a>

## 已知限制

- 审查比较的是预设的名称，而不是范围：一个未改变其允许内容、只改了名称的预设会拒绝，直到任务再次获得批准；不同部署中范围相同的两个名称也互不相关。
- 服务不为预设排定宽窄，因此移动到更窄的预设同样拒绝；只要批准时所用的预设不能被证明就是投递将运行的预设，审查就偏向拒绝。
- 插件不修改已存储的任务；解除一次拒绝是本人对该任务随后的编辑或重建，而服务以当时的预设再次审查每次投递。
- 为未在运行的 chat 创建的任务不存储基线，因为不恢复该 chat 就无法读取它的预设，所以它的第一次投递会拒绝，直到本人在该 chat 运行期间批准一次编辑。
- 创建时没有指定目录的新 chat 在 Host 自己的目录中打开，服务并不知道该目录；它先按部署默认值审查，然后再按它实际获得的预设审查一次。
- 主 chat 自己的守卫会在每次日程管理调用之前询问并独自决定，所以这些询问写的是守卫的文字，而不是这里的命名，并且在那里批准的编辑不会重新批准已被拒绝的任务。

<a id="tests"></a>

## 测试

[`tests/consent.spec.ts`](tests/consent.spec.ts) 在没有组合的情况下覆盖预设矩阵：预设相同则投递；移动到更宽预设的 chat 以其原因拒绝；更窄、未命名与不可读的读取各自以其原因拒绝；任务与 chat 都没有预设时投递；命名会写明标题、指令、重复规则、按标题给出的 chat 或新 chat 的目录，以及预设；为在某个目录中打开的 chat 读取 Workspace 预设；挂载后的服务提供全部三项，而被禁用的挂载不提供任何内容；配置 schema 把 `enabled` 默认为 false。运行时一侧的接缝由上游 schedule 包的 `consent.spec.ts` 文件覆盖。

<a id="when-the-service-fails"></a>

## 服务失败时

同意服务在 `enabled` 开启期间启动失败时，该行保持激活，并挂载一个拒绝每次定时投递的服务。拒绝信息会指名行 `delorun-schedule-consent` 和失败原因，并提示重启 Delorun、查看日志或以安全模式启动；被拒绝的任务会暂停，需要恢复。`enabled` 关闭时不挂载任何内容。

替身服务只在该行加载且其服务失败时挂载。插件从未加载的行，或其 `inject` 从未解析的行，会在 Host 运行期间让该接缝缺失；对这些情形，`delorun start` 的启动检查是唯一的保障。
