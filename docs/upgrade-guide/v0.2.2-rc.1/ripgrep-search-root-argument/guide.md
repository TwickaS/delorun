---
kind: upgrade-guide
description: "runRipgrep takes a RipgrepSearch instead of an argv array, and buildGlobCommand and buildGrepCommand take the root spelling as an optional second argument."
---

# `runRipgrep` takes the search root and an argv builder

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-fs-search` resolves the search root itself when the sandbox provider reports protected reads: it passes ripgrep the canonical path instead of the model's spelling, runs ripgrep confined, and filters and respells each output path. To do that it needs the root apart from the rest of the arguments.

- `runRipgrep(ctx, exec, toolName, argv, rawOutputMaxBytes, graceMs, stderrMaxBytes)` now takes a `RipgrepSearch` in place of `argv`: `{ path, argv(root) }`, where `path` is the requested root or `undefined`, and `argv(root)` returns the ripgrep arguments for the root spelling ripgrep receives (`undefined` searches the working directory).
- The returned `RipgrepRun` gains `keep(outputPath)`, false for a path under the protected reads, and `display(outputPath)`, the path respelled under the requested root. Without protected reads `keep` is always true and `display` returns the path unchanged.
- `buildGlobCommand(input)` and `buildGrepCommand(input)` take an optional second argument, the root spelling, which defaults to `input.path`.

This affects code that calls `runRipgrep` directly. Callers of the builders with one argument are unaffected.

## Migration

1. Replace `runRipgrep(ctx, exec, name, buildGrepCommand(input), ...)` with `runRipgrep(ctx, exec, name, { path: input.path, argv: root => buildGrepCommand(input, root) }, ...)`, and likewise for `buildGlobCommand`. A hand-built argv must append `--` and `root` only when `root` is defined.
2. For each path parsed from `run.stdout`, skip it when `run.keep(path)` is false and report `run.display(path)` in its place.
3. Confirm with a search under a sandbox provider whose `protectedReads` covers a directory inside the root: its files are absent from the results, and the other paths read as before.
