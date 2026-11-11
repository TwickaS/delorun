---
kind: upgrade-guide
description: "runRipgrep 以 RipgrepSearch 取代 argv 数组，buildGlobCommand 与 buildGrepCommand 以可选的第二个参数接收根目录写法。"
---

# `runRipgrep` 接收搜索根目录与 argv 构造函数

[English](guide.md) | 中文

## 变更

当沙箱提供方报告受保护读取时，`@deepseek-ai/dsh-tool-fs-search` 会自行解析搜索根目录：它把规范路径而不是模型的写法传给 ripgrep，在约束下运行 ripgrep，并过滤每个输出路径、改写其写法。为此它需要把根目录与其余参数分开。

- `runRipgrep(ctx, exec, toolName, argv, rawOutputMaxBytes, graceMs, stderrMaxBytes)` 改为以 `RipgrepSearch` 取代 `argv`：`{ path, argv(root) }`，其中 `path` 是请求的根目录或 `undefined`，`argv(root)` 返回 ripgrep 收到的根目录写法对应的 ripgrep 参数（`undefined` 表示搜索工作目录）。
- 返回的 `RipgrepRun` 新增 `keep(outputPath)`，对受保护读取之下的路径为 false；以及 `display(outputPath)`，即在请求的根目录写法下改写后的路径。没有受保护读取时，`keep` 总为 true，`display` 原样返回路径。
- `buildGlobCommand(input)` 与 `buildGrepCommand(input)` 接收可选的第二个参数，即根目录写法，默认为 `input.path`。

受影响的是直接调用 `runRipgrep` 的代码。只用一个参数调用构造函数的代码不受影响。

## 迁移

1. 把 `runRipgrep(ctx, exec, name, buildGrepCommand(input), ...)` 改为 `runRipgrep(ctx, exec, name, { path: input.path, argv: root => buildGrepCommand(input, root) }, ...)`，`buildGlobCommand` 同理。手工构造的 argv 只在 `root` 有定义时追加 `--` 与 `root`。
2. 对从 `run.stdout` 解析出的每个路径，`run.keep(path)` 为 false 时跳过它，并以 `run.display(path)` 代替它报告。
3. 在 `protectedReads` 覆盖根目录内某个目录的沙箱提供方下执行一次搜索以确认：该目录的文件不在结果中，其他路径与以前一致。
