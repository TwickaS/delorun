# @delo/plugin-instruction-consent

指令层同意（WP2.15，A101）： seams 背后的服务，防止模型在未经批准的情况下改写个人的指令层文件——技能、预设和工作区的 `AGENTS.md`。


[English](README.md) | 中文
## 提供什么

- `writeConsent` —— 写入工具在模型撰写的文件提交前咨询它。目标被归类为指令层文件的写入需要一次批准，批准文本说明这些指令会在该范围的每次未来对话中加载，并附上差异；拒绝则文件保持不变。
- `sandboxModeGuard` —— 模式变更钩子；挂载它是为了证明 seam 可用。Delo 的组成在 1.0 中不拒绝任何模式变更。

这些服务不理会权限预设：同意适用于每个预设，包括完全访问。个人在 studio 自己的编辑器中做的写入不会触发新的询问——seam 只看到模型撰写的写入。

## 配置

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `false` | Delo 的 C16 开关 `instruction_layer_consent`，在 parity 组成中关闭；开启时，同意门控指令层写入。 |

## 测试

`tests/consent.spec.ts` 覆盖分类（技能、预设、工作区的 `AGENTS.md`、无关路径）以及带差异备注的询问/拒绝流程。
