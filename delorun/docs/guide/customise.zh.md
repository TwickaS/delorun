---
description: "在哪里定制 Delorun：设置、profile 补丁、agent 预设、你自己的插件、已发布插件的改名 fork，以及直接编辑 harness 本身，并说明每一种在每次更新时会让你付出什么。"
---

# 什么该在哪里定制

[English](customise.md) | 中文

本页描述 Delorun 目前的工作方式。

## 摘要

你可以在六个层级上重塑 Delorun，从 studio 中的一项设置，到 harness 自己的源代码。每个层级都比前一个触及得更远，在每次更新时也要付出更多，所以请选择第一个能实现你的更改的层级。没有哪一个会编辑 Delorun 已签名的发布版本，不过最后一个会运行你改动过的文件，而更新会在关闭任何东西之前，先显示它会关闭什么（[更新绝不会拿走你的工作](trust.zh.md)）。

## 目录

- [各个层级](#the-levels)
- [更改插件的设置](#change-a-plugins-settings)
- [给 studio 起你自己的名称和图标](#give-the-studio-your-own-name-and-icon)
- [制作 agent 预设](#make-an-agent-preset)
- [编写插件](#write-a-plugin)
- [fork 已发布的插件](#fork-a-shipped-plugin)
- [编辑 harness 本身](#edit-the-harness-itself)

## 各个层级

| 层级 | 它改变什么 | 它存放在哪里 | 更新时它让你付出什么 |
| --- | --- | --- | --- |
| 设置 | 插件的设置页面提供什么 | studio 的“设置”和“插件”页面 | 没有：设置会被保留 |
| profile 补丁 | 任何插件的配置；关闭某个插件 | 你的 profile 的 `cordis.patch.yml` | 新版本改名或移除的键；补丁会重述插件完整的 `config` |
| agent 预设 | agent 开始时拥有的工具、指令、skill 和模型 | 在 Creator 模式中制作、保存在你的 profile 中的预设 | 很少：预设指名插件，所以只有被移除或改名的插件才会让它出问题 |
| 你自己的插件 | 新的工具、studio 组成部分、服务、插件行 | 安装到你的 profile 中的包 | 它的 `engines` 范围：排除新发布版本的范围会让插件被关闭，直到你放宽范围并测试 |
| 已发布插件的 fork | DeepSeek Harness 的某个插件的行为 | 安装到你的 profile 中的改名副本，同时关闭已发布的行 | 你必须自己合并该插件的每一项上游更改，而它的接口在 1.0 之前的任何次版本中都可能变化 |
| harness 本身 | 任何东西，包括插件循环 | 由 `delorun changes edit-harness` 制作的、你自己的已安装发布版本程序文件的副本 | 每项更改都属于已安装的版本，更新报告会说明它如何被保留；你运行的是 Delorun 没有签名的代码 |

## 更改插件的设置

大多数插件在 studio 中都有一个设置页面，保存到你的 profile 中。对于页面没有提供的内容，你的 profile 的 `cordis.patch.yml`（位于 `~/.delorun/profiles/<profile>/` 下）可以按 id 给任何插件的行打补丁。补丁会替换该行完整的 `config`，所以请重述插件需要的每个键，`disabled: true` 则关闭一行。DeepSeek Harness 的[加载顺序](../../../docs/user/develop/basic/publish.zh.md#the-loading-order)说明了哪一层优先。如果补丁关闭了 Delorun 的某项保护，Delorun 会拒绝启动，并指出该文件。

## 给 studio 起你自己的名称和图标

“设置”→“Branding”改变 studio 呈现自己的方式。你可以隐藏空白 chat 界面和侧边栏标题中的图标和名称，把 “Delorun” 替换为你自己的名称，把标志替换为你从工作区图标集中选取的图标或最大 256 KB 的 PNG、JPEG 或 WebP 图片，并把 “What are we working on?” 替换为预设语句之一或你自己的。名称也会显示在浏览器标签页中，上传的图片会成为标签页的图标。名称是 1 到 40 个字符的纯文本，问候语是 1 到 80 个字符。

其他设备打开的登录和配对页面显示相同的名称和图标，或者在你隐藏标志时两者都不显示。这些页面在任何人登录之前就会出现，所以任何能够访问你的地址的人都能看到它们。选取的图标只出现在 studio 中；登录页面仍保留 Delorun 的标志。如果保存的名称、问候语或图片无法使用，studio 会显示 Delorun 的默认值，Branding 部分会这样说明。Branding 设置保存在你的 profile 中，所以你已批准的手机在持有解锁时可以更改它们。

## 制作 agent 预设

agent 预设决定 agent 开始时拥有哪些工具、指令、skill 和模型。可以在 studio 中通过在 Creator 模式下开始一个 chat 来制作，也可以用 `delorun plugin new <name> --kind preset` 把它打包成插件（见[为 Delorun 编写插件](plugins.zh.md)）。预设会指名它所用的插件，所以只有当其中一个被移除或改名时，更新才会影响它。

## 编写插件

插件在不改变 Delorun 所发布的任何内容的情况下增加行为：一个工具、studio 的一部分、其他插件使用的服务，或针对现有插件的一组设置 bundle。[为 Delorun 编写插件](plugins.zh.md)从 `delorun plugin new` 讲到一个已安装的插件。你也可以从“设置”→“插件”→“Create a plugin”开始，或在 chat 中让 agent 在你的工作区中制作一个（[在 studio 中](plugins.zh.md#from-the-studio)，[在 chat 中](plugins.zh.md#in-a-chat)）；两种方式中，开启它都是你在电脑上要做的一步。变更保护默认是关闭的，所以对你所链接的插件的编辑（包括 agent 的编辑）会实时重新加载，并被记录为未经审阅而加载；开启保护之后，它们会等待你的批准（见[修改你的 harness](changing-your-harness.zh.md)）。请声明 `engines.dsh` 和 `engines.delorun`：更新时，Delorun 会关闭其范围不包含新发布版本的插件，并在这样做之前告诉你，而 [Delorun 版本对插件的承诺](../contracts/c22-delorun-plugin-interface.zh.md)说明了每个发布版本可能改变什么。

## fork 已发布的插件

Delorun 从自己的安装中加载它所发布的包，所以你的 profile 中与已发布的包同名的包永远不会被加载。要改变 DeepSeek Harness 的某个插件的行为：

1. 把它的包复制到一个文件夹中，并在 `package.json` 中给它起一个新名称，例如把 `@deepseek-ai/dsh-tool-todo` 改为 `my-todo`，并带有它自己的 `engines` 范围和一个 `dsh.bundle` 声明。
2. 在副本的 `cordis.patch.yml` 中，关闭已发布的行，并以新的 id 插入你自己的行，配置与已发布的行相同：

   ```yaml
   - id: tool-todo
     disabled: true
   - insert:
       - id: my-todo
         name: my-todo
         config:
           allowParallelInProgress: true
   ```

3. 用 `delorun plugin add ./my-todo` 安装副本，或用 `delorun plugin dev ./my-todo` 开发它。

Delorun 自己的插件，以及它的保护所需要的行（例如沙箱），不能用这种方式替换：只要其中任何一个被关闭，Delorun 就会拒绝启动，并指出关闭它的文件。请通过它们的设置来更改，或者[编辑 harness](#edit-the-harness-itself)。fork 会保留你复制时插件代码的样子，所以请查看该插件每个发布版本的 changelog，并自己把它的更改带过来。

## 编辑 harness 本身

对插件循环、组合或 Delorun 的保护的更改，要放在你自己的已安装 Delorun 程序文件的副本中：`delorun changes edit-harness` 制作该副本并打印它的文件夹，你在那里保存的每个文件都是对 Delorun 本身的一项更改，`delorun changes list` 会显示它，`delorun changes undo` 会撤销它。已安装的发布版本从不被编辑，但 Delorun 的签名和发布日志不再描述你所运行的代码，`delorun verify` 会列出你改动过的文件。[修改你的 harness](https://docs.delorun.com/guide/changing-your-harness)涵盖保护（它在更改加载之前等待你的审阅）以及 studio 的 Changes 部分。凡是插件能实现的更改，都应优先使用插件。
