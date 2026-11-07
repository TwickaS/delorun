/**
 * The active Docker context and its endpoint, resolved as the Docker command resolves them: `DOCKER_HOST` names the
 * endpoint of the `default` context, `DOCKER_CONTEXT` or the configuration's `currentContext` names a context whose
 * metadata lies under `contexts/meta/<sha256 of the name>/meta.json` in the Docker configuration directory
 * (`DOCKER_CONFIG`, else `~/.docker`), and without either the platform's default socket or pipe is used.
 *
 * @module @delo/supervisor/docker/endpoint
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DockerCapabilities } from '@delo/contract-runtime-supervisor'

/** The active context. */
export interface DockerContext {
  /** The context's name. */
  readonly name: string
  /** Its endpoint, as the capability report states it. */
  readonly endpoint: DockerCapabilities['endpoint']
  /** The endpoint's URL, for a refusal's detail. */
  readonly host: string
}

/**
 * The endpoint of a Docker host URL.
 * @param host - such as `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine` or `tcp://192.0.2.2:2376`.
 * @returns the endpoint, or `undefined` for a scheme Docker does not define.
 */
export function endpointOf(host: string): DockerCapabilities['endpoint'] | undefined {
  const match = /^(unix|npipe|tcp|ssh):\/\/(.*)$/.exec(host)
  if (match === null) return undefined
  const [, kind = '', rest = ''] = match
  switch (kind) {
    case 'unix':
      return { kind, path: rest }
    case 'npipe':
      // npipe:////./pipe/name names \\.\pipe\name.
      return { kind, path: rest.replaceAll('/', '\\') }
    case 'tcp':
    case 'ssh':
      return { kind }
    default:
      return undefined
  }
}

/** The platform's default endpoint when no context or host is configured. */
function defaultHost(): string {
  return process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock'
}

/**
 * Read a JSON file that may be absent.
 * @param path - the file.
 * @returns its parsed value, or `undefined` when it does not exist.
 */
async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as unknown
}

/**
 * Resolve the active Docker context.
 * @param env - the environment, read for `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG`.
 * @returns the context and its endpoint.
 * @throws {Error} naming the context when its metadata is missing or its endpoint's scheme is unknown.
 */
export async function resolveDockerContext(env: Readonly<Record<string, string | undefined>>): Promise<DockerContext> {
  const configDir = env.DOCKER_CONFIG !== undefined && env.DOCKER_CONFIG !== '' ? env.DOCKER_CONFIG : join(homedir(), '.docker')
  const dockerHost = env.DOCKER_HOST
  let name = env.DOCKER_CONTEXT !== undefined && env.DOCKER_CONTEXT !== '' ? env.DOCKER_CONTEXT : undefined
  if (name === undefined && (dockerHost === undefined || dockerHost === '')) {
    const config = await readJson(join(configDir, 'config.json'))
    const current = typeof config === 'object' && config !== null ? (config as { readonly currentContext?: unknown }).currentContext : undefined
    if (typeof current === 'string' && current !== '') name = current
  }
  let host: string
  if (name === undefined || name === 'default') {
    name = 'default'
    host = dockerHost !== undefined && dockerHost !== '' ? dockerHost : defaultHost()
  } else {
    const meta = await readJson(join(configDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json'))
    const endpoints = typeof meta === 'object' && meta !== null ? (meta as { readonly Endpoints?: { readonly docker?: { readonly Host?: unknown } } }).Endpoints : undefined
    const contextHost = endpoints?.docker?.Host
    if (typeof contextHost !== 'string') throw new Error(`the Docker context ${JSON.stringify(name)} has no docker endpoint in ${configDir}`)
    host = contextHost
  }
  const endpoint = endpointOf(host)
  if (endpoint === undefined) throw new Error(`the Docker context ${JSON.stringify(name)} names an endpoint of unknown scheme: ${host}`)
  return { name, endpoint, host }
}
