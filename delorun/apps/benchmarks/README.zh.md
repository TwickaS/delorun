# Delorun benchmarks

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

`@delorun/benchmarks` 衡量本人等待 Delorun 的各个环节，是位于 `delorun/apps/benchmarks` 的私有包。一套 harness 为每个 suite 提供一次性 home、被测提交的本地签名发布版本、合成数据、结果格式、表格和预算检查；每个 suite 衡量一个接触点。各 suite 衡量什么、如何运行以及目前记录的数字，见[性能页面](../../docs/performance/README.zh.md)。

## 模块

- `src/run.ts` 即 `pnpm run benchmark:delorun`：它解析命令行，用 `--prepare` 构建基础运行时闭包，在仅限回环的网络命名空间内重新运行自身，运行所选 suite，写出 JSON 结果，打印表格并检查预算。
- `src/harness/` 存放 harness：拒绝使用真实 home 的一次性根目录（`roots.ts`）、隔离网络（`isolation.ts`）、带计时输出行的子进程（`processes.ts`）、机器信息（`machine.ts`）、样本、结果以及路径和名称的清理（`result.ts`、`stats.ts`）、预算（`budgets.ts`）、表格（`table.ts`）、命令行（`options.ts`）和 suite 接口（`suite.ts`）。
- `src/fixtures/` 存放共享 fixture（测试前置数据）：基础闭包及由它派生的发布闭包（`closure.ts`）、本次运行的本地渠道、替代发布日志和启动器（`channel.ts`）、已安装的 home 及在其中运行的命令（`home.ts`）、模板 home 和已安装的发布版本（`releases.ts`），以及合成的 chat 和插件（`data.ts`）。
- `src/suites/` 为每个 suite 提供一个目录，并含 `index.ts`，即 suite 列表。
- `budgets.json` 存放 `--check-budgets` 强制执行的上限。
- `tests/` 存放 harness 及各 suite 纯辅助函数的规格。运行 suite 需要已安装的运行时闭包，因此各 suite 驱动进程的代码只在实测运行中执行。

## 新增 suite

添加导出 `Suite` 的 `src/suites/<id>/index.ts`，把它加入 `src/suites/index.ts`，运行它，用 `--propose-budgets` 在 `budgets.json` 中记录它的首批上限，并在 `delorun/docs/performance/` 下添加它的页面。
