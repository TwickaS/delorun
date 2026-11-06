/**
 * Shared fixtures for the logs specs: a temporary Delo home, a surface log on a settable clock, every file under a
 * home's `logs/` directory, and fake secrets. Every fake secret is generated at run time from random bytes, so no
 * secret-shaped text is committed and no two runs share a value.
 */
import type { LogRecord, SecretKind } from '@delo/contract-operational-logs'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redactor, resolveSurface, SurfaceLog, type LogsFailure, type SurfaceLocation } from '../src/index.ts'

/** A temporary Delo home and its removal. */
export interface TempHome {
  readonly home: string
  readonly remove: () => void
}

/**
 * A new, empty Delo home under the system's temporary directory, at mode 0700.
 * @returns the home.
 */
export function tempHome(): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'delo-logs-'))
  return { home, remove: () => { rmSync(home, { recursive: true, force: true }) } }
}

/** A clock a spec sets. */
export interface Clock {
  now: number
  readonly read: () => number
}

/**
 * A clock that starts at a fixed instant.
 * @returns the clock.
 */
export function clock(): Clock {
  const value: Clock = { now: Date.parse('2026-11-01T00:00:00.000Z'), read: () => value.now }
  return value
}

/** An open surface log with its redactor, clock and reported failures. */
export interface OpenLog {
  readonly log: SurfaceLog
  readonly redactor: Redactor
  readonly clock: Clock
  readonly location: SurfaceLocation
  readonly failures: LogsFailure[]
}

/**
 * Open the `home-default` surface of a home at level `debug`.
 * @param home - the Delo home.
 * @param options - another surface, profile or clock.
 * @returns the open log.
 */
export function openLog(home: string, options: { readonly kind?: 'home' | 'supervisor' | 'desktop-host'; readonly clock?: Clock; readonly redactor?: Redactor; readonly startId?: string } = {}): OpenLog {
  const redactor = options.redactor ?? new Redactor()
  const time = options.clock ?? clock()
  const location = resolveSurface({ kind: options.kind ?? 'home', home, profile: 'default' })
  const failures: LogsFailure[] = []
  const log = SurfaceLog.open({
    location,
    redactor,
    pid: 4242,
    level: 'debug',
    ...options.startId === undefined ? {} : { startId: options.startId },
    onFailure: (error) => { failures.push(error) },
    now: time.read,
  })
  return { log, redactor, clock: time, location, failures }
}

/**
 * Every regular file under a directory, recursively.
 * @param dir - the directory.
 * @returns absolute paths.
 */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return entry.isFile() ? [path] : []
  })
}

/**
 * The text of every file under a home's `logs/` directory, rotated files included.
 * @param home - the Delo home.
 * @returns each path with its text.
 */
export function logTexts(home: string): { readonly path: string; readonly text: string }[] {
  return filesUnder(join(home, 'logs')).map(path => ({ path, text: readFileSync(path, 'utf8') }))
}

/**
 * The records of one log file.
 * @param path - the file.
 * @returns each line parsed.
 */
export function recordsOf(path: string): LogRecord[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as LogRecord)
}

/**
 * A file's permission bits.
 * @param path - the file or directory.
 * @returns the mode masked to 0o777.
 */
export function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Random characters from an alphabet.
 * @param alphabet - the characters to draw from.
 * @param length - how many.
 * @returns the text.
 */
export function randomFrom(alphabet: string, length: number): string {
  return [...randomBytes(length)].map(byte => alphabet[byte % alphabet.length]).join('')
}

/** Every registered-secret kind of the redactor's step 1. */
export const SECRET_KINDS: readonly SecretKind[] = ['model-key', 'start-token', 'session-secret', 'cookie', 'owner-code', 'device-key', 'relay-key', 'helper-key', 'deploy-key', 'repository-token']

/**
 * A fake registered secret of a kind: an obvious canary prefix and random text.
 * @param kind - the kind.
 * @returns the value.
 */
export function canary(kind: SecretKind): string {
  return `delo-canary-${kind}-${randomBytes(12).toString('hex')}`
}

/**
 * The encodings of a value that must never reach a log: raw, base64, base64url, hexadecimal and URL-encoded.
 * @param value - the value.
 * @returns each form.
 */
export function encodings(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  return [value, bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex'), bytes.toString('hex').toUpperCase(), encodeURIComponent(value)]
}

/** Fake secrets in each form step 3 of the redactor lists, assembled at run time. */
export interface PatternCanaries {
  readonly providerKey: string
  readonly githubToken: string
  readonly githubPat: string
  readonly awsKeyId: string
  readonly jwt: string
  readonly slackToken: string
  readonly ownerCode: string
  readonly bearer: string
  readonly basic: string
  readonly cookie: string
  readonly urlPassword: string
  readonly urlToken: string
  readonly envSecret: string
  /** The body lines of a PEM private key, between its BEGIN and END lines. */
  readonly pemBody: readonly string[]
}

/**
 * New fake secrets for step 3's forms.
 * @returns the canaries.
 */
export function patternCanaries(): PatternCanaries {
  const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    providerKey: ['sk', randomBytes(16).toString('hex')].join('-'),
    githubToken: ['gh', 'p_', randomFrom(ALNUM, 36)].join(''),
    githubPat: ['github', 'pat', randomFrom(ALNUM, 40)].join('_'),
    awsKeyId: ['AK', 'IA', randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)].join(''),
    jwt: [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ sub: randomFrom(ALNUM, 12) }), randomBytes(32).toString('base64url')].join('.'),
    slackToken: ['xo', 'xb-', randomFrom('0123456789', 12), '-', randomFrom(ALNUM, 24)].join(''),
    ownerCode: randomFrom(BASE32, 26),
    bearer: randomFrom(ALNUM, 40),
    basic: Buffer.from(`account:${randomFrom(ALNUM, 20)}`).toString('base64'),
    cookie: randomFrom(ALNUM, 32),
    urlPassword: randomFrom(ALNUM, 24),
    urlToken: randomFrom(ALNUM, 30),
    envSecret: randomFrom(ALNUM, 28),
    pemBody: Array.from({ length: 4 }, () => randomBytes(48).toString('base64')),
  }
}

/**
 * The BEGIN or END line of a PEM private key block, assembled at run time.
 * @param edge - which line.
 * @returns the line.
 */
export function pemLine(edge: 'BEGIN' | 'END'): string {
  return ['-----', edge, ' ', 'PRIVATE', ' KEY', '-----'].join('')
}

/**
 * The secret parts of every pattern canary, which must not reach a log.
 * @param canaries - the canaries.
 * @returns each secret text.
 */
export function patternSecrets(canaries: PatternCanaries): string[] {
  return [
    canaries.providerKey, canaries.githubToken, canaries.githubPat, canaries.awsKeyId, canaries.jwt, canaries.slackToken,
    canaries.ownerCode, canaries.bearer, canaries.basic, canaries.cookie, canaries.urlPassword, canaries.urlToken,
    canaries.envSecret, ...canaries.pemBody,
  ]
}

/**
 * Lines of captured output that hold each pattern canary in its listed form.
 * @param canaries - the canaries.
 * @returns the lines, a PEM block among them.
 */
export function patternLines(canaries: PatternCanaries): string[] {
  return [
    `provider answered 401 for key ${canaries.providerKey}`,
    `pushing with ${canaries.githubToken} and ${canaries.githubPat}`,
    `aws id ${canaries.awsKeyId} in use`,
    `session jwt ${canaries.jwt}`,
    `slack ${canaries.slackToken}`,
    `owner code: ${canaries.ownerCode}.`,
    `Authorization: Bearer ${canaries.bearer}`,
    `Proxy-Authorization: Basic ${canaries.basic}`,
    `Cookie: sid=${canaries.cookie}; theme=dark`,
    `fetch https://account:${canaries.urlPassword}@git.example.invalid/repo.git failed`,
    `GET https://api.example.invalid/v1/items?page=2&access_token=${canaries.urlToken}#top`,
    `export DEPLOY_TOKEN=${canaries.envSecret}`,
    pemLine('BEGIN'),
    ...canaries.pemBody,
    pemLine('END'),
  ]
}
