---
description: "你的 Delorun home：delorun 把你的数据保存在哪里，如何用 DELORUN_HOME 移动它，profile，为何 ~/.dsh 保持不动，以及如何修复其他用户可以读取的 home 或密钥文件。"
---

# 你的 Delorun home

[English](home.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页告诉你 Delorun 把你的数据保存在哪里、如何移动它、profile 如何运作，以及当 Delorun 因为其他用户可以读取某个文件而拒绝使用它时该怎么办。你不需要任何前置准备；`delorun` 首次运行时会创建这个文件夹（见[安装与首次运行](../get-started/install.zh.md)）。Delorun 把一切都放在一个文件夹里，即你的 [Delorun home](../../reference/glossary.zh.md#home)：`~/.delorun`。你的 chat、工作区、profile、密钥和 Delorun 自己的记录都保存在其中。`delorun` 首次运行时创建它，并把它设为只有你能读取。备份这个文件夹，就等于备份了 Delorun。

## 目录

- [home 的位置](#where-the-home-is)
- [首次运行](#the-first-run)
- [Profile](#profiles)
- [你的 DeepSeek Harness home](#your-deepseek-harness-home)
- [修复权限](#fixing-permissions)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="where-the-home-is"></a>

## home 的位置

想把 home 放到别处，请设置 `DELORUN_HOME`：

```sh
DELORUN_HOME=~/work/delorun delorun
```

路径必须是绝对路径，或以 `~` 开头。`delorun` 会拒绝你的用户主目录本身、文件系统根目录，以及 DeepSeek Harness 的 home `~/.dsh` 或其中的任何文件夹，因为这些位置都存放着 Delorun 不能与自己的数据混在一起的东西。`delorun status` 会打印正在使用的 home。

<a id="the-first-run"></a>

## 首次运行

在新的 home 上首次运行 `delorun` 会执行 setup（见[安装与首次运行](../get-started/install.zh.md)）。此后，`delorun` 会在后台启动 Delorun，并在浏览器中打开 studio；如果你在 setup 中选择了在终端中运行，则不会这样。`delorun status` 显示它是否在运行，`delorun stop` 会在正在运行的 chat 结束后停止它，使用 `delorun stop --now` 则立即停止。每个 profile 只运行一个 Delorun：第二次启动会告诉你它已经在运行。[日常使用](../everyday-use/daily-use.zh.md)列出了每一条命令。

<a id="profiles"></a>

## Profile

[Profile](../../reference/glossary.zh.md#profile) 是 Delorun 的一套设置：它的插件、插件的设置和它的 studio 端口。大多数人只需要 setup 创建的那一个，即 `default`。想使用另一个，请传入 `--profile <name>` 或设置 `DELORUN_PROFILE`：

```sh
delorun --profile work          # sets up the profile the first time, then starts it
delorun status --profile work   # other commands take --profile after their name
```

Profile 名称由 1 到 32 个小写字母、数字、`-` 或 `_` 组成，并以字母或数字开头。Delorun 会拒绝 `desktop`（留给桌面应用自己的 profile）和 `headless`（`delorun headless` 使用它）。所有 profile 共享你的 chat、工作区和密钥。

<a id="your-deepseek-harness-home"></a>

## 你的 DeepSeek Harness home

本节只在你以前用过 DeepSeek Harness（Delorun 所基于的程序）时才有意义。Delorun 从不更改或移动 `~/.dsh`，即 DeepSeek Harness 保存数据的文件夹。只有当你从中导入时才会读取它（见[从 DeepSeek Harness 切换](../get-started/switching.zh.md)）。如果你为 DeepSeek Harness 设置了 `DSH_HOME`，`delorun` 会忽略它并使用你的 Delorun home，`delorun status` 会告诉你这一点。

`delorun plugin` 的行为与 `dsh plugin` 相同，只是在你的 Delorun home 内运行；`delorun headless` 像 `dsh headless` 一样回答单个任务，但带有 Delorun 的沙箱保护和防护措施（见[日常使用](../everyday-use/daily-use.zh.md#the-plugin-and-headless-commands)）。

<a id="fixing-permissions"></a>

## 修复权限

在 Linux 上，你的 home 及其中 Delorun 的文件夹必须只有你能读取（模式 700），其中的密钥文件也一样（模式 600）。如果其他用户能够读取其中之一，Delorun 会拒绝使用它，并打印修复它的命令：

```text
Delorun stopped before using /home/you/.delorun/secrets/home-auth/home-key.pem.
Why: SECRET_FILE_MODE: /home/you/.delorun/secrets/home-auth/home-key.pem has mode 0640, which other users can read; it must be 0600
What you can do:
  Fix it with: chmod 600 /home/you/.delorun/secrets/home-auth/home-key.pem
```

运行打印出的 `chmod` 命令，然后再次运行 `delorun`。Delorun 从不替你更改这些权限，所以错误会保持可见。如果 home、文件夹或密钥文件是符号链接，或属于其他用户，也会被拒绝，并且不会给出修复命令：请把它移走，让 `delorun` 重新创建。

<details>
<summary>边界情况</summary>

- 如果 profile 名称含有大写字母、空格，首字符不是字母或数字，或超过 32 个字符，或者是 `desktop` 或 `headless`，那么 `delorun` 会拒绝它。
- 如果其他用户能读取你的 home 或某个密钥文件，那么 Delorun 会拒绝使用它，并打印修复它的 `chmod` 命令（见[修复权限](#fixing-permissions)）。
- 如果 home 中的某个文件或文件夹是符号链接或属于其他用户，那么 Delorun 会拒绝它，且不给出修复命令。请把它移走，让 `delorun` 重新创建。
- 如果两条命令同时修改 home，那么第二条会以 `another process … holds the home lock` 拒绝。请等待后再运行（见[启动与停止](../help/troubleshooting.zh.md#starting-and-stopping)）。

</details>

<details>
<summary>进一步了解</summary>

- 把工作用的设置与个人用的设置分开：`delorun --profile work`。各 profile 共享 chat、工作区和密钥，但各自保有自己的插件、设置和端口。
- 把整个 home 放到别处，例如更大的磁盘：`DELORUN_HOME=~/work/delorun delorun`。
- 在 Delorun 停止（`delorun stop`）时复制 home 文件夹，即可备份 Delorun。
- 用 `delorun export` 和 `delorun import` 在不同 home 之间移动单个 chat 或工作区（见[日常使用](../everyday-use/daily-use.zh.md#trash-export-and-import)）。

</details>

<a id="next"></a>

## 接下来

- 启动与停止 Delorun：[日常使用](../everyday-use/daily-use.zh.md)。
- 了解日志存放位置：[Delorun 的日志存放在哪里](../help/logs.zh.md)。
- 如果某个文件被拒绝：[home 及其文件](../help/troubleshooting.zh.md#the-home-and-its-files)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[home 布局约定](../../contracts/c01-home-layout.zh.md)列出了 home 中的每个文件夹和文件、所需的模式以及错误代码；[故障排查](../help/troubleshooting.zh.md#the-home-and-its-files)解释了每个代码。
