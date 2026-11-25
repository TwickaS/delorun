# Delorun release channel

English | [中文](README.zh.md)

The production release channel: the R2 bucket that holds the signed release files, the public Worker that serves them, the cron Worker that re-signs `timestamp.json` every day and keeps a high-water mark, and the command that publishes a release. Contract [C2](../../docs/contracts/c02-release-manifest.md) defines the files; this package hosts them and adds no cryptography of its own. It reuses `@delorun/release-formats` for verification and `@delorun/release`'s `sign/timestamp.ts` for the content of a re-signed timestamp.

- [Modules](#modules)
- [The stack](#the-stack)
- [Public routes](#public-routes)
- [Timestamp re-signing](#timestamp-re-signing)
- [Publishing](#publishing)
- [Secrets and tokens](#secrets-and-tokens)
- [Deploying](#deploying)
- [Cost](#cost)

## Modules

- `src/routes.ts` and `src/worker.ts` are the public Worker, written against `head` and `get` of the bucket only.
- `src/resign-core.ts`, `src/resign-worker.ts` and `src/mark.ts` are the re-signing: the function, the cron Worker and the high-water mark.
- `src/publish-release.ts` uploads a channel directory and mirrors it to GitHub.
- `src/store.ts`, `src/r2-store.ts` and `src/s3-store.ts` are the object store the commands share: R2 bindings inside the cron Worker, R2's S3 API from the publish command. Every write is conditional.
- `deploy/` is the Alchemy stack. It is a workspace of its own with its own lockfile, so Alchemy's dependencies stay out of the repository's lockfile.
- `tests/` holds the specs, which use an in-memory store with R2's conditional-write behaviour and throwaway keys.

## The stack

`deploy/alchemy.run.ts` is the stack `DelorunReleaseChannel`. Per stage it creates:

| Resource | Name | Purpose |
| --- | --- | --- |
| R2 bucket | `delorun-releases-<stage>` | The channel's files. Stages never share a bucket. |
| Bucket lock rules | `releases/` and `root/` | R2 refuses to overwrite or delete an object under either prefix. `prod` locks indefinitely, so its bucket can never be emptied; other stages lock for 7 days. `timestamp.json` has no rule, because it is replaced. |
| Worker `Channel` | | The public Worker with the bucket binding `RELEASES`. |
| Workers KV namespace `Mark` | `delorun-release-mark-<stage>` | The re-signer's high-water mark. Only `Resign` is bound to it, and the S3 publish token cannot reach it. |
| Worker `Resign` | | The cron Worker, schedule `17 3 * * *` (UTC), with the bucket binding `RELEASES`, the namespace binding `MARK` and the secrets `TIMESTAMP_KEY` and `MARK_SECRET`. It answers the publisher's HMAC-signed `POST /mark` on its workers.dev address (the stack output `markUrl`) and 404 elsewhere. |

The `prod` stage serves `releases.delorun.com` (main) and `releases.delo.run` (spare) from `Channel`; every other stage has only its workers.dev address. Only the owner deploys `prod`.

Cloudflare offers no read-only R2 binding, so the public Worker is read-only by code, not by its binding: it is typed against `head` and `get`, and `tests/routes.spec.ts` proves no route reaches a write and fails if `routes.ts` or `worker.ts` calls `put` or `delete`. The prod bucket locks protect `releases/` and `root/`; `timestamp.json` is writable through that binding, which the Worker's code never does. The credentials that write from outside are an S3 token, not a Worker secret.

## Public routes

`GET` and `HEAD` for exactly these paths, and 404 for every other path and method:

- `/timestamp.json`, `Cache-Control: public, max-age=60`;
- `/root/<n>.root.json`, with `n` a positive number without a leading zero;
- `/releases/download/v<version>/<file>`, with `<file>` one plain file name.

Roots and release files send `Cache-Control: public, max-age=31536000, immutable`. A single `Range` is honoured with 206, and a range outside the object answers 416.

## Timestamp re-signing

`resignTimestamp` reads `timestamp.json` and every `root/<n>.root.json`, walks the root chain, and verifies the timestamp under the newest root. It then writes the next timestamp: the current file's signed JSON with only `version` (+ 1), `issued` (one hour before now, so a client clock a little behind still accepts it) and `expires` (exactly 3 days after `issued`) replaced, and a new signature. It never rebuilds the file from parsed fields, so a key this code does not know, such as a later channel, stays in the signed file. It refuses, writing nothing, when:

- no timestamp or root is stored;
- the roots do not chain;
- the current timestamp's signature, lifetime or root does not verify, including a timestamp that names an older root than the newest stored one (publish a timestamp for the new root first);
- the key is not one of the newest root's timestamp keys;
- the current timestamp's version is below the high-water mark, or a channel names a lower release than the mark records (a bucket rolled back to an older signed file).

The high-water mark is the highest version and each channel's release that the re-signer has seen verified. It is stored in the Workers KV namespace `Mark`, bound to `Resign` alone, never in the bucket the S3 publish token can write. A publish updates nothing there: the re-signer learns it by seeing a higher version on its next run, and writes the mark after its own write succeeds. The first run, with no mark, records the current file. A refusal fails the run, so Cloudflare reports it; restoring a deliberately older state is an owner decision made by editing the key `timestamp-high-water-mark` in the namespace.

A timestamp that has expired after missed runs is still re-signed, because its signature and lifetime hold. The write replaces `timestamp.json` only if it still has the entity tag that was read. A publish that raced it keeps its file; the run reports that and the next run continues from the publish. Only the cron Worker re-signs, because only it can reach the mark.

A holder of the timestamp key, or of the Cloudflare account, can keep a stale release current beyond 3 days. It cannot forge a release, because every channel entry names a manifest the offline targets key signed, and a re-signing never changes the entries. A holder of the S3 publish token alone cannot make the re-signer renew a rolled-back timestamp.

## Publishing

```sh
DELORUN_R2_ACCESS_KEY_ID=... DELORUN_R2_SECRET_ACCESS_KEY=... DELORUN_MARK_SECRET=... \
  node delorun/apps/release-channel/src/publish-release.ts --stage <stage> --account <id> --channel <dir> \
  --mark-url <the Resign Worker's /mark address, a URL ending in /mark> [--mirror github --tag v<version> --repo <owner/name>]
```

`--channel` is a directory laid out as `local-release.ts` writes it (`timestamp.json`, `root/`, `releases/download/v<version>/`). Hidden entries are skipped and any other file is refused. The order is the release files, then new roots, then `timestamp.json`. Release files and roots are create-only (`If-None-Match: *`). An existing object with the same bytes is skipped, so an interrupted publish resumes; one with other bytes stops the publish with a refusal that names the key. `timestamp.json` is replaced only when the new file's version is higher than the stored file's, and against the entity tag read just before, so a racing re-signing keeps its file and the publish stops. Right after the upload the script posts the file to `--mark-url`, signed with `DELORUN_MARK_SECRET`; the Worker reads at most 64 KB of body (413 beyond), moves the high-water mark to it only when the bucket holds those bytes and the file verifies under the newest root of the bucket's root chain (an unsigned or wrongly signed file is refused with 409), and never lowers it, so a restored older timestamp is refused by the next cron run. A refused request fails the publish. A publish whose version is equal or lower is refused; sign the next version from the re-signed file.

R2 sometimes drops a connection mid-publish: `fetch failed`, undici's `UND_ERR_SOCKET` ("other side closed"), typically on the first read after a run of already-published files. Every store call is therefore tried up to three times, with a pause that doubles between attempts, and the retry is logged. The writes are create-only or conditional, so a repeated attempt publishes nothing twice. An HTTP answer is never retried: a 403 or a 412 is the bucket's decision, not a dropped connection. When all three attempts drop the connection, the publish fails with the error the store raised, unchanged. Before each local release after the first, run `sign-timestamp.ts --import-from https://<channel origin> --root <root>... --state <state.json>` (see the [release README](../release/README.md#root-and-timestamp-metadata)), which moves the signer's state to the timestamp the Worker's re-signing left; if the Worker re-signs between the import and the publish, the publish refuses and nothing is replaced, so import, sign and publish again.

`--mirror github` then runs `gh release upload <tag> <files> --repo <repo>` for that version's release files, without `--clobber`. Tests mock the command.

## Secrets and tokens

| Name | Where | Holds |
| --- | --- | --- |
| `DELORUN_TIMESTAMP_KEY` | The environment of the process that deploys the stack; bound as the secret `TIMESTAMP_KEY` on `Resign` only | The timestamp private key, PKCS #8 PEM, Ed25519. |
| `DELORUN_MARK_SECRET` | The environment of the process that deploys the stack, and of the publisher's machine or workflow | A random secret. Bound as `MARK_SECRET` on `Resign` only; the publisher signs each mark request with it (HMAC-SHA-256 over the request body). Never committed. |
| `DELORUN_R2_ACCESS_KEY_ID`, `DELORUN_R2_SECRET_ACCESS_KEY` | The publisher's machine or workflow | An R2 S3 token scoped to Object Read and Write on the one bucket. Never a Worker secret. |
| Cloudflare credentials | Alchemy's login or environment | The deploy. |

## Deploying

```sh
cd delorun/apps/release-channel/deploy
pnpm install
DELORUN_TIMESTAMP_KEY="$(cat staging-timestamp.pem)" DELORUN_MARK_SECRET="$(cat staging-mark-secret)" pnpm exec alchemy deploy --stage staging
```

Staging is signed with a non-production root. The launcher for staging is built with `--channel-origin` set to the Channel Worker's workers.dev address. The `prod` stage is the owner's.

## Cost

The Workers Paid plan costs $5 a month and includes 10 million requests. R2 costs $0.015 per GB-month after 10 GB, with free egress. At 1,000 active installs, each checking daily and updating monthly, the channel makes about 30,000 timestamp requests and 1,000 archive requests a month. Ten kept releases of three runtimes and three desktop builds are about 6 GB. The cron Worker adds 30 invocations a month.

Workers KV has no compare-and-swap, so the mark is moved up by reading it, writing the higher value and reading it again, writing once more if a concurrent writer replaced it with a lower one. The publish endpoint and the cron run both use that sequence. One window remains: a writer that read the mark before this write and replaces it after the second read, with a lower value, is not noticed until the next cron run or publish sees the higher timestamp in the bucket and moves the mark up again.
