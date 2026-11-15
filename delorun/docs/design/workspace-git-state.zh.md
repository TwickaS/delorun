---
description: "尚待决定的设计选项：在可写工作区内，让受限命令对仓库的 `.git/config`、`.git/hooks` 和 `.git/info` 只读，使模型无法埋下之后会被此人自己的 git 或编辑器以完全访问权限运行的配置；以及它给模型合法使用 `git config` 和 `git remote` 带来的代价。"
---

# 可写工作区内的仓库设置

[English](workspace-git-state.md) | 中文

## 摘要

在 `workspace-write` 下，受限命令可以写入仓库的 `.git/config`、它所包含的文件、`.git/hooks` 和 `.git/info/attributes`。harness 自己的 git 命令在加固后、在 Session 的沙箱内运行，所以这类设置不会以 harness 的权限启动任何程序。此人自己的 git、编辑器以及在沙箱之外读取仓库的其他工具则没有经过加固：受限命令写在那里的设置，可以在此人下次在该仓库中运行 git 时，以此人的完全访问权限启动一个程序。本页陈述关闭这一点的一个方向，留待以后决定。它尚未被采纳。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

在 `workspace-write` 下，沙箱在每种方言上都把整个工作区绑定为可写，包括 `.git`。harness 的变更摘要在 Session 的沙箱内运行 git，其配置关闭了文件系统监视器、hooks、过滤器和 diff 驱动（[workspace-changes](../../../packages/deliverables/workspace-changes/README.zh.md#git-hardening)）。没有任何东西保护此人自己的工具免受受限命令所写入的设置的影响。

<a id="the-rules"></a>

## 规则

1. 在 `workspace-write` 下，对于每个其 `.git` 目录在包装时位于可写根之内的仓库，沙箱让受限命令对 `.git/config`、`.git/config` 从工作区内部包含的每个文件、`.git/hooks` 和 `.git/info` 保持只读。bwrap 把它们以只读方式绑定在可写绑定之上；Landlock 和 Seatbelt 则把它们排除在写入授权之外。
2. 指向可写根内某个 git 目录的 `.git` 文件，被视为那个目录。
3. `.git` 的其余部分保持可写，所以受限命令仍然可以提交、创建分支、向已有的远程仓库抓取以及变基。
4. 需要 `git config` 或 `git remote add` 的模型，会请求升级权限，其批准会指出仓库和设置。

代价是：模型不再能够设置仓库的用户名、添加远程仓库、安装此人要求的 hook，或运行自己会写入 `.git/config` 的工具（一些子模块和 LFS 命令就会这样做），除非每次都进行一次升级。在命令执行期间于工作区内创建的仓库，要到下一次包装才会适用这条规则。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- 在 Session 以 `danger-full-access` 运行期间，或通过已批准的升级所写入的设置。
- `.git` 之外的设置：工作树中的 `.gitattributes`、`.envrc`，以及工作区中的编辑器和任务运行器配置，此人自己的工具也可能运行它们。
- `.git` 目录位于所有可写根之外、但工作树位于其中之一的仓库。

<a id="denial-tests"></a>

## 拒绝测试

- `git-config-readonly`：在每种方言上，`workspace-write` 下的受限命令无法更改 `.git/config`、它从工作区包含的文件、`.git/hooks/*` 或 `.git/info/attributes`，但仍然可以创建提交。
- `gitfile-readonly`：由 `.git` 文件所指名的 git 目录同样如此。

<a id="implementation-status"></a>

## 实现状态

尚无。威胁模型陈述了这一局限（见[威胁模型](../security/threat-model.zh.md#confinement-of-native-commands)）。
