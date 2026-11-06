---
description: "Delo 约定索引：每份约定页面、其类型包，以及消费它的代码。"
---

# Delo 约定

[English](README.md) | 中文

## 摘要

约定是供工作包按原样使用的规格：代码所消费的类型、线上格式、限额、错误与安全要求，以及证明这些要求的拒绝测试。每份约定页面都有一个安全章节，陈述其要求及对应的拒绝测试；页面的声明有局限时，还附有「本约定不能证明的内容」小节。约定 C12（遥测）不属于首个发布版本，因此没有页面涵盖它。

## 约定

| 编号 | 约定 | 类型包 | 消费方 |
| --- | --- | --- | --- |
| C1 | [C1 Home 布局与运行时仓库](c01-home-layout.zh.md) | [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.zh.md) | `delorun` 命令、`delo/packages/integrity`、安装脚本与 npm 启动器、`delo/packages/runtime-store`、`delo/packages/home-process`、`delo/packages/supervisor`、`delo/packages/home-auth`；上游的沙箱方言 |
| C2 | [C2 发布 manifest 与签名](c02-release-manifest.zh.md) | [`@delo/contract-release-manifest`](../../packages/contract-release-manifest/README.zh.md) | `delo/apps/release`、`delo/apps/install` 与 `delo/apps/npm-launcher`、`delo/packages/runtime-store`、桌面更新器、`delo/packages/integrity`、Docker 监管器的镜像检查、插件索引的密钥 |
| C3 | [C3 更新报告](c03-update-report.zh.md) | [`@delo/contract-update-report`](../../packages/contract-update-report/README.zh.md) | `delo/packages/update`、上游的 profile 与插件管理器恢复、`delo/packages/profile-safety`、studio 的更新界面与桌面更新器 |
| C4 | [约定 C4：准入与监听器](c04-admission.zh.md) | [`@delo/contract-admission`](../../packages/contract-admission/README.zh.md) | 上游的客户端连接与 Web 服务器、Trusted Types 策略、`delo/packages/home-auth`、`delo/packages/reach` |
| C5 | [约定 C5：设备批准](c05-device-approval.zh.md) | [`@delo/contract-device-approval`](../../packages/contract-device-approval/README.zh.md) | `delo/packages/home-auth`、`delo/packages/certificates`、`delo/packages/plugin-reach-ui`、桌面应用对另一个 home 的连接 |
| C6 | [约定 C6：中继协议](c06-relay-protocol.zh.md) | [`@delo/contract-relay-protocol`](../../packages/contract-relay-protocol/README.zh.md) | `delo/apps/relay`、`delo/packages/reach`、`delo/packages/certificates` |
| C7 | [约定 C7：远程访问提供方](c07-reach-providers.zh.md) | [`@delo/contract-reach-providers`](../../packages/contract-reach-providers/README.zh.md) | `delo/packages/reach`、`delo/packages/certificates`、`delo/packages/plugin-reach-ui`、`delo/packages/home-auth` |
| C8 | [约定 C8：归档格式 v1 与回收站](c08-archive-and-trash.zh.md) | [`@delo/contract-archive-and-trash`](../../packages/contract-archive-and-trash/README.zh.md) | `delo/packages/archive`、`delo/packages/trash`、studio 的回收站界面、`delorun import` |
| C9 | [C9 运行时与监管器接口](c09-runtime-supervisor.zh.md) | [`@delo/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.zh.md) | `delo/packages/supervisor`、`delo/packages/runtime-docker`、studio 的工作区插件、`delo/apps/release`、`delo/packages/integrity`；上游的沙箱与 PTC 包 |
| C10 | [约定 C10：host 限定键](c10-host-qualified-keys.zh.md) | [`@delo/contract-host-qualified-keys`](../../packages/contract-host-qualified-keys/README.zh.md) | 上游的客户端 store 与 UI 包、`delo/packages/trash`、`delo/packages/plugin-workspaces` |
| C11 | [约定 C11：setup 回答](c11-setup-answers.zh.md) | [`@delo/contract-setup-answers`](../../packages/contract-setup-answers/README.zh.md) | `delo/apps/cli` 的 setup、`delo/packages/bundle-local`、`delo/packages/plugin-onboarding` |
| C13 | [C13 插件索引文件与撤销列表](c13-catalogue-revocation.zh.md) | [`@delo/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.zh.md) | `Delo-Run/delo-plugins`、`delo/packages/catalogue`、Discover 的配置与 studio 插件、`delorun verify`、更新报告 |
| C14 | [约定 C14：OpenID Connect 与通行密钥](c14-oidc-passkeys.zh.md) | [`@delo/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.zh.md) | `delo/packages/home-auth`、`delo/apps/cli` 中的 setup、`delo/packages/plugin-reach-ui` |
| C15 | [约定 C15：验证检查与报告](c15-verification-checks.zh.md) | [`@delo/contract-verification-checks`](../../packages/contract-verification-checks/README.zh.md) | `delo/packages/integrity`、`delo/apps/cli`（`delorun verify` 与 `delorun status`）、studio 的验证面板 |
| C16 | [约定 C16：对等组合](c16-parity-composition.zh.md) | [`@delo/contract-parity-composition`](../../packages/contract-parity-composition/README.zh.md) | `delo/apps/tools`（回放通道、静态扫描、开关扫描）、注册开关的各包、`delo/apps/cli` 的 doctor、上游的 snapshot 配置 |
| C17 | [C17 插件版本要求](c17-plugin-versions.zh.md) | [`@delo/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md) | 上游的 app-boot 插件兼容性、`delo/apps/cli` 的版本输出、更新报告、插件索引的 corpus |
| C18 | [C18 发布日志与见证者](c18-release-log.zh.md) | [`@delo/contract-release-log`](../../packages/contract-release-log/README.zh.md) | `delo/apps/release`、`delo/apps/install` 与 `delo/apps/npm-launcher`、CLI 启动器与 home 进程、桌面更新器、`delorun verify` |
| C19 | [C19 Home 进程与更新握手](c19-home-process.zh.md) | [`@delo/contract-home-process`](../../packages/contract-home-process/README.zh.md) | `delo/packages/home-process`、`delo/apps/cli`、`delo/packages/runtime-store`、`delo/packages/logs`、Host 的更新插件、更新报告界面 |
| C20 | [C20 运行日志](c20-operational-logs.zh.md) | [`@delo/contract-operational-logs`](../../packages/contract-operational-logs/README.zh.md) | `delo/packages/logs`、`delo/apps/cli`（`delorun logs` 与清除）、`delo/packages/home-process`、`delo/packages/supervisor`、`delo/apps/relay`、上游桌面 Host 的日志 |

## 约定的变更

约定与消费它的代码在同一次变更中修改，其类型包也在同一个拉取请求中变更。每页的兼容性小节陈述变更可能造成的影响：若某次变更移动、重命名或改变外部接口的含义，则它属于破坏性变更，需要在 `delo/docs/upgrade-guide/` 下提供升级指南。
