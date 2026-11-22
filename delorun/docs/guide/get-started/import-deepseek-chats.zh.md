---
description: "把你在 chat.deepseek.com 上的 chat 带入 Delorun：从网站导出它们，开启 chat 导入插件，上传文件，哪些会变成 chat，哪些不会。"
---

# 导入你的 DeepSeek 网站 chat

[English](import-deepseek-chats.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页介绍如何把 DeepSeek 网站（chat.deepseek.com）上的 chat 带入 Delorun，在这里阅读并继续对话。如果你在开始使用 Delorun 之前用过该网站，它会有帮助。你需要先让 Delorun 运行起来，并有一个用来存放这些 chat 的[工作区](../../reference/glossary.zh.md#workspace)。导入是一个可选插件，在你开启之前是关闭的。导入本身只读取你上传的文件，不发送任何东西到任何地方。继续一个导入的 chat 则不同：下一次请求会把整段导入的历史发送给你的模型提供方，并像任何长 chat 一样消耗 token。

## 目录

- [从网站导出你的 chat](#export-your-chats-from-the-website)
- [开启导入](#turn-the-import-on)
- [上传文件](#upload-the-file)
- [会导入什么](#what-is-imported)
- [不会导入什么](#what-is-not-imported)
- [接下来](#next)

<a id="export-your-chats-from-the-website"></a>

## 从网站导出你的 chat

在 chat.deepseek.com 上，打开账户设置并导出你的全部数据。网站会准备一个名称类似 `deepseek_data-2026-01-01.zip` 的文件并提供下载。请保持该文件原样，不要解压。网站的菜单名称可能会变，所以请在账户设置中寻找数据导出。

<a id="turn-the-import-on"></a>

## 开启导入

在侧边栏打开“插件”，选择“更多”，然后在“实验性插件”下开启 **DeepSeek chat import**。新手引导的“推荐插件”步骤提供同样的开关。开启之后，**New session** 右侧会出现一个带上传箭头的按钮。关闭它会移除该按钮；已导入的 chat 会保留。

<a id="upload-the-file"></a>

## 上传文件

1. 点击 **New session** 旁边的上传箭头按钮。
2. 在 **Export file** 下，选择 `deepseek_data-*.zip` 文件。
3. 在 **Workspace** 下，保留显示的那个、选择另一个，或选择 **Add workspace…** 添加一个文件夹。
4. 点击 **Import**。进度条会先显示上传，然后显示 chat 的写入。关闭对话框会取消导入。

对话框最后会说明导入了多少个 chat、导入到哪个工作区、有多少较旧的被略去，以及有多少无法导入。只有你本人在运行 Delorun 的那台电脑上才能导入；你批准过的手机不能。

你应该会在该工作区的 chat 列表中看到导入的 chat。

<a id="what-is-imported"></a>

## 会导入什么

- **chat。**网站上的每段对话变成一个 chat，保留其原有的标题和时间。导入的 chat 会显示你的问题、模型的推理、搜索和读取网页的卡片，以及回答。
- **最新的对话。**按最后更新时间排列的最新 1000 段对话。再次导入同一个文件会添加第二份副本。
- **你所在的分支。**当你在网站上编辑过问题或重新生成过回答时，只有你最终停留的那个分支会被带入。
- 你的问题中的**图片**，前提是导出文件中包含该图片文件。

<details>
<summary>边界情况</summary>

- 如果某段对话失败，那么它会被跳过，由下一段较旧的对话顶替它的位置。
- 如果某个问题的回复被网站的内容过滤器撤回，那么这个问题和回复都不会出现。
- 如果某条回复没有完成，那么它的 chat 以一行说明原因的错误结束，问题则保留。
- 如果文件大于 512 MiB，那么导入会在写入任何内容之前拒绝它。
- 如果另一个导入正在运行，那么对话框会这样说明，并且不写入任何内容。
- 如果每个 chat 都导入失败，那么当问题出在整个文件上时，对话框会说明原因：它不是可读取的 ZIP 文件（请重新下载且不要解压）、缺少网站的导出索引或其格式版本不是本插件能读取的，或者其中没有任何对话。当文件可以读取而每个对话都失败时，对话框只给出无法导入的 chat 数量；`delorun logs home` 会指出每一个的缺陷，[报告未列出的问题](../help/troubleshooting.zh.md#report-a-problem-that-is-not-listed)说明如何报告。

</details>

<a id="what-is-not-imported"></a>

## 不会导入什么

- **你附加的其他文件。**图片以外的文件显示为带有名称和大小的卡片。该卡片无法打开，模型也看不到其内容。
- 一段对话的**其他分支**。
- 导出文件中的**设置、记忆和账户详情**。
- **比最新 1000 段更早的对话。**对话框会告诉你略去了多少段。

<a id="next"></a>

## 接下来

- 从 DeepSeek Harness 迁移 chat：[从 DeepSeek Harness 切换](switching.zh.md)。
- 开始 chat：[日常使用](../everyday-use/daily-use.zh.md)。
