/**
 * Helpers of the supervisor's specs: a temporary Delo home, the home process's half of the start token (writing the
 * token file as C1 states), a fixture verified manifest, an in-process supervisor and a client that sends one
 * request line.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartToken } from '@delo/contract-home-layout'
import { IMAGES, type SupervisorFailure } from '@delo/contract-runtime-supervisor'
import type { FileRef, OciDigest } from '@delo/contract-release-manifest'
import { ensureHomeTree, writeProtectedFile } from '@delo/home'
import type { DeloLogger } from '@delo/logs'
import { openSupervisorLog, startTokenFile, Supervisor, type ImagePull, type SupervisorLog, type VerifiedManifest } from '../src/index.ts'

/** The CLI profile the specs use. */
export const PROFILE = 'default'

/** A temporary Delo home with C1's tree. */
export interface TempHome {
  /** The canonical home. */
  readonly home: string
  /** A directory beside the home, outside it, for workspace parents. */
  readonly outside: string
  /** Remove both. */
  remove(): void
}

/**
 * Create a temporary home and a sibling directory. The paths stay short, so the socket path fits C1's limit.
 * @param parent - where to create them; the OS temporary directory when omitted.
 * @returns the home.
 */
export async function tempHome(parent: string = tmpdir()): Promise<TempHome> {
  mkdirSync(parent, { recursive: true })
  const base = realpathSync(mkdtempSync(join(parent, 'dsv-')))
  const home = join(base, 'h')
  const outside = join(base, 'o')
  await ensureHomeTree(home, PROFILE)
  mkdirSync(outside, { mode: 0o700 })
  return { home, outside, remove: () => { rmSync(base, { recursive: true, force: true }) } }
}

/**
 * Write a new start token the way the home process does at each start.
 * @param home - the Delo home.
 * @returns the token.
 */
export async function writeStartToken(home: string): Promise<StartToken> {
  const token = randomBytes(32).toString('base64url') as StartToken
  await writeProtectedFile(startTokenFile(home, PROFILE), `${token}\n`)
  return token
}

/** A digest that no image has. */
export const ABSENT_DIGEST = `sha256:${'0'.repeat(64)}` as OciDigest

/**
 * A verified manifest naming C9's repositories at the given digests.
 * @param s2 - the S2 image's digest, used for its index and both platforms.
 * @param s3 - the S3 image's digest.
 * @param s2Seccomp - the S2 image's listed seccomp profile file, if any.
 * @returns the manifest's image entries.
 */
export function fixtureManifest(s2: OciDigest = ABSENT_DIGEST, s3: OciDigest = ABSENT_DIGEST, s2Seccomp?: FileRef): VerifiedManifest {
  return {
    images: {
      s2: { repository: IMAGES.s2, index: s2, platforms: { 'linux/amd64': s2, 'linux/arm64': s2 }, ...s2Seccomp === undefined ? {} : { seccomp: s2Seccomp } },
      s3: { repository: IMAGES.s3, index: s3, platforms: { 'linux/amd64': s3, 'linux/arm64': s3 } },
    },
  }
}

/** An environment whose Docker endpoint answers nothing. */
export function noDockerEnv(home: string): Record<string, string> {
  return { DOCKER_HOST: `unix://${join(home, 'no-docker.sock')}`, DOCKER_CONFIG: join(home, 'no-docker-config') }
}

/** An in-process supervisor and its log. */
export interface RunningSupervisor {
  readonly supervisor: Supervisor
  readonly log: SupervisorLog
  readonly token: StartToken
  stop(): Promise<void>
}

/** The options of {@link startSupervisor}. */
export interface StartOptions {
  /** The token; a new one is written when omitted. */
  readonly token?: StartToken
  /** The manifest; {@link fixtureManifest} when omitted. */
  readonly manifest?: VerifiedManifest
  /** The environment; {@link noDockerEnv} when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Pulling; `none` when omitted, so no spec reaches a registry. */
  readonly pull?: ImagePull
  /** The OS home; the real one when omitted. */
  readonly osHome?: string
  /** The seccomp profile directory; `<home>/seccomp` when omitted. */
  readonly seccompDirectory?: string
}

/**
 * Start a supervisor in this process, logging to the home's supervisor surface.
 * @param home - the Delo home.
 * @param options - the token, manifest, environment and pulling.
 * @returns the running supervisor.
 */
export async function startSupervisor(home: string, options: StartOptions = {}): Promise<RunningSupervisor> {
  const token = options.token ?? await writeStartToken(home)
  const log = openSupervisorLog({ home, profile: PROFILE, startId: randomBytes(16).toString('hex'), level: 'debug', onFailure: () => {} })
  log.redactor.register(token, 'start-token')
  const supervisor = await Supervisor.start({
    home, profile: PROFILE, token, manifest: options.manifest ?? fixtureManifest(), pull: options.pull ?? 'none',
    logger: log.logger, env: options.env ?? noDockerEnv(home), osHome: options.osHome ?? homedir(), seccompDirectory: options.seccompDirectory ?? join(home, 'seccomp'),
  })
  return {
    supervisor, log, token,
    stop: async () => {
      await supervisor.close()
      log.log.close()
    },
  }
}

/** A response line. */
export type Response = ({ readonly ok: true } & Record<string, unknown>) | SupervisorFailure

/**
 * Send raw bytes on one connection and read the response line.
 * @param socketPath - the supervisor's socket.
 * @param bytes - what to write; the connection stays open until the supervisor ends it.
 * @returns the parsed response line.
 */
export function sendRaw(socketPath: string, bytes: string | Buffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        resolve(JSON.parse(text.split('\n')[0] ?? '') as Response)
      } catch (error) {
        reject(new Error(`no response line: ${JSON.stringify(text)}`, { cause: error }))
      }
    })
    socket.write(bytes)
  })
}

/**
 * Send one request object as a line.
 * @param socketPath - the supervisor's socket.
 * @param request - the request; any value, so specs can send what the schema refuses.
 * @returns the parsed response line.
 */
export function send(socketPath: string, request: unknown): Promise<Response> {
  return sendRaw(socketPath, `${JSON.stringify(request)}\n`)
}

/** A logger that drops every record. */
export const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
