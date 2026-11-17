/**
 * Specs' stand-in for the home process's update channel and the routes over the Changes gate. The channel's token is a
 * constant the specs search every answer for; the channel answers each request from a script and records what it was asked.
 *
 * @module @delorun/plugin-update/tests/update-fixture
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { UPDATE_REPORT_SCHEMA, type ReportItem, type UpdateReport } from '@delorun/contract-update-report'
import type { ResponseLine, UnsignedRequest, UpdateChannelAccess } from '@delorun/home-process'
import { changesGate } from '@delorun/plugin-changes'
import { routeHome, serveRoutes, type RouteServer } from '../../plugin-changes/tests/routes-fixture.ts'
import { updateRoutes, type UpdateCheckAccess } from '../src/routes.ts'

/** The Host's channel token as the stand-in holds it; no answer may carry it. */
export const CHANNEL_TOKEN = 'channel-token-must-never-reach-a-page'

/** The home process's report id for a prepared update; no answer may carry it. */
export const REPORT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** A scripted channel. */
export class FakeChannel implements UpdateChannelAccess {
  readonly requests: UnsignedRequest[] = []
  /** Answers by operation; a function receives the request. */
  readonly answers = new Map<string, readonly ResponseLine[] | ((request: UnsignedRequest) => readonly ResponseLine[])>()
  /** Whether sending throws, as with a channel that is not open. */
  closed = false
  /** The token the stand-in holds. */
  readonly token = CHANNEL_TOKEN

  constructor() {
    this.answers.set('status', [{ ok: true, status: { state: 'running', pid: 1, startId: 's', runtime: { current: '0.1.0', running: '0.1.0' }, chats: 2 } }])
  }

  /** @returns the operations asked, in order. */
  ops(): string[] {
    return this.requests.map(request => request.op)
  }

  send(request: UnsignedRequest, options: { readonly onLine?: (line: ResponseLine) => void } = {}): Promise<ResponseLine[]> {
    if (this.closed) return Promise.reject(new Error('the update channel is not open'))
    this.requests.push(request)
    const scripted = this.answers.get(request.op)
    const lines = typeof scripted === 'function' ? scripted(request) : scripted ?? [{ ok: true }]
    for (const line of lines) options.onLine?.(line)
    return Promise.resolve([...lines])
  }
}

/** The channel the stand-in releases are on. */
const CHANNEL: UpdateReport['from']['channel'] = 'beta'

/** A semantic version as the report types carry it. */
function version(text: string): UpdateReport['from']['delorun'] {
  return brandString<UpdateReport['from']['delorun']>(text)
}

/** A report with the items given; the release facts are those of a clean, verified release. */
export function report(items: readonly ReportItem[] = [], release: Partial<UpdateReport['release']> = {}): UpdateReport {
  return {
    schema: UPDATE_REPORT_SCHEMA,
    installation: 'cli-home',
    from: { delorun: version('0.1.0'), dsh: version('1.0.0'), channel: CHANNEL },
    to: { delorun: version('0.1.1'), dsh: version('1.0.0'), channel: CHANNEL },
    release: { manifest: brandString<UpdateReport['release']['manifest']>('f'.repeat(64)), signature: 'passed', freshness: 'passed', log: 'passed', ...release },
    generated: brandString<UpdateReport['generated']>('2026-11-17T12:00:00Z'),
    installations: [],
    items,
    notChecked: [],
    counts: { disabled: 0, removed: 0, changed: items.length, unverified: 0, data: 0, harness: 0 },
  }
}

/** An item that disables a plugin. */
export const DISABLED_PLUGIN = { kind: 'plugin', subject: { name: '@x/plug', version: version('1.0.0') }, reason: 'dsh-requirement-unmet', effect: 'disabled', verification: 'verified', detail: {}, actions: [] } as ReportItem

/** The data item: the chat data changes format. */
export const DATA_ITEM = { kind: 'data', subject: { directories: ['sessions', 'storages'] }, reason: 'data-format-changed', effect: 'changed', verification: 'verified', detail: {}, actions: ['copy-session-data', 'continue-without-copy'] } as ReportItem

/** A harness file whose approved content conflicts with the target's. */
export const CONFLICTED_HARNESS = { kind: 'harness', subject: { file: 'app/x.js' }, reason: 'harness-change-conflicts', effect: 'kept', verification: 'verified', detail: { merge: 'edits-overlap' }, actions: [] } as ReportItem

/** The served update routes. */
export interface UpdateServer {
  readonly server: RouteServer
  readonly channel: FakeChannel
  readonly home: string
  readonly clock: { now: number }
  readonly log: string[]
  /** What the release check answers, or undefined for the check being off. */
  check: UpdateCheckAccess | undefined
}

/**
 * Serve the update routes over the Changes gate.
 * @param options - Phone powers, whether the channel exists, and the release check.
 * @returns the server and its stand-ins.
 */
export async function serveUpdate(options: { readonly powers?: 'careful' | 'full', readonly noChannel?: boolean } = {}): Promise<UpdateServer> {
  const { ctx } = routeHome()
  mkdirSync(join(ctx.home, 'run', ctx.profile), { recursive: true, mode: 0o700 })
  const channel = new FakeChannel()
  const clock = { now: 1_000_000 }
  const log: string[] = []
  const handle: UpdateServer = {
    channel, home: ctx.home, clock, log, check: undefined,
    server: await serveRoutes(ctx, {
      ...options.powers === undefined ? {} : { powers: options.powers },
      extraRoutes: dependencies => updateRoutes({
        gate: changesGate(dependencies),
        channel: () => options.noChannel === true ? undefined : channel,
        check: () => handle.check,
        waitSeconds: 600,
        release: () => ({ delorun: '0.1.0', dsh: '1.0.0' }),
        logger: { info: (message) => { log.push(message) }, warn: (message) => { log.push(message) } },
        now: () => clock.now,
      }),
    }),
  }
  return handle
}

/**
 * Write the home's outcome record for a profile.
 * @param home - the Delorun home.
 * @param record - the record's fields.
 */
export function writeResult(home: string, record: Record<string, unknown>): void {
  writeFileSync(join(home, 'run', 'default', 'update-result.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}
