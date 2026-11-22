# 安全

[English](SAFETY.md) | 中文

> 本页是英文页面的模型翻译。如有出入，以英文页面为准。

## 预览状态

Delorun 是预览版软件。它的发布使用预览密钥签名，尚未经过外部安全评审，并且只有一个人维护。不要把它视为安全或可用于生产环境的软件。[使用 Delorun 时你要信任什么](delorun/docs/guide/safety-and-updates/trust.zh.md)说明了其中每一项的含义。

Delorun 可以执行模型编写的代码与命令、加载第三方插件，并访问你向其开放的网络、进程、凭据和文件。模型的错误、缺陷、错误的设置、恶意输入或不可信插件可能损坏你的计算机、修改或删除文件、泄露数据或凭据，或造成其他损害。

## 沙箱做不到什么

沙箱、审批提示与权限设置可以降低风险，但不保证隔离，也不能保证防止损害，任何限制都无法保护你已允许 Delorun 访问的资源。[Delorun 保护什么](delorun/docs/guide/safety-and-updates/safety.zh.md)列出了每一项保护和每一项限制。

运行你不信任的工作时，不要把 Delorun 当作唯一的保护。

## 负责任地使用

- 仅授予 Delorun 工作所需的最小访问权限。
- 优先使用虚拟机、容器或专门预留的计算机。
- 备份 Delorun 可以访问的文件，并用 git 管理你的项目：Delorun 不会撤销 agent 对你的文件所做的改动。
- 除非你接受相关风险，否则不要向其提供凭据或数据。
- 在允许运行前检查插件、设置和拟执行的命令。

## 不提供保证，不承担责任

请自行承担使用 Delorun 的风险。本软件依照 [MIT License](LICENSE) 提供，不附带任何保证。在适用法律允许的最大范围内，对于使用本项目造成的计算机损坏、数据丢失或泄露、文件丢失或其他损害，作者和版权持有人不承担责任。

To report a security problem, follow [SECURITY.md](SECURITY.md). For anything else, use the contact details in [SUPPORT.md](SUPPORT.md).

本说明以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安全说明为基础，Delorun 构建于其上。
