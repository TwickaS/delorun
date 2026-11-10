/**
 * The clean machine the journey installs into: an image made from the pinned Debian base of `images.json` and the
 * pinned Node distribution of `toolchain.json`, both read from this computer's caches, holding nothing of the
 * repository; and containers that reach only the spec's servers.
 *
 * Isolation: the journey's containers sit on a Docker network created `--internal`, which has no route out of Docker,
 * not to the internet and not to this computer. One gateway container sits on that network and on Docker's default
 * bridge and forwards exactly the spec's server ports to this computer (`host.docker.internal`). Inside each journey
 * container a forwarder listens on the loopback address on those ports and forwards to the gateway, because the
 * launcher accepts an `http:` channel or log origin only on loopback. The spec proves it: a request from a journey
 * container to an address outside, to a name outside, and to this computer directly all fail.
 *
 * Every container and network carries the label {@link JOURNEY_LABEL} with the run's id, and is removed after the run.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The label every container and network of a journey run carries. */
export const JOURNEY_LABEL = 'run.delo.journey'

/** This directory, mounted read-only into every container at {@link MOUNT}, for the forwarder and the probe. */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Where the journey's own files appear in a container. */
export const MOUNT = '/journey'

/** Where the run's files (the launcher tarball, archives, answers) appear in a container. */
export const SHARED = '/journey-run'

/** The person's account in the image. */
export const PERSON = 'person'

/** The person's home directory in the image. */
export const PERSON_HOME = `/home/${PERSON}`

/** A finished command. */
export interface Finished {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `docker` and wait for it.
 * @param args - its arguments.
 * @param timeout - milliseconds before it is killed.
 * @returns its standard output, trimmed.
 * @throws Error naming the command and its standard error when it fails.
 */
export function docker(args: readonly string[], timeout = 300_000): string {
  try {
    return execFileSync('docker', [...args], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(`docker ${args.join(' ')} failed: ${stderr.trim() || String(error)}`)
  }
}

/**
 * Why no Docker engine answers, or nothing when one does.
 * @returns the reason, or `undefined`.
 */
export function engineProblem(): string | undefined {
  let problem: string | undefined
  // A busy engine can miss one deadline; three misses in a row are an answer.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      docker(['info', '--format', '{{.ServerVersion}}'], 60_000)
      return undefined
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
  }
  return problem
}

/** What the image is made from. */
export interface ImageSources {
  /** The base image reference, pinned by digest. */
  readonly base: string
  /** The Node distribution tarball for Linux x64. */
  readonly nodeTarball: string
}

/**
 * Build the journey image, or reuse the one already built from the same sources. The base must already be in the
 * engine and the Node tarball is copied in; the build reaches the network once, for Debian's `git` package, which a
 * person installs when `delorun update` asks for it, because the profile history it keeps runs git.
 * @param sources - the base and the Node tarball.
 * @param scratch - a directory for the build context.
 * @returns the image's tag.
 */
export function journeyImage(sources: ImageSources, scratch: string): string {
  const dockerfile = [
    `FROM ${sources.base}`,
    'COPY node.tar.gz /tmp/node.tar.gz',
    `RUN tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE && rm /tmp/node.tar.gz && useradd --create-home --shell /bin/sh ${PERSON}`,
    'RUN apt-get update && apt-get install --yes --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
    `USER ${PERSON}`,
    `WORKDIR ${PERSON_HOME}`,
    '',
  ].join('\n')
  const tag = `delo-journey-machine:${createHash('sha256').update(dockerfile).update(readFileSync(sources.nodeTarball)).digest('hex').slice(0, 16)}`
  if (docker(['image', 'ls', '-q', tag]) !== '') return tag
  const context = join(scratch, 'image')
  mkdirSync(context, { recursive: true })
  writeFileSync(join(context, 'Dockerfile'), dockerfile)
  copyFileSync(sources.nodeTarball, join(context, 'node.tar.gz'))
  docker(['build', '--quiet', '--label', `${JOURNEY_LABEL}=image`, '--tag', tag, context], 600_000)
  return tag
}

/** The journey's network and gateway. */
export interface Network {
  readonly id: string
  readonly name: string
  readonly gateway: string
  readonly image: string
  readonly ports: readonly number[]
  readonly shared: string
}

/**
 * Create the internal network and its gateway, which forwards the spec's ports to this computer.
 * @param image - the journey image.
 * @param ports - the spec's server ports.
 * @param shared - the directory mounted read-only at {@link SHARED} in every journey container.
 * @returns the network.
 */
export function journeyNetwork(image: string, ports: readonly number[], shared: string): Network {
  const id = randomBytes(4).toString('hex')
  const name = `delo-journey-${id}`
  const label = `${JOURNEY_LABEL}=${id}`
  docker(['network', 'create', '--internal', '--label', label, name])
  const gateway = `${name}-gateway`
  docker(['run', '--detach', '--init', '--name', gateway, '--label', label, '--volume', `${HERE}:${MOUNT}:ro`, image, 'node', `${MOUNT}/forward.mjs`, '0.0.0.0', 'host.docker.internal', ...ports.map(String)])
  docker(['network', 'connect', name, gateway])
  return { id, name, gateway, image, ports, shared }
}

/**
 * Start one journey container on the internal network with its loopback forwarder.
 * @param network - the network.
 * @param role - a short name for the container.
 * @returns the container's name.
 */
export async function journeyContainer(network: Network, role: string): Promise<string> {
  const name = `${network.name}-${role}`
  docker(['run', '--detach', '--init', '--name', name, '--network', network.name, '--label', `${JOURNEY_LABEL}=${network.id}`,
    '--volume', `${HERE}:${MOUNT}:ro`, '--volume', `${network.shared}:${SHARED}:ro`, network.image, 'sleep', 'infinity'])
  docker(['exec', '--detach', name, 'node', `${MOUNT}/forward.mjs`, '127.0.0.1', network.gateway, ...network.ports.map(String)])
  // The forwarder listens within a moment; the spec's first request would otherwise race it.
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = await exec(name, ['node', '-e', `require('node:net').connect(${String(network.ports[0])}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`], {})
    if (probe.status === 0) return name
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`the forwarder in ${name} did not listen on 127.0.0.1:${String(network.ports[0])}`)
}

/**
 * Remove every container and network of one run.
 * @param network - the network, or `undefined` when none was created.
 */
export function removeNetwork(network: Network | undefined): void {
  if (network === undefined) return
  const filter = `label=${JOURNEY_LABEL}=${network.id}`
  const containers = docker(['ps', '-aq', '--filter', filter]).split('\n').filter(line => line !== '')
  if (containers.length > 0) docker(['rm', '--force', '--volumes', ...containers])
  docker(['network', 'rm', network.name])
}

/**
 * Run a command in a container as the person, without blocking this process, whose servers the command reaches.
 * @param container - the container.
 * @param command - the command and its arguments.
 * @param env - variables to set.
 * @param timeout - milliseconds before it is killed.
 * @returns its exit status and output.
 */
export function exec(container: string, command: readonly string[], env: Readonly<Record<string, string>>, timeout = 900_000): Promise<Finished> {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`])
  return new Promise((resolve) => {
    execFile('docker', ['exec', ...variables, container, ...command], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })
}

/** One answer an interactive command gets: the text to type once its output matches. */
export interface Answer {
  readonly when: RegExp
  readonly send: string
  /** Called with the output so far when the prompt appears, before the answer is typed. */
  readonly before?: (output: string) => Promise<void>
}

/**
 * Run a command in a container on a pseudo-terminal (`script`) of 200 columns, typing each answer once its prompt
 * appears. A terminal without a size gets prompts drawn one character per line.
 * @param container - the container.
 * @param command - the shell command line.
 * @param env - variables to set.
 * @param answers - the answers, in order.
 * @param timeout - milliseconds before it is killed.
 * @returns its exit status and the terminal's output.
 */
export function interact(container: string, command: string, env: Readonly<Record<string, string>>, answers: readonly Answer[], timeout = 900_000): Promise<Finished> {
  const variables = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`])
  const child = spawn('docker', ['exec', '--interactive', ...variables, container, 'script', '--quiet', '--flush', '--return', '--command', `stty cols 200 rows 50; ${command}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let stderr = ''
  let next = 0
  let answering = false
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  const answer = async (): Promise<void> => {
    const pending = answers[next]
    if (answering || pending === undefined || !pending.when.test(output)) return
    answering = true
    next++
    await pending.before?.(output)
    child.stdin.write(pending.send)
    answering = false
    await answer()
  }
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    void answer()
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout: output, stderr })
    })
  })
}

/**
 * Whether a file exists on this computer, for the paths the spec checks before it runs.
 * @param path - the path.
 * @returns true when it exists.
 */
export function present(path: string): boolean {
  return existsSync(path)
}
