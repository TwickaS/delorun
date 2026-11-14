/**
 * C20's denial tests on the home process's real wiring: the secrets the home process mints or loads reach the log's
 * redactor at their mint or load points, and the Host's Cordis messages carry session and turn keys on the home surface.
 * The cross-surface suite registers its own canaries; these tests register nothing themselves and plant what the
 * production code created.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CredentialProvider, credentialKey, credentialRef, type CredentialInfo, type CredentialRecord, type CredentialRecordEntry, type CredentialRecordInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { attachHomeLogs, registerEnvironment } from '../../../../apps/cli/src/log-secrets.ts'
import type { DeviceId, ReachListenerId, StudioAddress } from '@delorun/contract-admission'
import type { Base64Url } from '@delorun/contract-device-approval'
import { RECORD_MAX_BYTES, ROTATE_BYTES, type SecretKind } from '@delorun/contract-operational-logs'
import { Approvals } from '../../../home-auth/src/approvals.ts'
import { loadHomeKey } from '../../../home-auth/src/home-key.ts'
import { formatMatchCode, matchCode } from '../../../home-auth/src/match-code.ts'
import { OwnerCodeStore } from '../../../home-auth/src/owner-code.ts'
import { PAIRING_DEFAULTS } from '../../../home-auth/src/pairing.ts'
import { SessionStore } from '../../../home-auth/src/sessions.ts'
import { captureHomeOutput, openHomeLog, type HomeLog } from '../../../home-process/src/index.ts'
import { newStartId } from '@delorun/home'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodings, logTexts, recordsOf, tempHome, type TempHome } from '../support.ts'

let context: Context | undefined
let temp: TempHome | undefined
let homeLog: HomeLog | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  homeLog?.log.close()
  homeLog = undefined
  temp?.remove()
  temp = undefined
})

/** The credential provider of the Host in these specs: values in memory, with the seam's write and read methods. */
class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()
  private readonly records = new Map<string, CredentialRecord>()

  constructor(ctx: Context) {
    super(ctx)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }

  override readRecord(key: string): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(_key: string): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override async modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return next ?? this.records.get(key)
  }

  override deleteRecord(key: string): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

/** Open the home log as the home process does and attach a Host root context to it. */
async function openHome(): Promise<{ readonly ctx: Context; readonly home: string; readonly log: HomeLog }> {
  temp = tempHome()
  const log = homeLog = openHomeLog({ home: temp.home, profile: 'default', startId: newStartId(), level: 'debug', onFailure: () => {} })
  const ctx = context = new Context()
  attachHomeLogs(ctx, log)
  return { ctx, home: temp.home, log }
}

/** Write enough filler to rotate the active file at least once. */
function rotate(log: HomeLog): void {
  const filler = 'f'.repeat(RECORD_MAX_BYTES - 512)
  for (let index = 0; index < Math.ceil(ROTATE_BYTES / filler.length) + 1; index += 1) log.logger.info(filler)
}

describe('log-canary-every-surface: the secrets the home process holds', () => {
  it('registers every secret kind at the point the home process mints or loads it, so none reaches the log', async () => {
    const { ctx, home, log } = await openHome()
    const secrets = ctx.delorunSecrets
    expect(secrets, 'the Host finds the registry as ctx.delorunSecrets').toBeDefined()
    const planted = new Map<SecretKind, string[]>()
    const note = (kind: SecretKind, ...values: string[]): void => { planted.set(kind, [...planted.get(kind) ?? [], ...values]) }

    // Owner code, minted by the home-auth store.
    const secretsDir = join(home, 'secrets', 'home-auth')
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
    const owner = await new OwnerCodeStore({ file: join(secretsDir, 'owner-code.json'), secrets }).issue()
    note('owner-code', owner.code)

    // Session token, minted by the session store.
    const sessionStore = new SessionStore({ file: join(secretsDir, 'sessions.json'), secrets })
    const opened = await sessionStore.open({ deviceId: brandString<DeviceId>('device-one'), listener: 'tailscale-private' as ReachListenerId, address: brandString<StudioAddress>('https://h.example'), lifetimeMs: 3_600_000, factor: 'tailnet-membership' } as never)
    note('session-secret', opened.token)

    // Home key and pop-up pairing: the request secret and the 8-digit match code in each spelling.
    const key = await loadHomeKey(secretsDir, secrets)
    const approvals = new Approvals({ now: Date.now, random: (size) => new Uint8Array(size).map((_, index) => (index * 37 + 11) % 256), homeKey: () => key, pairing: () => PAIRING_DEFAULTS, secrets })
    approvals.openWindow()
    const deviceNonce = brandString<Base64Url>(Buffer.alloc(16, 7).toString('base64url'))
    const deviceId = brandString<DeviceId>(Buffer.alloc(32, 5).toString('base64url'))
    const address = brandString<StudioAddress>('https://h.example')
    const accepted = approvals.request({ devicePublicKey: { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>('x'), y: brandString<Base64Url>('y') }, deviceId, deviceNonce, label: 'phone', platform: 'ios' }, { listener: 'tailscale-private' as ReachListenerId, address, source: '192.0.2.1' })
    const code = matchCode({ homePublicKey: key.publicKey, deviceId, homeNonce: accepted.homeNonce, deviceNonce, address })
    expect(code).toHaveLength(8)
    note('session-secret', accepted.requestSecret)
    note('pairing-code', code, formatMatchCode(code), `${code.slice(0, 4)}-${code.slice(4)}`)
    const pem = await import('node:fs').then(fs => fs.readFileSync(join(secretsDir, 'home-key.pem'), 'utf8'))
    note('device-key', ...pem.split('\n').filter(line => line !== '' && !line.startsWith('-----')))

    // Model and provider keys: from the environment, through the credential provider, set later, and as a stored record.
    note('model-key', 'delorun-canary-env-0123456789abcdef')
    registerEnvironment({ PROVIDER_API_KEY: 'delorun-canary-env-0123456789abcdef', PATH: '/usr/bin' }, secrets!)
    await ctx.plugin(MemoryCredentials, undefined)
    await ctx.credentials.set(credentialRef('LATER_API_KEY'), 'delorun-canary-studio-set-key-9876')
    note('model-key', 'delorun-canary-studio-set-key-9876')
    await ctx.credentials.modifyRecord(credentialKey('client-connection', 'browser-session'), () => Promise.resolve({ kind: 'grant', payload: { version: 1, secret: 'delorun-canary-signing-secret-5555' } }))
    note('session-secret', 'delorun-canary-signing-secret-5555')

    const all = [...planted.values()].flat()
    expect(all.length).toBeGreaterThan(8)
    const plant = (): void => {
      for (const value of all) {
        for (const form of encodings(value)) {
          log.logger.info(`loaded ${form}`, { data: { note: form } })
          process.stdout.write(`upstream printed ${form}\n`)
        }
      }
    }
    const stop = captureHomeOutput(log.log, false)
    try {
      plant()
      rotate(log)
      plant()
    } finally {
      stop()
    }
    const texts = logTexts(home)
    expect(texts.some(({ path }) => /\.log\.\d/.test(path)), 'a file rotated').toBe(true)
    for (const { path, text } of texts) {
      for (const value of all) for (const form of encodings(value)) expect(text.includes(form), `${form} in ${path}`).toBe(false)
    }
    const joined = texts.map(({ text }) => text).join('')
    for (const kind of planted.keys()) expect(joined, kind).toContain(`[redacted:${kind}]`)
  })

  it('keeps a model or provider key registered after it is replaced or removed', async () => {
    const { ctx, log } = await openHome()
    await ctx.plugin(MemoryCredentials, undefined)
    const ref = credentialRef('ROTATED_API_KEY')
    const before = 'delorun-canary-before-rotation-1111'
    const after = 'delorun-canary-after-rotation-22222'
    await ctx.credentials.set(ref, before)
    await ctx.credentials.set(ref, after)
    // The provider accepts the replaced key until it is revoked, so a line that quotes it is still redacted.
    expect(log.redactor.text(`x ${before} y`)).toContain('[redacted:model-key]')
    await ctx.credentials.unset(ref)
    expect(log.redactor.text(`x ${after} y`)).toContain('[redacted:model-key]')
    const record = credentialKey('model', 'provider-record')
    await ctx.credentials.modifyRecord(record, () => Promise.resolve({ kind: 'api-key', key: 'delorun-canary-record-key-3333' }))
    await ctx.credentials.deleteRecord(record)
    expect(log.redactor.text('x delorun-canary-record-key-3333 y')).toContain('[redacted:model-key]')
  })

  it('registers only the key and the secret-named fields of a stored record, and drops a grant when it is replaced or deleted', async () => {
    const { ctx, log } = await openHome()
    await ctx.plugin(MemoryCredentials, undefined)
    const ordinary = ['eu-west-1-ordinary-region', 'https://example.test/ordinary/path', 'read:ordinary-scope']
    const unchanged = (): void => { for (const text of ordinary) expect(log.redactor.text(`x ${text} y`)).toBe(`x ${text} y`) }
    await ctx.credentials.modifyRecord(credentialKey('model', 'bedrock'), () => Promise.resolve({
      kind: 'api-key',
      key: 'delorun-canary-bedrock-key-4444',
      env: { AWS_REGION: ordinary[0] ?? '', AWS_SECRET_ACCESS_KEY: 'delorun-canary-aws-secret-5555' },
    }))
    expect(log.redactor.text('x delorun-canary-bedrock-key-4444 y')).toContain('[redacted:model-key]')
    expect(log.redactor.text('x delorun-canary-aws-secret-5555 y')).toContain('[redacted:model-key]')
    const grant = credentialKey('client-connection', 'oauth')
    const write = (secret: string): Promise<CredentialRecord | undefined> => ctx.credentials.modifyRecord(grant, () => Promise.resolve({
      kind: 'grant',
      payload: { region: ordinary[0], url: ordinary[1], scopes: [ordinary[2]], tokens: { access_token: secret } },
    }))
    await write('delorun-canary-grant-first-6666')
    expect(log.redactor.text('x delorun-canary-grant-first-6666 y')).toContain('[redacted:session-secret]')
    unchanged()
    await write('delorun-canary-grant-second-7777')
    expect(log.redactor.text('x delorun-canary-grant-first-6666 y')).toBe('x delorun-canary-grant-first-6666 y')
    expect(log.redactor.text('x delorun-canary-grant-second-7777 y')).toContain('[redacted:session-secret]')
    await ctx.credentials.deleteRecord(grant)
    expect(log.redactor.text('x delorun-canary-grant-second-7777 y')).toBe('x delorun-canary-grant-second-7777 y')
    unchanged()
  })
})

const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const

/** Streams one scripted step per request. */
class ScriptedAdapter extends LlmAdapter {
  private readonly script: StreamChunk[][]

  constructor(script: StreamChunk[][]) {
    super()
    this.script = script
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.script.shift()
    if (step === undefined) throw new Error('the script has no step for this request')
    yield * step
  }
}

describe('log-session-keys: on the home surface', () => {
  it('keys a record written during a turn by its session id and turn, writes each Cordis message once, and leaves other records unkeyed', async () => {
    const { ctx, home, log } = await openHome()
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const callId = ToolCallId('c1')
    const call: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name: 'probe', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'probe', arguments: '{}' } },
      usage,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const done: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      usage,
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([call, done]))
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Log one line.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => {
        ctx.logger('delorun-probe').info('probe ran')
        process.stdout.write('probe printed\n')
        return Promise.resolve('ok')
      },
    }))
    const agent: Agent = await harness.create(SessionId('s-home'), { provider: 'mock', model: 'mock' })
    const stop = captureHomeOutput(log.log, false)
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      ctx.logger('outside').info('between chats')
    } finally {
      stop()
    }
    const records = recordsOf(log.log.location.file)
    const ran = records.filter(record => record.msg === 'probe ran')
    expect(ran.map(record => [record.surface, record.source, record.sessionId, record.turn])).toEqual([['home-default', 'delorun', 's-home', 1]])
    expect(records.filter(record => record.msg === 'probe printed').map(record => [record.sessionId, record.turn])).toEqual([['s-home', 1]])
    const outside = records.find(record => record.msg === 'between chats')
    expect(outside).toBeDefined()
    expect(outside).not.toHaveProperty('sessionId')
    expect(home).toBeDefined()
  })
})

// Referenced so the Service import documents that the provider above is a Cordis service.
void Service
