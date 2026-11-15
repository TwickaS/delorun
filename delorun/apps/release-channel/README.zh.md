# Delorun release channel

[English](README.md) | 中文

生产环境的发布渠道：保存已签名发布文件的 R2 存储桶、提供这些文件的公开 Worker、每天重新签署 `timestamp.json` 并保存高水位标记的 cron Worker，以及发布一个发布版本的命令。约定 [C2](../../docs/contracts/c02-release-manifest.zh.md) 定义这些文件；本包托管它们，自身不增加任何密码学实现。它复用 `@delorun/release-formats` 进行验证，复用 `@delorun/release` 的 `sign/timestamp.ts` 生成重新签署的时间戳的内容。

- [模块](#modules)
- [部署栈](#the-stack)
- [公开路由](#public-routes)
- [时间戳重新签署](#timestamp-re-signing)
- [发布](#publishing)
- [密钥与令牌](#secrets-and-tokens)
- [部署](#deploying)
- [成本](#cost)

<a id="modules"></a>

## 模块

- `src/routes.ts` 和 `src/worker.ts` 是公开 Worker，仅针对存储桶的 `head` 和 `get` 编写。
- `src/resign-core.ts`、`src/resign-worker.ts` 和 `src/mark.ts` 是重新签署：函数、cron Worker 和高水位标记。
- `src/publish-release.ts` 上传渠道目录并将其镜像到 GitHub。
- `src/store.ts`、`src/r2-store.ts` 和 `src/s3-store.ts` 是各命令共用的对象存储：cron Worker 内部使用 R2 绑定，发布命令使用 R2 的 S3 API。每次写入都是有条件的。
- `deploy/` 是 Alchemy 部署栈。它是带有自己锁文件的独立工作区，所以 Alchemy 的依赖不会进入仓库的锁文件。
- `tests/` 存放规格，它们使用一个具备 R2 条件写入行为的内存存储和一次性密钥。

<a id="the-stack"></a>

## 部署栈

`deploy/alchemy.run.ts` 是栈 `DelorunReleaseChannel`。每个 stage 创建：

| 资源 | 名称 | 用途 |
| --- | --- | --- |
| R2 存储桶 | `delorun-releases-<stage>` | 渠道的文件。各 stage 从不共用存储桶。 |
| 存储桶锁定规则 | `releases/` 和 `root/` | R2 拒绝覆盖或删除这两个前缀之下的对象。`prod` 无限期锁定，所以其存储桶永远无法被清空；其他 stage 锁定 7 天。`timestamp.json` 没有规则，因为它会被替换。 |
| Worker `Channel` | | 带存储桶绑定 `RELEASES` 的公开 Worker。 |
| Workers KV 命名空间 `Mark` | `delorun-release-mark-<stage>` | 重新签署者的高水位标记。只有 `Resign` 绑定到它，S3 发布令牌无法访问它。 |
| Worker `Resign` | | cron Worker，计划为 `17 3 * * *`（UTC），带存储桶绑定 `RELEASES`、命名空间绑定 `MARK` 以及密钥 `TIMESTAMP_KEY` 和 `MARK_SECRET`。它在其 workers.dev 地址（栈输出 `markUrl`）上应答发布者经 HMAC 签名的 `POST /mark`，其他地方应答 404。 |

`prod` stage 通过 `Channel` 提供 `releases.delorun.com`（主域名）和 `releases.delo.run`（备用域名）；其他每个 stage 只有自己的 workers.dev 地址。只有所有者部署 `prod`。

Cloudflare 不提供只读的 R2 绑定，所以公开 Worker 的只读性来自代码，而不是它的绑定：它按 `head` 和 `get` 编写类型，`tests/routes.spec.ts` 证明没有路由会触及写入，并在 `routes.ts` 或 `worker.ts` 调用 `put` 或 `delete` 时失败。prod 存储桶的锁定保护 `releases/` 和 `root/`；`timestamp.json` 可通过该绑定写入，而 Worker 的代码从不这样做。从外部写入的凭据是 S3 令牌，而不是 Worker 的密钥。

<a id="public-routes"></a>

## 公开路由

仅对下列路径提供 `GET` 和 `HEAD`，其他每个路径和方法一律 404：

- `/timestamp.json`，`Cache-Control: public, max-age=60`；
- `/root/<n>.root.json`，其中 `n` 是不带前导零的正数；
- `/releases/download/v<version>/<file>`，其中 `<file>` 是一个普通文件名。

根文件和发布文件发送 `Cache-Control: public, max-age=31536000, immutable`。单个 `Range` 以 206 应答，超出对象范围的 range 应答 416。

<a id="timestamp-re-signing"></a>

## 时间戳重新签署

`resignTimestamp` 读取 `timestamp.json` 和每个 `root/<n>.root.json`，沿着根链遍历，并在最新的根之下验证时间戳。然后它写入下一个时间戳：当前文件的已签名 JSON，仅替换 `version`（加 1）、`issued`（现在之前一小时，使时钟略微落后的客户端仍能接受它）和 `expires`（恰好在 `issued` 之后 3 天），并附新的签名。它从不根据解析出的字段重建文件，所以此代码不认识的键（例如后来的渠道）会保留在已签名的文件中。出现下列情形时它拒绝，且不写入任何内容：

- 没有存储时间戳或根；
- 各根不能构成链；
- 当前时间戳的签名、有效期或根无法通过验证，包括指名了比已存储的最新根更旧的根的时间戳（应先为新的根发布一个时间戳）；
- 密钥不是最新根的时间戳密钥之一；
- 当前时间戳的版本低于高水位标记，或某个渠道指名的发布版本低于标记所记录的版本（存储桶回滚到了更旧的已签名文件）。

高水位标记是重新签署者已见到并验证过的最高版本及各渠道的发布版本。它存储在 Workers KV 命名空间 `Mark` 中，仅绑定到 `Resign`，从不放在 S3 发布令牌可写的存储桶里。发布不会在那里更新任何内容：重新签署者在下次运行时看到更高的版本而得知，并在自己的写入成功之后写入标记。没有标记的首次运行会记录当前文件。拒绝会使运行失败，所以 Cloudflare 会报告它；恢复到有意设定的更旧状态是所有者的决定，通过编辑命名空间中的键 `timestamp-high-water-mark` 来作出。

因错过运行而过期的时间戳仍会被重新签署，因为它的签名和有效期成立。写入只在 `timestamp.json` 仍带有读取时的实体标签时才替换它。与之竞争的发布会保留它的文件；本次运行报告这一点，下次运行从该发布继续。只有 cron Worker 重新签署，因为只有它能访问标记。

时间戳密钥的持有者或 Cloudflare 账户的持有者，可以让过期的发布版本保持有效超过 3 天。他们无法伪造发布版本，因为每个渠道条目都指名一个由离线目标密钥签署的清单，而重新签署从不更改这些条目。仅持有 S3 发布令牌的人无法让重新签署者续期已回滚的时间戳。

<a id="publishing"></a>

## 发布

```sh
DELORUN_R2_ACCESS_KEY_ID=... DELORUN_R2_SECRET_ACCESS_KEY=... DELORUN_MARK_SECRET=... \
  node delorun/apps/release-channel/src/publish-release.ts --stage <stage> --account <id> --channel <dir> \
  --mark-url <the Resign Worker's /mark address> [--mirror github --tag v<version> --repo <owner/name>]
```

`--channel` 是按 `local-release.ts` 写出的方式组织的目录（`timestamp.json`、`root/`、`releases/download/v<version>/`）。隐藏条目会被跳过，任何其他文件都会被拒绝。顺序是发布文件，然后是新的根，最后是 `timestamp.json`。发布文件和根只能创建（`If-None-Match: *`）。字节相同的现有对象会被跳过，所以被中断的发布可以继续；字节不同的对象会使发布停止，并给出指名该键的拒绝。仅当新文件的版本高于已存储文件的版本、且对照刚刚读取的实体标签成立时，才会替换 `timestamp.json`，所以与之竞争的重新签署会保留它的文件，而发布会停止。上传之后，脚本立即把该文件提交到 `--mark-url`，用 `DELORUN_MARK_SECRET` 签名；Worker 最多读取 64 KB 的请求体（超出则 413），只有存储桶保存了这些字节、且该文件在存储桶根链的最新根之下验证通过（未签名或签名错误的文件以 409 被拒绝）时，才把高水位标记移动到它，并且从不降低它，所以恢复出的更旧时间戳会被下次 cron 运行拒绝。被拒绝的请求会使发布失败。版本相同或更低的发布会被拒绝；应从重新签署后的文件签署下一个版本。在第一次之后的每次本地发布之前，运行 `sign-timestamp.ts --import-from https://<channel origin> --root <root>... --state <state.json>`（见[发布 README](../release/README.zh.md#root-and-timestamp-metadata)），它把签署者的状态移动到 Worker 重新签署所留下的时间戳；如果 Worker 在导入与发布之间重新签署，发布会拒绝且不替换任何内容，此时应再次导入、签署并发布。

随后 `--mirror github` 为该版本的发布文件运行 `gh release upload <tag> <files> --repo <repo>`，不带 `--clobber`。测试会模拟该命令。

<a id="secrets-and-tokens"></a>

## 密钥与令牌

| 名称 | 位置 | 保存内容 |
| --- | --- | --- |
| `DELORUN_TIMESTAMP_KEY` | 部署栈的进程的环境；仅在 `Resign` 上绑定为密钥 `TIMESTAMP_KEY` | 时间戳私钥，PKCS #8 PEM，Ed25519。 |
| `DELORUN_MARK_SECRET` | 部署栈的进程的环境，以及发布者的机器或工作流 | 一个随机密钥。仅在 `Resign` 上绑定为 `MARK_SECRET`；发布者用它为每个标记请求签名（对请求体计算 HMAC-SHA-256）。从不提交。 |
| `DELORUN_R2_ACCESS_KEY_ID`、`DELORUN_R2_SECRET_ACCESS_KEY` | 发布者的机器或工作流 | 仅限于那一个存储桶的对象读写权限的 R2 S3 令牌。绝不是 Worker 的密钥。 |
| Cloudflare 凭据 | Alchemy 的登录或环境 | 部署。 |

<a id="deploying"></a>

## 部署

```sh
cd delorun/apps/release-channel/deploy
pnpm install
DELORUN_TIMESTAMP_KEY="$(cat staging-timestamp.pem)" DELORUN_MARK_SECRET="$(cat staging-mark-secret)" pnpm exec alchemy deploy --stage staging
```

staging 使用非生产的根签署。staging 的启动器构建时把 `--channel-origin` 设为 Channel Worker 的 workers.dev 地址。`prod` stage 归所有者所有。

<a id="cost"></a>

## 成本

Workers 付费计划每月 5 美元，包含 1000 万次请求。R2 在超出 10 GB 之后每 GB 每月 0.015 美元，出站流量免费。在 1,000 个活跃安装、每个每天检查一次且每月更新一次的情况下，渠道每月约有 30,000 次时间戳请求和 1,000 次归档请求。保留十个发布版本，包含三个运行时和三个桌面构建，约为 6 GB。cron Worker 每月增加 30 次调用。

Workers KV 没有 compare-and-swap，所以标记的上移是先读取它，写入更高的值，再次读取，如果并发的写入者用更低的值替换了它，则再写一次。发布端点和 cron 运行都使用这一序列。仍有一个窗口：在本次写入之前读取了标记、并在第二次读取之后以更低的值替换它的写入者，要到下一次 cron 运行或发布在存储桶中看到更高的时间戳并再次上移标记时，才会被发现。
