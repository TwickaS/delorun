/**
 * The network helper container: build its image, start it so that it owns a run's network namespace, wait until its
 * proxy has made the run's throwaway CA, and collect and stop it at the end. The plugin container joins the helper's
 * network (`--network container:<name>`), so its traffic passes the proxy, and only the helper has network-admin rights.
 *
 * @module @delorun/tools/compat-bench/privacy/helper/image
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCH_LABEL, dockerOrThrow } from '../docker.ts'
import type { Docker } from '../docker.ts'

const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
/** The files whose content decides the image tag. */
const IMAGE_FILES = ['Dockerfile', 'entry.sh', 'poll.py', 'addon.py'] as const

/** The helper container's resource limits. */
export const HELPER_LIMITS = { memory: '512m', pids: 256 } as const

/**
 * Name the helper image after the content that builds it, so a changed file makes a new image.
 * @returns the image tag: `delorun-bench-helper:` and a hash of the files that build it.
 */
export async function helperImageTag(): Promise<string> {
  const hash = createHash('sha256')
  for (const name of IMAGE_FILES) hash.update(name).update(await readFile(join(HELPER_DIR, name)))
  return `delorun-bench-helper:${hash.digest('hex').slice(0, 12)}`
}

/**
 * Build the helper image unless this content's tag already exists. Called by `bench image build --host helper`.
 * @param docker - the docker function.
 * @param options - `force` rebuilds even when the tag exists.
 * @returns the image tag.
 */
export async function buildHelperImage(docker: Docker, options: Readonly<{ force?: boolean }> = {}): Promise<string> {
  const tag = await helperImageTag()
  if (options.force !== true && (await docker(['image', 'inspect', tag])).status === 0) return tag
  await dockerOrThrow(docker, ['build', '--label', BENCH_LABEL, '--tag', tag, HELPER_DIR], { timeoutMs: 900_000 })
  return tag
}

/** What a started helper is. */
export type StartedHelper = Readonly<{ name: string; image: string; caPath: string }>

/** How to start a helper. */
export type HelperOptions = Readonly<{
  /** The run's id; the container is `bench-helper-<runId>`. */
  runId: string
  /** The run's output folder; the CA is copied to `<outDir>/privacy/ca.pem`. */
  outDir: string
  /** The canaries by name, searched for in every request. */
  canaries: Readonly<Record<string, string>>
  /** The studio port to publish on 127.0.0.1 (host port, container port), if the runner uses one. */
  publish?: Readonly<{ host: number; container: number }>
  /** Extra arguments for the proxy, for the helper's own tests only (for example `--set ssl_insecure=true`). */
  proxyArgs?: string
  /** How long to wait for the proxy's CA, in milliseconds. */
  readyTimeoutMs?: number
}>

/**
 * The name of a run's helper container.
 * @param runId - the run's id.
 * @returns the name.
 */
export function helperName(runId: string): string {
  return `bench-helper-${runId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
}

/**
 * The arguments of `docker run` for a helper: every capability dropped but NET_ADMIN, no new privileges, a read-only
 * root, limits, and the studio port published on the loopback address only.
 * @param name - the container name.
 * @param image - the image.
 * @param options - the helper's options.
 * @returns the arguments.
 */
export function helperRunArgs(name: string, image: string, options: HelperOptions): ReadonlyArray<string> {
  return [
    'run', '--detach', '--name', name, '--label', BENCH_LABEL, '--label', 'delorun.bench.role=helper',
    '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/ca', '--tmpfs', '/out', '--tmpfs', '/tmp',
    '--memory', HELPER_LIMITS.memory, '--pids-limit', String(HELPER_LIMITS.pids),
    ...options.publish === undefined ? [] : ['--publish', `127.0.0.1:${options.publish.host}:${options.publish.container}`],
    '--env', `BENCH_CANARIES=${JSON.stringify(options.canaries)}`,
    ...options.proxyArgs === undefined ? [] : ['--env', `BENCH_PROXY_ARGS=${options.proxyArgs}`],
    image,
  ]
}

/**
 * Start a helper and wait until it has made the CA.
 * @param docker - the docker function.
 * @param image - the helper image.
 * @param options - the helper's options.
 * @returns the helper and where its CA was copied.
 */
export async function startHelper(docker: Docker, image: string, options: HelperOptions): Promise<StartedHelper> {
  const name = helperName(options.runId)
  await dockerOrThrow(docker, helperRunArgs(name, image, options))
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000)
  for (;;) {
    if ((await docker(['exec', name, 'test', '-f', '/out/ready'])).status === 0) break
    const state = (await docker(['inspect', '--format', '{{.State.Running}}', name])).stdout.trim()
    if (state !== 'true') {
      const logs = await docker(['logs', name])
      await docker(['rm', '--force', name])
      throw new Error(`the bench helper stopped before it was ready: ${(logs.stderr + logs.stdout).trim().slice(-400)}`)
    }
    if (Date.now() > deadline) {
      await docker(['rm', '--force', name])
      throw new Error('the bench helper was not ready in time')
    }
    await new Promise(done => setTimeout(done, 200))
  }
  const caPath = join(options.outDir, 'privacy', 'ca.pem')
  try {
    await mkdir(dirname(caPath), { recursive: true })
    // `docker cp` cannot read a tmpfs mount, so the helper's files are read through `docker exec cat`.
    await writeFile(caPath, await dockerOrThrow(docker, ['exec', name, 'cat', '/out/ca.pem']))
  } catch (error) {
    await docker(['rm', '--force', name])
    throw error
  }
  return { name, image, caPath }
}

/**
 * Copy the helper's report files (`hosts.json`, `net.jsonl`, logs) from `/out` to `<outDir>/privacy/helper/`.
 * @param docker - the docker function.
 * @param name - the helper's name.
 * @param outDir - the run's output folder.
 * @returns the folder the files were copied to.
 */
export async function collectHelper(docker: Docker, name: string, outDir: string): Promise<string> {
  const target = join(outDir, 'privacy', 'helper')
  await mkdir(target, { recursive: true })
  const names = (await dockerOrThrow(docker, ['exec', name, 'ls', '-1', '/out'])).split('\n').filter(file => /^[\w.-]+$/.test(file))
  for (const file of names) await writeFile(join(target, file), await dockerOrThrow(docker, ['exec', name, 'cat', `/out/${file}`]))
  return target
}

/**
 * Stop and remove the helper. Only the container this run made is touched.
 * @param docker - the docker function.
 * @param name - the helper's name.
 */
export async function stopHelper(docker: Docker, name: string): Promise<void> {
  await docker(['stop', '--time', '5', name])
  await docker(['rm', '--force', name])
}
