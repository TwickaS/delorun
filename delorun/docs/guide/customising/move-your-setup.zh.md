---
description: "用 delorun setup export 与 delorun setup import 把你的插件、模型选择与设置迁移到另一台电脑或另一个 profile：文件包含与绝不包含什么，导入如何展示签名者和它将替换的内容，你自己编写的插件代码如何被扣留等待审阅，之后要添加的密钥，以及如何撤销一次导入。"
---

# 把你的 setup 迁移到另一台电脑

[English](move-your-setup.md) | 中文

## 摘要

`delorun setup export` 把你添加的插件、模型选择与设置写成一个已签名的文件。在另一台电脑或另一个 [profile](../../reference/glossary.zh.md#profile) 上运行 `delorun setup import`，会在向你展示全部更改并征得同意之后，用文件中的 setup 替换该 profile 的 setup。文件从不包含密钥、chat、已配对的设备或你对 setup 的回答。两台电脑上都需要 Delorun，导入的那台还需要终端。

## 目录

- [写出文件](#write-the-file)
- [文件包含什么](#what-the-file-holds)
- [导入文件](#import-the-file)
- [导入之后](#after-the-import)
- [退回](#go-back)
- [在 studio 中](#in-the-studio)
- [给想深入了解的人](#for-the-technically-curious)

<a id="write-the-file"></a>

## 写出文件

```sh
delorun setup export --out my-setup.delorun
```

Delorun 会打印放进了什么、签名该文件的这台电脑的密钥，以及它略去了什么及原因。它从不替换已存在的文件。加上 `--profile <name>` 可导出另一个 profile。

你可以选择放进什么：

| 选项 | 作用 |
| --- | --- |
| `--no-settings` | 略去模型选择之外的设置。文件会记录它不含设置。 |
| `--plugin <name>`（可重复） | 只放进你指名的插件，因此你分享的文件只含一个插件，而不含你的其他内容。 |
| `--no-local-code` | 只写出你自己编写的插件的名称，不带代码。导入者自行复制它们。 |
| `--note "…"` | 导入者会在签名者旁边读到的备注。 |

你的模型提供方、模型与自定义端点地址总会放进去；studio 的“导出 setup”对话框用开关和清单提供同样的选择（**包含设置**、**包含我自己编写的插件的代码**、插件，以及备注）。

<a id="what-the-file-holds"></a>

## 文件包含什么

| 文件中有 | 文件中没有 |
| --- | --- |
| 你添加的每个插件，按其确切版本与包的校验和记录 | Delorun 自己的包，每台电脑都有 |
| 你自己编写的插件：你已批准的副本的文件 | 你编写但尚未批准的插件，以及其中的符号链接 |
| 你的默认模型与提供方，以及模型设置，包括自定义端点地址 | 任何密钥、令牌或密码。若设置行中有这些，导出会停止并指出该设置 |
| studio 的外观，以及文件中各插件的设置 | 沙箱、权限、网络、设备与 reach 设置：它们保护的是某一台电脑 |
| | chat、附件、你已配对的设备、你给出的豁免，以及你对 setup 的回答 |

用 `!!js` 读取环境变量的设置会被留下，因为表达式会运行代码。

<a id="import-the-file"></a>

## 导入文件

```sh
delorun setup import my-setup.delorun
```

加上 `--dry-run`，无需终端即可查看文件将做什么，且不更改任何内容。加上 `--no-settings`，你的设置保持原样（只替换你的模型选择）；加上 `--remove-others`，还会移除文件未列出的插件。导入随后：

1. 在写入任何内容之前完整检查文件。签名之后被改动过、或含有插件文件夹之外路径的文件会被拒绝。
2. 说明谁签了名。来自你自己电脑的文件显示为由这台电脑的密钥签名。来自另一台电脑的文件、或未签名的文件，显示为**未验证（Unverified signer）**并带密钥指纹。请把指纹与另一台电脑上导出时打印的指纹比对。你仍可导入；接下来你读到的内容就是保障。
3. 列出它将做的事，并说明它替换哪些部分：它添加或移动的插件、它移除的插件（仅在使用 `--remove-others` 时）、它设置、更改或恢复默认的设置、发送者的备注、文件只写了名称而没有代码的插件、你的模型设置将向其发送请求的端点、它保持原样的插件，以及它不应用的内容。
4. 询问 `Replace the setup of the profile default with this one? [y/N]`。你的密钥、chat、设备、豁免与 setup 的回答从不被触碰。
5. 若某个模型设置把请求发往不是提供方自己的地址，则对每个这样的地址单独询问：`Requests and your custom key will go to models.example.com. Allow that? [y/N]`。回答否，则不会有任何更改。

默认情况下，导入替换你的模型选择和其他设置，并且只动文件所列的插件，因此只含一个插件的文件无法清空你的 setup。文件未携带的模型或插件设置恢复默认，但你保留的插件的设置除外：它们保持原样。模型提供方只能指名它自己的密钥变量，因此文件无法让 Delorun 把你电脑上的另一个变量发给服务器。使用 `--remove-others` 时，文件未列出的插件也会被移除。沙箱、权限、网络这类保护电脑的设置从不被携带，保持原样。

导入像 `delorun plugin` 一样安装与移除插件，检查也相同。在另一台电脑上编写的插件被写入你 home 下的一个文件夹，并从该处链接。它的代码**不会被导入批准**。[保护](../../reference/glossary.zh.md#changes-protection)开启时，它在 `delorun changes list` 中等待，直到你审阅（[修改你的 harness](changing-your-harness.zh.md)）。保护关闭时，它在下一次启动时无需审阅即加载，与你从文件夹链接的任何插件一样；若想先读，请先用 `delorun changes protection on` 开启保护。

<a id="after-the-import"></a>

## 导入之后

Delorun 会指出需要密钥的模型提供方。用 `delorun setup key` 添加，或在 studio 的 Settings → Agent → Models 中添加。setup 从不携带密钥。

<a id="go-back"></a>

## 退回

在更改任何内容之前，导入会把你的 setup 保存为版本 **Before importing a setup**。一次恢复即可全部还原：

```sh
delorun recover restore <version>
```

该命令会打印版本号。你也可以在 studio 的 Settings → Setup versions 中选择它（[修改你的 harness](changing-your-harness.zh.md)）。退回还会丢弃导入为你在别处编写的插件所扣留的代码审阅。

<details>
<summary>边缘情况</summary>

- 若导入中途停止，例如某个包无法安装，之前的步骤保持已完成，保存的版本可恢复你原来的 setup。提示信息会指出是哪一步。
- 若某个包到达时的校验和与文件所写的不同，或校验和无法检查，导入就在那包加载之前停止，其中任何内容都不会被应用。
- 若文件列出了 Delorun 自己的包，导入会拒绝它。
- 若你编写的插件需要它在自己文件夹里安装的包，请在导入之后在那里安装。链接不被携带。
- 若在没有终端的情况下运行导入，它会拒绝；`--dry-run` 无需终端。

</details>

<a id="in-the-studio"></a>

## 在 studio 中

Settings → Setup versions 有 **Export setup** 与 **Import setup** 两个按钮；它们只在运行 Delorun 的那台电脑上的 studio 中可用，手机上不可用。“Export setup”会打开一个对话框，含**包含设置**与**包含我自己编写的插件的代码**两个开关、你的插件清单和备注。“Import setup”先显示更改清单，带有**包含设置**开关（仅当文件含设置时出现）和**移除不在此归档中的插件**（默认关闭），只有在你点击**替换我的 setup**时才替换你的 setup。当某个模型设置把请求发往不是提供方自己的地址时，清单会写出 `Requests and your <provider> key will go to <address>`，在你打开**我确认这些端点**之前，**替换我的 setup**保持不可用。更改任何开关都会重新规划，而你应用的计划始终是你所看到的那个。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

该文件是[合约 C8 的归档格式](../../contracts/c08-archive-and-trash.zh.md#the-setup-archive)，`content` 为 `setup`，以这台电脑的 home 密钥签名，因此同一个读取器检查每一种归档。导入通过与 agent 的 `plugin_manager` 所记录的相同的插件请求来应用插件（[`@delorun/changes`](../../../packages/changes/README.zh.md)），所以手动安装遇到的任何检查都不会被跳过。
