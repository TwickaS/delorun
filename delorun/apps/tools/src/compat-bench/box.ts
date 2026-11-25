/**
 * A running bench container, as the runner uses it: start it hardened, run commands in it, copy a folder in, and
 * call the container-side scripts (`ctl.mjs`, `browse.mjs`), which print one JSON line. Everything the plugin runs is
 * inside the container; the host only calls `docker`.
 *
 * @module @delorun/tools/compat-bench/box
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { docker, hardenedRunArgs, inspectContainer, inspectProblems, type DockerResult, type RunSpec } from './docker.ts'
import type { ContainerAdditions } from './observer.ts'

/** The value prefix a secret-named environment variable added by an observer must carry: it is a planted fake. */
export const CANARY_PREFIX = 'sk-bench-canary-'

/** A running container. */
export interface Box {
  /** The container's name. */
  readonly name: string
  /** The run's output folder on the host. */
  readonly outDir: string
  /**
   * Run a command in the container.
   * @param argv - the command.
   * @param options - a time limit.
   * @returns the result; a failing command resolves with its code.
   */
  exec(argv: readonly string[], options?: { readonly timeoutMs?: number }): Promise<DockerResult>
  /**
   * Run a container-side script and parse its one JSON line.
   * @param script - `ctl` or `browse`.
   * @param args - its command and flags.
   * @param options - a time limit.
   * @returns the parsed answer; `{ ok: false }` with the output when the script printed no JSON.
   */
  script(script: 'ctl' | 'browse', args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<Record<string, unknown> & { readonly ok: boolean }>
  /**
   * Copy a host folder into the container.
   * @param hostPath - the folder.
   * @param containerPath - the destination.
   */
  copyIn(hostPath: string, containerPath: string): Promise<void>
  /** Stop and remove the container. */
  remove(): Promise<void>
}

/**
 * Start a hardened container and check its configuration over `docker inspect`.
 * @param spec - what to run; it runs `sleep infinity` unless a command is given.
 * @param additions - what the observers add: environment, files, preloads.
 * @returns the box.
 * @throws Error when Docker refuses to start it or the inspected configuration departs from the hardening.
 */
export async function startBox(spec: RunSpec, additions: readonly ContainerAdditions[] = []): Promise<Box> {
  mkdirSync(join(spec.outDir, 'logs'), { recursive: true })
  const env: Record<string, string> = { ...spec.env }
  const nodeOptions: string[] = []
  for (const add of additions) {
    for (const [name, value] of Object.entries(add.env ?? {})) {
      if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name) && !value.startsWith(CANARY_PREFIX)) throw new Error(`an observer added ${name} with a value that is not a bench canary (it must start with ${CANARY_PREFIX})`)
    }
    Object.assign(env, add.env)
    for (const preload of add.preloads ?? []) nodeOptions.push(`--import ${preload}`)
    if (add.caCertPath !== undefined) env.NODE_EXTRA_CA_CERTS = add.caCertPath
  }
  if (nodeOptions.length > 0) env.NODE_OPTIONS = [env.NODE_OPTIONS, ...nodeOptions].filter(each => each !== undefined).join(' ')
  const networkContainer = additions.find(add => add.networkContainer !== undefined)?.networkContainer ?? spec.networkContainer
  const pidContainer = additions.find(add => add.pidContainer !== undefined)?.pidContainer
  const full: RunSpec = { ...spec, env, observerEnv: additions.flatMap(add => Object.keys(add.env ?? {})), ...(pidContainer === undefined ? {} : { pidContainer }), command: spec.command ?? ['sleep', 'infinity'], ...(networkContainer === undefined ? {} : { networkContainer }) }
  const started = await docker(hardenedRunArgs(full), { timeoutMs: 120_000 })
  if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`)
  const problems = inspectProblems(await inspectContainer(spec.name), { outDir: spec.outDir, allowedEnv: additions.flatMap(add => Object.keys(add.env ?? {})), ...(spec.homeVolume === undefined ? {} : { volumes: [spec.homeVolume] }) })
  if (problems.length > 0) {
    await docker(['rm', '-f', spec.name])
    throw new Error(`the container is not hardened: ${problems.join('; ')}`)
  }
  for (const add of additions) {
    for (const file of add.files ?? []) {
      const written = await docker(['exec', '-i', spec.name, 'sh', '-c', `mkdir -p "$(dirname '${file.path}')" && cat > '${file.path}' && chmod ${(file.mode ?? 0o644).toString(8)} '${file.path}'`], { input: file.content, timeoutMs: 30_000 })
      if (written.code !== 0) throw new Error(`could not write ${file.path} into the container: ${written.stderr.trim()}`)
    }
  }
  const commands = join(spec.outDir, 'logs', 'commands.log')
  const exec: Box['exec'] = async (argv, options = {}) => {
    appendFileSync(commands, `${new Date().toISOString()} ${argv.join(' ')}\n`)
    return await docker(['exec', spec.name, ...argv], options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
  return {
    name: spec.name,
    outDir: spec.outDir,
    exec,
    async script(script, args, options = {}) {
      const result = await exec(['node', `/opt/bench/${script}.mjs`, ...args], options)
      const line = result.stdout.trim().split('\n').filter(each => each.startsWith('{')).pop()
      if (line === undefined) return { ok: false, code: result.code, output: `${result.stdout}${result.stderr}`.slice(-2000) }
      return JSON.parse(line) as Record<string, unknown> & { ok: boolean }
    },
    async copyIn(hostPath, containerPath) {
      const copied = await docker(['cp', hostPath, `${spec.name}:${containerPath}`], { timeoutMs: 120_000 })
      if (copied.code !== 0) throw new Error(`docker cp failed: ${copied.stderr.trim()}`)
    },
    async remove() {
      await docker(['rm', '-f', '-v', spec.name])
    },
  }
}
