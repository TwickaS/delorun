/**
 * The home process's registration of the secrets it holds with its log's redactor (contract C20, "Redaction", step 1),
 * and the attachment of the Host's Cordis logger to the same log.
 *
 * The Host's plugins find the registry as `ctx.delorunSecrets` and register what they mint; it offers `register` and nothing
 * else. This module registers the rest: the secret-named values of the process environment, and the values the Host's
 * credential provider returns, stores or creates, including a key set later from the studio. A model or provider key
 * stays registered for the life of the process, because the provider accepts a replaced or deleted key until it is
 * revoked; a grant's secret fields are dropped when the grant is replaced or deleted.
 *
 * @module @delorun/cli/log-secrets
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MIN_REGISTERED_SECRET_LENGTH, REDACTED_KEY_PARTS, type SecretKind, type SecretSink } from '@delorun/contract-operational-logs'
import type { HomeLog } from '@delorun/home-process'
import { attachCordisLogs } from '@delorun/logs/cordis'

/** Environment names whose values are secrets, by the words C20's structured-field step uses. */
const SECRET_NAME = new RegExp(REDACTED_KEY_PARTS.join('|'), 'i')

/**
 * The most live registrations one context may hold through `ctx.delorunSecrets`. A security constant, not a setting: it
 * bounds how much ordinary text a plugin can blank from the log by registering it, and the home's own plugins hold a
 * few dozen at most (open sessions, pending requests, minted codes).
 */
export const MAX_REGISTRATIONS_PER_CONTEXT = 1024

/** The closure behind {@link SecretRegistry.register}; it holds no value and gives none back. */
const ACCEPT = Symbol('delorun.secrets.accept')

/**
 * The `ctx.delorunSecrets` service: `register` and nothing else. A context that reads the service gets a view whose
 * `ctx` is its own, so each plugin's fiber has its own count of live registrations. The redactor and the values it holds are
 * reachable only through a closure, so a Host plugin cannot read a session token, pairing secret or owner code back.
 */
export class SecretRegistry extends Service implements SecretSink {
  declare private readonly [ACCEPT]: (caller: Context, value: string, kind: SecretKind) => () => void

  /**
   * @param ctx - the Host's root context.
   * @param redactor - where values are registered; held in a closure only.
   */
  constructor(ctx: Context, redactor: SecretSink) {
    super(ctx, 'delorunSecrets')
    // A context is rebuilt on each read of the service, so a plugin is counted by its fiber.
    const live = new WeakMap<object, number>()
    Object.defineProperty(this, ACCEPT, {
      value: (caller: Context, value: string, kind: SecretKind): (() => void) => {
        if (value.length < MIN_REGISTERED_SECRET_LENGTH) {
          throw new RangeError(`delorunSecrets: a value of ${String(value.length)} characters is shorter than the ${String(MIN_REGISTERED_SECRET_LENGTH)} the log redactor matches, so registering it would protect nothing`)
        }
        const owner = caller.fiber
        const count = live.get(owner) ?? 0
        if (count >= MAX_REGISTRATIONS_PER_CONTEXT) {
          throw new RangeError(`delorunSecrets: this context holds ${String(MAX_REGISTRATIONS_PER_CONTEXT)} registrations already; release some before registering more`)
        }
        live.set(owner, count + 1)
        const release = redactor.register(value, kind)
        let released = false
        return () => {
          if (released) return
          released = true
          live.set(owner, (live.get(owner) ?? 1) - 1)
          release()
        }
      },
    })
  }

  /**
   * Register a secret value with the home log's redactor.
   * @param value - the secret, at least 8 characters.
   * @param kind - what the value is.
   * @returns a disposer that drops this registration.
   * @throws {RangeError} when the value is shorter than 8 characters or this context holds the most registrations.
   */
  register(value: string, kind: SecretKind): () => void {
    return this[ACCEPT](this.ctx, value, kind)
  }
}

/**
 * Register the secret-named values of an environment. They stay registered for the life of the process: a `.env` layer
 * or the inherited environment holds the key the provider accepts.
 * @param env - the environment `delorun` was started with, or this process's after the `.env` layers apply.
 * @param sink - where the values are registered.
 * @returns the disposer that drops them all.
 */
export function registerEnvironment(env: Readonly<Record<string, string | undefined>>, sink: SecretSink): () => void {
  const releases: (() => void)[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '' || !SECRET_NAME.test(name)) continue
    releases.push(sink.register(value, /key/i.test(name) ? 'model-key' : 'session-secret'))
  }
  return () => { for (const release of releases) release() }
}

/** The secret values of a stored record, split by how long they stay registered. */
interface RecordSecrets {
  /** An API key and the secret-named values of its environment: provider keys, kept for the life of the process. */
  readonly keys: readonly string[]
  /** The secret-named fields of a grant's payload: dropped when the grant is replaced or deleted. */
  readonly grant: readonly string[]
}

/**
 * The secret values of a stored record: an API record's `key` and its secret-named environment values, and the string
 * values under secret-named fields of a grant's payload (C20, "Redaction", step 2's names). Other text in a record,
 * such as a region, a URL or a scope, is not registered, because registering it would blank ordinary text.
 * @param record - the record.
 * @returns its secret values.
 */
function recordSecrets(record: CredentialRecord): RecordSecrets {
  if (record.kind === 'api-key') {
    const env = Object.entries(record.env ?? {}).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value)
    return { keys: [...record.key === undefined ? [] : [record.key], ...env], grant: [] }
  }
  const grant: string[] = []
  const visit = (value: unknown, named: boolean): void => {
    if (typeof value === 'string') {
      if (named) grant.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, named)
    } else if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) visit(item, named || SECRET_NAME.test(name))
    }
  }
  visit(record.payload, false)
  return { keys: [], grant }
}

/** What a watched credential provider keeps registered, by reference name or record key. */
class Held {
  private readonly values = new Map<string, { readonly values: readonly string[], readonly releases: readonly (() => void)[] }>()
  private readonly kept = new Set<string>()
  private readonly sink: SecretSink
  private readonly kind: SecretKind
  private readonly retain: boolean

  /**
   * @param sink - where values are registered.
   * @param kind - what the values are.
   * @param retain - whether a value stays registered after it is replaced or removed, as a provider key does.
   */
  constructor(sink: SecretSink, kind: SecretKind, retain: boolean) {
    this.sink = sink
    this.kind = kind
    this.retain = retain
  }

  /**
   * Hold the current values of a reference or record. A retained value is registered once and never dropped; any
   * other is dropped when the values change.
   * @param name - the reference or record key.
   * @param values - its values; none once it has none.
   */
  set(name: string, values: readonly string[]): void {
    if (this.retain) {
      for (const value of values) {
        if (this.kept.has(value)) continue
        this.kept.add(value)
        this.sink.register(value, this.kind)
      }
      return
    }
    const held = this.values.get(name)
    if (held?.values.length === values.length && held.values.every((value, index) => value === values[index])) return
    for (const release of held?.releases ?? []) release()
    if (values.length === 0) this.values.delete(name)
    else this.values.set(name, { values, releases: values.map(value => this.sink.register(value, this.kind)) })
  }

  /** Drop every value that is not retained. */
  clear(): void {
    for (const { releases } of this.values.values()) for (const release of releases) release()
    this.values.clear()
  }
}

/**
 * Register what a credential provider hands out. The provider's `resolve`, `set`, `unset`, `readRecord`,
 * `modifyRecord` and `deleteRecord` are wrapped on the instance while the Host runs, so a value is registered before the caller that asked
 * for it can log it, and a change made later from the studio or a phone is registered the same way.
 * @param provider - the Host's credential provider.
 * @param sink - where the values are registered.
 * @returns the disposer that restores the provider's methods and drops the values.
 */
export function watchCredentialProvider(provider: CredentialProvider, sink: SecretSink): () => void {
  const references = new Held(sink, 'model-key', true)
  const recordKeys = new Held(sink, 'model-key', true)
  const grants = new Held(sink, 'session-secret', false)
  const original = { resolve: provider.resolve, set: provider.set, unset: provider.unset, readRecord: provider.readRecord, modifyRecord: provider.modifyRecord, deleteRecord: provider.deleteRecord }
  const noteRecord = (key: string, record: CredentialRecord | undefined): void => {
    const secrets = record === undefined ? { keys: [], grant: [] } : recordSecrets(record)
    recordKeys.set(key, secrets.keys)
    grants.set(key, secrets.grant)
  }
  provider.resolve = async (ref: CredentialRef) => {
    const resolved = await original.resolve.call(provider, ref)
    references.set(ref, resolved === undefined ? [] : [resolved.value])
    return resolved
  }
  provider.set = async (ref: CredentialRef, value: string) => {
    references.set(ref, [value])
    await original.set.call(provider, ref, value)
  }
  provider.unset = async (ref: CredentialRef) => {
    await original.unset.call(provider, ref)
    references.set(ref, [])
  }
  provider.readRecord = async (key) => {
    const record = await original.readRecord.call(provider, key)
    noteRecord(key, record)
    return record
  }
  provider.modifyRecord = async (key, mutate) => original.modifyRecord.call(provider, key, async (current) => {
    const next = await mutate(current)
    const record = next ?? current
    // Registered before the write, so the value is held whether or not the write then succeeds.
    noteRecord(key, record)
    return next
  })
  provider.deleteRecord = async (key) => {
    await original.deleteRecord.call(provider, key)
    noteRecord(key, undefined)
  }
  return () => {
    Object.assign(provider, original)
    references.clear()
    recordKeys.clear()
    grants.clear()
  }
}

/**
 * Attach the Host's root context to the home log: the secret registry for the Host's plugins, the credential provider's
 * registrations, and the Host's Cordis logger messages as records keyed by session and turn. The shipped profile mounts
 * no console exporter, so a Cordis message reaches the log through this one path and not also as captured output.
 * @param root - the Host's root context, before its first entry mounts.
 * @param homeLog - the home process's log.
 */
export function attachHomeLogs(root: Context, homeLog: HomeLog): void {
  new SecretRegistry(root, homeLog.redactor)
  root.effect(() => attachCordisLogs(root, homeLog.log), 'delorun home log')
  root.inject(['credentials'], (ctx) => {
    ctx.effect(() => watchCredentialProvider(ctx.credentials, homeLog.redactor), 'delorun credential registrations')
  })
}
